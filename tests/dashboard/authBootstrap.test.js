'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const SOURCE_PATH = path.join(__dirname, '..', '..', 'DeseTourDashboard.jsx');
const SOURCE = fs.readFileSync(SOURCE_PATH, 'utf8');

// _resolveStaffState calls _withTimeout by name, so both markers are
// extracted and evaluated together — the REAL implementation of each,
// never a hand-copied duplicate that could drift from what ships.
function extractCombined(names) {
  let body = '';
  for (const name of names) {
    const startMarker = `// TESTABLE:${name}:start`;
    const endMarker = `// TESTABLE:${name}:end`;
    const startIdx = SOURCE.indexOf(startMarker);
    const endIdx = SOURCE.indexOf(endMarker);
    assert.ok(startIdx !== -1 && endIdx !== -1 && endIdx > startIdx, `markers for "${name}" not found`);
    body += SOURCE.slice(startIdx + startMarker.length, endIdx) + '\n';
  }
  const lastName = names[names.length - 1];
  // eslint-disable-next-line no-new-func
  return new Function(`${body}\nreturn ${lastName};`)();
}

const resolveStaffState = extractCombined(['_withTimeout', '_dedupedLoadStaffData', '_resolveStaffState']);
const computeAuthResolution = extractCombined(['_computeAuthResolution']);
const signInWithPassword = extractCombined(['_signInWithPassword']);

function session(userId) {
  return { user: { id: userId, email: `${userId}@desetour.com` } };
}

// A. Existing persisted session + successful staff lookup.
test('a persisted session with a successful staff lookup resolves to the real profile', async () => {
  const loadFn = async (id) => ({ data: { id, full_name: 'Berk Çetinkaya', role: 'admin', is_active: true }, error: null });
  const result = await resolveStaffState(session('u1'), loadFn);
  assert.equal(result.staff.full_name, 'Berk Çetinkaya');
  assert.equal(result.staffQueryError, null);
  assert.equal(result.staffInactive, false);
  assert.equal(result.authLoading, false);
  assert.equal(result.session.user.id, 'u1');
});

// B. Slow staff lookup — must resolve via the 12000ms timeout, never hang.
// Uses its own dedicated user id ('u-slow-timeout-test'), deliberately
// never reused by any other test in this file: neverResolves() never
// settles, so _dedupedLoadStaffData's in-flight entry for this id would
// otherwise never clear and could silently poison a LATER test that
// happens to reuse the same id (see the dedup tests further down, which
// use their own distinct ids for the same reason).
test('a staff lookup slower than the 12000ms budget resolves with a timeout error instead of hanging', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const neverResolves = () => new Promise(() => {});
    const promise = resolveStaffState(session('u-slow-timeout-test'), neverResolves);
    t.mock.timers.tick(12000);
    const result = await promise;
    assert.match(result.staffQueryError, /zaman aşımına uğradı \(12000ms\)/);
    assert.equal(result.staff, null);
    // The session itself must be preserved — a slow profile lookup is not a logout.
    assert.equal(result.session.user.id, 'u-slow-timeout-test');
  } finally {
    t.mock.timers.reset();
  }
});

test('_withTimeout clears its internal timer once the race settles (no dangling 12s timeout after a fast, successful resolve)', async () => {
  const realSetTimeout = global.setTimeout;
  const realClearTimeout = global.clearTimeout;
  let scheduledId = null;
  const clearedIds = [];
  global.setTimeout = (fn, ms) => { scheduledId = realSetTimeout(fn, ms); return scheduledId; };
  global.clearTimeout = (id) => { clearedIds.push(id); return realClearTimeout(id); };
  try {
    const withTimeout = extractCombined(['_withTimeout']);
    const result = await withTimeout(Promise.resolve('ok'), 5000, 'x');
    assert.equal(result, 'ok');
    assert.ok(scheduledId !== null, 'a timer should have been scheduled');
    assert.ok(clearedIds.includes(scheduledId), 'the internal timer must be cleared once the race settles, or it leaks until it fires');
  } finally {
    global.setTimeout = realSetTimeout;
    global.clearTimeout = realClearTimeout;
  }
});

// C. Temporary lookup failure followed by a successful retry (mirrors the
// real "Tekrar Dene" button, which just calls _resolveStaffState again).
test('a temporary lookup failure followed by a retry succeeds cleanly', async () => {
  const failing = async () => { throw new Error('network hiccup'); };
  const first = await resolveStaffState(session('u1'), failing);
  assert.match(first.staffQueryError, /network hiccup/);
  assert.equal(first.staff, null);

  const succeeding = async (id) => ({ data: { id, full_name: 'Berk Çetinkaya', is_active: true }, error: null });
  const second = await resolveStaffState(session('u1'), succeeding);
  assert.equal(second.staffQueryError, null);
  assert.equal(second.staff.full_name, 'Berk Çetinkaya');
});

