'use strict';
/**
 * tests/dashboard/reservationPreparationsUI.test.js
 * ─────────────────────────────────────────────────────────────────────────
 * Tour Preparation Intelligence — Phase C2D-1: Reservation Detail "Tur
 * Hazırlıkları" (read-only). Tests the pure helpers extracted directly
 * from DeseTourDashboard.jsx via the existing TESTABLE-marker convention
 * (see tests/dashboard/extractTestableFn.js / reservationMealStatus.test.js),
 * so these exercise the REAL shipping implementation, never a hand-copied
 * duplicate. DeseTourDashboard.jsx itself cannot be require()'d or
 * rendered in Node (browser-only globals at module scope), so JSX
 * rendering is not exercised here; card placement, data-loading, and
 * production-safety checks instead prove correctness by static inspection
 * of the real source, mirroring reservationMealStatus.test.js's own
 * section 11.
 * ─────────────────────────────────────────────────────────────────────────
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { extractTestableFn } = require('./extractTestableFn');

const SOURCE_PATH = path.join(__dirname, '..', '..', 'DeseTourDashboard.jsx');
const SOURCE = fs.readFileSync(SOURCE_PATH, 'utf8');

// Composes several TESTABLE blocks into one executable factory, so a
// helper that calls OTHER real TESTABLE helpers (e.g. _preparationViewModel
// calling getPreparationStatusDisplay) is exercised against the real
// implementations of all of them, not a hand-copied duplicate of either.
function extractCombined(names) {
  const bodies = names.map(name => {
    const startMarker = `// TESTABLE:${name}:start`;
    const endMarker = `// TESTABLE:${name}:end`;
    const startIdx = SOURCE.indexOf(startMarker);
    const endIdx = SOURCE.indexOf(endMarker);
    if (startIdx === -1 || endIdx === -1 || endIdx < startIdx) {
      throw new Error(`extractCombined: markers for "${name}" not found in DeseTourDashboard.jsx`);
    }
    return SOURCE.slice(startIdx + startMarker.length, endIdx);
  });
  const lastName = names[names.length - 1];
  // eslint-disable-next-line no-new-func
  const factory = new Function(`${bodies.join('\n')}\nreturn ${lastName};`);
  return factory();
}

const getPreparationStatusDisplay = extractTestableFn('getPreparationStatusDisplay');
const getPreparationTypeDisplay = extractTestableFn('getPreparationTypeDisplay');
const getPreparationQuantityDisplay = extractTestableFn('getPreparationQuantityDisplay');
const _sortPreparations = extractTestableFn('_sortPreparations');
const _preparationViewModel = extractCombined([
  'getPreparationStatusDisplay',
  'getPreparationTypeDisplay',
  'getPreparationQuantityDisplay',
  '_preparationViewModel',
]);

function prep(overrides) {
  return Object.assign({
    id: 'p1',
    reservationId: 'r1',
    preparationRuleId: 'rule1',
    preparationType: 'entrance_ticket',
    label: 'Ayasofya Giriş Bileti',
    requiredQuantity: 2,
    status: 'pending',
    completedAt: null,
    completedBy: null,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  }, overrides);
}

// ═══════════════════════════════════════════════════════════════════════
// 1-4: status -> Turkish display label (never a raw enum string)
// ═══════════════════════════════════════════════════════════════════════

test('1. pending -> "Bekliyor"', () => {
  assert.equal(getPreparationStatusDisplay('pending').label, 'Bekliyor');
});

test('2. completed -> "Tamamlandı"', () => {
  assert.equal(getPreparationStatusDisplay('completed').label, 'Tamamlandı');
});

test('3. superseded displays safely (never throws, never a raw enum string)', () => {
  const d = getPreparationStatusDisplay('superseded');
  assert.equal(d.label, 'Güncellendi');
  assert.notEqual(d.label, 'superseded');
});

test('4. cancelled -> "İptal"', () => {
  assert.equal(getPreparationStatusDisplay('cancelled').label, 'İptal');
});

test('unrecognized/missing status falls back safely rather than throwing or leaking a raw value', () => {
  assert.doesNotThrow(() => getPreparationStatusDisplay('some_future_status'));
  assert.doesNotThrow(() => getPreparationStatusDisplay(null));
  assert.doesNotThrow(() => getPreparationStatusDisplay(undefined));
});

// ═══════════════════════════════════════════════════════════════════════
// 5: preparation_type never shown as a raw enum string
// ═══════════════════════════════════════════════════════════════════════

test('5. preparation_type values map to Turkish labels, never the raw enum string', () => {
  assert.equal(getPreparationTypeDisplay('entrance_ticket'), 'Giriş Bileti');
  assert.notEqual(getPreparationTypeDisplay('entrance_ticket'), 'entrance_ticket');
  for (const t of ['meal', 'reservation', 'transport', 'special_access', 'other', 'unrecognized', null]) {
    assert.doesNotThrow(() => getPreparationTypeDisplay(t));
  }
});

// ═══════════════════════════════════════════════════════════════════════
// 6-7: quantity display
// ═══════════════════════════════════════════════════════════════════════

test('6. required_quantity 1 -> "1 adet"', () => {
  assert.equal(getPreparationQuantityDisplay(1), '1 adet');
});

test('7. required_quantity multiple -> "N adet"', () => {
  assert.equal(getPreparationQuantityDisplay(2), '2 adet');
  assert.equal(getPreparationQuantityDisplay(5), '5 adet');
});

test('quantity display never throws on a malformed value', () => {
  assert.equal(getPreparationQuantityDisplay(null), '0 adet');
  assert.equal(getPreparationQuantityDisplay(undefined), '0 adet');
  assert.equal(getPreparationQuantityDisplay(-1), '0 adet');
  assert.equal(getPreparationQuantityDisplay('not a number'), '0 adet');
});

// ═══════════════════════════════════════════════════════════════════════
// 8-10: deterministic sorting
// ═══════════════════════════════════════════════════════════════════════

test('8-9. pending sorts before completed, which sorts before historical statuses', () => {
  const list = [
    prep({ id:'c', status:'cancelled', createdAt:'2026-01-01T00:00:00Z' }),
    prep({ id:'s', status:'superseded', createdAt:'2026-01-01T00:00:00Z' }),
    prep({ id:'done', status:'completed', createdAt:'2026-01-01T00:00:00Z' }),
    prep({ id:'pend', status:'pending', createdAt:'2026-01-01T00:00:00Z' }),
  ];
  const sorted = _sortPreparations(list).map(p => p.id);
  assert.deepEqual(sorted, ['pend', 'done', 'c', 's']);
});

test('10. multiple preparations sort deterministically by created_at, then label, within the same status', () => {
  const list = [
    prep({ id:'b', status:'pending', label:'Z Rule', createdAt:'2026-02-01T00:00:00Z' }),
    prep({ id:'a', status:'pending', label:'A Rule', createdAt:'2026-01-01T00:00:00Z' }),
    prep({ id:'c', status:'pending', label:'B Rule', createdAt:'2026-02-01T00:00:00Z' }),
  ];
  const sorted = _sortPreparations(list).map(p => p.id);
  // a (earliest createdAt) first, then tie between b/c broken by label (B < Z)
  assert.deepEqual(sorted, ['a', 'c', 'b']);
});

test('sorting never mutates the input array', () => {
  const list = [prep({ id:'x', status:'cancelled' }), prep({ id:'y', status:'pending' })];
  const originalOrder = list.map(p => p.id);
  _sortPreparations(list);
  assert.deepEqual(list.map(p => p.id), originalOrder);
});

// ═══════════════════════════════════════════════════════════════════════
// view model: safe presentation for every real status, completedAt only
// shown for a completed row, completed_by never exposed
// ═══════════════════════════════════════════════════════════════════════

test('view model never exposes completedBy (no second query to resolve a staff name)', () => {
  const vm = _preparationViewModel(prep({ status:'completed', completedAt:'2026-03-01T00:00:00Z', completedBy:'staff-123' }));
  assert.equal('completedBy' in vm, false);
});

test('completedAtLabel is populated only for a completed row, never for pending/superseded/cancelled', () => {
  assert.ok(_preparationViewModel(prep({ status:'completed', completedAt:'2026-03-01T00:00:00Z' })).completedAtLabel);
  assert.equal(_preparationViewModel(prep({ status:'pending', completedAt:null })).completedAtLabel, null);
  assert.equal(_preparationViewModel(prep({ status:'superseded', completedAt:null })).completedAtLabel, null);
  assert.equal(_preparationViewModel(prep({ status:'cancelled', completedAt:null })).completedAtLabel, null);
});

test('isHistorical is true only for superseded/cancelled, false for pending/completed', () => {
  assert.equal(_preparationViewModel(prep({ status:'pending' })).isHistorical, false);
  assert.equal(_preparationViewModel(prep({ status:'completed' })).isHistorical, false);
  assert.equal(_preparationViewModel(prep({ status:'superseded' })).isHistorical, true);
  assert.equal(_preparationViewModel(prep({ status:'cancelled' })).isHistorical, true);
});

test('view model never renders a raw enum anywhere in its output', () => {
  for (const status of ['pending', 'completed', 'superseded', 'cancelled']) {
    const vm = _preparationViewModel(prep({ status, preparationType:'entrance_ticket' }));
    assert.notEqual(vm.statusLabel, status);
    assert.notEqual(vm.typeLabel, 'entrance_ticket');
  }
});

// ═══════════════════════════════════════════════════════════════════════
// 11: mapPreparationFromDB maps every relevant column
// ═══════════════════════════════════════════════════════════════════════

test('11. mapPreparationFromDB maps every relevant reservation_preparations column, including ones C2D-1 does not display yet', () => {
  const fnStart = SOURCE.indexOf('function mapPreparationFromDB(');
  assert.ok(fnStart !== -1, 'mapPreparationFromDB must exist');
  const fnEnd = SOURCE.indexOf('\n}', SOURCE.indexOf('_fromDB: true', fnStart));
  const fnBody = SOURCE.slice(fnStart, fnEnd);
  // Raw DB column -> mapped field, for every column on reservation_preparations.
  assert.match(fnBody, /id:\s*r\.id/);
  assert.match(fnBody, /reservationId:\s*r\.reservation_id/);
  assert.match(fnBody, /preparationRuleId:\s*r\.preparation_rule_id/);
  assert.match(fnBody, /preparationType:\s*r\.preparation_type/);
  assert.match(fnBody, /label:\s*r\.label/);
  assert.match(fnBody, /requiredQuantity:.*r\.required_quantity/);
  assert.match(fnBody, /status:\s*r\.status/);
  assert.match(fnBody, /completedAt:\s*r\.completed_at/);
  assert.match(fnBody, /completedBy:\s*r\.completed_by/);
  assert.match(fnBody, /createdAt:\s*r\.created_at/);
  assert.match(fnBody, /updatedAt:\s*r\.updated_at/);
});

test('mapPreparationFromDB returns null for a null/undefined row, same convention as every other mapper', () => {
  const fnStart = SOURCE.indexOf('function mapPreparationFromDB(');
  const fnEnd = SOURCE.indexOf('\n}', SOURCE.indexOf('_fromDB: true', fnStart));
  const fnBody = SOURCE.slice(fnStart, fnEnd);
  assert.match(fnBody, /if\s*\(\s*!r\s*\)\s*return\s*null/);
});

// ═══════════════════════════════════════════════════════════════════════
// repository: ONE query, no itinerary inference, no materialization call
// ═══════════════════════════════════════════════════════════════════════

// Scoped strictly to getByReservation's OWN method body (by signature,
// ending at its own closing `},`) — NOT the whole
// SupabaseReservationPreparationRepo object, which also holds the later
// Phase C2D-2 getUpcomingPending method with its own separate query.
function _getByReservationBody() {
  const start = SOURCE.indexOf('async getByReservation(reservationId){');
  assert.ok(start !== -1, 'getByReservation must exist');
  const end = SOURCE.indexOf('\n  },', start);
  return SOURCE.slice(start, end);
}

test('SupabaseReservationPreparationRepo.getByReservation performs exactly one query, filtered by reservation_id', () => {
  const body = _getByReservationBody();
  assert.match(body, /\.from\('reservation_preparations'\)/);
  assert.match(body, /\.eq\('reservation_id',reservationId\)/);
  const fromCalls = body.match(/\.from\(/g) || [];
  assert.equal(fromCalls.length, 1, 'expected exactly one query in getByReservation');
});

test('getByReservation never queries tour_preparation_rules and never infers from itinerary', () => {
  const body = _getByReservationBody();
  assert.doesNotMatch(body, /tour_preparation_rules/);
  assert.doesNotMatch(body, /itinerary/i);
});

test('getByReservation never calls materialize_reservation_preparations and performs no write', () => {
  const body = _getByReservationBody();
  assert.doesNotMatch(body, /materialize_reservation_preparations/);
  assert.doesNotMatch(body, /\.rpc\(/);
  assert.doesNotMatch(body, /\.insert\(|\.update\(|\.delete\(|\.upsert\(/);
});

test('getActiveRepo registers reservationPreparation and falls back to an empty-array mock in non-Supabase mode', () => {
  const idx = SOURCE.indexOf("if(entity==='reservationPreparation')");
  assert.ok(idx !== -1, 'reservationPreparation must be registered in getActiveRepo');
  const line = SOURCE.slice(idx, SOURCE.indexOf('\n', idx));
  assert.match(line, /SupabaseReservationPreparationRepo/);
  assert.match(line, /getByReservation:\s*async\s*\(\)\s*=>\s*\[\]/);
});

// ═══════════════════════════════════════════════════════════════════════
// 12-14: card placement (desktop + mobile)
// ═══════════════════════════════════════════════════════════════════════

test('12-13. desktop: Tur Hazırlıkları sits after Tur İçeriği and before Ödeme Özeti, inside ReservationDetailPage', () => {
  const pageStart = SOURCE.indexOf('function ReservationDetailPage(');
  const pageEnd = SOURCE.indexOf('function MobileReservationDetailPage(');
  const page = SOURCE.slice(pageStart, pageEnd);
  const idxMeal = page.indexOf('title="Tur İçeriği"');
  const idxPrep = page.indexOf('title="Tur Hazırlıkları"');
  const idxPayment = page.indexOf('title="Ödeme Özeti"');
  assert.ok(idxMeal !== -1 && idxPrep !== -1 && idxPayment !== -1, 'all three card titles must be present');
  assert.ok(idxMeal < idxPrep, 'Tur İçeriği must precede Tur Hazırlıkları');
  assert.ok(idxPrep < idxPayment, 'Tur Hazırlıkları must precede Ödeme Özeti');
});

test('14. mobile: Tur Hazırlıkları section sits after the mobile Tur İçeriği section', () => {
  const pageStart = SOURCE.indexOf('function MobileReservationDetailPage(');
  const page = SOURCE.slice(pageStart);
  const idxMeal = page.indexOf('title="Tur İçeriği"');
  const idxPrep = page.indexOf('title="Tur Hazırlıkları"');
  assert.ok(idxMeal !== -1 && idxPrep !== -1, 'both mobile section titles must be present');
  assert.ok(idxMeal < idxPrep, 'mobile Tur İçeriği must precede mobile Tur Hazırlıkları');
});

// ═══════════════════════════════════════════════════════════════════════
// 15. zero preparations -> section omitted entirely (no empty-state card)
// ═══════════════════════════════════════════════════════════════════════

test('15. the desktop card is wrapped in a zero-rows guard — omitted entirely rather than shown empty', () => {
  const pageStart = SOURCE.indexOf('function ReservationDetailPage(');
  const idxPrep = SOURCE.indexOf('title="Tur Hazırlıkları"', pageStart);
  const guardWindow = SOURCE.slice(Math.max(pageStart, idxPrep - 600), idxPrep);
  assert.match(guardWindow, /resPreparations\s*\|\|\s*\[\]\)\.length\s*>\s*0/);
});

test('15b. the mobile section is wrapped in the same zero-rows guard', () => {
  const pageStart = SOURCE.indexOf('function MobileReservationDetailPage(');
  const idxPrep = SOURCE.indexOf('title="Tur Hazırlıkları"', pageStart);
  const guardWindow = SOURCE.slice(Math.max(pageStart, idxPrep - 600), idxPrep);
  assert.match(guardWindow, /mobPreparations\s*\|\|\s*\[\]\)\.length\s*>\s*0/);
});

// ═══════════════════════════════════════════════════════════════════════
// meal_status separation, no itinerary inference, no RPC call, no write,
// no raw Supabase query inside the presentation components
// ═══════════════════════════════════════════════════════════════════════

// Scoped strictly within ReservationDetailPage/MobileReservationDetailPage
// (via pageStart, same as the placement tests above) — NOT a bare global
// indexOf, which would otherwise match the Dashboard's OWN, textually
// earlier "Tur Hazırlıkları" SectionHeader (Phase C2D-2) instead of the
// Reservation Detail card/section this test actually targets.
function _desktopPrepCardSnippet() {
  const pageStart = SOURCE.indexOf('function ReservationDetailPage(');
  const idxPrep = SOURCE.indexOf('title="Tur Hazırlıkları"', pageStart);
  const cardEnd = SOURCE.indexOf('title="Ödeme Özeti"', idxPrep);
  return SOURCE.slice(idxPrep, cardEnd);
}
function _mobilePrepSectionSnippet() {
  const pageStart = SOURCE.indexOf('function MobileReservationDetailPage(');
  const idxPrep = SOURCE.indexOf('title="Tur Hazırlıkları"', pageStart);
  const cardEnd = SOURCE.indexOf('title="Ödeme"', idxPrep);
  return SOURCE.slice(idxPrep, cardEnd);
}

test('meal_status is not duplicated into the new Tur Hazırlıkları card (desktop)', () => {
  assert.doesNotMatch(_desktopPrepCardSnippet(), /meal_status|mealStatus|purchasedActivityRaw/);
});

test('meal_status is not duplicated into the new Tur Hazırlıkları section (mobile)', () => {
  assert.doesNotMatch(_mobilePrepSectionSnippet(), /meal_status|mealStatus|purchasedActivityRaw/);
});

test('the new card/section never performs a write, mutation, or RPC call (desktop + mobile)', () => {
  assert.doesNotMatch(_desktopPrepCardSnippet(), /\.update\(|\.rpc\(|useRepoMutation|materialize_reservation_preparations/);
  assert.doesNotMatch(_mobilePrepSectionSnippet(), /\.update\(|\.rpc\(|useRepoMutation|materialize_reservation_preparations/);
});

test('the presentation components never run a raw Supabase query themselves — only via useRepo', () => {
  assert.doesNotMatch(_desktopPrepCardSnippet(), /getSB\(\)|\.from\(/);
  assert.doesNotMatch(_mobilePrepSectionSnippet(), /getSB\(\)|\.from\(/);
});

test('data loading uses the useRepo hook pattern, not a direct repo call, in both pages', () => {
  const idx1 = SOURCE.indexOf('useRepo("reservationPreparation", "getByReservation", resId)');
  assert.ok(idx1 !== -1, 'desktop must load preparations via useRepo');
  const idx2 = SOURCE.indexOf('useRepo("reservationPreparation", "getByReservation", resId)', idx1 + 1);
  assert.ok(idx2 !== -1, 'mobile must also load preparations via useRepo (separate call site)');
});

test('this new code never mentions anything WhatsApp-related, auth tables, or Civitatis V12/V13 RPCs', () => {
  const helpersStart = SOURCE.indexOf('// TESTABLE:getPreparationStatusDisplay:start');
  const helpersEnd = SOURCE.indexOf('// TESTABLE:_preparationViewModel:end') + '// TESTABLE:_preparationViewModel:end'.length;
  const helpers = SOURCE.slice(helpersStart, helpersEnd);
  assert.doesNotMatch(helpers, /whatsapp/i);
  assert.doesNotMatch(helpers, /ingest_civitatis_booking|cancel_civitatis_booking/);

  const repoIdx = SOURCE.indexOf('const SupabaseReservationPreparationRepo');
  const repoEnd = SOURCE.indexOf('\n};', repoIdx);
  const repoBody = SOURCE.slice(repoIdx, repoEnd);
  assert.doesNotMatch(repoBody, /whatsapp/i);
  assert.doesNotMatch(repoBody, /ingest_civitatis_booking|cancel_civitatis_booking/);
});
