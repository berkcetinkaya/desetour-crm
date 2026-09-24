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

const resolveStaffState = extractCombined(['_withTimeout', '_resolveStaffState']);
const computeAuthResolution = extractCombined(['_computeAuthResolution']);

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
test('a staff lookup slower than the 12000ms budget resolves with a timeout error instead of hanging', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const neverResolves = () => new Promise(() => {});
    const promise = resolveStaffState(session('u1'), neverResolves);
    t.mock.timers.tick(12000);
    const result = await promise;
    assert.match(result.staffQueryError, /zaman aşımına uğradı \(12000ms\)/);
    assert.equal(result.staff, null);
    // The session itself must be preserved — a slow profile lookup is not a logout.
    assert.equal(result.session.user.id, 'u1');
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
  const loginIdx = SOURCE.indexOf('async function login(email, password)');
  assert.ok(useAuthIdx !== -1 && loginIdx !== -1 && loginIdx > useAuthIdx);
  const body = SOURCE.slice(useAuthIdx, loginIdx);
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
  assert.match(SOURCE, /_withTimeout\(loadFn\(s\.user\.id\), 12000, 'Personel profili'\)/);
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
