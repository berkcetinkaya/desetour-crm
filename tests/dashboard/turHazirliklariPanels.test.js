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
  // Phase C2G: the ticket panel's title/tabs/rows/completion all moved
  // into _BiletHazirliklariDesktopPanel (so Bekleyenler/Tamamlananlar
  // state can live in its own component) — TurHazirliklari() itself now
  // only renders that sub-component inside the hasTickets-guarded cell.
  assert.match(body, /<_BiletHazirliklariDesktopPanel\b/);
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
  // Meal overflow text is still rendered directly inside TurHazirliklari().
  assert.match(body, /diğer yemek hazırlığı/);
  assert.doesNotMatch(body, /\+ \{remaining\} diğer hazırlık[^ı]/); // old single-list overflow text is gone

  // Phase C2G: ticket overflow text now lives inside
  // _BiletHazirliklariDesktopPanel (tab-aware: "diğer bilet hazırlığı" for
  // Bekleyenler, "diğer tamamlanan hazırlık" for Tamamlananlar).
  const panelStart = SOURCE.indexOf('function _BiletHazirliklariDesktopPanel(');
  const panelEnd = SOURCE.indexOf('\n}', panelStart);
  const panelBody = SOURCE.slice(panelStart, panelEnd);
  assert.match(panelBody, /diğer bilet hazırlığı/);
  assert.match(panelBody, /diğer tamamlanan hazırlık/);
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

// Phase C2G superseded this C2D-4-era expectation: the ticket panel now
// DOES support a completion action (that is the whole point of C2G), via
// the shared, existing _canCompletePreparation/mutate('complete', id)
// architecture — never a new one. What must remain true is narrower and
// more precise: TurHazirliklari()'s OWN orchestration body still has none
// directly (it only renders the sub-components below), and the MEAL
// panel's own rendered block still has none at all, in either the
// orchestrator or the sub-component that renders it.
test('TurHazirliklari() itself still has no completion action directly — it only renders the two panel sub-components', () => {
  const body = _turHazirliklariBody();
  assert.doesNotMatch(body, /_canCompletePreparation|handleCompletePreparation|useRepoMutation/);
});

test('the ticket panel (desktop) now supports the completion action via the existing shared architecture', () => {
  // The completion action spans three cooperating pieces: the panel
  // (role check), the row component (the button itself), and the shared
  // hook (the actual mutate call) — assert each claim against the piece
  // that actually contains it, rather than assuming they're all inlined
  // in one function.
  const panelStart = SOURCE.indexOf('function _BiletHazirliklariDesktopPanel(');
  const panelBody = SOURCE.slice(panelStart, SOURCE.indexOf('\n}', panelStart));
  assert.match(panelBody, /_canCompletePreparation\(/);

  const rowStart = SOURCE.indexOf('function _TicketPrepRow(');
  const rowBody = SOURCE.slice(rowStart, SOURCE.indexOf('\n}', rowStart));
  assert.match(rowBody, /Hazırlandı/);

  const hookStart = SOURCE.indexOf('function useBiletHazirliklariTabs(');
  const hookBody = SOURCE.slice(hookStart, SOURCE.indexOf('\n}', hookStart));
  // Reuses the existing shared helper — never a second completion
  // implementation inlined here.
  assert.match(hookBody, /_completePreparationWithFeedback\(/);
});

test('the meal panel body (hasMeals block) still has no completion action of any kind', () => {
  const body = _turHazirliklariBody();
  const mealStart = body.indexOf('{hasMeals && (');
  assert.ok(mealStart !== -1, 'expected a {hasMeals && (...)} block');
  const mealEnd = body.indexOf('\n        )}', mealStart);
  const mealBody = body.slice(mealStart, mealEnd === -1 ? undefined : mealEnd);
  assert.doesNotMatch(mealBody, /_canCompletePreparation|handleCompletePreparation|useRepoMutation|Hazırlandı|<button/);
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
  // Phase C2G: the ticket summary now comes from the SAME shared
  // useBiletHazirliklariTabs hook / _summarizePendingTicketRows helper
  // the desktop panel uses too (via _BiletHazirliklariMobilePanel) —
  // MobileHomePage itself no longer calls _summarizeTicketPreparations
  // directly, same as the desktop TurHazirliklari() no longer does.
  assert.match(body, /<_BiletHazirliklariMobilePanel\b/);
  assert.match(body, /_summarizeMealPreparations\(/);
  assert.match(body, /Yemek Hazırlıkları/);
  // Never a second, independent useRepo("reservationPreparation", ...)
  // or useRepo("reservation", "getUpcomingMealIncluded") call site inside
  // MobileHomePage itself — it must come from the shared hooks only.
  assert.doesNotMatch(body, /useRepo\("reservationPreparation"/);
  assert.doesNotMatch(body, /useRepo\("reservation",\s*"getUpcomingMealIncluded"\)/);
});

// Phase C2G superseded this C2D-4-era expectation the same way the
// desktop test above was updated: the mobile ticket panel now DOES
// support completion, via the shared architecture — but MobileHomePage's
// own orchestration body still has none directly, and the meal section
// still has none at all.
test('MobileHomePage() itself still has no completion action directly — it only renders the ticket/meal sub-components', () => {
  const start = SOURCE.indexOf('function MobileHomePage(');
  const end = SOURCE.indexOf('\nfunction ', start + 10);
  const body = SOURCE.slice(start, end);
  assert.doesNotMatch(body, /_canCompletePreparation|handleCompletePreparation|useRepoMutation/);
});

test('the ticket panel (mobile) now supports the completion action via the existing shared architecture', () => {
  const panelStart = SOURCE.indexOf('function _BiletHazirliklariMobilePanel(');
  const panelBody = SOURCE.slice(panelStart, SOURCE.indexOf('\n}', panelStart));
  assert.match(panelBody, /_canCompletePreparation\(/);

  const rowStart = SOURCE.indexOf('function _MobileTicketPrepRow(');
  const rowBody = SOURCE.slice(rowStart, SOURCE.indexOf('\n}', rowStart));
  assert.match(rowBody, /Hazırlandı/);

  // Same shared hook as desktop — asserted already in the desktop test
  // above, not repeated verbatim here, but confirmed structurally: the
  // mobile panel calls the identical useBiletHazirliklariTabs hook.
  assert.match(panelBody, /useBiletHazirliklariTabs\(/);
});

test('the mobile meal section (hasMeals block) still has no completion action of any kind', () => {
  const start = SOURCE.indexOf('function MobileHomePage(');
  const end = SOURCE.indexOf('\nfunction ', start + 10);
  const body = SOURCE.slice(start, end);
  const mealStart = body.indexOf('{hasMeals && (');
  assert.ok(mealStart !== -1, 'expected a {hasMeals && (...)} block');
  const mealEnd = body.indexOf('\n            )}', mealStart);
  const mealBody = body.slice(mealStart, mealEnd === -1 ? undefined : mealEnd);
  assert.doesNotMatch(mealBody, /_canCompletePreparation|handleCompletePreparation|useRepoMutation|Hazırlandı|<button/);
});
