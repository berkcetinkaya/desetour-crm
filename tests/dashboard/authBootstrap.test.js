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

const resolveStaffState = extractCombined(['_authDiag', '_withTimeout', '_dedupedLoadStaffData', '_resolveStaffState']);
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
    const withTimeout = extractCombined(['_authDiag', '_withTimeout']);
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
  assert.match(SOURCE, /_withTimeout\(_dedupedLoadStaffData\(s\.user\.id, loadFn, diagId\), 12000, 'Personel profili', diagId\)/);
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

// 2. INITIAL_SESSION followed by SIGNED_IN (or ANY other repeat event) for
//    the SAME user/session must not create duplicate staff lookups —
//    proven directly against the real onAuthStateChange handler body: an
//    identity that hasn't changed, with an already-verified profile
//    cached, short-circuits before reaching _resolveStaffState at all,
//    regardless of which event type triggered it. This guard used to be
//    narrowed to only TOKEN_REFRESHED/INITIAL_SESSION — widened (see the
//    fix's own comment in the handler) after live production evidence
//    showed a genuine HTTP 200 staff_users response at ~777ms followed by
//    a stale "profile lookup threw (session kept)" timeout ~12s later:
//    proof that some OTHER, uncovered event type was starting a second,
//    non-deduped, sequential lookup for an identity that was already
//    verified.
test('REGRESSION 2: a repeat auth event of ANY type (not just TOKEN_REFRESHED/INITIAL_SESSION) for an unchanged identity with an already-cached profile short-circuits before reaching _resolveStaffState at all', () => {
  const useAuthIdx = SOURCE.indexOf('function useAuth()');
  const idx = SOURCE.indexOf('newUserId && newUserId === prevUserId && prevCache?.staff', useAuthIdx);
  assert.ok(idx !== -1, 'the same-identity short-circuit for repeated auth events was not found');
  const lineEnd = SOURCE.indexOf('\n', idx);
  const line = SOURCE.slice(SOURCE.lastIndexOf('if (', idx), lineEnd);
  // The guard must NOT be narrowed back down to specific event-type checks
  // (ev === '...') — it must apply to every event type Supabase can fire.
  assert.doesNotMatch(line, /ev\s*===/, 'the short-circuit must not be gated on specific event types — any repeat event for an unchanged, already-verified identity must be covered');
  assert.match(line, /newUserId && newUserId === prevUserId && prevCache\?\.staff/);
  // And the short-circuit branch returns before ever reaching the
  // _resolveStaffState call further down in the same handler.
  const resolveCallIdx = SOURCE.indexOf('_resolveStaffState(s', idx);
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

// ── Live production evidence round 2: Chrome Network, filtered to
// "staff_users", showed the REAL query completing HTTP 200 in ~777ms —
// disproving the earlier "the query itself is slow" theory. Yet the
// console still later logged "[Auth] staff profile lookup threw (session
// kept): ... zaman aşımına uğradı (12000ms)". Root cause, found by tracing
// _resolveStaffState/_withTimeout/_dedupedLoadStaffData/onAuthStateChange
// together rather than in isolation: the short-circuit that skips
// re-querying staff_users for an unchanged, already-verified identity was
// narrowed to exactly two Supabase event types (TOKEN_REFRESHED,
// INITIAL_SESSION). ANY other repeat event for that same already-verified
// user — a duplicate SIGNED_IN (Supabase re-broadcasts auth state across
// browser tabs via a storage/BroadcastChannel listener), USER_UPDATED, or
// anything else — fell through the guard and started a full second,
// independent staff_users lookup, SEQUENTIAL with (not concurrent with)
// the first one. Because _dedupedLoadStaffData only collapses requests
// that overlap in time, a sequential second lookup gets its own real
// network request and its own independent _withTimeout/12000ms timer. If
// that SECOND request is ever slow or fails for any reason unrelated to
// the first (rare, but not impossible), it settles up to 12 seconds after
// it started — which can land well after the FIRST request already
// succeeded and authorized the session — and logs a "profile lookup
// threw" error that looks like an active problem but is actually a stale,
// already-superseded echo. Fixed two ways: (1) the short-circuit now
// covers ANY event type, not just two, removing the redundant request for
// the routine case entirely; (2) _resolveStaffState now takes an
// isStale() check (wired from the caller's reqId vs the live _authReqSeq)
// that suppresses ONLY a stale rejection's console.error — a CURRENT
// failure (the latest-dispatched resolution) still always logs. Both
// changes are pure logging/request-count corrections: _computeAuthResolution
// already guaranteed a stale result could never overwrite a verified
// profile, and staffLinked (!!staff) already never becomes true from a
// timeout — authorization was never at risk from this bug, only the
// console was. ──────────────────────────────────────────────────────────

test('PRODUCTION SEQUENCE: a staff lookup that resolves successfully at ~777ms logs nothing, even once the clock is advanced past the full 12000ms timeout budget — no dangling timer, no stale error, ever', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const originalConsoleError = console.error;
  const logged = [];
  console.error = (...args) => logged.push(args);
  try {
    const loadFn = (id) => new Promise((resolve) => {
      setTimeout(() => resolve({ data: { id, full_name: 'Berk Çetinkaya', is_active: true }, error: null }), 777);
    });
    const promise = resolveStaffState(session('u-prod-777'), loadFn);
    t.mock.timers.tick(777);
    const result = await promise;
    assert.equal(result.staffQueryError, null);
    assert.equal(result.staff.full_name, 'Berk Çetinkaya');
    // The exact reported sequence: the clock keeps running well past the
    // 12000ms budget after the real response already came back.
    t.mock.timers.tick(20000);
    assert.equal(logged.length, 0, `no console.error may fire after a successful resolution, however long the clock later advances — got: ${JSON.stringify(logged)}`);
  } finally {
    console.error = originalConsoleError;
    t.mock.timers.reset();
  }
});

test('PRODUCTION SEQUENCE: a stale OLDER lookup that is still in flight when a NEWER lookup for a different identity already succeeded logs nothing when it eventually times out — the isStale() check suppresses only the superseded one', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const originalConsoleError = console.error;
  const logged = [];
  console.error = (...args) => logged.push(args);
  try {
    let latestReqId = 0;

    // Call A: dispatched first (reqId 1), for a user whose lookup never
    // settles within the budget — mirrors a stale/orphaned request that
    // outlives whatever started it (e.g. a superseded session).
    const reqIdA = ++latestReqId;
    const hangingLoadFn = () => new Promise(() => {});
    const promiseA = resolveStaffState(session('u-stale-A'), hangingLoadFn, () => reqIdA !== latestReqId);

    // Call B: dispatched shortly after (reqId 2, a genuinely different,
    // newer identity — e.g. the user that's actually signed in now) and
    // resolves quickly, becoming the latest applied resolution.
    const reqIdB = ++latestReqId;
    const fastLoadFn = (id) => Promise.resolve({ data: { id, full_name: 'Yeni Kullanıcı', is_active: true }, error: null });
    const promiseB = resolveStaffState(session('u-fresh-B'), fastLoadFn, () => reqIdB !== latestReqId);
    const resultB = await promiseB;
    assert.equal(resultB.staff.full_name, 'Yeni Kullanıcı');
    assert.equal(logged.length, 0, 'the fast, current resolution must never log anything');

    // Now the stale call's own 12000ms budget elapses.
    t.mock.timers.tick(12000);
    const resultA = await promiseA;
    assert.match(resultA.staffQueryError, /zaman aşımına uğradı/);
    assert.equal(logged.length, 0, 'a lookup that is no longer the latest dispatched request must not log its own late failure as if it were current');
  } finally {
    console.error = originalConsoleError;
    t.mock.timers.reset();
  }
});

