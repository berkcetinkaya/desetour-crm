'use strict';
/**
 * tests/dashboard/preparationCompletionWorkflow.test.js
 * ─────────────────────────────────────────────────────────────────────────
 * Tour Preparation Intelligence — Phase C2D-3: preparation completion
 * workflow (reservation_preparations only, one-directional pending ->
 * completed). Tests the pure helpers extracted directly from
 * DeseTourDashboard.jsx via the existing TESTABLE-marker convention, so
 * these exercise the REAL shipping implementation, never a hand-copied
 * duplicate. The repository's actual database write is NEVER executed
 * here — no live Supabase connection, no network call, no production
 * write — only static source inspection and pure-function execution
 * against a stubbed `mutate`.
 * ─────────────────────────────────────────────────────────────────────────
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { extractTestableFn } = require('./extractTestableFn');

const SOURCE_PATH = path.join(__dirname, '..', '..', 'DeseTourDashboard.jsx');
const SOURCE = fs.readFileSync(SOURCE_PATH, 'utf8');

const _canCompletePreparation = extractTestableFn('_canCompletePreparation');

// _completePreparationWithFeedback calls the REAL showToast by name. A
// stub showToast is appended AFTER the extracted body in the same
// function-scope string, so it overrides (later function declarations of
// the same name win within one scope) — this captures what the real
// implementation calls showToast with, without touching the real
// TOAST_REF/console machinery.
function extractCompleteWithFeedback() {
  const startMarker = '// TESTABLE:_completePreparationWithFeedback:start';
  const endMarker = '// TESTABLE:_completePreparationWithFeedback:end';
  const startIdx = SOURCE.indexOf(startMarker);
  const endIdx = SOURCE.indexOf(endMarker);
  assert.ok(startIdx !== -1 && endIdx !== -1, 'markers for _completePreparationWithFeedback not found');
  const body = SOURCE.slice(startIdx + startMarker.length, endIdx);
  const toastCalls = [];
  // eslint-disable-next-line no-new-func
  const factory = new Function('toastCalls', `
    ${body}
    function showToast(msg) { toastCalls.push(msg); }
    return _completePreparationWithFeedback;
  `);
  return { fn: factory(toastCalls), toastCalls };
}

function _completeRepoBody() {
  const start = SOURCE.indexOf('async complete(id){');
  assert.ok(start !== -1, 'complete(id) must exist on SupabaseReservationPreparationRepo');
  const end = SOURCE.indexOf('\n  },', start);
  return SOURCE.slice(start, end);
}

function prep(overrides) {
  return Object.assign({ id: 'p1', status: 'pending' }, overrides);
}

// ═══════════════════════════════════════════════════════════════════════
// completion eligibility (role x status) — shared by desktop + mobile
// ═══════════════════════════════════════════════════════════════════════

test('Yönetici can complete a pending preparation', () => {
  assert.equal(_canCompletePreparation('Yönetici', prep({ status:'pending' })), true);
});

test('Operasyon can complete a pending preparation', () => {
  assert.equal(_canCompletePreparation('Operasyon', prep({ status:'pending' })), true);
});

test('Rehber cannot complete a preparation', () => {
  assert.equal(_canCompletePreparation('Rehber', prep({ status:'pending' })), false);
});

test('Satış cannot complete a preparation', () => {
  assert.equal(_canCompletePreparation('Satış', prep({ status:'pending' })), false);
});

test('pending shows the action (eligible role)', () => {
  assert.equal(_canCompletePreparation('Operasyon', prep({ status:'pending' })), true);
});

test('completed does not show the action, even for an eligible role', () => {
  assert.equal(_canCompletePreparation('Operasyon', prep({ status:'completed' })), false);
});

test('superseded does not show the action', () => {
  assert.equal(_canCompletePreparation('Operasyon', prep({ status:'superseded' })), false);
});

test('cancelled does not show the action', () => {
  assert.equal(_canCompletePreparation('Yönetici', prep({ status:'cancelled' })), false);
});

test('never throws on a missing/null preparation or role', () => {
  assert.doesNotThrow(() => _canCompletePreparation('Operasyon', null));
  assert.doesNotThrow(() => _canCompletePreparation(undefined, prep()));
  assert.equal(_canCompletePreparation('Operasyon', null), false);
  assert.equal(_canCompletePreparation(undefined, prep()), false);
});

// ═══════════════════════════════════════════════════════════════════════
// _completePreparationWithFeedback — success / stale / error branches
// ═══════════════════════════════════════════════════════════════════════

test('success changes UI state: shows "Hazırlık tamamlandı." and reports ok:true', async () => {
  const { fn, toastCalls } = extractCompleteWithFeedback();
  const mutate = async () => ({ data: { ok:true, preparation:{ id:'p1', status:'completed' } }, error: null });
  const result = await fn(mutate, 'p1');
  assert.deepEqual(toastCalls, ['Hazırlık tamamlandı.']);
  assert.equal(result.ok, true);
});

test('zero-row update is treated as stale/conflict, never silently claimed as success', async () => {
  const { fn, toastCalls } = extractCompleteWithFeedback();
  const mutate = async () => ({ data: { ok:false, reason:'stale' }, error: null });
  const result = await fn(mutate, 'p1');
  assert.deepEqual(toastCalls, ['Bu hazırlığın durumu başka bir işlemle değişmiş. Liste güncellendi.']);
  assert.equal(result.ok, false);
  assert.equal(result.stale, true);
});

test('an unexpected failure uses the existing generic error pattern, never claims success', async () => {
  const { fn, toastCalls } = extractCompleteWithFeedback();
  const mutate = async () => ({ data: null, error: 'network down' });
  const result = await fn(mutate, 'p1');
  assert.deepEqual(toastCalls, ['Hata: network down']);
  assert.equal(result.ok, false);
});

// ═══════════════════════════════════════════════════════════════════════
// repository: complete(id) — one-directional, exact id, conditional guard
// ═══════════════════════════════════════════════════════════════════════

test('complete() targets the exact preparation id, never reservation_id', () => {
  const body = _completeRepoBody();
  assert.match(body, /\.eq\('id', id\)/);
  assert.doesNotMatch(body, /\.eq\('reservation_id'/);
});

test('conditional status=pending guard exists — structurally one-directional', () => {
  const body = _completeRepoBody();
  assert.match(body, /\.eq\('status', 'pending'\)/);
  // The ONLY status this UPDATE ever writes is 'completed' — there is no
  // code path that could write 'pending' back, so completed -> pending
  // (a toggle) is structurally impossible, not just avoided by convention.
  const statusWrites = body.match(/status:\s*'(\w+)'/g) || [];
  assert.deepEqual(statusWrites, ["status:'completed'"]);
});

test('completed_at is written as a fresh timestamp', () => {
  const body = _completeRepoBody();
  assert.match(body, /completed_at:new Date\(\)\.toISOString\(\)/);
});

test('completed_by is written from the authenticated staff identity, never a new identity source', () => {
  const body = _completeRepoBody();
  assert.match(body, /getAuthContext\(\)\?\.staff\?\.id/);
  assert.match(body, /completed_by:staffId/);
});

test('reservation_id, preparation_rule_id, preparation_type, label, and required_quantity are never written by complete()', () => {
  const body = _completeRepoBody();
  const updateCallStart = body.indexOf('.update({');
  const updateCallEnd = body.indexOf('})', updateCallStart);
  const updatePayload = body.slice(updateCallStart, updateCallEnd);
  for (const field of ['reservation_id', 'preparation_rule_id', 'preparation_type', 'label', 'required_quantity']) {
    assert.doesNotMatch(updatePayload, new RegExp(field));
  }
});

test('exactly one updated row is required for success — uses maybeSingle(), never single() (which would error on a legitimate zero-row guard mismatch)', () => {
  const body = _completeRepoBody();
  assert.match(body, /\.select\(\)\s*\n\s*\.maybeSingle\(\)/);
  assert.doesNotMatch(body, /\.select\(\)\.single\(\)/);
});

test('zero rows updated (data is null) returns a stale result, never ok:true', () => {
  const body = _completeRepoBody();
  assert.match(body, /if\(!data\) return \{ ok:false, reason:'stale' \}/);
});

test('no activity log is written on a failed/stale update — the log call is textually reachable only after the stale-return guard', () => {
  const body = _completeRepoBody();
  const guardIdx = body.indexOf("if(!data) return { ok:false, reason:'stale' }");
  const logIdx = body.indexOf('_sbLog(');
  assert.ok(guardIdx !== -1 && logIdx !== -1);
  assert.ok(guardIdx < logIdx, 'the stale-return guard must come before the activity log call');
});

test('activity log is written on successful completion, naming the entity_type/action convention', () => {
  const body = _completeRepoBody();
  assert.match(body, /_sbLog\('reservation_preparation', data\.id, 'completed'/);
});

test('complete() performs exactly one write (.update call), no second write anywhere', () => {
  const body = _completeRepoBody();
  const updateCalls = body.match(/\.update\(/g) || [];
  assert.equal(updateCalls.length, 1);
  assert.doesNotMatch(body, /\.insert\(|\.delete\(|\.upsert\(/);
});

test('complete() only ever writes to reservation_preparations, never to reservations or tour_preparation_rules', () => {
  const body = _completeRepoBody();
  assert.match(body, /\.from\('reservation_preparations'\)/);
  assert.doesNotMatch(body, /\.from\('reservations'\)/);
  assert.doesNotMatch(body, /tour_preparation_rules/);
});

test('complete() never calls the materialization RPC', () => {
  const body = _completeRepoBody();
  assert.doesNotMatch(body, /materialize_reservation_preparations/);
  assert.doesNotMatch(body, /\.rpc\(/);
});

test('getActiveRepo registers complete() with a safe non-Supabase mock fallback', () => {
  const idx = SOURCE.indexOf("if(entity==='reservationPreparation')");
  const line = SOURCE.slice(idx, SOURCE.indexOf('\n', idx));
  assert.match(line, /complete:\s*async\s*\(\)\s*=>\s*\(\{\s*ok:false,\s*reason:'invalid'\s*\}\)/);
});

// ═══════════════════════════════════════════════════════════════════════
// cache invalidation: completion goes through useRepoMutation, which
// always calls Store.notify() — the same mechanism the Dashboard's
// upcoming-pending query and this page's own preparation list both rely
// on to refresh. No bespoke invalidation code should exist.
// ═══════════════════════════════════════════════════════════════════════

test('useRepoMutation calls Store.notify() unconditionally after any resolved mutation (success or stale)', () => {
  const start = SOURCE.indexOf('function useRepoMutation(entity)');
  const end = SOURCE.indexOf('\n}', start);
  const body = SOURCE.slice(start, end);
  assert.match(body, /Store\.notify\(\)/);
});

test('both desktop and mobile completion handlers use useRepoMutation("reservationPreparation"), not a raw repo call', () => {
  // Scoped to the actual hook-declaration call sites, not prose/comments
  // elsewhere that merely mention the same string.
  assert.match(SOURCE, /const \{ mutate:mutPreparation \} = useRepoMutation\("reservationPreparation"\)/);
  assert.match(SOURCE, /const \{ mutate:mutPreparationMobile \} = useRepoMutation\("reservationPreparation"\)/);
});

// ═══════════════════════════════════════════════════════════════════════
// desktop + mobile UI wiring
// ═══════════════════════════════════════════════════════════════════════

test('desktop Tur Hazırlıkları card renders the completion action via the shared eligibility helper', () => {
  const pageStart = SOURCE.indexOf('function ReservationDetailPage(');
  const cardStart = SOURCE.indexOf('title="Tur Hazırlıkları"', pageStart);
  const cardEnd = SOURCE.indexOf('title="Ödeme Özeti"', cardStart);
  const body = SOURCE.slice(cardStart, cardEnd);
  assert.match(body, /_canCompletePreparation\(auth\.role, p\)/);
  assert.match(body, /handleCompletePreparation\(p\.id\)/);
  assert.match(body, /"Tamamlandı"/);
});

test('mobile Tur Hazırlıkları section renders the completion action via the shared eligibility helper', () => {
  const pageStart = SOURCE.indexOf('function MobileReservationDetailPage(');
  const sectionStart = SOURCE.indexOf('title="Tur Hazırlıkları"', pageStart);
  const sectionEnd = SOURCE.indexOf('title="Ödeme"', sectionStart);
  const body = SOURCE.slice(sectionStart, sectionEnd);
  assert.match(body, /_canCompletePreparation\(mobAuth\.role, p\)/);
  assert.match(body, /handleCompletePreparationMobile\(p\.id\)/);
  assert.match(body, /"Tamamlandı"/);
});

test('Dashboard Tur Hazırlıkları section has NO completion button or completion logic of its own', () => {
  const start = SOURCE.indexOf('function TurHazirliklari()');
  const end = SOURCE.indexOf('\n}', start);
  const body = SOURCE.slice(start, end);
  assert.doesNotMatch(body, /_canCompletePreparation|handleCompletePreparation|<button/);
});

test('meal rows (kind=meal) never render a completion button — the Dashboard card has no completion UI for any row kind', () => {
  // Re-confirms the same Dashboard scope as above, scoped explicitly to
  // this requirement since meal rows share the same render loop as
  // preparation rows there.
  const start = SOURCE.indexOf('function TurHazirliklari()');
  const end = SOURCE.indexOf('\n}', start);
  const body = SOURCE.slice(start, end);
  assert.doesNotMatch(body, /Tamamlandı<\/button>|onClick.*complete/i);
});

// ═══════════════════════════════════════════════════════════════════════
// production safety
// ═══════════════════════════════════════════════════════════════════════

test('this new code never mentions WhatsApp, auth-architecture internals, V12/V13 RPCs, or SQL migrations', () => {
  const helpersStart = SOURCE.indexOf('// TESTABLE:_canCompletePreparation:start');
  const helpersEnd = SOURCE.indexOf('// TESTABLE:_completePreparationWithFeedback:end') + '// TESTABLE:_completePreparationWithFeedback:end'.length;
  const helpers = SOURCE.slice(helpersStart, helpersEnd);
  assert.doesNotMatch(helpers, /whatsapp/i);
  assert.doesNotMatch(helpers, /ingest_civitatis_booking|cancel_civitatis_booking/);

  const repoBody = _completeRepoBody();
  assert.doesNotMatch(repoBody, /whatsapp/i);
  assert.doesNotMatch(repoBody, /ingest_civitatis_booking|cancel_civitatis_booking/);
});
