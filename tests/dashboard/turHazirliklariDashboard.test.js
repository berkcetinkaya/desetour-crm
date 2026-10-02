'use strict';
/**
 * tests/dashboard/turHazirliklariDashboard.test.js
 * ─────────────────────────────────────────────────────────────────────────
 * Tour Preparation Intelligence — Phase C2D-2: Dashboard "Tur Hazırlıkları"
 * (read-only). Tests the pure helpers extracted directly from
 * DeseTourDashboard.jsx via the existing TESTABLE-marker convention (see
 * tests/dashboard/extractTestableFn.js / reservationPreparationsUI.test.js),
 * so these exercise the REAL shipping implementation, never a hand-copied
 * duplicate. DeseTourDashboard.jsx itself cannot be require()'d or
 * rendered in Node, so JSX rendering, card placement, and query-shape
 * checks instead prove correctness by static inspection of the real
 * source, mirroring the existing convention.
 * ─────────────────────────────────────────────────────────────────────────
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { extractTestableFn } = require('./extractTestableFn');

const SOURCE_PATH = path.join(__dirname, '..', '..', 'DeseTourDashboard.jsx');
const SOURCE = fs.readFileSync(SOURCE_PATH, 'utf8');

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

const _isMealPreparationRequired = extractTestableFn('_isMealPreparationRequired');
const _filterUpcomingPendingPreparationRows = extractTestableFn('_filterUpcomingPendingPreparationRows');
const _sortDashboardPreparationRows = extractTestableFn('_sortDashboardPreparationRows');
const _paginateDashboardPreparationRows = extractTestableFn('_paginateDashboardPreparationRows');
const _filterUpcomingMealReservations = extractCombined(['_isMealPreparationRequired', '_filterUpcomingMealReservations']);
const _buildPreparationDashboardRow = extractCombined([
  'getPreparationStatusDisplay', 'getPreparationQuantityDisplay', '_buildPreparationDashboardRow',
]);
const _buildMealDashboardRow = extractTestableFn('_buildMealDashboardRow');
const _buildTurHazirliklariRows = extractCombined([
  'istanbulNowParts',
  'getPreparationStatusDisplay', 'getPreparationQuantityDisplay',
  '_isMealPreparationRequired',
  '_filterUpcomingPendingPreparationRows', '_filterUpcomingMealReservations',
  '_buildPreparationDashboardRow', '_buildMealDashboardRow',
  '_sortDashboardPreparationRows',
  '_buildTurHazirliklariRows',
]);

function prepRow(overrides) {
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
    reservationNumber: 'R-2026-0009',
    checkIn: '2026-10-03',
    tourName: 'Bosforo y Barrio Sultanahmet',
    reservation: { status: 'confirmed', check_in: '2026-10-03' },
  }, overrides);
}

function mealRes(overrides) {
  return Object.assign({
    id: 'res1',
    resNumber: 'R-2026-0013',
    checkIn: '2026-10-05',
    tour: 'Estambul Histórica',
    pax: 1,
    paxChild: 0,
    mealStatus: 'included',
    opStatus: 'Onaylandı',
  }, overrides);
}

// ═══════════════════════════════════════════════════════════════════════
// meal_status contract: included / not_included / unknown
// ═══════════════════════════════════════════════════════════════════════

test('meal_status included creates a meal row (via _isMealPreparationRequired)', () => {
  assert.equal(_isMealPreparationRequired('included'), true);
});

test('meal_status not_included does not create a meal row', () => {
  assert.equal(_isMealPreparationRequired('not_included'), false);
});

test('meal_status unknown does not create a meal row', () => {
  assert.equal(_isMealPreparationRequired('unknown'), false);
  assert.equal(_isMealPreparationRequired(null), false);
  assert.equal(_isMealPreparationRequired(undefined), false);
});

test('_filterUpcomingMealReservations keeps only included, non-cancelled, non-past reservations', () => {
  const todayISO = '2026-10-01';
  const list = [
    mealRes({ id:'a', mealStatus:'included', checkIn:'2026-10-05' }),
    mealRes({ id:'b', mealStatus:'not_included', checkIn:'2026-10-05' }),
    mealRes({ id:'c', mealStatus:'unknown', checkIn:'2026-10-05' }),
    mealRes({ id:'d', mealStatus:'included', opStatus:'İptal', checkIn:'2026-10-05' }),
    mealRes({ id:'e', mealStatus:'included', checkIn:'2026-09-01' }),
  ];
  const kept = _filterUpcomingMealReservations(list, todayISO).map(r => r.id);
  assert.deepEqual(kept, ['a']);
});

// ═══════════════════════════════════════════════════════════════════════
// reservation_preparations contract: pending / cancelled reservation / past
// ═══════════════════════════════════════════════════════════════════════

test('pending reservation_preparation appears (future, non-cancelled reservation)', () => {
  const kept = _filterUpcomingPendingPreparationRows([prepRow()], '2026-10-01');
  assert.equal(kept.length, 1);
});

test('cancelled reservation excluded even if its preparation row is pending', () => {
  const row = prepRow({ reservation: { status:'cancelled', check_in:'2026-10-03' } });
  assert.equal(_filterUpcomingPendingPreparationRows([row], '2026-10-01').length, 0);
});

test('past reservation excluded', () => {
  const row = prepRow({ checkIn:'2026-09-01', reservation: { status:'confirmed', check_in:'2026-09-01' } });
  assert.equal(_filterUpcomingPendingPreparationRows([row], '2026-10-01').length, 0);
});

test('future reservation included', () => {
  const row = prepRow({ checkIn:'2026-12-28', reservation: { status:'confirmed', check_in:'2026-12-28' } });
  assert.equal(_filterUpcomingPendingPreparationRows([row], '2026-10-01').length, 1);
});

test('a row with no attached reservation is dropped defensively, never throws', () => {
  assert.doesNotThrow(() => _filterUpcomingPendingPreparationRows([{ id:'x' }], '2026-10-01'));
  assert.equal(_filterUpcomingPendingPreparationRows([{ id:'x' }], '2026-10-01').length, 0);
});

test('completed/superseded/cancelled preparation statuses are excluded at the query layer, not by this client-side filter', () => {
  // getUpcomingPending's own .eq('status','pending') is what actually
  // excludes a completed/superseded/cancelled PREPARATION row — proven
  // below by static inspection of the repository method itself (the
  // database never returns those rows in the first place, so there is
  // nothing for this client-side helper to filter on).
  const repoStart = SOURCE.indexOf('async getUpcomingPending()');
  const repoEnd = SOURCE.indexOf('\n  },', repoStart);
  const body = SOURCE.slice(repoStart, repoEnd);
  assert.match(body, /\.eq\('status','pending'\)/);
});

// ═══════════════════════════════════════════════════════════════════════
// row normalization
// ═══════════════════════════════════════════════════════════════════════

test('_buildPreparationDashboardRow produces the documented normalized shape with correct required_quantity', () => {
  const row = _buildPreparationDashboardRow(prepRow({ requiredQuantity: 2 }));
  assert.equal(row.kind, 'preparation');
  assert.equal(row.label, 'Ayasofya Giriş Bileti');
  assert.equal(row.quantityText, '2 adet');
  assert.equal(row.statusLabel, 'Bekliyor');
  assert.equal(row.reservationNumber, 'R-2026-0009');
  assert.equal(row.checkIn, '2026-10-03');
});

test('_buildMealDashboardRow uses the SAME authoritative guest-count calculation already used elsewhere (pax + paxChild), never adult-only pax alone', () => {
  const row = _buildMealDashboardRow(mealRes({ pax: 2, paxChild: 1 }));
  assert.equal(row.kind, 'meal');
  assert.equal(row.quantityText, '3 misafir');
  assert.equal(row.label, 'Yemek Organizasyonu');
  assert.equal(row.statusLabel, 'Yemek Dahil');
});

test('a reservation with zero children still reports the correct single-guest quantity', () => {
  const row = _buildMealDashboardRow(mealRes({ pax: 1, paxChild: 0 }));
  assert.equal(row.quantityText, '1 misafir');
});

test('ticket and meal rows for the SAME reservation are both produced, never merged into one row', () => {
  const ticket = _buildPreparationDashboardRow(prepRow({ reservationId: 'shared-res' }));
  const meal = _buildMealDashboardRow(mealRes({ id: 'shared-res' }));
  assert.equal(ticket.kind, 'preparation');
  assert.equal(meal.kind, 'meal');
  assert.notEqual(ticket.label, meal.label);
});

// ═══════════════════════════════════════════════════════════════════════
// sorting
// ═══════════════════════════════════════════════════════════════════════

test('date ascending sort', () => {
  const rows = [
    { kind:'preparation', checkIn:'2026-12-28', label:'Z' },
    { kind:'preparation', checkIn:'2026-10-03', label:'A' },
    { kind:'preparation', checkIn:'2026-10-26', label:'M' },
  ];
  const sorted = _sortDashboardPreparationRows(rows).map(r => r.checkIn);
  assert.deepEqual(sorted, ['2026-10-03', '2026-10-26', '2026-12-28']);
});

test('preparation sorts before meal on the same reservation/date', () => {
  const rows = [
    { kind:'meal', checkIn:'2026-10-05', label:'Yemek Organizasyonu' },
    { kind:'preparation', checkIn:'2026-10-05', label:'Ayasofya Giriş Bileti' },
  ];
  const sorted = _sortDashboardPreparationRows(rows).map(r => r.kind);
  assert.deepEqual(sorted, ['preparation', 'meal']);
});

test('stable, deterministic label ordering within the same date and kind', () => {
  const rows = [
    { kind:'preparation', checkIn:'2026-10-05', label:'Z Rule' },
    { kind:'preparation', checkIn:'2026-10-05', label:'A Rule' },
  ];
  const sorted = _sortDashboardPreparationRows(rows).map(r => r.label);
  assert.deepEqual(sorted, ['A Rule', 'Z Rule']);
});

test('sorting never mutates its input array', () => {
  const rows = [{ kind:'meal', checkIn:'2026-10-05', label:'B' }, { kind:'preparation', checkIn:'2026-10-01', label:'A' }];
  const before = rows.map(r => r.label);
  _sortDashboardPreparationRows(rows);
  assert.deepEqual(rows.map(r => r.label), before);
});

// ═══════════════════════════════════════════════════════════════════════
// Istanbul-local "today" boundary (via the real istanbulNowParts)
// ═══════════════════════════════════════════════════════════════════════

test('Istanbul-local today boundary: a reservation checking in exactly "today" (Istanbul) is included, yesterday is excluded', () => {
  // 2026-06-15T10:00:00Z + 3h (Europe/Istanbul, no DST ambiguity at this
  // instant) = 2026-06-15T13:00 Istanbul -> dateISO '2026-06-15'.
  const nowMs = Date.parse('2026-06-15T10:00:00Z');
  const preparationRows = [
    prepRow({ id:'today', checkIn:'2026-06-15', reservation:{ status:'confirmed', check_in:'2026-06-15' } }),
    prepRow({ id:'yesterday', checkIn:'2026-06-14', reservation:{ status:'confirmed', check_in:'2026-06-14' } }),
  ];
  const rows = _buildTurHazirliklariRows(preparationRows, [], nowMs);
  assert.deepEqual(rows.map(r => r.checkIn), ['2026-06-15']);
});

// ═══════════════════════════════════════════════════════════════════════
// overflow / MAX_VISIBLE
// ═══════════════════════════════════════════════════════════════════════

test('MAX_VISIBLE behavior and +N overflow calculation', () => {
  const rows = Array.from({ length: 8 }, (_, i) => ({ id:i }));
  const { visible, remaining } = _paginateDashboardPreparationRows(rows, 5);
  assert.equal(visible.length, 5);
  assert.equal(remaining, 3);
});

test('no overflow when the row count is within the limit', () => {
  const rows = Array.from({ length: 3 }, (_, i) => ({ id:i }));
  const { visible, remaining } = _paginateDashboardPreparationRows(rows, 5);
  assert.equal(visible.length, 3);
  assert.equal(remaining, 0);
});

test('each panel has its own sensible, bounded visible-row cap (Phase C2D-4 split)', () => {
  const mTicket = SOURCE.match(/const MAX_VISIBLE_TICKET_PREPARATIONS = (\d+);/);
  const mMeal = SOURCE.match(/const MAX_VISIBLE_MEAL_PREPARATIONS = (\d+);/);
  assert.ok(mTicket, 'MAX_VISIBLE_TICKET_PREPARATIONS must be defined');
  assert.ok(mMeal, 'MAX_VISIBLE_MEAL_PREPARATIONS must be defined');
  const nTicket = parseInt(mTicket[1], 10);
  const nMeal = parseInt(mMeal[1], 10);
  assert.ok(nTicket >= 3 && nTicket <= 10, 'expected a sensible, bounded ticket visible-row cap');
  assert.ok(nMeal >= 3 && nMeal <= 10, 'expected a sensible, bounded meal visible-row cap');
});

// ═══════════════════════════════════════════════════════════════════════
// data contract: ticket source is reservation_preparations ONLY, meal
// source is reservation.meal_status ONLY — no itinerary/rule inference
// ═══════════════════════════════════════════════════════════════════════

test('getUpcomingPending never queries tour_preparation_rules and never infers from itinerary or tour name', () => {
  const start = SOURCE.indexOf('async getUpcomingPending()');
  const end = SOURCE.indexOf('\n  },', start);
  const body = SOURCE.slice(start, end);
  assert.match(body, /\.from\('reservation_preparations'\)/);
  assert.doesNotMatch(body, /tour_preparation_rules/);
  assert.doesNotMatch(body, /itinerary/i);
});

test('getUpcomingPending performs exactly one query (bounded, not per-row)', () => {
  const start = SOURCE.indexOf('async getUpcomingPending()');
  const end = SOURCE.indexOf('\n  },', start);
  const body = SOURCE.slice(start, end);
  const fromCalls = body.match(/\.from\(/g) || [];
  assert.equal(fromCalls.length, 1);
});

test('getUpcomingMealIncluded reads meal_status only, never reservation_preparations, and performs exactly one query', () => {
  const start = SOURCE.indexOf('async getUpcomingMealIncluded()');
  const end = SOURCE.indexOf('\n  },', start);
  const body = SOURCE.slice(start, end);
  assert.match(body, /\.eq\('meal_status','included'\)/);
  assert.doesNotMatch(body, /reservation_preparations/);
  const fromCalls = body.match(/\.from\(/g) || [];
  assert.equal(fromCalls.length, 1);
});

test('neither new repository method ever writes, mutates, or calls an RPC', () => {
  for (const name of ['async getUpcomingPending()', 'async getUpcomingMealIncluded()']) {
    const start = SOURCE.indexOf(name);
    const end = SOURCE.indexOf('\n  },', start);
    const body = SOURCE.slice(start, end);
    assert.doesNotMatch(body, /\.insert\(|\.update\(|\.delete\(|\.upsert\(|\.rpc\(/);
    assert.doesNotMatch(body, /materialize_reservation_preparations/);
  }
});

test('the data hook issues exactly two bounded useRepo calls, never one per row (no N+1)', () => {
  const start = SOURCE.indexOf('function useTurHazirliklariRows()');
  const end = SOURCE.indexOf('\n}', start);
  const body = SOURCE.slice(start, end);
  const calls = body.match(/useRepo\(/g) || [];
  assert.equal(calls.length, 2, 'expected exactly two useRepo calls (preparations + meals), fixed regardless of data volume');
  assert.match(body, /useRepo\("reservationPreparation",\s*"getUpcomingPending"\)/);
  assert.match(body, /useRepo\("reservation",\s*"getUpcomingMealIncluded"\)/);
});

// ═══════════════════════════════════════════════════════════════════════
// Dashboard placement, empty state, navigation
// ═══════════════════════════════════════════════════════════════════════

test('TurHazirliklari is placed immediately after KpiRow and before the TodayTours/UrgentPanel row inside Dashboard()', () => {
  const start = SOURCE.indexOf('function Dashboard()');
  const end = SOURCE.indexOf('\nfunction ', start + 10);
  const body = SOURCE.slice(start, end);
  const idxKpi = body.indexOf('<KpiRow/>');
  const idxPrep = body.indexOf('<TurHazirliklari/>');
  const idxRow2 = body.indexOf('dash-row-2');
  assert.ok(idxKpi !== -1 && idxPrep !== -1 && idxRow2 !== -1);
  assert.ok(idxKpi < idxPrep, 'KpiRow must precede TurHazirliklari');
  assert.ok(idxPrep < idxRow2, 'TurHazirliklari must precede the TodayTours/UrgentPanel row');
});

test('the section is omitted entirely (returns null) when there are zero rows, loading, or an error — never an empty card', () => {
  const start = SOURCE.indexOf('function TurHazirliklari()');
  const end = SOURCE.indexOf('\n}', start);
  const body = SOURCE.slice(start, end);
  assert.match(body, /if\s*\(\s*loading\s*\|\|\s*error\s*\|\|\s*rows\.length\s*===\s*0\s*\)\s*return\s*null/);
});

test('clicking a row navigates to Reservation Detail via the existing navigation convention', () => {
  const start = SOURCE.indexOf('function _goToPreparationReservation');
  const end = SOURCE.indexOf('\n}', start);
  const body = SOURCE.slice(start, end);
  assert.match(body, /NAV_REF\.fn\('\/reservations\/'\s*\+\s*reservationId\)/);

  // Phase C2D-4: the row's onClick now lives in the shared _DashboardPrepRow
  // presentational component (used by both the ticket and meal panels),
  // not inlined directly in TurHazirliklari() itself.
  const rowStart = SOURCE.indexOf('function _DashboardPrepRow(');
  const rowEnd = SOURCE.indexOf('\n}', rowStart);
  const rowBody = SOURCE.slice(rowStart, rowEnd);
  assert.match(rowBody, /onClick=\{\(\)\s*=>\s*_goToPreparationReservation\(row\.reservationId\)\}/);
});

test('no completion write, no status mutation, and no "Tamamlandı" button exist anywhere in the new Dashboard section', () => {
  const start = SOURCE.indexOf('function TurHazirliklari()');
  const end = SOURCE.indexOf('\n}', start);
  const body = SOURCE.slice(start, end);
  assert.doesNotMatch(body, /\.update\(|\.rpc\(|useRepoMutation|materialize_reservation_preparations/);
});

test('this new section never mentions WhatsApp, auth tables, or Civitatis V12/V13 RPCs', () => {
  const helpersStart = SOURCE.indexOf('// TESTABLE:_isMealPreparationRequired:start');
  const helpersEnd = SOURCE.indexOf('// TESTABLE:_buildTurHazirliklariRows:end') + '// TESTABLE:_buildTurHazirliklariRows:end'.length;
  const helpers = SOURCE.slice(helpersStart, helpersEnd);
  assert.doesNotMatch(helpers, /whatsapp/i);
  assert.doesNotMatch(helpers, /ingest_civitatis_booking|cancel_civitatis_booking/);

  const sectionStart = SOURCE.indexOf('function TurHazirliklari()');
  const sectionEnd = SOURCE.indexOf('\n}', sectionStart);
  const sectionBody = SOURCE.slice(sectionStart, sectionEnd);
  assert.doesNotMatch(sectionBody, /whatsapp/i);
});