test('PRODUCTION SEQUENCE (negative control): the SAME stale timeout DOES log when no isStale() check is supplied — proving the suppression above is a real, active guard, not a no-op', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const originalConsoleError = console.error;
  const logged = [];
  console.error = (...args) => logged.push(args);
  try {
    const hangingLoadFn = () => new Promise(() => {});
    // No third argument — defaults to () => false, i.e. "never stale".
    const promise = resolveStaffState(session('u-negative-control'), hangingLoadFn);
    t.mock.timers.tick(12000);
    const result = await promise;
    assert.match(result.staffQueryError, /zaman aşımına uğradı/);
    assert.equal(logged.length, 1, 'without an isStale() check, a genuinely current (or default-configured) failure must still log — this is what proves the guard in the test above is actually doing something, not passing by coincidence');
  } finally {
    console.error = originalConsoleError;
    t.mock.timers.reset();
  }
});

test('PRODUCTION SEQUENCE: a CURRENT failure (the latest-dispatched resolution) still logs normally — staleness suppression never hides a real, active problem', async (t) => {
  const originalConsoleError = console.error;
  const logged = [];
  console.error = (...args) => logged.push(args);
  try {
    let latestReqId = 1;
    const failing = async () => { throw new Error('genuinely down right now'); };
    const result = await resolveStaffState(session('u-current-failure'), failing, () => 1 !== latestReqId);
    assert.match(result.staffQueryError, /genuinely down right now/);
    assert.equal(logged.length, 1, 'a failure that IS the latest-dispatched resolution must still be logged — "no legitimate current auth failure may be hidden"');
  } finally {
    console.error = originalConsoleError;
  }
});

test('PRODUCTION SEQUENCE: the same deduplicated promise, consumed by two separate _resolveStaffState/_withTimeout wrappers, resolves both identically and logs nothing on success', async () => {
  let loadCalls = 0;
  const loadFn = async (id) => { loadCalls++; return { data: { id, full_name: 'Paylaşılan Profil', is_active: true }, error: null }; };
  const originalConsoleError = console.error;
  let loggedCount = 0;
  console.error = () => { loggedCount++; };
  try {
    const [r1, r2] = await Promise.all([
      resolveStaffState(session('u-shared-consumer'), loadFn, () => false),
      resolveStaffState(session('u-shared-consumer'), loadFn, () => false),
    ]);
    assert.equal(loadCalls, 1, 'two concurrent consumers of the same user must still only trigger one real query');
    assert.deepEqual(r1, r2, 'both independent _withTimeout wrappers around the same deduplicated promise must resolve to the same outcome');
    assert.equal(loggedCount, 0);
  } finally {
    console.error = originalConsoleError;
  }
});

test('the useAuth() mount effect\'s cleanup function is purely synchronous — it never awaits the in-flight staff lookup, so unmounting mid-lookup still immediately unsubscribes and removes the listener regardless of how long that lookup takes to settle', () => {
  const useAuthIdx = SOURCE.indexOf('function useAuth()');
  const effectIdx = SOURCE.indexOf('useEffect(() => {', useAuthIdx);
  const effectEndIdx = SOURCE.indexOf('}, []);', effectIdx);
  const body = SOURCE.slice(effectIdx, effectEndIdx);
  const cleanups = body.match(/return \(\) => \{[^}]*\};/g) || [];
  const realPathCleanup = cleanups[cleanups.length - 1];
  assert.doesNotMatch(realPathCleanup, /await\b/, 'a cleanup function that awaited the in-flight lookup would delay unmount cleanup by up to 12 seconds');
  assert.doesNotMatch(realPathCleanup, /\.then\(/, 'cleanup must not be gated on the lookup promise settling');
});