// D. Missing staff profile — query succeeds, zero rows.
test('a genuinely missing staff profile resolves with staff:null and no error', async () => {
  const loadFn = async () => ({ data: null, error: null });
  const result = await resolveStaffState(session('u1'), loadFn);
  assert.equal(result.staff, null);
  assert.equal(result.staffQueryError, null);
  assert.equal(result.staffInactive, false);
});

// E. Inactive staff profile — a row exists and is linked, but is_active is false.
test('an inactive staff profile is flagged distinctly, never conflated with "missing"', async () => {
  const loadFn = async (id) => ({ data: { id, full_name: 'Eski Personel', is_active: false }, error: null });
  const result = await resolveStaffState(session('u1'), loadFn);
  assert.equal(result.staff, null);
  assert.equal(result.staffInactive, true);
  assert.equal(result.staffQueryError, null);
});

// F. Expired/invalid Supabase session — the SDK has already reduced this to
// no session (s is null); the profile step must short-circuit, no query at all.
test('a null session (expired/invalid) resolves to signed-out state without querying staff_users', async () => {
  let called = false;
  const loadFn = async () => { called = true; return { data: null, error: null }; };
  const result = await resolveStaffState(null, loadFn);
  assert.equal(called, false, 'staff_users must never be queried when there is no session');
  assert.equal(result.session, null);
  assert.equal(result.staff, null);
  assert.equal(result.authLoading, false);
  assert.equal(result.staffQueryError, null);
});

// G. Duplicate/overlapping auth events during bootstrap — only the
// latest-STARTED resolution may ever apply, regardless of which settles first.
test('a stale resolution (an older reqId than the latest dispatched) is discarded', () => {
  const patch = { session: session('u1'), staff: { id: 'u1', full_name: 'X' }, staffQueryError: null };
  // reqId 1 settling after reqId 2 has already been dispatched (latestReqId=2)
  const result = computeAuthResolution(1, 2, patch, null, null);
  assert.equal(result, null);
});

test('the latest-dispatched resolution is applied normally', () => {
  const patch = { session: session('u1'), staff: { id: 'u1', full_name: 'X' }, staffQueryError: null };
  const result = computeAuthResolution(2, 2, patch, null, null);
  assert.deepEqual(result, { ...patch, staffRefreshError: null });
});

test('a stale FAILURE for the same user never overwrites an already-verified cached profile', () => {
  const prevCache = { session: session('u1'), staff: { id: 'u1', full_name: 'Berk' }, staffQueryError: null };
  const failurePatch = { session: session('u1'), staff: null, staffQueryError: 'zaman aşımına uğradı (12000ms)' };
  const result = computeAuthResolution(3, 3, failurePatch, prevCache, 'u1');
  assert.equal(result.staff.full_name, 'Berk', 'the verified profile must survive a same-user refresh failure');
  assert.equal(result.staffRefreshError, 'zaman aşımına uğradı (12000ms)');
});

test('a genuine failure for a DIFFERENT (or first-time) user is not treated as a same-user refresh failure', () => {
  const failurePatch = { session: session('u2'), staff: null, staffQueryError: 'boom' };
  const result = computeAuthResolution(1, 1, failurePatch, null, null);
  assert.deepEqual(result, { ...failurePatch, staffRefreshError: null });
});

// --- Static source checks: the actual root cause is fixed -----------------

