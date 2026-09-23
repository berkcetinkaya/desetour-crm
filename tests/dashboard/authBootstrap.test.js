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
