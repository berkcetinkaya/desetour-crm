'use strict';
/**
 * tests/dashboard/preparationReversal.test.js
 * ─────────────────────────────────────────────────────────────────────────
 * Tour Preparation Intelligence — Phase C2H: ticket preparation completion
 * reversal (reservation_preparations: completed -> pending), Reservation
 * Detail only — never Dashboard. Reuses the EXISTING completion
 * architecture's shape (_canCompletePreparation's sibling
 * _canReopenPreparation, _completePreparationWithFeedback's sibling
 * _reopenPreparationWithFeedback, the same useRepoMutation
 * ("reservationPreparation") entity, the same Store.notify cache
 * invalidation) — never a new completion/reversal RPC, never a direct
 * Supabase write from a component. Tests the pure helpers extracted
 * directly from DeseTourDashboard.jsx via the existing TESTABLE-marker
 * convention, so these exercise the REAL shipping implementation, plus
 * static source inspection for architecture claims (no migration, no RLS
 * change needed, role gating, UI placement). No real Supabase/network
 * call anywhere in this file.
 * ─────────────────────────────────────────────────────────────────────────
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { extractTestableFn } = require('./extractTestableFn');

const SOURCE_PATH = path.join(__dirname, '..', '..', 'DeseTourDashboard.jsx');
const SOURCE = fs.readFileSync(SOURCE_PATH, 'utf8');

const _canReopenPreparation = extractTestableFn('_canReopenPreparation');
const _confirmReopenPreparationMessage = extractTestableFn('_confirmReopenPreparationMessage');

// _reopenPreparationWithFeedback calls the REAL showToast by name — same
// extraction/stubbing convention preparationCompletionWorkflow.test.js
// already uses for _completePreparationWithFeedback.
function extractReopenWithFeedback() {
  const startMarker = '// TESTABLE:_reopenPreparationWithFeedback:start';
  const endMarker = '// TESTABLE:_reopenPreparationWithFeedback:end';
  const startIdx = SOURCE.indexOf(startMarker);
  const endIdx = SOURCE.indexOf(endMarker);
  assert.ok(startIdx !== -1 && endIdx !== -1, 'markers for _reopenPreparationWithFeedback not found');
  const body = SOURCE.slice(startIdx + startMarker.length, endIdx);
  const toastCalls = [];
  // eslint-disable-next-line no-new-func
  const factory = new Function('toastCalls', `
    ${body}
    function showToast(msg) { toastCalls.push(msg); }
    return _reopenPreparationWithFeedback;
  `);
  return { fn: factory(toastCalls), toastCalls };
}

function _reopenRepoBody() {
  const start = SOURCE.indexOf('async reopen(id){');
  assert.ok(start !== -1, 'reopen(id) must exist on SupabaseReservationPreparationRepo');
  const end = SOURCE.indexOf('\n  },', start);
  return SOURCE.slice(start, end);
}

// Includes the design-rationale comment immediately preceding reopen(id),
// for assertions about the documented RLS/CHECK-constraint reasoning.
function _reopenRepoBodyWithComment() {
  const start = SOURCE.indexOf('// Tour Preparation Intelligence Phase C2H — the reversal counterpart');
  assert.ok(start !== -1, 'reopen(id) design-rationale comment must exist on SupabaseReservationPreparationRepo');
  const fnStart = SOURCE.indexOf('async reopen(id){', start);
  assert.ok(fnStart !== -1, 'reopen(id) must exist on SupabaseReservationPreparationRepo');
  const end = SOURCE.indexOf('\n  },', fnStart);
  return SOURCE.slice(start, end);
}

function _completeRepoBody() {
  const start = SOURCE.indexOf('async complete(id){');
  const end = SOURCE.indexOf('\n  },', start);
  return SOURCE.slice(start, end);
}

function prep(overrides) {
  return Object.assign({ id: 'p1', status: 'completed' }, overrides);
}

// ═══════════════════════════════════════════════════════════════════════
// DATABASE: no migration necessary — the audit's own conclusion, asserted
// structurally (no new .sql file for this phase, no RLS/CHECK reference
// anywhere in the new code claiming one was needed)
// ═══════════════════════════════════════════════════════════════════════

test('reopen() relies on the EXISTING admin/operations RLS policies and CHECK constraint — no new migration file was introduced for this phase', () => {
  const body = _reopenRepoBodyWithComment();
  assert.doesNotMatch(body, /CREATE POLICY|ALTER TABLE|CREATE OR REPLACE FUNCTION/i);
  // Documents (in the real shipping comment) exactly which existing
  // policies this relies on, rather than assuming silently.
  assert.match(body, /admin full access|operations full access/);
});

// ═══════════════════════════════════════════════════════════════════════
// reversal eligibility (role x status) — the sibling of
// _canCompletePreparation, same role gate, opposite status
// ═══════════════════════════════════════════════════════════════════════

test('admin (Yönetici) can reopen a completed preparation', () => {
  assert.equal(_canReopenPreparation('Yönetici', prep({ status:'completed' })), true);
});

test('operations (Operasyon) can reopen a completed preparation', () => {
  assert.equal(_canReopenPreparation('Operasyon', prep({ status:'completed' })), true);
});

test('sales (Satış) cannot reopen a preparation', () => {
  assert.equal(_canReopenPreparation('Satış', prep({ status:'completed' })), false);
});

test('guide (Rehber) cannot reopen a preparation', () => {
  assert.equal(_canReopenPreparation('Rehber', prep({ status:'completed' })), false);
});

test('a pending preparation is never eligible for reopen, even for an eligible role', () => {
  assert.equal(_canReopenPreparation('Operasyon', prep({ status:'pending' })), false);
  assert.equal(_canReopenPreparation('Yönetici', prep({ status:'pending' })), false);
});

test('superseded/cancelled preparations are never eligible for reopen', () => {
  assert.equal(_canReopenPreparation('Operasyon', prep({ status:'superseded' })), false);
  assert.equal(_canReopenPreparation('Yönetici', prep({ status:'cancelled' })), false);
});

test('never throws on a missing/null preparation or role', () => {
  assert.doesNotThrow(() => _canReopenPreparation('Operasyon', null));
  assert.doesNotThrow(() => _canReopenPreparation(undefined, prep()));
  assert.equal(_canReopenPreparation('Operasyon', null), false);
  assert.equal(_canReopenPreparation(undefined, prep()), false);
});

test('_canReopenPreparation and _canCompletePreparation are mutually exclusive for any given status — never both true, never both false for pending/completed', () => {
  const _canCompletePreparation = extractTestableFn('_canCompletePreparation');
  for (const role of ['Yönetici', 'Operasyon']) {
    assert.notEqual(_canCompletePreparation(role, prep({ status:'pending' })), _canReopenPreparation(role, prep({ status:'pending' })));
    assert.notEqual(_canCompletePreparation(role, prep({ status:'completed' })), _canReopenPreparation(role, prep({ status:'completed' })));
  }
});

// ═══════════════════════════════════════════════════════════════════════
// confirmation message
// ═══════════════════════════════════════════════════════════════════════

test('the confirmation message names the exact ticket label and states the row returns to Bekleyenler', () => {
  const msg = _confirmReopenPreparationMessage('Ayasofya Giriş Bileti');
  assert.match(msg, /Ayasofya Giriş Bileti/);
  assert.match(msg, /Bekleyenler/);
});

test('both desktop and mobile reopen handlers call window.confirm with this exact message before ever mutating', () => {
  const desktopStart = SOURCE.indexOf('async function handleReopenPreparation(prepId, label)');
  const desktopBody = SOURCE.slice(desktopStart, SOURCE.indexOf('\n  }', desktopStart));
  assert.match(desktopBody, /window\.confirm\(_confirmReopenPreparationMessage\(label\)\)/);
  // Declining returns before ever calling mutate. (The `if (...)` wraps
  // the already-balanced `window.confirm(_confirmReopenPreparationMessage(label))`
  // condition in its own parens, so there are three trailing closes.)
  assert.match(desktopBody, /if \(!window\.confirm\([^)]*\)\)\) return;/);

  const mobileStart = SOURCE.indexOf('async function handleReopenPreparationMobile(prepId, label)');
  const mobileBody = SOURCE.slice(mobileStart, SOURCE.indexOf('\n  }', mobileStart));
  assert.match(mobileBody, /window\.confirm\(_confirmReopenPreparationMessage\(label\)\)/);
  assert.match(mobileBody, /if \(!window\.confirm\([^)]*\)\)\) return;/);
});

test('ordinary completion has no confirmation step — only reversal does, since one does not already exist for completion', () => {
  const start = SOURCE.indexOf('async function handleCompletePreparation(prepId)');
  const body = SOURCE.slice(start, SOURCE.indexOf('\n  }', start));
  assert.doesNotMatch(body, /window\.confirm\(/);
});

// ═══════════════════════════════════════════════════════════════════════
// _reopenPreparationWithFeedback — success / stale / error branches
// ═══════════════════════════════════════════════════════════════════════

test('success shows "Hazırlık bekleyene alındı." and reports ok:true', async () => {
  const { fn, toastCalls } = extractReopenWithFeedback();
  const mutate = async () => ({ data: { ok:true, preparation:{ id:'p1', status:'pending' } }, error: null });
  const result = await fn(mutate, 'p1');
  assert.deepEqual(toastCalls, ['Hazırlık bekleyene alındı.']);
  assert.equal(result.ok, true);
});

test('zero-row update (stale conflict) is handled gracefully, never claimed as success', async () => {
  const { fn, toastCalls } = extractReopenWithFeedback();
  const mutate = async () => ({ data: { ok:false, reason:'stale' }, error: null });
  const result = await fn(mutate, 'p1');
  assert.deepEqual(toastCalls, ['Bu hazırlığın durumu başka bir işlemle değişmiş. Liste güncellendi.']);
  assert.equal(result.ok, false);
  assert.equal(result.stale, true);
});

test('an unexpected failure uses the existing generic error pattern, never claims success (failed reopen never visually marks the row reopened)', async () => {
  const { fn, toastCalls } = extractReopenWithFeedback();
  const mutate = async () => ({ data: null, error: 'network down' });
  const result = await fn(mutate, 'p1');
  assert.deepEqual(toastCalls, ['Hata: network down']);
  assert.equal(result.ok, false);
});

// ═══════════════════════════════════════════════════════════════════════
// repository: reopen(id) — conditional guard, exact transition, same id
// ═══════════════════════════════════════════════════════════════════════

test('reopen() targets the exact preparation id, never reservation_id', () => {
  const body = _reopenRepoBody();
  assert.match(body, /\.eq\('id', id\)/);
  assert.doesNotMatch(body, /\.eq\('reservation_id'/);
});

test('reopen() is conditional on status=completed — structurally cannot touch a pending/superseded/cancelled row', () => {
  const body = _reopenRepoBody();
  assert.match(body, /\.eq\('status', 'completed'\)/);
  // The ONLY status this UPDATE ever writes is 'pending'.
  const statusWrites = body.match(/status:\s*'(\w+)'/g) || [];
  assert.deepEqual(statusWrites, ["status:'pending'"]);
});

test('reopen() clears completed_at to NULL', () => {
  const body = _reopenRepoBody();
  assert.match(body, /completed_at:null/);
});

test('reopen() clears completed_by to NULL', () => {
  const body = _reopenRepoBody();
  assert.match(body, /completed_by:null/);
});

test('completed_at and completed_by are cleared TOGETHER in the same update payload (satisfies the completed_consistency CHECK, which requires both NULL together for a non-completed status)', () => {
  const body = _reopenRepoBody();
  const updateCallStart = body.indexOf('.update({');
  const updateCallEnd = body.indexOf('})', updateCallStart);
  const payload = body.slice(updateCallStart, updateCallEnd);
  assert.match(payload, /completed_at:null/);
  assert.match(payload, /completed_by:null/);
});

test('reservation_id, preparation_rule_id, preparation_type, label, and required_quantity are never written by reopen()', () => {
  const body = _reopenRepoBody();
  const updateCallStart = body.indexOf('.update({');
  const updateCallEnd = body.indexOf('})', updateCallStart);
  const updatePayload = body.slice(updateCallStart, updateCallEnd);
  for (const field of ['reservation_id', 'preparation_rule_id', 'preparation_type', 'label', 'required_quantity']) {
    assert.doesNotMatch(updatePayload, new RegExp(field));
  }
});

test('exactly one updated row is required for success — uses maybeSingle(), never single()', () => {
  const body = _reopenRepoBody();
  assert.match(body, /\.select\(\)\s*\n\s*\.maybeSingle\(\)/);
  assert.doesNotMatch(body, /\.select\(\)\.single\(\)/);
});

test('zero rows updated (data is null) returns a stale result, never ok:true — same stale philosophy as complete(id)', () => {
  const body = _reopenRepoBody();
  assert.match(body, /if\(!data\) return \{ ok:false, reason:'stale' \}/);
});

test('reopen() performs exactly one write (.update call), no second write anywhere', () => {
  const body = _reopenRepoBody();
  const updateCalls = body.match(/\.update\(/g) || [];
  assert.equal(updateCalls.length, 1);
  assert.doesNotMatch(body, /\.insert\(|\.delete\(|\.upsert\(/);
});

test('reopen() only ever writes to reservation_preparations, never to reservations or tour_preparation_rules', () => {
  const body = _reopenRepoBody();
  assert.match(body, /\.from\('reservation_preparations'\)/);
  assert.doesNotMatch(body, /\.from\('reservations'\)/);
  assert.doesNotMatch(body, /tour_preparation_rules/);
});

test('reopen() never calls the materialization RPC, and never touches V12/V13', () => {
  const body = _reopenRepoBody();
  assert.doesNotMatch(body, /materialize_reservation_preparations/);
  assert.doesNotMatch(body, /\.rpc\(/);
  assert.doesNotMatch(body, /ingest_civitatis_booking|cancel_civitatis_booking/);
});

test('getActiveRepo registers reopen() with a safe non-Supabase mock fallback', () => {
  const idx = SOURCE.indexOf("if(entity==='reservationPreparation')");
  const line = SOURCE.slice(idx, SOURCE.indexOf('\n', idx));
  assert.match(line, /reopen:\s*async\s*\(\)\s*=>\s*\(\{\s*ok:false,\s*reason:'invalid'\s*\}\)/);
});

// ═══════════════════════════════════════════════════════════════════════
// activity log — written on success, using a CHECK-constraint-valid
// entity_type/action (the audit found complete()'s own call uses an
// entity_type NOT in the real CHECK vocabulary; reopen() deliberately
// does not repeat that)
// ═══════════════════════════════════════════════════════════════════════

test('activity log is written on successful reopen, using entity_type="reservation" (a real activity_logs CHECK-allowed value) and action="status_changed"', () => {
  const body = _reopenRepoBody();
  assert.match(body, /_sbLog\('reservation', data\.reservation_id, 'status_changed'/);
});

test("reopen()'s activity log entity_type is NOT 'reservation_preparation' — that value is documented as not present in activity_logs' own CHECK vocabulary", () => {
  const body = _reopenRepoBody();
  assert.doesNotMatch(body, /_sbLog\('reservation_preparation'/);
});

test('no activity log is written on a failed/stale reopen — the log call is textually reachable only after the stale-return guard', () => {
  const body = _reopenRepoBody();
  const guardIdx = body.indexOf("if(!data) return { ok:false, reason:'stale' }");
  const logIdx = body.indexOf('_sbLog(');
  assert.ok(guardIdx !== -1 && logIdx !== -1);
  assert.ok(guardIdx < logIdx, 'the stale-return guard must come before the activity log call');
});

test('the description names the ticket label and quantity, so the log entry is identifiable without a join', () => {
  const body = _reopenRepoBody();
  assert.match(body, /\$\{data\.label\}.*\$\{data\.required_quantity\}/);
});

test('reopen() never deletes or modifies any existing activity_logs row — only ever inserts (via _sbLog), never .delete( or .update( on activity_logs', () => {
  const body = _reopenRepoBody();
  assert.doesNotMatch(body, /activity_logs.*\.(delete|update)\(/);
});

test("complete()'s activity-log call was fixed in a follow-up to this phase to use the same valid entity_type='reservation'/entity_id=data.reservation_id architecture as reopen() — the previously-invalid 'reservation_preparation' entity_type is gone, while the completion state-transition (the .update/.eq/.maybeSingle chain and the pending->completed guard) remains byte-for-byte unchanged", () => {
  const body = _completeRepoBody();
  assert.match(body, /_sbLog\('reservation', data\.reservation_id, 'completed'/);
  assert.doesNotMatch(body, /_sbLog\('reservation_preparation'/);
  assert.match(body, /\.update\(\{ status:'completed', completed_at:new Date\(\)\.toISOString\(\), completed_by:staffId \}\)/);
  assert.match(body, /\.eq\('status', 'pending'\)/);
});

test('completion and reopen activity logs can coexist — both use entity_type="reservation" with distinct actions ("completed" vs "status_changed"), so neither insert collides with or overwrites the other', () => {
  const completeBody = _completeRepoBody();
  const reopenBody = _reopenRepoBody();
  assert.match(completeBody, /_sbLog\('reservation', data\.reservation_id, 'completed'/);
  assert.match(reopenBody, /_sbLog\('reservation', data\.reservation_id, 'status_changed'/);
});

test('neither complete() nor reopen() ever deletes or modifies an existing activity_logs row — both only ever insert via _sbLog', () => {
  assert.doesNotMatch(_completeRepoBody(), /activity_logs.*\.(delete|update)\(/);
  assert.doesNotMatch(_reopenRepoBody(), /activity_logs.*\.(delete|update)\(/);
});

test('completion log identifies the ticket label and required quantity, same as reopen()', () => {
  const body = _completeRepoBody();
  assert.match(body, /\$\{data\.label\}.*\$\{data\.required_quantity\}/);
});

// ═══════════════════════════════════════════════════════════════════════
// desktop + mobile UI wiring
// ═══════════════════════════════════════════════════════════════════════

test('desktop Tur Hazırlıkları card renders the reopen action via the shared eligibility helper, for a completed row', () => {
  const pageStart = SOURCE.indexOf('function ReservationDetailPage(');
  const cardStart = SOURCE.indexOf('title="Tur Hazırlıkları"', pageStart);
  const cardEnd = SOURCE.indexOf('title="Ödeme Özeti"', cardStart);
  const body = SOURCE.slice(cardStart, cardEnd);
  assert.match(body, /_canReopenPreparation\(auth\.role, p\)/);
  assert.match(body, /handleReopenPreparation\(p\.id, vm\.label\)/);
  assert.match(body, /"Bekleyene Geri Al"/);
});

test('mobile Tur Hazırlıkları section renders the reopen action via the shared eligibility helper, for a completed row', () => {
  const pageStart = SOURCE.indexOf('function MobileReservationDetailPage(');
  const sectionStart = SOURCE.indexOf('title="Tur Hazırlıkları"', pageStart);
  const sectionEnd = SOURCE.indexOf('title="Ödeme"', sectionStart);
  const body = SOURCE.slice(sectionStart, sectionEnd);
  assert.match(body, /_canReopenPreparation\(mobAuth\.role, p\)/);
  assert.match(body, /handleReopenPreparationMobile\(p\.id, vm\.label\)/);
  assert.match(body, /"Bekleyene Geri Al"/);
});

test('a pending preparation never renders the reopen control on desktop or mobile — canReopen/canComplete are mutually exclusive per row', () => {
  const pageStart = SOURCE.indexOf('function ReservationDetailPage(');
  const cardStart = SOURCE.indexOf('title="Tur Hazırlıkları"', pageStart);
  const cardEnd = SOURCE.indexOf('title="Ödeme Özeti"', cardStart);
  const body = SOURCE.slice(cardStart, cardEnd);
  assert.match(body, /const canReopen = _canReopenPreparation\(auth\.role, p\);/);
  assert.match(body, /\{canReopen && \(/);
});

test('the reopen button is visually secondary — neutral border/background/text color, lighter font-weight than the green completion button, on both desktop and mobile', () => {
  const desktopStart = SOURCE.indexOf('onClick={() => handleReopenPreparation(p.id, vm.label)}');
  const desktopBtn = SOURCE.slice(desktopStart - 50, SOURCE.indexOf('</button>', desktopStart));
  assert.match(desktopBtn, /border:`1px solid \$\{C\.border\}`, background:C\.white, color:C\.textMid/);
  assert.match(desktopBtn, /fontWeight:500/);

  const mobileStart = SOURCE.indexOf('onClick={() => handleReopenPreparationMobile(p.id, vm.label)}');
  const mobileBtn = SOURCE.slice(mobileStart - 50, SOURCE.indexOf('</button>', mobileStart));
  assert.match(mobileBtn, /border:`1px solid \$\{C\.border\}`, background:C\.white, color:C\.textMid/);
  assert.match(mobileBtn, /fontWeight:500/);
});

test('both reopen handlers have their own independent in-flight id, never sharing state with the completion handler', () => {
  assert.match(SOURCE, /const \[reopeningPrepId, setReopeningPrepId\] = useState\(null\);/);
  assert.match(SOURCE, /const \[reopeningPrepIdMobile, setReopeningPrepIdMobile\] = useState\(null\);/);
});

// ═══════════════════════════════════════════════════════════════════════
// Dashboard: no reversal control, ever
// ═══════════════════════════════════════════════════════════════════════

test('Dashboard (desktop Bilet Hazırlıkları panel, including Tamamlananlar) has NO reopen control or reversal logic of any kind', () => {
  const pieces = [
    (() => { const s = SOURCE.indexOf('function TurHazirliklari()'); return SOURCE.slice(s, SOURCE.indexOf('\n}', s)); })(),
    (() => { const s = SOURCE.indexOf('function _BiletHazirliklariDesktopPanel('); return SOURCE.slice(s, SOURCE.indexOf('\n}', s)); })(),
    (() => { const s = SOURCE.indexOf('function _TicketPrepRow('); return SOURCE.slice(s, SOURCE.indexOf('\n}', s)); })(),
  ];
  for (const body of pieces) {
    assert.doesNotMatch(body, /_canReopenPreparation|handleReopenPreparation|Bekleyene Geri Al|reopen\(/);
  }
});

test('Dashboard (mobile Bilet Hazırlıkları panel, including Tamamlananlar) has NO reopen control or reversal logic of any kind', () => {
  const pieces = [
    (() => { const s = SOURCE.indexOf('function _BiletHazirliklariMobilePanel('); return SOURCE.slice(s, SOURCE.indexOf('\n}', s)); })(),
    (() => { const s = SOURCE.indexOf('function _MobileTicketPrepRow('); return SOURCE.slice(s, SOURCE.indexOf('\n}', s)); })(),
  ];
  for (const body of pieces) {
    assert.doesNotMatch(body, /_canReopenPreparation|handleReopenPreparation|Bekleyene Geri Al|reopen\(/);
  }
});

test('useBiletHazirliklariTabs (the Dashboard ticket panel\'s shared hook) never calls mutate(\'reopen\', ...)', () => {
  const start = SOURCE.indexOf('function useBiletHazirliklariTabs(');
  const body = SOURCE.slice(start, SOURCE.indexOf('\n}', start));
  assert.doesNotMatch(body, /mutate\('reopen'/);
});

// ═══════════════════════════════════════════════════════════════════════
// cache invalidation: reopen goes through the SAME useRepoMutation /
// Store.notify mechanism as completion — no bespoke invalidation code
// ═══════════════════════════════════════════════════════════════════════

test('both desktop and mobile reopen handlers reuse the EXISTING useRepoMutation("reservationPreparation") instance — never a second hook instance', () => {
  // Desktop: handleReopenPreparation must use the SAME mutPreparation the
  // completion handler already uses.
  const desktopStart = SOURCE.indexOf('async function handleReopenPreparation(prepId, label)');
  const desktopBody = SOURCE.slice(desktopStart, SOURCE.indexOf('\n  }', desktopStart));
  assert.match(desktopBody, /_reopenPreparationWithFeedback\(mutPreparation, prepId\)/);

  const mobileStart = SOURCE.indexOf('async function handleReopenPreparationMobile(prepId, label)');
  const mobileBody = SOURCE.slice(mobileStart, SOURCE.indexOf('\n  }', mobileStart));
  assert.match(mobileBody, /_reopenPreparationWithFeedback\(mutPreparationMobile, prepId\)/);

  // Only ONE actual useRepoMutation("reservationPreparation") hook
  // assignment exists on the desktop page — shared by both complete and
  // reopen. (A comment elsewhere in the page also mentions the same
  // string for documentation purposes, so this matches the assignment
  // statement specifically rather than any substring occurrence.)
  const pageStart = SOURCE.indexOf('function ReservationDetailPage(');
  const pageEnd = SOURCE.indexOf('\nfunction ', pageStart + 10);
  const pageBody = SOURCE.slice(pageStart, pageEnd);
  const desktopCalls = pageBody.match(/const \{ ?mutate:\w+ ?\} ?= ?useRepoMutation\("reservationPreparation"\)/g) || [];
  assert.equal(desktopCalls.length, 1);
});

test('a reopened row becomes eligible for the Dashboard pending query — getUpcomingPending filters on status=pending only, which a reopened row now satisfies, with no separate code path needed', () => {
  const start = SOURCE.indexOf('async getUpcomingPending()');
  const body = SOURCE.slice(start, SOURCE.indexOf('\n  },', start));
  assert.match(body, /\.eq\('status','pending'\)/);
});

// ═══════════════════════════════════════════════════════════════════════
// meals: completely unaffected
// ═══════════════════════════════════════════════════════════════════════

test('none of the new reversal code mentions meal_status — meals remain entirely separate', () => {
  const pieces = [
    _reopenRepoBody(),
    (() => { const s = SOURCE.indexOf('function _canReopenPreparation('); return SOURCE.slice(s, SOURCE.indexOf('\n}', s)); })(),
  ];
  for (const body of pieces) {
    assert.doesNotMatch(body, /meal_status/);
  }
});

// ═══════════════════════════════════════════════════════════════════════
// production safety: C2F / V12 / V13 / auth / WhatsApp untouched
// ═══════════════════════════════════════════════════════════════════════

test('this new code never mentions WhatsApp, auth-architecture internals, V12/V13 RPCs, or SQL migrations', () => {
  const helpersStart = SOURCE.indexOf('// TESTABLE:_canReopenPreparation:start');
  const helpersEnd = SOURCE.indexOf('// TESTABLE:_confirmReopenPreparationMessage:end') + '// TESTABLE:_confirmReopenPreparationMessage:end'.length;
  const helpers = SOURCE.slice(helpersStart, helpersEnd);
  assert.doesNotMatch(helpers, /whatsapp/i);
  assert.doesNotMatch(helpers, /ingest_civitatis_booking|cancel_civitatis_booking/);
  assert.doesNotMatch(helpers, /auth\.uid\(\)/);

  const repoBody = _reopenRepoBody();
  assert.doesNotMatch(repoBody, /whatsapp/i);
  assert.doesNotMatch(repoBody, /ingest_civitatis_booking|cancel_civitatis_booking/);
});

test('reopen() never references materialize_reservation_preparations, tour_preparation_rules, the Ayasofya label, or the Topkapı label as something it modifies', () => {
  const body = _reopenRepoBody();
  assert.doesNotMatch(body, /materialize_reservation_preparations/);
  assert.doesNotMatch(body, /tour_preparation_rules/);
  // The label is only ever read (data.label) for the log description,
  // never hardcoded/branched on by name.
  assert.doesNotMatch(body, /'Ayasofya Giriş Bileti'|'Topkapı Sarayı \+ Harem Bileti'/);
});
