'use strict';
/**
 * tests/dashboard/turHazirliklariPanels.test.js
 * ─────────────────────────────────────────────────────────────────────────
 * Tour Preparation Intelligence — Phase C2D-4: Dashboard Tur Hazırlıkları
 * visual information architecture refinement. Entrance-ticket preparations
 * (Bilet Hazırlıkları) and meal preparations (Yemek Hazırlıkları) are now
 * two separated panels inside the same outer section — never interleaved
 * into one chronological list. Tests the pure helpers extracted directly
 * from DeseTourDashboard.jsx via the existing TESTABLE-marker convention,
 * so these exercise the REAL shipping implementation. This is a UI/
 * presentation refinement only: no query, no data source, and no
 * completion-workflow change is exercised or expected here.
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

const _groupTourPreparationRows = extractTestableFn('_groupTourPreparationRows');
const _summarizeTicketPreparations = extractTestableFn('_summarizeTicketPreparations');
const _summarizeMealPreparations = extractTestableFn('_summarizeMealPreparations');
const _formatTicketSummary = extractTestableFn('_formatTicketSummary');
const _formatMealSummary = extractTestableFn('_formatMealSummary');
const _formatTicketQuantityLabel = extractTestableFn('_formatTicketQuantityLabel');
const _formatMealQuantityLabel = extractTestableFn('_formatMealQuantityLabel');
const _paginateDashboardPreparationRows = extractTestableFn('_paginateDashboardPreparationRows');

const _buildPreparationDashboardRow = extractCombined([
  'getPreparationStatusDisplay', 'getPreparationQuantityDisplay', '_buildPreparationDashboardRow',
]);
const _buildMealDashboardRow = extractTestableFn('_buildMealDashboardRow');

// Full end-to-end pipeline: filter -> normalize -> sort -> group. Proves
// the grouping step, applied AFTER the existing sort, never needs its own
// sorting/filtering logic — splitting a sorted array by predicate
// preserves each subset's relative (date) order.
const _buildTurHazirliklariRowsGrouped = extractCombined([
  'istanbulNowParts',
  'getPreparationStatusDisplay', 'getPreparationQuantityDisplay',
  '_isMealPreparationRequired',
  '_filterUpcomingPendingPreparationRows', '_filterUpcomingMealReservations',
  '_buildPreparationDashboardRow', '_buildMealDashboardRow',
  '_sortDashboardPreparationRows',
  '_buildTurHazirliklariRows',
  '_groupTourPreparationRows',
]);
function buildAndGroup(preparationRows, mealReservations, nowMs) {
  // _buildTurHazirliklariRowsGrouped resolves to _groupTourPreparationRows
  // (the last extracted name) — call _buildTurHazirliklariRows's own logic
  // first via the combined scope, then group the result.
  const combined = extractCombined([
    'istanbulNowParts',
    'getPreparationStatusDisplay', 'getPreparationQuantityDisplay',
    '_isMealPreparationRequired',
    '_filterUpcomingPendingPreparationRows', '_filterUpcomingMealReservations',
    '_buildPreparationDashboardRow', '_buildMealDashboardRow',
    '_sortDashboardPreparationRows',
    '_buildTurHazirliklariRows',
  ]);
  const rows = combined(preparationRows, mealReservations, nowMs);
  return _groupTourPreparationRows(rows);
}

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

function ticketDashboardRow(overrides) {
  return _buildPreparationDashboardRow(prepRow(overrides));
}
function mealDashboardRow(overrides) {
  return _buildMealDashboardRow(mealRes(overrides));
}

// ═══════════════════════════════════════════════════════════════════════
// grouping: tickets and meals are strictly separated
// ═══════════════════════════════════════════════════════════════════════

test('ticket and meal rows are separated into two groups', () => {
  const rows = [ticketDashboardRow(), mealDashboardRow()];
  const { tickets, meals } = _groupTourPreparationRows(rows);
  assert.equal(tickets.length, 1);
  assert.equal(meals.length, 1);
});

test('ticket rows never appear in the meal group', () => {
  const rows = [ticketDashboardRow({ reservationId:'a' }), ticketDashboardRow({ reservationId:'b' })];
  const { meals } = _groupTourPreparationRows(rows);
  assert.equal(meals.length, 0);
});

test('meal rows never appear in the ticket group', () => {
  const rows = [mealDashboardRow({ id:'a' }), mealDashboardRow({ id:'b' })];
  const { tickets } = _groupTourPreparationRows(rows);
  assert.equal(tickets.length, 0);
});

test('ticket and meal rows are not interleaved, regardless of input order', () => {
  const rows = [
    mealDashboardRow({ id:'m1', checkIn:'2026-10-01' }),
    ticketDashboardRow({ reservationId:'t1', checkIn:'2026-10-02' }),
    mealDashboardRow({ id:'m2', checkIn:'2026-10-03' }),
    ticketDashboardRow({ reservationId:'t2', checkIn:'2026-10-04' }),
  ];
  const { tickets, meals } = _groupTourPreparationRows(rows);
  assert.ok(tickets.every(r => r.kind === 'preparation'));
  assert.ok(meals.every(r => r.kind === 'meal'));
  assert.equal(tickets.length, 2);
  assert.equal(meals.length, 2);
});

// ═══════════════════════════════════════════════════════════════════════
// summaries
// ═══════════════════════════════════════════════════════════════════════

test('ticket summary counts UNIQUE reservations, not row count', () => {
  const tickets = [
    ticketDashboardRow({ reservationId:'r1', label:'A' }),
    ticketDashboardRow({ reservationId:'r1', label:'B' }), // same reservation, second row
    ticketDashboardRow({ reservationId:'r2', label:'A' }),
  ];
  const summary = _summarizeTicketPreparations(tickets);
  assert.equal(summary.reservationCount, 2);
});

test('ticket summary sums required quantities across all ticket rows', () => {
  const tickets = [
    ticketDashboardRow({ reservationId:'r1', requiredQuantity:2 }),
    ticketDashboardRow({ reservationId:'r2', requiredQuantity:2 }),
    ticketDashboardRow({ reservationId:'r3', requiredQuantity:2 }),
  ];
  const summary = _summarizeTicketPreparations(tickets);
  assert.equal(summary.reservationCount, 3);
  assert.equal(summary.ticketCount, 6);
});

test('ticket summary only counts rows whose NORMALIZED preparation_type is entrance_ticket, never by label text', () => {
  const tickets = [
    ticketDashboardRow({ reservationId:'r1', requiredQuantity:2, preparationType:'entrance_ticket' }),
    // Same kind='preparation' bucket, but a different preparation_type —
    // must not contribute to the ticket summary even though it would
    // still render in the ticket panel today.
    ticketDashboardRow({ reservationId:'r2', requiredQuantity:5, preparationType:'transport', label:'Bir Bilet Değil' }),
  ];
  const summary = _summarizeTicketPreparations(tickets);
  assert.equal(summary.reservationCount, 1);
  assert.equal(summary.ticketCount, 2);
});

test('meal summary counts reservations', () => {
  const meals = [mealDashboardRow({ id:'a' }), mealDashboardRow({ id:'b' })];
  const summary = _summarizeMealPreparations(meals);
  assert.equal(summary.reservationCount, 2);
});

test('meal summary sums the authoritative guest count (pax + paxChild), never a separate definition', () => {
  const meals = [
    mealDashboardRow({ id:'a', pax:1, paxChild:0 }),
    mealDashboardRow({ id:'b', pax:1, paxChild:0 }),
    mealDashboardRow({ id:'c', pax:3, paxChild:2 }),
  ];
  const summary = _summarizeMealPreparations(meals);
  assert.equal(summary.reservationCount, 3);
  assert.equal(summary.guestCount, 1 + 1 + 5);
});

test('summary text formatting matches the required copy', () => {
  assert.equal(_formatTicketSummary({ reservationCount:3, ticketCount:6 }), '3 rezervasyon · 6 bilet bekliyor');
  assert.equal(_formatMealSummary({ reservationCount:4, guestCount:9 }), '4 yaklaşan yemekli tur · 9 misafir');
});

// ═══════════════════════════════════════════════════════════════════════
// quantity display: BİLET / MİSAFİR, prominent, presentation-only
// ═══════════════════════════════════════════════════════════════════════

test('ticket quantity renders as "N BİLET"', () => {
  assert.equal(_formatTicketQuantityLabel(2), '2 BİLET');
  assert.equal(_formatTicketQuantityLabel(0), '0 BİLET');
  assert.equal(_formatTicketQuantityLabel(null), '0 BİLET');
});

test('meal quantity renders as "N MİSAFİR"', () => {
  assert.equal(_formatMealQuantityLabel(1), '1 MİSAFİR');
  assert.equal(_formatMealQuantityLabel(5), '5 MİSAFİR');
});

test('the raw required_quantity/guest count is unchanged — only its dashboard-row display differs from Reservation Detail\'s existing "N adet"', () => {
  const row = ticketDashboardRow({ requiredQuantity: 2 });
  assert.equal(row.quantity, 2);
  assert.equal(row.quantityText, '2 adet'); // untouched, still used elsewhere
  assert.equal(_formatTicketQuantityLabel(row.quantity), '2 BİLET');
});

// ═══════════════════════════════════════════════════════════════════════
// sorting within each panel (via the full pipeline, grouping after sort)
// ═══════════════════════════════════════════════════════════════════════

test('ticket rows are sorted by check_in ascending within the ticket panel', () => {
  const nowMs = Date.parse('2026-01-01T10:00:00Z');
  const preparationRows = [
    prepRow({ id:'p1', reservationId:'r1', checkIn:'2026-12-28', reservation:{ status:'confirmed', check_in:'2026-12-28' } }),
    prepRow({ id:'p2', reservationId:'r2', checkIn:'2026-10-03', reservation:{ status:'confirmed', check_in:'2026-10-03' } }),
    prepRow({ id:'p3', reservationId:'r3', checkIn:'2026-10-26', reservation:{ status:'confirmed', check_in:'2026-10-26' } }),
  ];
  const { tickets } = buildAndGroup(preparationRows, [], nowMs);
  assert.deepEqual(tickets.map(t => t.checkIn), ['2026-10-03', '2026-10-26', '2026-12-28']);
});

test('meal rows are sorted by check_in ascending within the meal panel', () => {
  const nowMs = Date.parse('2026-01-01T10:00:00Z');
  const mealReservations = [
    mealRes({ id:'m1', checkIn:'2026-11-19' }),
    mealRes({ id:'m2', checkIn:'2026-10-05' }),
    mealRes({ id:'m3', checkIn:'2026-10-23' }),
  ];
  const { meals } = buildAndGroup([], mealReservations, nowMs);
  assert.deepEqual(meals.map(m => m.checkIn), ['2026-10-05', '2026-10-23', '2026-11-19']);
});

test('ticket and meal rows are not interleaved end-to-end, even when their dates overlap', () => {
  const nowMs = Date.parse('2026-01-01T10:00:00Z');
  const preparationRows = [
    prepRow({ id:'p1', reservationId:'r1', checkIn:'2026-10-05', reservation:{ status:'confirmed', check_in:'2026-10-05' } }),
  ];
  const mealReservations = [
    mealRes({ id:'m1', checkIn:'2026-10-05' }),
  ];
  const { tickets, meals } = buildAndGroup(preparationRows, mealReservations, nowMs);
  assert.equal(tickets.length, 1);
  assert.equal(meals.length, 1);
  assert.equal(tickets[0].kind, 'preparation');
  assert.equal(meals[0].kind, 'meal');
});

// ═══════════════════════════════════════════════════════════════════════
// panel visibility / layout logic (static inspection of TurHazirliklari)
// ═══════════════════════════════════════════════════════════════════════

function _turHazirliklariBody() {
  const start = SOURCE.indexOf('function TurHazirliklari()');
  const end = SOURCE.indexOf('\nfunction Dashboard()', start);
  return SOURCE.slice(start, end);
}

test('both categories present -> two-column desktop layout', () => {
  const body = _turHazirliklariBody();
  assert.match(body, /gridTemplateColumns:\s*hasTickets\s*&&\s*hasMeals\s*\?\s*"1fr 1fr"\s*:\s*"1fr"/);
});

test('tickets only -> only the ticket panel renders (guarded by hasTickets)', () => {
  const body = _turHazirliklariBody();
  assert.match(body, /\{hasTickets && \(/);
  assert.match(body, /Bilet Hazırlıkları/);
});

test('meals only -> only the meal panel renders (guarded by hasMeals)', () => {
  const body = _turHazirliklariBody();
  assert.match(body, /\{hasMeals && \(/);
  assert.match(body, /Yemek Hazırlıkları/);
});

test('neither category present -> the entire Tur Hazırlıkları section is omitted', () => {
  const body = _turHazirliklariBody();
  assert.match(body, /if \(!hasTickets && !hasMeals\) return null;/);
});

test('no blank second column — the grid falls back to a single "1fr" track when only one panel has rows', () => {
  const body = _turHazirliklariBody();
  // The only possible column templates are "1fr 1fr" (both) or "1fr"
  // (one) — there is no code path that renders a grid with an empty
  // second cell.
  assert.doesNotMatch(body, /gridTemplateColumns:\s*"1fr 1fr"\s*,?\s*$/m);
  assert.match(body, /: "1fr"/);
});

// ═══════════════════════════════════════════════════════════════════════
// independent overflow per panel
// ═══════════════════════════════════════════════════════════════════════

test('ticket overflow is independent of how many meal rows exist', () => {
  const tickets = Array.from({ length: 7 }, (_, i) => ({ id:i }));
  const meals = Array.from({ length: 1 }, (_, i) => ({ id:i }));
  const t = _paginateDashboardPreparationRows(tickets, 5);
  const m = _paginateDashboardPreparationRows(meals, 5);
  assert.equal(t.visible.length, 5);
  assert.equal(t.remaining, 2);
  assert.equal(m.visible.length, 1);
  assert.equal(m.remaining, 0);
});

test('meal overflow is independent of how many ticket rows exist', () => {
  const tickets = Array.from({ length: 1 }, (_, i) => ({ id:i }));
  const meals = Array.from({ length: 9 }, (_, i) => ({ id:i }));
  const t = _paginateDashboardPreparationRows(tickets, 5);
  const m = _paginateDashboardPreparationRows(meals, 5);
  assert.equal(t.remaining, 0);
  assert.equal(m.visible.length, 5);
  assert.equal(m.remaining, 4);
});

test('correct +N overflow text for tickets and meals, distinct from each other', () => {
  const body = _turHazirliklariBody();
  assert.match(body, /diğer bilet hazırlığı/);
  assert.match(body, /diğer yemek hazırlığı/);
  assert.doesNotMatch(body, /\+ \{remaining\} diğer hazırlık[^ı]/); // old single-list overflow text is gone
});

test('each panel manages its own MAX_VISIBLE constant', () => {
  assert.match(SOURCE, /const MAX_VISIBLE_TICKET_PREPARATIONS = \d+;/);
  assert.match(SOURCE, /const MAX_VISIBLE_MEAL_PREPARATIONS = \d+;/);
});

// ═══════════════════════════════════════════════════════════════════════
// navigation, completion workflow, production safety
// ═══════════════════════════════════════════════════════════════════════

test('row navigation still goes to Reservation Detail via the existing convention', () => {
  const start = SOURCE.indexOf('function _DashboardPrepRow(');
  const end = SOURCE.indexOf('\n}', start);
  const body = SOURCE.slice(start, end);
  assert.match(body, /onClick=\{\(\)\s*=>\s*_goToPreparationReservation\(row\.reservationId\)\}/);
});

test('Dashboard still contains no completion action anywhere in the refined section', () => {
  const body = _turHazirliklariBody();
  assert.doesNotMatch(body, /_canCompletePreparation|handleCompletePreparation|<button/);
});

test('the completion workflow repository method is untouched by this phase', () => {
  const start = SOURCE.indexOf('async complete(id){');
  const end = SOURCE.indexOf('\n  },', start);
  const body = SOURCE.slice(start, end);
  assert.match(body, /\.eq\('status', 'pending'\)/);
  assert.match(body, /\.maybeSingle\(\)/);
});

// ═══════════════════════════════════════════════════════════════════════
// query architecture: still exactly 2 bounded queries, no N+1
// ═══════════════════════════════════════════════════════════════════════

test('the 2-query architecture is preserved — useTurHazirliklariRows still issues exactly 2 useRepo calls', () => {
  const start = SOURCE.indexOf('function useTurHazirliklariRows()');
  const end = SOURCE.indexOf('\n}', start);
  const body = SOURCE.slice(start, end);
  const calls = body.match(/useRepo\(/g) || [];
  assert.equal(calls.length, 2);
});

test('getUpcomingPending still performs exactly one query and never queries tour_preparation_rules or infers from itinerary/tour name', () => {
  const start = SOURCE.indexOf('async getUpcomingPending()');
  const end = SOURCE.indexOf('\n  },', start);
  const body = SOURCE.slice(start, end);
  assert.match(body, /\.from\('reservation_preparations'\)/);
  const fromCalls = body.match(/\.from\(/g) || [];
  assert.equal(fromCalls.length, 1);
  assert.doesNotMatch(body, /tour_preparation_rules/);
  assert.doesNotMatch(body, /itinerary/i);
});

test('getUpcomingMealIncluded still reads meal_status only and performs exactly one query', () => {
  const start = SOURCE.indexOf('async getUpcomingMealIncluded()');
  const end = SOURCE.indexOf('\n  },', start);
  const body = SOURCE.slice(start, end);
  assert.match(body, /\.eq\('meal_status','included'\)/);
  assert.doesNotMatch(body, /reservation_preparations/);
  const fromCalls = body.match(/\.from\(/g) || [];
  assert.equal(fromCalls.length, 1);
});

test('no database write and no materialization RPC anywhere in the new grouping/summary/formatting helpers', () => {
  const helpersStart = SOURCE.indexOf('// TESTABLE:_groupTourPreparationRows:start');
  const helpersEnd = SOURCE.indexOf('// TESTABLE:_formatMealQuantityLabel:end') + '// TESTABLE:_formatMealQuantityLabel:end'.length;
  const helpers = SOURCE.slice(helpersStart, helpersEnd);
  assert.doesNotMatch(helpers, /\.insert\(|\.update\(|\.delete\(|\.upsert\(|\.rpc\(/);
  assert.doesNotMatch(helpers, /materialize_reservation_preparations/);
  assert.doesNotMatch(helpers, /whatsapp/i);
});

// ═══════════════════════════════════════════════════════════════════════
// MobileHomePage reuses the exact same hook and helpers (no separate
// business logic, only presentation differs)
// ═══════════════════════════════════════════════════════════════════════

test('MobileHomePage reuses useTurHazirliklariRows and the same grouping/summary helpers — no separate query, no separate filtering logic', () => {
  const start = SOURCE.indexOf('function MobileHomePage(');
  const end = SOURCE.indexOf('\nfunction ', start + 10);
  const body = SOURCE.slice(start, end);
  assert.match(body, /useTurHazirliklariRows\(\)/);
  assert.match(body, /_groupTourPreparationRows\(/);
  assert.match(body, /_summarizeTicketPreparations\(/);
  assert.match(body, /_summarizeMealPreparations\(/);
  assert.match(body, /Bilet Hazırlıkları/);
  assert.match(body, /Yemek Hazırlıkları/);
  // Never a second, independent useRepo("reservationPreparation", ...)
  // or useRepo("reservation", "getUpcomingMealIncluded") call site inside
  // MobileHomePage itself — it must come from the shared hook only.
  assert.doesNotMatch(body, /useRepo\("reservationPreparation"/);
  assert.doesNotMatch(body, /useRepo\("reservation",\s*"getUpcomingMealIncluded"\)/);
});

test('MobileHomePage has no completion action either', () => {
  const start = SOURCE.indexOf('function MobileHomePage(');
  const end = SOURCE.indexOf('\nfunction ', start + 10);
  const body = SOURCE.slice(start, end);
  assert.doesNotMatch(body, /_canCompletePreparation|handleCompletePreparation/);
});