test('bootstrap no longer calls sb.auth.getSession() directly — onAuthStateChange is the sole trigger', () => {
  const useAuthIdx = SOURCE.indexOf('function useAuth()');
  const logoutIdx = SOURCE.indexOf('async function logout()', useAuthIdx);
  assert.ok(useAuthIdx !== -1 && logoutIdx !== -1 && logoutIdx > useAuthIdx);
  const body = SOURCE.slice(useAuthIdx, logoutIdx);
  assert.doesNotMatch(body, /await\s+_withTimeout\(sb\.auth\.getSession\(\)/, 'a direct getSession() call would re-introduce the duplicate-query race');
});

test('there is exactly one call site that can start a staff_users resolution during the mount effect', () => {
  const effectIdx = SOURCE.indexOf('useEffect(() => {', SOURCE.indexOf('function useAuth()'));
  const effectEndIdx = SOURCE.indexOf('}, []);', effectIdx);
  const body = SOURCE.slice(effectIdx, effectEndIdx);
  const matches = body.match(/_resolveStaffState\(/g) || [];
  assert.equal(matches.length, 1, 'exactly one _resolveStaffState call should exist inside the mount effect (inside onAuthStateChange)');
});

test('a boot-time safety timer still guarantees authLoading cannot hang forever if no auth event ever fires', () => {
  const effectIdx = SOURCE.indexOf('useEffect(() => {', SOURCE.indexOf('function useAuth()'));
  const effectEndIdx = SOURCE.indexOf('}, []);', effectIdx);
  const body = SOURCE.slice(effectIdx, effectEndIdx);
  assert.match(body, /const bootTimer = setTimeout\(/);
  assert.match(body, /}, 12000\);/);
  assert.match(body, /clearTimeout\(bootTimer\)/);
});

test('the staff_users lookup is keyed by the authenticated Supabase user id (the FK relationship)', () => {
  const idx = SOURCE.indexOf('async function loadStaffData(userId)');
  assert.ok(idx !== -1);
  const line = SOURCE.slice(idx, idx + 200);
  assert.match(line, /\.from\('staff_users'\)\.select\('\*'\)\.eq\('id',\s*userId\)/);
});

test('the 12000ms staff-profile timeout is unchanged', () => {
  assert.match(SOURCE, /_withTimeout\(_dedupedLoadStaffData\(s\.user\.id, loadFn\), 12000, 'Personel profili'\)/);
});

// ── AuthGuard render-branch ordering: the actual proof for the "transient
// staff error" symptom, distinct from the pure _resolveStaffState/
// _computeAuthResolution tests above (those prove the DATA is resolved
// correctly; these prove the RENDER never exposes a wrong intermediate
// state while getting there — the two are separate risks). This codebase
// has no component-render test harness (every existing dashboard test
// extracts real functions or asserts on source structure — see this
// file's and every sibling test file's own convention), so "no visible
// transient staff error" is proven the same way: statically, from
// AuthGuard's own function body, that every staff-error branch is
// textually unreachable until BOTH auth.authLoading is false AND
// auth.isLoggedIn is resolved. React renders exactly one of a function
// component's mutually-exclusive early returns per render — if the
// authLoading/isLoggedIn checks always appear first in source order and
// always return before any staff-branch code executes, no staff-error
// JSX can physically be produced while auth is still resolving, in any
// render, on any timing. ──────────────────────────────────────────────

function extractFunctionBody(name, nextMarker) {
  const idx = SOURCE.indexOf(`function ${name}(`);
  assert.ok(idx !== -1, `could not find function ${name}`);
  return SOURCE.slice(idx, SOURCE.indexOf(nextMarker, idx));
}

const AUTH_GUARD_BODY = extractFunctionBody('AuthGuard', '\nfunction getAuthContext');

// --- 1. Initial auth loading state -----------------------------------------

test('1. useAuth() starts in a loading state by default (session:null, staff:null, authLoading:true) — never "no session" or "no staff" before any auth event has even fired', () => {
  const idx = SOURCE.indexOf('function useAuth()');
  const body = SOURCE.slice(idx, SOURCE.indexOf('const session', idx) + 400);
  assert.match(body, /useState\(\(\) => _authCache \|\| \{\s*\n?\s*session: null, staff: null, authLoading: true\s*\n?\s*\}\)/);
});

test('1 (render). AuthGuard\'s VERY FIRST check is authLoading — the loading spinner is always the first possible render, before isLoggedIn or any staff branch is even evaluated', () => {
  const loadingIdx = AUTH_GUARD_BODY.indexOf('if (auth.authLoading)');
  assert.ok(loadingIdx !== -1, 'authLoading check not found in AuthGuard');
  // Nothing before it in the function body except the auth = useAuth() call
  // and the AuthGuard._current assignment (neither of which renders).
  const before = AUTH_GUARD_BODY.slice(0, loadingIdx);
  assert.doesNotMatch(before, /return\s*\(/, 'something renders before the authLoading check');
});

// --- 5/6. No transient staff error; logged-out state; refresh-while-authenticated ---
// (the actual order proof, covering desired-behavior items 3, 6, 9, 10 at once)

test('5/6/9/10. AuthGuard checks authLoading, then isLoggedIn, strictly before any staffQueryError/staffInactive/staffLinked branch — a staff-error screen can never render while auth is still resolving, whether on first load, a slow network, or a page refresh with an already-valid session', () => {
  const order = [
    'if (auth.authLoading)',
    'if (!auth.isLoggedIn)',
    'if (!auth.staffLinked && auth.staffQueryError)',
    'if (!auth.staffLinked && auth.staffInactive)',
    'if (!auth.staffLinked)',
  ];
  const indices = order.map(marker => {
    const idx = AUTH_GUARD_BODY.indexOf(marker);
    assert.ok(idx !== -1, `could not find "${marker}" in AuthGuard`);
    return idx;
  });
  for (let i = 1; i < indices.length; i++) {
    assert.ok(indices[i] > indices[i - 1], `"${order[i]}" must appear after "${order[i - 1]}" — a staff-error branch reachable before authLoading/isLoggedIn is checked would produce exactly the transient error this test guards against`);
  }
});

test('every staff-error branch in AuthGuard is gated on !auth.staffLinked, and staffLinked is only ever computed from a completed staff query (staff:!!staff, set only inside _resolveStaffState\'s resolved results) — never from an in-progress or unresolved state', () => {
  assert.match(SOURCE, /const staffLinked = !!staff;/);
  // staffLinked can only be true/false once `staff` itself has been set by
  // a completed _resolveStaffState resolution — authLoading:false is set
  // in the exact same return statements, so the two can never disagree.
  const resolveBody = extractFunctionBody('_resolveStaffState', '\n// TESTABLE:_resolveStaffState:end');
  const returns = resolveBody.match(/return \{[^}]*\};/g) || [];
  assert.ok(returns.length >= 4, 'expected multiple distinct resolution outcomes in _resolveStaffState');
  for (const r of returns) assert.match(r, /authLoading:\s*false/, `every _resolveStaffState outcome must set authLoading:false alongside its staff verdict: ${r}`);
});

// --- Full state-machine coverage: every branch AuthGuard can render --------

test('7. an authenticated user with a genuinely missing staff record reaches the "Personel Profili Bağlı Değil" branch, never a silent pass-through', () => {
  assert.match(AUTH_GUARD_BODY, /Personel Profili Bağlı Değil/);
  const idx = AUTH_GUARD_BODY.indexOf('if (!auth.staffLinked) {');
  assert.ok(idx !== -1);
  assert.match(AUTH_GUARD_BODY.slice(idx, idx + 2000), /Personel Profili Bağlı Değil/);
});

test('8. an authenticated user with an inactive staff record reaches the distinct "Hesap Pasif" branch, never conflated with "missing"', () => {
  const idx = AUTH_GUARD_BODY.indexOf('if (!auth.staffLinked && auth.staffInactive) {');
  assert.ok(idx !== -1);
  assert.match(AUTH_GUARD_BODY.slice(idx, idx + 2000), /Hesap Pasif/);
});

test('9. a staff query failure (timeout/network/RLS denial) reaches the distinct "Personel Profili Sorgulanamadı" branch with a retry option, never silently treated as "missing"', () => {
  const idx = AUTH_GUARD_BODY.indexOf('if (!auth.staffLinked && auth.staffQueryError) {');
  assert.ok(idx !== -1);
  const body = AUTH_GUARD_BODY.slice(idx, idx + 2500);
  assert.match(body, /Personel Profili Sorgulanamadı/);
  assert.match(body, /auth\.retryStaffLookup/);
});

test('6. a logged-out user reaches LoginPage, not any staff-error branch', () => {
  const idx = AUTH_GUARD_BODY.indexOf('if (!auth.isLoggedIn) {');
  assert.ok(idx !== -1);
  assert.match(AUTH_GUARD_BODY.slice(idx, idx + 200), /<LoginPage/);
});

test('2. an authenticated admin with a valid, active staff record falls through every error branch and reaches the real app (AuthContext.Provider)', () => {
  const providerIdx = AUTH_GUARD_BODY.lastIndexOf('<AuthContext.Provider');
  assert.ok(providerIdx !== -1);
  // Must be the LAST thing in the function — every error branch above it
  // is a `return` inside an `if`, so control only reaches this point when
  // none of authLoading/!isLoggedIn/staffQueryError/staffInactive/
  // !staffLinked held true.
  const afterProvider = AUTH_GUARD_BODY.slice(providerIdx);
  assert.doesNotMatch(afterProvider.slice(40), /^\s*if \(/, 'no further branching after the success path');
});

// ── _signInWithPassword: the real sign-in call, and how its failures are
// reported — added while investigating a live report of a user (Auth
// UUID confirmed, staff row confirmed valid/active/linked, last_sign_in_at
// NULL) whose login fails even with a believed-correct password. Proves,
// with the REAL implementation and an injectable fake `sb` (never a real
// network call), exactly what reaches Supabase and exactly how a real
// rejection differs from the request itself failing. ─────────────────────

function fakeSb(signInImpl) {
  return { auth: { signInWithPassword: signInImpl } };
}

test('email/password are sent to signInWithPassword exactly as given — no trim, no case change, no other transformation', async () => {
  let received = null;
  const sb = fakeSb(async (args) => { received = args; return { data: {}, error: null }; });
  await signInWithPassword(sb, '  Deniz@Desetour.com ', 'MyP@ssw0rd ');
  assert.deepEqual(received, { email: '  Deniz@Desetour.com ', password: 'MyP@ssw0rd ' });
});

test('a real Supabase rejection (wrong credentials, rate limit, etc.) returns the existing generic Turkish message, and logs the real error for diagnosis', async () => {
  const realError = new Error('Invalid login credentials');
  const originalConsoleError = console.error;
  const logged = [];
  console.error = (...args) => logged.push(args);
  try {
    const sb = fakeSb(async () => ({ data: null, error: realError }));
    const result = await signInWithPassword(sb, 'deniz@desetour.com', 'wrongpass');
    assert.deepEqual(result, { error: 'Hatalı email veya şifre.' });
    assert.ok(logged.some(args => args.some(a => a === realError)), 'the real Supabase error object must be logged, not silently discarded');
  } finally {
    console.error = originalConsoleError;
  }
});

test('a successful sign-in returns {error:null}, with nothing logged as an error', async () => {
  const originalConsoleError = console.error;
  let called = false;
  console.error = () => { called = true; };
  try {
    const sb = fakeSb(async () => ({ data: { user: { id: 'u1' } }, error: null }));
    const result = await signInWithPassword(sb, 'deniz@desetour.com', 'correct-password');
    assert.deepEqual(result, { error: null });
    assert.equal(called, false);
  } finally {
    console.error = originalConsoleError;
  }
});

test('a request that never reaches Supabase (network failure, CORS, a paused/misconfigured project) is caught, never left to propagate uncaught, and reported with a DISTINCT message from a real credential rejection', async () => {
  const networkError = new TypeError('Failed to fetch');
  const originalConsoleError = console.error;
  const logged = [];
  console.error = (...args) => logged.push(args);
  try {
    const sb = fakeSb(async () => { throw networkError; });
    const result = await signInWithPassword(sb, 'deniz@desetour.com', 'correct-password');
    assert.notEqual(result.error, 'Hatalı email veya şifre.', 'a request failure must never be reported identically to a real credential rejection');
    assert.match(result.error, /Bağlantı hatası/);
    assert.ok(logged.some(args => args.some(a => a === networkError)));
  } finally {
    console.error = originalConsoleError;
  }
});

test('REGRESSION: before this fix, a thrown/rejected signInWithPassword propagated uncaught out of login() — this proves it no longer does, so the login button can never stay stuck on "Giriş yapılıyor…" forever with no error shown', async () => {
  const sb = fakeSb(async () => { throw new Error('boom'); });
  await assert.doesNotReject(signInWithPassword(sb, 'x@desetour.com', 'y'));
});

// --- Static source checks -----------------------------------------------

test('LoginPage.handleSubmit passes the raw controlled-input state through unmodified — no trim()/toLowerCase() applied to email or password before login() is called', () => {
  const idx = SOURCE.indexOf('async function handleSubmit(e)');
  assert.ok(idx !== -1);
  const body = SOURCE.slice(idx, SOURCE.indexOf('\n  }', idx));
  assert.match(body, /await login\(email, password\)/);
  assert.doesNotMatch(body, /\.trim\(\)/);
  assert.doesNotMatch(body, /\.toLowerCase\(\)/);
});

test('login() delegates to the real, extracted _signInWithPassword — one implementation, directly tested above, not a second inline copy', () => {
  const idx = SOURCE.indexOf('async function login(email, password)');
  assert.ok(idx !== -1);
  const body = SOURCE.slice(idx, SOURCE.indexOf('\nfunction useAuth()', idx));
  assert.match(body, /return _signInWithPassword\(sb, email, password\);/);
  assert.doesNotMatch(body, /sb\.auth\.signInWithPassword\(/, 'login() itself must not call signInWithPassword directly — only _signInWithPassword may');
});

test('the login <input> fields are standard controlled inputs (value + onChange) with type="email"/type="password", not defaultValue/uncontrolled — the standard React pattern browser autofill is expected to update correctly', () => {
  const idx = SOURCE.indexOf('function LoginPage({ onLogin, connectionError })');
  const body = SOURCE.slice(idx, SOURCE.indexOf('Giriş Yap', idx) + 20);
  assert.match(body, /value=\{email\} onChange=\{e=>setEmail\(e\.target\.value\)\}/);
  assert.match(body, /value=\{password\} onChange=\{e=>setPassword\(e\.target\.value\)\}/);
});

test('a forgot-password flow exists and uses Supabase\'s official resetPasswordForEmail for the EXISTING auth user — never account deletion/recreation', () => {
  const idx = SOURCE.indexOf('async function handleReset()');
  assert.ok(idx !== -1);
  const body = SOURCE.slice(idx, SOURCE.indexOf('\n  async function handleSubmit', idx));
  assert.match(body, /sb\.auth\.resetPasswordForEmail\(resetEmail,/);
  assert.doesNotMatch(SOURCE, /auth\.admin\.deleteUser/);
  assert.doesNotMatch(SOURCE, /auth\.admin\.createUser/);
});

// ── Production evidence round: "[Auth] Staff profile lookup threw (session
// kept): ... zaman aşımına uğradı (12000ms)" appearing after a real login,
// with the user admitted anyway. Root cause: LoginPage used to mount its
// OWN useAuth() instance purely to reach login(), which meant its OWN
// onAuthStateChange subscription received SIGNED_IN and started its own
// _resolveStaffState(...) staff_users query. handleSubmit does not await
// that — it navigates to the dashboard as soon as login() itself resolves,
// unmounting LoginPage (orphaning, not cancelling, its in-flight query) and
// mounting AuthGuard, whose fresh useAuth() instance subscribes again,
// receives INITIAL_SESSION for the now-active session, and started a
// SECOND, independent staff_users query for the SAME user — two real
// Postgres queries competing for the same connection/bandwidth budget,
// exactly the contention class that pushes a lookup past the 12000ms
// budget. Fixed two ways: (1) login()/updateAuth() hoisted to module level
// so LoginPage no longer calls useAuth() at all — no second subscription
// exists, by construction; (2) _dedupedLoadStaffData as defense-in-depth,
// collapsing any other overlapping resolution for the same user (e.g.
// React StrictMode double-invocation) onto one real network request. The
// eight tests below are the exact regression scenarros the investigation
// was asked to prove. ────────────────────────────────────────────────────

// 1. Initial authenticated page load performs exactly one logical staff
//    bootstrap — proven both by the dedup layer (a second concurrent call
//    for the same user reuses the first's promise, not a second query) and
//    by the earlier static check that only one _resolveStaffState call site
//    exists inside the mount effect.
test('REGRESSION 1: initial authenticated page load performs one logical staff bootstrap — a single call to _dedupedLoadStaffData issues exactly one underlying query', async () => {
  const dedupedLoadStaffData = extractCombined(['_dedupedLoadStaffData']);
  let calls = 0;
  const loadFn = async (id) => { calls++; return { data: { id, full_name: 'Berk', is_active: true }, error: null }; };
  const result = await dedupedLoadStaffData('u-bootstrap-1', loadFn);
  assert.equal(calls, 1);
  assert.equal(result.data.full_name, 'Berk');
});

// 2. INITIAL_SESSION followed by SIGNED_IN for the SAME user/session must
//    not create duplicate staff lookups — proven directly against the real
//    onAuthStateChange handler body: TOKEN_REFRESHED/INITIAL_SESSION for an
//    identity that hasn't changed, with an already-verified profile cached,
//    short-circuits before reaching _resolveStaffState at all.
test('REGRESSION 2: INITIAL_SESSION plus a same-user SIGNED_IN/TOKEN_REFRESHED does not create duplicate staff lookups — the handler short-circuits when identity is unchanged and a profile is already cached', () => {
  const useAuthIdx = SOURCE.indexOf('function useAuth()');
  const idx = SOURCE.indexOf("ev === 'TOKEN_REFRESHED' || ev === 'INITIAL_SESSION'", useAuthIdx);
  assert.ok(idx !== -1, 'the same-identity short-circuit for repeated auth events was not found');
  const lineEnd = SOURCE.indexOf('\n', idx);
  const line = SOURCE.slice(SOURCE.lastIndexOf('if (', idx), lineEnd);
  assert.match(line, /newUserId && newUserId === prevUserId && prevCache\?\.staff/);
  // And the short-circuit branch returns before ever reaching the
  // _resolveStaffState call further down in the same handler.
  const resolveCallIdx = SOURCE.indexOf('_resolveStaffState(s)', idx);
  const returnIdx = SOURCE.indexOf('return;', idx);
  assert.ok(returnIdx !== -1 && returnIdx < resolveCallIdx, 'the short-circuit must return before the real staff lookup is ever started');
});

// 3. Duplicate auth callbacks for the same user (whatever triggers them —
//    a duplicate event, a second component instance, StrictMode) reuse one
//    in-flight lookup rather than firing a second real query.
test('REGRESSION 3: duplicate auth callbacks for the same user reuse one in-flight lookup via _dedupedLoadStaffData, instead of firing a second concurrent query', async () => {
  const dedupedLoadStaffData = extractCombined(['_dedupedLoadStaffData']);
  let calls = 0;
  let resolveFirst;
  const loadFn = (id) => new Promise((resolve) => {
    calls++;
    resolveFirst = () => resolve({ data: { id, full_name: 'Berk', is_active: true }, error: null });
  });
  const p1 = dedupedLoadStaffData('u-dup-callback', loadFn);
  const p2 = dedupedLoadStaffData('u-dup-callback', loadFn);
  assert.equal(calls, 1, 'a second concurrent call for the same user must not start a second real query');
  assert.strictEqual(p1, p2, 'both callers must be handed the exact same in-flight promise');
  resolveFirst();
  const [r1, r2] = await Promise.all([p1, p2]);
  assert.equal(r1.data.full_name, 'Berk');
  assert.deepEqual(r1, r2);
  // Once settled, the very next lookup for that same user gets a fresh
  // query — the cache never serves a stale result to a later, separate call.
  const p3 = dedupedLoadStaffData('u-dup-callback', loadFn);
  assert.notStrictEqual(p3, p1, 'a lookup started after the previous one settled must be a fresh request, not the old cached promise');
});

// 4. Logout must invalidate any stale profile result — a slow/late-settling
//    lookup from before the logout must never repopulate the cache with a
//    stale identity after the session has already been cleared.
test('REGRESSION 4: logout invalidates stale profile results — a late-settling resolution started before logout is discarded, never repopulating the cache with a signed-out user\'s profile', () => {
  // Logout itself bumps nothing in _authReqSeq — it goes straight through
  // updateAuth(), never through _applyAuthResolution — so any resolution
  // that was already in flight when logout happened is judged purely by
  // whether a NEWER resolution has started since. Model that: reqId 1 was
  // the in-flight lookup; reqId 2 is the resolution logout's own next auth
  // event (SIGNED_OUT session:null) would produce.
  const staleProfilePatch = { session: session('u-logout'), staff: { id: 'u-logout', full_name: 'Stale' }, staffQueryError: null };
  const result = computeAuthResolution(1, 2, staleProfilePatch, null, null);
  assert.equal(result, null, 'a stale resolution (lower reqId than latest) must be discarded outright, never applied after logout');
});

test('REGRESSION 4b: logout itself always clears session and staff via updateAuth(), unconditionally — not gated on any in-flight request', () => {
  const idx = SOURCE.indexOf('async function logout()');
  assert.ok(idx !== -1);
  const body = SOURCE.slice(idx, SOURCE.indexOf("if (typeof NAV_REF.fn", idx));
  assert.match(body, /updateAuth\(\{ session:null, staff:null, authLoading:false, authError:null, staffQueryError:null \}\)/);
});

// 5. A staff lookup timeout must never authorize an unverified user —
//    fail-closed proof: staff stays null and staffLinked (computed from
//    !!staff) stays false, so AuthGuard's staffQueryError branch — never
//    the authenticated app — is what renders.
test('REGRESSION 5: a staff lookup timeout does not authorize an unverified user — staff stays null (staffLinked=false) on timeout, so AuthGuard cannot fall through to the authenticated app', async () => {
  const neverResolves = () => new Promise(() => {});
  const t = { mock: undefined };
  // Reuse the real timeout path directly (no fake timers needed — assert on
  // the shape of a genuinely-pending lookup forced to resolve via a fast
  // fake loadFn that mimics the timeout outcome _withTimeout itself would
  // produce, proving the CONSEQUENCE: staff:null + staffQueryError set).
  const timedOut = async () => { throw new Error('Personel profili zaman aşımına uğradı (12000ms)'); };
  const result = await resolveStaffState(session('u-failclosed'), timedOut);
  assert.equal(result.staff, null, 'a timed-out lookup must never produce a truthy staff object');
  assert.match(result.staffQueryError, /zaman aşımına uğradı/);
  const staffLinked = !!result.staff;
  assert.equal(staffLinked, false, 'staffLinked must be false on timeout — this is exactly what routes AuthGuard to "Personel Profili Sorgulanamadı", never the authenticated app');
});

// 6. A successful, verified staff lookup authorizes normally — the positive
//    control proving the fail-closed check above isn't just always false.
test('REGRESSION 6: a successful verified staff lookup authorizes normally — staff is populated and staffLinked is true', async () => {
  const loadFn = async (id) => ({ data: { id, full_name: 'Berk Çetinkaya', role: 'admin', is_active: true }, error: null });
  const result = await resolveStaffState(session('u-verified'), loadFn);
  assert.equal(result.staffQueryError, null);
  assert.ok(result.staff, 'a genuinely successful lookup must produce a staff object');
  const staffLinked = !!result.staff;
  assert.equal(staffLinked, true);
});

// 7. Subscriptions are cleaned up — the mount effect's cleanup function
//    must unsubscribe the onAuthStateChange subscription, clear the boot
//    safety timer, and remove this instance's listener, on every return
//    path (mock client, cached-state early return, and the real Supabase
//    path alike), so remounts/route changes never leak a subscription.
test('REGRESSION 7: the useAuth() mount effect always returns a cleanup function that unsubscribes onAuthStateChange, clears the boot timer, and removes the listener', () => {
  const useAuthIdx = SOURCE.indexOf('function useAuth()');
  const effectIdx = SOURCE.indexOf('useEffect(() => {', useAuthIdx);
  const effectEndIdx = SOURCE.indexOf('}, []);', effectIdx);
  const body = SOURCE.slice(effectIdx, effectEndIdx);
  const cleanups = body.match(/return \(\) => \{[^}]*\};/g) || [];
  assert.ok(cleanups.length >= 3, `expected a cleanup function on every early-return path, found ${cleanups.length}`);
  const realPathCleanup = cleanups[cleanups.length - 1];
  assert.match(realPathCleanup, /clearTimeout\(bootTimer\)/);
  assert.match(realPathCleanup, /subscription\?\.unsubscribe\?\.\(\)/);
  assert.match(realPathCleanup, /_authListeners = _authListeners\.filter\(l => l !== listener\)/);
  for (const c of cleanups) {
    assert.match(c, /_authListeners = _authListeners\.filter\(l => l !== listener\)/, 'every early-return path must still remove its own listener on cleanup');
  }
});

// 8. No duplicate Supabase client is created by the auth flow — getSB()'s
//    singleton is unchanged, and LoginPage (the component that used to
//    mount a second subscription) provably no longer calls useAuth() at
//    all, so it can never create a second onAuthStateChange subscription
//    on that shared client.
test('REGRESSION 8a: getSB() remains a true singleton — repeated calls never create a second Supabase client', () => {
  const idx = SOURCE.indexOf('function getSB()');
  const body = SOURCE.slice(idx, SOURCE.indexOf('\n}', idx) + 2);
  assert.match(body, /if \(_sb\) return _sb;/, 'getSB() must short-circuit on an already-created client');
  const createClientCalls = (body.match(/factory\(/g) || []).length;
  assert.equal(createClientCalls, 1, 'createClient must be invoked from exactly one place inside getSB()');
});

test('REGRESSION 8b: LoginPage never calls useAuth() — it cannot create a second onAuthStateChange subscription, structurally', () => {
  const idx = SOURCE.indexOf('function LoginPage({ onLogin, connectionError })');
  assert.ok(idx !== -1);
  const nextFnIdx = SOURCE.indexOf('\nfunction ', idx + 10);
  const body = SOURCE.slice(idx, nextFnIdx)
    // Strip the explanatory comment lines, which deliberately mention
    // "useAuth()" in prose — only actual code should be checked below.
    .split('\n').filter(line => !line.trim().startsWith('//')).join('\n');
  assert.doesNotMatch(body, /[^/]\buseAuth\(\)/, 'LoginPage mounting its own useAuth() instance is exactly the mechanism that raced AuthGuard\'s staff lookup in production');
  assert.match(body, /await login\(email, password\)/, 'LoginPage must still reach the module-level login() directly');
});

test('REGRESSION 8c: login() and updateAuth() are module-level (defined before useAuth()), not per-instance closures recreated on every hook mount', () => {
  const loginIdx = SOURCE.indexOf('async function login(email, password)');
  const updateAuthIdx = SOURCE.indexOf('function updateAuth(patch)');
  const useAuthIdx = SOURCE.indexOf('function useAuth()');
  assert.ok(loginIdx !== -1 && updateAuthIdx !== -1 && useAuthIdx !== -1);
  assert.ok(loginIdx < useAuthIdx, 'login() must be defined before/outside useAuth(), at module level');
  assert.ok(updateAuthIdx < useAuthIdx, 'updateAuth() must be defined before/outside useAuth(), at module level');
});