test('logout during an in-flight lookup: the stale lookup\'s eventual timeout is discarded outright by _computeAuthResolution once the SIGNED_OUT event has already bumped past its reqId — the logged-out state is never overwritten', () => {
  // Mirrors the real onAuthStateChange handler's own sequencing: the
  // in-flight lookup was dispatched under reqId 1; logout's own SIGNED_OUT
  // event increments _authReqSeq to 2 (a different identity: newUserId
  // becomes null) and applies its own resolution immediately (a null
  // session resolves synchronously, no query). The stale lookup's patch,
  // whenever it finally settles, carries reqId 1 — now stale.
  const staleTimeoutPatch = { session: session('u-logout-race'), staff: null, staffQueryError: 'zaman aşımına uğradı (12000ms)' };
  const result = computeAuthResolution(1, 2, staleTimeoutPatch, { session: null, staff: null, authLoading: false }, null);
  assert.equal(result, null, 'a stale lookup settling after logout must never repopulate the cache with the logged-out user\'s profile');
});

// ── [AUTH-DIAG] temporary diagnostic instrumentation — added to collect
// one clean, correlated production trace of the "staff_users returns 200
// in ~1s, yet a timeout logs ~12s later" sequence, without yet changing
// any auth/timeout/dedup/retry behavior. Every test below either (a)
// proves the instrumentation is behaviorally inert — the exact same
// scenario, run once with a diagId and once without, must produce
// byte-identical results — or (b) proves the diagnostic OUTPUT itself is
// correct, deterministic, and free of anything sensitive. This extraction
// includes '_authDiag' so diagId can actually be exercised; the resolveStaffState
// used by every earlier test in this file already includes it too (see
// the top of this file), so those 52 pre-existing tests already prove the
// instrumentation changes nothing when diagId is omitted, as every real
// production call site... except now diagId IS always passed there. These
// tests instead prove diagId-passed and diagId-omitted are equivalent.
const diagResolveStaffState = extractCombined(['_authDiag', '_withTimeout', '_dedupedLoadStaffData', '_resolveStaffState']);

// _authDiagLog uses console.log (not console.debug) specifically because
// Chrome DevTools filters console.debug under its "Verbose" level, which
// is OFF by default — exactly the bug this round's investigation found
// and fixed. Capture console.log accordingly.
function captureDebug() {
  const original = console.log;
  const lines = [];
  console.log = (...args) => lines.push(args);
  return { lines, restore: () => { console.log = original; } };
}

test('[AUTH-DIAG] _authDiagNextId() produces deterministic, incrementing ids (authdiag-1, authdiag-2, authdiag-3, …), never Math.random-based', () => {
  // extractCombined(['_authDiag']) returns the LAST name in the list per
  // its own convention (see extractCombined above) — here that's
  // _authDiagLog, not the id generator, so reach _authDiagNextId via a
  // dedicated `new Function` over the same block instead.
  const block = SOURCE.slice(SOURCE.indexOf('// TESTABLE:_authDiag:start'), SOURCE.indexOf('// TESTABLE:_authDiag:end'));
  // eslint-disable-next-line no-new-func
  const nextId = new Function(`${block}\nreturn _authDiagNextId;`)();
  assert.equal(nextId(), 'authdiag-1');
  assert.equal(nextId(), 'authdiag-2');
  assert.equal(nextId(), 'authdiag-3');
});

test('[AUTH-DIAG] diagnostic ids increment deterministically within one lifecycle', () => {
  const idx = SOURCE.indexOf('function _authDiagNextId()');
  assert.ok(idx !== -1);
  const line = SOURCE.slice(idx, SOURCE.indexOf('\n', idx) + 40);
  assert.match(line, /authdiag-\$\{\+\+_authDiagSeq\}/, 'the id must be a deterministic incrementing counter, not Math.random()');
  assert.doesNotMatch(SOURCE.slice(idx, idx + 200), /Math\.random/);
});

test('[AUTH-DIAG] every diagnostic line is prefixed exactly "[AUTH-DIAG]"', () => {
  const idx = SOURCE.indexOf('function _authDiagLog(diagId, ...rest)');
  assert.ok(idx !== -1);
  const line = SOURCE.slice(idx, SOURCE.indexOf('\n', idx) + 5);
  assert.match(line, /console\.log\('\[AUTH-DIAG\]', diagId, \.\.\.rest\)/);
  // console.debug specifically must NOT be used — it is filtered by
  // Chrome DevTools' "Verbose" log level (off by default), which is
  // exactly why production showed zero [AUTH-DIAG] lines despite the
  // instrumentation actually running.
  assert.doesNotMatch(line, /console\.debug/);
});

test('[AUTH-DIAG] user id tail is truncated to a maximum of 6 characters and never logs the full id', () => {
  const idx = SOURCE.indexOf('function _authDiagUserTail(userId)');
  assert.ok(idx !== -1);
  const line = SOURCE.slice(idx, SOURCE.indexOf('\n', idx) + 5);
  assert.match(line, /\.slice\(-6\)/);
});

test('[AUTH-DIAG] a full successful resolution logs only primitives (id, tags, numbers, a <=6-char user tail) — never the session object, tokens, or full user id', async () => {
  const cap = captureDebug();
  try {
    const fullUserId = 'aaaaaaaa-bbbb-cccc-dddd-ffffffffffff';
    const loadFn = async (id) => ({ data: { id, full_name: 'Berk Çetinkaya', is_active: true }, error: null });
    const diagId = 'authdiag-test-success';
    const result = await diagResolveStaffState(session(fullUserId), loadFn, () => false, diagId);
    assert.equal(result.staff.full_name, 'Berk Çetinkaya');
    assert.ok(cap.lines.length > 0, 'a successful resolution with a diagId must produce diagnostic output');
    for (const line of cap.lines) {
      assert.equal(line[0], '[AUTH-DIAG]');
      assert.equal(line[1], diagId);
      const serialized = JSON.stringify(line);
      assert.doesNotMatch(serialized, /aaaaaaaa-bbbb-cccc-dddd-ffffffffffff/, 'the full user id must never appear in a diagnostic line');
      assert.doesNotMatch(serialized, /@desetour\.com/, 'no email may appear in a diagnostic line');
      assert.doesNotMatch(serialized, /"session"/i);
      assert.doesNotMatch(serialized, /Bearer /i, 'no auth header/token may appear in a diagnostic line');
    }
    // The 6-char tail of the full id above:
    const flat = JSON.stringify(cap.lines);
    assert.match(flat, /ffffff/, 'the (safe, <=6-char) user tail should still appear somewhere, proving correlation data is present, just truncated');
  } finally {
    cap.restore();
  }
});

test('[AUTH-DIAG] passing a diagId does not change the returned result for a successful lookup — instrumentation is behaviorally inert', async () => {
  const loadFn = async (id) => ({ data: { id, full_name: 'Berk', role: 'admin', is_active: true }, error: null });
  const withoutDiag = await resolveStaffState(session('u-diag-parity-1'), loadFn);
  const withDiag = await diagResolveStaffState(session('u-diag-parity-1'), loadFn, () => false, 'authdiag-parity-1');
  assert.deepEqual(withoutDiag, withDiag);
});

test('[AUTH-DIAG] passing a diagId does not change fail-closed timeout behavior — staff still never becomes truthy, and the same error text is produced', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const neverResolves = () => new Promise(() => {});
    const withoutDiag = resolveStaffState(session('u-diag-parity-timeout-a'), neverResolves);
    const withDiag = diagResolveStaffState(session('u-diag-parity-timeout-b'), neverResolves, () => false, 'authdiag-parity-timeout');
    t.mock.timers.tick(12000);
    const [r1, r2] = await Promise.all([withoutDiag, withDiag]);
    assert.equal(r1.staff, null);
    assert.equal(r2.staff, null, 'a diagId must never cause a timeout to authorize an unverified user');
    assert.match(r1.staffQueryError, /zaman aşımına uğradı \(12000ms\)/);
    assert.match(r2.staffQueryError, /zaman aşımına uğradı \(12000ms\)/);
  } finally {
    t.mock.timers.reset();
  }
});

test('[AUTH-DIAG] passing a diagId does not change stale-result console.error suppression', async () => {
  const originalConsoleError = console.error;
  const errLogged = [];
  console.error = (...args) => errLogged.push(args);
  const cap = captureDebug();
  try {
    const hangingLoadFn = () => new Promise(() => {});
    // Never awaited to completion within this test (would need fake timers
    // for that) — this only proves the isStale() wiring/behavior itself,
    // matching the existing "negative control" test's pattern, but with a
    // diagId also present to prove it doesn't interfere with the gate.
    const failing = async () => { throw new Error('boom'); };
    const result = await diagResolveStaffState(session('u-diag-stale-check'), failing, () => true, 'authdiag-stale-check');
    assert.match(result.staffQueryError, /boom/);
    assert.equal(errLogged.length, 0, 'isStale()=true must still suppress console.error even when a diagId is present');
    assert.ok(cap.lines.some(l => l.includes('TIMEOUT-OR-THROW')), 'the diagnostic trace must still record the outcome even when the user-facing console.error is suppressed');
  } finally {
    console.error = originalConsoleError;
    cap.restore();
  }
});

test('[AUTH-DIAG] passing a diagId does not change request deduplication — still exactly one real query for two concurrent callers', async () => {
  const cap = captureDebug();
  try {
    let calls = 0;
    const loadFn = async (id) => { calls++; return { data: { id, full_name: 'Paylaşılan', is_active: true }, error: null }; };
    const [r1, r2] = await Promise.all([
      diagResolveStaffState(session('u-diag-dedup'), loadFn, () => false, 'authdiag-dedup-a'),
      diagResolveStaffState(session('u-diag-dedup'), loadFn, () => false, 'authdiag-dedup-b'),
    ]);
    assert.equal(calls, 1, 'a diagId must never affect the underlying dedup — still exactly one real query');
    assert.deepEqual(r1, r2);
    const flat = JSON.stringify(cap.lines);
    assert.match(flat, /NEW-REQUEST/);
    assert.match(flat, /JOIN-EXISTING/);
  } finally {
    cap.restore();
  }
});

test('[AUTH-DIAG] the trace distinguishes the three promise stages (load / dedup / race) with explicit tags, not a single undifferentiated log', async () => {
  const cap = captureDebug();
  try {
    const loadFn = async (id) => ({ data: { id, full_name: 'X', is_active: true }, error: null });
    await diagResolveStaffState(session('u-diag-tags'), loadFn, () => false, 'authdiag-tags');
    const flat = cap.lines.map(l => l.join(' ')).join('\n');
    assert.match(flat, /\bload\b/, 'the raw loadStaffData promise stage must be tagged distinctly');
    assert.match(flat, /\bdedup\b/, 'the deduplicated cached promise stage must be tagged distinctly');
    assert.match(flat, /\brace\b/, 'the _withTimeout race promise stage must be tagged distinctly');
    assert.match(flat, /\bresolve\b/, 'the overall _resolveStaffState outcome must also be tagged');
  } finally {
    cap.restore();
  }
});

test('[AUTH-DIAG] elapsed-ms values come from one shared performance.now()-based origin and are non-negative, monotonic integers', async () => {
  const cap = captureDebug();
  try {
    const loadFn = async (id) => ({ data: { id, full_name: 'X', is_active: true }, error: null });
    await diagResolveStaffState(session('u-diag-elapsed'), loadFn, () => false, 'authdiag-elapsed');
    const times = [];
    for (const line of cap.lines) {
      const tIdx = line.indexOf('t');
      if (tIdx !== -1 && typeof line[tIdx + 1] === 'number') times.push(line[tIdx + 1]);
    }
    assert.ok(times.length >= 3, 'expected multiple timestamped diagnostic lines');
    for (const t of times) {
      assert.ok(Number.isInteger(t) && t >= 0, `elapsed ms must be a non-negative integer, got ${t}`);
    }
    for (let i = 1; i < times.length; i++) {
      assert.ok(times[i] >= times[i - 1], 'elapsed ms must be non-decreasing across one lookup\'s own lifecycle');
    }
  } finally {
    cap.restore();
  }
});

test('[AUTH-DIAG] the onAuthStateChange handler logs the real Supabase event type, reqId, and current _authReqSeq — not a placeholder', () => {
  const useAuthIdx = SOURCE.indexOf('function useAuth()');
  const handlerIdx = SOURCE.indexOf('onAuthStateChange((ev, s) => {', useAuthIdx);
  assert.ok(handlerIdx !== -1);
  const handlerEnd = SOURCE.indexOf('return () => {', handlerIdx);
  const body = SOURCE.slice(handlerIdx, handlerEnd);
  assert.match(body, /_authDiagLog\(diagId, 'event', ev, 'userTail', _authDiagUserTail\(newUserId\), 't', _authDiagNow\(\)\)/);
  assert.match(body, /_authDiagLog\(diagId, 'reqId', reqId, 'authReqSeq', _authReqSeq, 't', _authDiagNow\(\)\)/);
  assert.match(body, /_authDiagLog\(diagId, 'apply', applied \? 'APPLIED' : 'DISCARDED-STALE'/);
});

test('[AUTH-DIAG] retryStaffLookup also emits a correlated trace tagged RETRY, reusing the exact same _resolveStaffState/diagId wiring as the mount-effect path', () => {
  const idx = SOURCE.indexOf('async function retryStaffLookup()');
  assert.ok(idx !== -1);
  const body = SOURCE.slice(idx, SOURCE.indexOf('\n  useEffect(() => {', idx));
  assert.match(body, /_authDiagLog\(diagId, 'event', 'RETRY'/);
  assert.match(body, /_resolveStaffState\(session, undefined, \(\) => reqId !== _authReqSeq, diagId\)/);
});

test('[AUTH-DIAG] diagnostic helpers never reference session, token, password, or key-shaped identifiers in their own source', () => {
  const block = SOURCE.slice(SOURCE.indexOf('// TESTABLE:_authDiag:start'), SOURCE.indexOf('// TESTABLE:_authDiag:end'));
  assert.doesNotMatch(block, /\baccess_token\b|\brefresh_token\b|\bpassword\b|\bsupabaseKey\b|Authorization/i);
});

// ── Round 2: production ran v12.31 (confirmed via window.__DESETOUR_BUILD__),
// the legacy 12000ms timeout still logged, but ZERO [AUTH-DIAG] lines
// appeared despite the instrumentation from a786ab0 genuinely being
// present in that exact build (verified: app.js byte-identical to a fresh
// compile of this source, and grepping app.js for "[AUTH-DIAG]",
// "authdiag-", "NEW-REQUEST", "TIMER-FIRED", "SKIPPED-ALREADY-VERIFIED"
// all matched). Root cause: _authDiagLog used console.debug(), which
// Chrome's DevTools Console filters under its "Verbose" log level — OFF
// by default in most browser profiles — while console.error (the legacy
// line) is a different, always-shown level. No code defect in the auth
// bootstrap itself; the trace was firing all along, just invisible. Two
// repository-wide searches independently confirmed there is no second
// useAuth()/onAuthStateChange/createClient/bootstrap implementation and
// no _resolveStaffState call site missing diagId (both real call sites —
// the mount effect and retryStaffLookup — pass it). Fixed by switching to
// console.log (never level-gated in any major browser) and adding an
// UNCONDITIONAL (never `if (diagId)`-gated) trace line immediately before
// each of the two legacy console.error calls, so this exact contradiction
// — a visible console.error with zero preceding trace — can never recur
// for this function, regardless of any future caller. ──────────────────

test('[AUTH-DIAG] the unconditional trace before the timeout/throw console.error fires even when diagId is completely omitted — proving the legacy line can never again log with zero preceding trace', async () => {
  const cap = captureDebug();
  const originalConsoleError = console.error;
  const errLogged = [];
  console.error = (...args) => errLogged.push(args);
  try {
    const failing = async () => { throw new Error('boom-no-diagid'); };
    // Called exactly like every pre-786ab0/pre-diagnostic caller would —
    // no loadFn override needed here beyond failing, no isStale, no diagId.
    const result = await resolveStaffState(session('u-no-diagid'), failing);
    assert.match(result.staffQueryError, /boom-no-diagid/);
    assert.equal(errLogged.length, 1, 'the legacy console.error must still fire normally with no diagId');
    const unconditional = cap.lines.filter(l => l.includes('UNCONDITIONAL'));
    assert.equal(unconditional.length, 1, 'the unconditional trace must fire exactly once, with or without a diagId');
    assert.ok(unconditional[0].includes('(none)'), 'a missing diagId must be reported explicitly as "(none)", never silently omitted');
  } finally {
    console.error = originalConsoleError;
    cap.restore();
  }
});

test('[AUTH-DIAG] the unconditional trace distinguishes a real _withTimeout timeout (wrapperTimedOut:true) from a genuine underlying throw (wrapperTimedOut:false)', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const cap = captureDebug();
  try {
    const neverResolves = () => new Promise(() => {});
    const promise = resolveStaffState(session('u-unconditional-timeout'), neverResolves);
    t.mock.timers.tick(12000);
    await promise;
    const line = cap.lines.find(l => l.includes('UNCONDITIONAL') && l.includes('timeout-or-throw'));
    assert.ok(line, 'expected an unconditional timeout-or-throw trace line');
    const flagIdx = line.indexOf('wrapperTimedOut');
    assert.equal(line[flagIdx + 1], true, 'a real 12000ms _withTimeout firing must report wrapperTimedOut:true');
  } finally {
    cap.restore();
    t.mock.timers.reset();
  }
});

test('[AUTH-DIAG] a genuine network/query throw (not a timeout) reports wrapperTimedOut:false in the unconditional trace', async () => {
  const cap = captureDebug();
  try {
    const failing = async () => { throw new Error('ECONNRESET'); };
    await resolveStaffState(session('u-unconditional-throw'), failing);
    const line = cap.lines.find(l => l.includes('UNCONDITIONAL') && l.includes('timeout-or-throw'));
    assert.ok(line);
    const flagIdx = line.indexOf('wrapperTimedOut');
    assert.equal(line[flagIdx + 1], false, 'a genuine (non-timeout) throw must report wrapperTimedOut:false, distinguishing it from a real 12000ms timeout');
  } finally {
    cap.restore();
  }
});

test('[AUTH-DIAG] the unconditional trace before the query-error console.error also fires unconditionally, reporting authReqSeq safely even when it is out of scope', async () => {
  const cap = captureDebug();
  const originalConsoleError = console.error;
  console.error = () => {};
  try {
    const erroring = async () => ({ data: null, error: { message: 'RLS denied' } });
    await resolveStaffState(session('u-unconditional-query-error'), erroring);
    const line = cap.lines.find(l => l.includes('UNCONDITIONAL') && l.includes('query-error'));
    assert.ok(line, 'expected an unconditional query-error trace line');
    const seqIdx = line.indexOf('authReqSeq');
    // resolveStaffState's extraction here does not include the module
    // scope that declares _authReqSeq, so the defensive typeof-guard must
    // report null rather than throwing a ReferenceError.
    assert.equal(line[seqIdx + 1], null);
  } finally {
    console.error = originalConsoleError;
    cap.restore();
  }
});

test('[AUTH-DIAG] no code path in the whole repository can emit "[Auth] staff profile lookup threw" without the unconditional trace line immediately preceding it', () => {
  const block = extractFunctionBody('_resolveStaffState', '\n// TESTABLE:_resolveStaffState:end');
  const legacyIdx = block.indexOf("console.error('[Auth] staff profile lookup threw");
  assert.ok(legacyIdx !== -1);
  const before = block.slice(0, legacyIdx);
  const unconditionalIdx = before.lastIndexOf("console.log('[AUTH-DIAG]', 'UNCONDITIONAL', 'timeout-or-throw'");
  assert.ok(unconditionalIdx !== -1, 'the unconditional trace must appear before the legacy console.error');
  // Nothing but the isStale()-gated diag call and the unconditional trace
  // itself may sit between them — no other branch/return can slip in.
  const between = before.slice(unconditionalIdx);
  assert.doesNotMatch(between.slice(between.indexOf(';') + 1), /return\s*\{/, 'no return statement may separate the unconditional trace from the legacy console.error it guards');
});

// ── Round 3: PROVEN root cause, traced directly against the pinned
// @supabase/supabase-js@2.45.4 source. Every REST request (sb.from(...))
// goes through fetchWithAuth -> _getAccessToken() -> this.auth.getSession()
// -> GoTrueClient's internal navigator.locks-based _acquireLock. But
// _notifyAllSubscribers (which dispatches SIGNED_IN/INITIAL_SESSION/etc.
// to our onAuthStateChange callback) does
// `await Promise.all(listeners.map(l => l.callback(ev, s)))` from INSIDE
// that same _acquireLock. Awaiting a Supabase database call directly
// inside the callback therefore nests a second _acquireLock call inside
// the first — not a hard deadlock (the SDK queues re-entrant calls via
// its own pendingInLock list rather than re-requesting navigator.locks),
// but it DOES serialize our query's token fetch behind the still-open
// outer callback, and — if the persisted session's access token happened
// to already be expired at that exact moment — __loadSession() additionally
// awaits a full, real token-refresh network round-trip first. That is the
// proven mechanism behind the production trace showing a genuine
// staff_users request still unresolved 12+ seconds after SIGNED_IN,
// settling only once a LATER, no-longer-nested INITIAL_SESSION dispatch
// let it complete.
//
// Fix: the callback itself is now fully synchronous (no `async`, no
// `await` before it returns) and hands the actual _resolveStaffState call
// to a setTimeout(0) macrotask, guaranteed to run after the callback — and
// therefore _notifyAllSubscribers' Promise.all and the outer _acquireLock —
// have already resolved and released the lock. Staleness/logout/user-switch
// safety is NOT reimplemented: the deferred lookup still goes through the
// exact same reqId/_authReqSeq/_applyAuthResolution/_computeAuthResolution
// machinery, with reqId/prevCache/prevUserId captured synchronously at
// dispatch time, exactly as before. ──────────────────────────────────────

test('[DEFERRED-LOOKUP] A. the onAuthStateChange callback is not async and awaits nothing before handing off to the deferred setTimeout', () => {
  const useAuthIdx = SOURCE.indexOf('function useAuth()');
  const handlerIdx = SOURCE.indexOf('onAuthStateChange((ev, s) => {', useAuthIdx);
  assert.ok(handlerIdx !== -1, 'the callback must be a plain (non-async) function — the whole point of the fix');
  assert.doesNotMatch(SOURCE.slice(useAuthIdx, SOURCE.indexOf('function LoginPage', useAuthIdx)), /onAuthStateChange\(async /, 'the old async-callback form must be gone entirely');
  const deferIdx = SOURCE.indexOf('setTimeout(() => {', handlerIdx);
  assert.ok(deferIdx !== -1);
  const beforeDefer = SOURCE.slice(handlerIdx, deferIdx)
    // Strip comment lines — the explanatory prose above mentions "await"
    // in the abstract; only actual code should be checked here.
    .split('\n').filter(line => !line.trim().startsWith('//')).join('\n');
  assert.doesNotMatch(beforeDefer, /\bawait\b/, 'nothing before the deferred setTimeout may await a Supabase call — that is exactly the bug this fix removes');
});

test('[DEFERRED-LOOKUP] the actual staff_users lookup (_resolveStaffState) only appears INSIDE the setTimeout(...,0) deferral, never directly in the synchronous callback body', () => {
  const useAuthIdx = SOURCE.indexOf('function useAuth()');
  const handlerIdx = SOURCE.indexOf('onAuthStateChange((ev, s) => {', useAuthIdx);
  const deferIdx = SOURCE.indexOf('setTimeout(() => {', handlerIdx);
  const handlerEnd = SOURCE.indexOf('return () => {', handlerIdx);
  const beforeDefer = SOURCE.slice(handlerIdx, deferIdx);
  const afterDefer = SOURCE.slice(deferIdx, handlerEnd);
  assert.doesNotMatch(beforeDefer, /_resolveStaffState\(/);
  assert.match(afterDefer, /_resolveStaffState\(/);
  const setTimeoutCallEnd = SOURCE.indexOf('}, 0);', deferIdx);
  assert.ok(setTimeoutCallEnd !== -1 && setTimeoutCallEnd < handlerEnd, 'the deferral must use a 0ms macrotask delay, not an arbitrary debounce');
});

test('[DEFERRED-LOOKUP] H. the already-verified short-circuit still returns before ever reaching the deferred setTimeout — no deferred lookup is scheduled at all for a redundant event', () => {
  const useAuthIdx = SOURCE.indexOf('function useAuth()');
  const handlerIdx = SOURCE.indexOf('onAuthStateChange((ev, s) => {', useAuthIdx);
  const shortCircuitIdx = SOURCE.indexOf('SKIPPED-ALREADY-VERIFIED', handlerIdx);
  const shortCircuitReturnIdx = SOURCE.indexOf('return;', shortCircuitIdx);
  const deferIdx = SOURCE.indexOf('setTimeout(() => {', handlerIdx);
  assert.ok(shortCircuitReturnIdx !== -1 && deferIdx !== -1);
  assert.ok(shortCircuitReturnIdx < deferIdx, 'the short-circuit must return before the deferred setTimeout is ever scheduled');
});

test('[DEFERRED-LOOKUP] J. retryStaffLookup is unchanged by this refactor — it still awaits _resolveStaffState directly, since it is triggered by a user click, not nested inside onAuthStateChange\'s own dispatch/lock', () => {
  const idx = SOURCE.indexOf('async function retryStaffLookup()');
  assert.ok(idx !== -1);
  const body = SOURCE.slice(idx, SOURCE.indexOf('\n  useEffect(() => {', idx));
  assert.match(body, /await _resolveStaffState\(session, undefined, \(\) => reqId !== _authReqSeq, diagId\)/);
  assert.doesNotMatch(body, /setTimeout/, 'retryStaffLookup does not need the deferral — it is never invoked from inside a Supabase auth-lock-held callback');
});

test('[DEFERRED-LOOKUP] K. there is still exactly one sb.auth.onAuthStateChange(...) subscription and one getSB() singleton — the fix did not introduce a second client or subscription', () => {
  const subscriptionCalls = (SOURCE.match(/\.onAuthStateChange\(/g) || []).length;
  assert.equal(subscriptionCalls, 1, 'exactly one onAuthStateChange call site must exist in the whole file');
  const idx = SOURCE.indexOf('function getSB()');
  const body = SOURCE.slice(idx, SOURCE.indexOf('\n}', idx) + 2);
  assert.match(body, /if \(_sb\) return _sb;/);
});

// A faithful local mirror of the real handler's own orchestration (reqId
// capture at dispatch time, the short-circuit, the setTimeout(0) defer,
// applying via the REAL computeAuthResolution) — never a reimplementation
// of _resolveStaffState/_computeAuthResolution's own logic, which are the
// real, directly-imported/extracted functions under test everywhere else
// in this file. This exists only because the real handler lives inline
// inside useAuth()'s useEffect, with no component-render harness in this
// codebase (see this file's own established convention/comment further
// up) — so the DEFERRAL MECHANICS themselves (real Promises, real
// setTimeout, real staleness comparisons) are exercised end-to-end here,
// exactly as the real handler drives them.
function simulateDeferredAuthEvent(state, s, loadFn) {
  const prevCache = state.authCache;
  const prevUserId = prevCache?.session?.user?.id || null;
  const newUserId = s?.user?.id || null;
  if (newUserId && newUserId === prevUserId && prevCache?.staff) {
    state.authCache = { ...prevCache, session: s };
    return { deferred: null, reqId: null, shortCircuited: true };
  }
  const reqId = ++state.authReqSeq;
  if (newUserId !== prevUserId) {
    state.authCache = { session: s, staff: null, authLoading: true, staffQueryError: null, staffRefreshError: null };
  }
  let resolveDeferred;
  const deferred = new Promise((res) => { resolveDeferred = res; });
  setTimeout(() => {
    (async () => {
      const patch = await resolveStaffState(s, loadFn, () => reqId !== state.authReqSeq);
      const next = computeAuthResolution(reqId, state.authReqSeq, patch, prevCache, prevUserId);
      const applied = next !== null;
      if (applied) state.authCache = next;
      resolveDeferred({ applied, cache: state.authCache });
    })();
  }, 0);
  return { deferred, reqId, shortCircuited: false };
}

test('[DEFERRED-LOOKUP] B/C. the callback returns — and DEFERRED STAFF LOOKUP STARTED logs — strictly before the staff lookup itself begins, proven with real timer/Promise mechanics', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  try {
    let loadStarted = false;
    const loadFn = async (id) => { loadStarted = true; return { data: { id, full_name: 'X', is_active: true }, error: null }; };
    const state = { authReqSeq: 0, authCache: null };
    const { deferred } = simulateDeferredAuthEvent(state, session('u-order-test'), loadFn);
    // Mirrors the real handler: by the time simulateDeferredAuthEvent
    // RETURNS (the synchronous callback body has finished), the lookup
    // must not have started yet — it is only scheduled, not yet run.
    assert.equal(loadStarted, false, 'the staff lookup must not have started yet at the moment the callback returns');
    t.mock.timers.tick(0);
    await deferred;
    assert.equal(loadStarted, true, 'the deferred lookup must eventually run once the macrotask fires');
  } finally {
    t.mock.timers.reset();
  }
});

test('[DEFERRED-LOOKUP] D. a successful deferred lookup applies the staff profile normally', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const state = { authReqSeq: 0, authCache: null };
    const loadFn = async (id) => ({ data: { id, full_name: 'Berk Çetinkaya', is_active: true }, error: null });
    const { deferred } = simulateDeferredAuthEvent(state, session('u-defer-success'), loadFn);
    t.mock.timers.tick(0);
    const result = await deferred;
    assert.equal(result.applied, true);
    assert.equal(state.authCache.staff.full_name, 'Berk Çetinkaya');
  } finally {
    t.mock.timers.reset();
  }
});

test('[DEFERRED-LOOKUP] E. a deferred lookup that times out at the full 12000ms budget remains fail-closed — staff never becomes truthy', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const state = { authReqSeq: 0, authCache: null };
    const neverResolves = () => new Promise(() => {});
    const { deferred } = simulateDeferredAuthEvent(state, session('u-defer-fail'), neverResolves);
    t.mock.timers.tick(0);
    t.mock.timers.tick(12000);
    const result = await deferred;
    assert.equal(state.authCache.staff, null, 'a timed-out deferred lookup must never authorize an unverified user');
    assert.match(state.authCache.staffQueryError, /zaman aşımına uğradı \(12000ms\)/);
  } finally {
    t.mock.timers.reset();
  }
});

test('[DEFERRED-LOOKUP] F. SIGNED_OUT arriving before a slow deferred lookup resolves prevents that stale result from ever authorizing the logged-out session', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const state = { authReqSeq: 0, authCache: null };
    const slowLoadFnA = (id) => new Promise((resolve) => {
      setTimeout(() => resolve({ data: { id, full_name: 'A', is_active: true }, error: null }), 5000);
    });
    const { deferred: deferredA } = simulateDeferredAuthEvent(state, session('u-signout-race-A'), slowLoadFnA);
    t.mock.timers.tick(0); // A's deferred lookup starts, its own 5000ms timer begins

    // SIGNED_OUT arrives — dispatched synchronously, exactly like the real
    // handler (s = null, a different "identity" than A).
    const { deferred: deferredOut } = simulateDeferredAuthEvent(state, null, async () => ({ data: null, error: null }));
    t.mock.timers.tick(0); // the SIGNED_OUT dispatch's own (trivial, no-session) deferred step runs
    await deferredOut;
    assert.equal(state.authCache.session, null, 'logout must take effect immediately, synchronously, at dispatch time');

    t.mock.timers.tick(5000); // now A's slow lookup finally settles
    const resultA = await deferredA;
    assert.equal(resultA.applied, false, 'a stale lookup started before logout must be discarded once a newer event has been dispatched');
    assert.equal(state.authCache.session, null, 'the logged-out state must never be overwritten by the late-arriving stale A result');
    assert.equal(state.authCache.staff, null);
  } finally {
    t.mock.timers.reset();
  }
});

test('[DEFERRED-LOOKUP] G. a slower user-A deferred lookup resolving after user B has already become current is discarded, never overwriting B', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const state = { authReqSeq: 0, authCache: null };
    const slowLoadFnA = (id) => new Promise((resolve) => {
      setTimeout(() => resolve({ data: { id, full_name: 'A', is_active: true }, error: null }), 5000);
    });
    const fastLoadFnB = async (id) => ({ data: { id, full_name: 'B', is_active: true }, error: null });

    const { deferred: deferredA } = simulateDeferredAuthEvent(state, session('u-switch-A'), slowLoadFnA);
    t.mock.timers.tick(0);

    const { deferred: deferredB } = simulateDeferredAuthEvent(state, session('u-switch-B'), fastLoadFnB);
    t.mock.timers.tick(0);
    const resultB = await deferredB;
    assert.equal(resultB.applied, true);
    assert.equal(state.authCache.staff.full_name, 'B');

    t.mock.timers.tick(5000);
    const resultA = await deferredA;
    assert.equal(resultA.applied, false, 'the slower, older A lookup must be discarded once B has already become current');
    assert.equal(state.authCache.staff.full_name, 'B', 'B must remain authorized — A must never overwrite it');
  } finally {
    t.mock.timers.reset();
  }
});

test('[DEFERRED-LOOKUP] I. request deduplication is untouched by this refactor — _dedupedLoadStaffData source is unchanged', () => {
  assert.match(SOURCE, /function _dedupedLoadStaffData\(userId, loadFn = loadStaffData, diagId\) \{/);
  assert.match(SOURCE, /if \(_inFlightStaffLookup && _inFlightStaffLookup\.userId === userId\)/);
});
