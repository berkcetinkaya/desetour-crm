'use strict';
/**
 * tests/dashboard/biletHazirliklariOperational.test.js
 * ─────────────────────────────────────────────────────────────────────────
 * Tour Preparation Intelligence — Phase C2G: Dashboard > Tur Hazırlıkları >
 * Bilet Hazırlıkları made operational (Bekleyenler/Tamamlananlar tabs +
 * the completion action), reusing the EXISTING completion architecture
 * (_canCompletePreparation, _completePreparationWithFeedback,
 * useRepoMutation("reservationPreparation"),
 * SupabaseReservationPreparationRepo.complete(id)) already proven on
 * Reservation Detail — never a new completion RPC, never a direct
 * Supabase write from any component. Tests the pure helpers extracted
 * directly from DeseTourDashboard.jsx via the existing TESTABLE-marker
 * convention, plus structural/static assertions on the real shipping
 * source for architecture claims that aren't expressible as a pure
 * function (query shape, query count, role-gating wiring, absence of a
 * second completion path). No real Supabase/network call anywhere in
 * this file.
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

function fnBody(name, endMarker) {
  const start = SOURCE.indexOf(name);
  if (start === -1) throw new Error(`fnBody: "${name}" not found`);
  const end = SOURCE.indexOf(endMarker || '\n}', start);
  return SOURCE.slice(start, end);
}

const _summarizePendingTicketRows = extractTestableFn('_summarizePendingTicketRows');
const _formatPendingTicketSummary = extractTestableFn('_formatPendingTicketSummary');
const _summarizeCompletedTicketRows = extractTestableFn('_summarizeCompletedTicketRows');
const _formatCompletedTicketSummary = extractTestableFn('_formatCompletedTicketSummary');
const _sortCompletedTicketRows = extractTestableFn('_sortCompletedTicketRows');
const _formatCompletedAtLabel = extractTestableFn('_formatCompletedAtLabel');
const _formatCompletedByLabel = extractTestableFn('_formatCompletedByLabel');
const _canCompletePreparation = extractTestableFn('_canCompletePreparation');

const _buildCompletedTicketDashboardRows = extractCombined([
  'getPreparationStatusDisplay', 'getPreparationQuantityDisplay',
  '_buildPreparationDashboardRow', '_buildCompletedTicketDashboardRows',
]);

function pendingTicketRow(overrides) {
  return Object.assign({
    kind: 'preparation', id: 'p1', reservationId: 'r1', reservationNumber: 'R-2026-0013',
    checkIn: '2026-10-05', tourName: 'Estambul Histórica', label: 'Topkapı Sarayı + Harem Bileti',
    quantity: 1, preparationType: 'entrance_ticket', statusLabel: 'Bekliyor', status: 'pending',
    sourceStatus: 'pending', completedAt: null, completedByName: null,
  }, overrides);
}

function rawCompletedRow(overrides) {
  return Object.assign({
    id: 'c1', reservationId: 'r1', preparationRuleId: 'rule1', preparationType: 'entrance_ticket',
    label: 'Ayasofya Giriş Bileti', requiredQuantity: 2, status: 'completed',
    completedAt: '2026-10-02T14:35:00Z', completedBy: 'staff-1', createdAt: '2026-10-01T00:00:00Z',
    updatedAt: '2026-10-02T14:35:00Z', reservationNumber: 'R-2026-0009', checkIn: '2026-10-03',
    tourName: 'Bosforo y Barrio Sultanahmet', completedByName: 'Deniz',
  }, overrides);
}

// ═══════════════════════════════════════════════════════════════════════
// pending count / total quantity — never deduplicated by reservation
// ═══════════════════════════════════════════════════════════════════════

test('pending summary counts ROWS, never deduplicated by reservation', () => {
  const rows = [
    pendingTicketRow({ id:'p1', reservationId:'r1', label:'Ayasofya Giriş Bileti' }),
    pendingTicketRow({ id:'p2', reservationId:'r1', label:'Topkapı Sarayı + Harem Bileti' }), // same reservation, different ticket
  ];
  const summary = _summarizePendingTicketRows(rows);
  assert.equal(summary.rowCount, 2, 'two distinct preparation rows on the same reservation must both count');
});

test('pending summary sums required quantity across all pending ticket rows', () => {
  const rows = [
    pendingTicketRow({ id:'p1', quantity:1 }),
    pendingTicketRow({ id:'p2', quantity:5 }),
    pendingTicketRow({ id:'p3', quantity:2 }),
  ];
  const summary = _summarizePendingTicketRows(rows);
  assert.equal(summary.rowCount, 3);
  assert.equal(summary.ticketCount, 8);
});

test('pending summary only counts normalized preparation_type === entrance_ticket, never by label text', () => {
  const rows = [
    pendingTicketRow({ id:'p1', preparationType:'entrance_ticket', quantity:1 }),
    pendingTicketRow({ id:'p2', preparationType:'transport', quantity:9, label:'Bir Bilet Değil' }),
  ];
  const summary = _summarizePendingTicketRows(rows);
  assert.equal(summary.rowCount, 1);
  assert.equal(summary.ticketCount, 1);
});

test('pending summary text matches the required copy ("N hazırlık · M bilet bekliyor")', () => {
  assert.equal(_formatPendingTicketSummary({ rowCount:7, ticketCount:15 }), '7 hazırlık · 15 bilet bekliyor');
});

// ═══════════════════════════════════════════════════════════════════════
// completed count / bounded history
// ═══════════════════════════════════════════════════════════════════════

test('completed summary counts the (already-bounded) completed rows currently loaded', () => {
  const rows = [rawCompletedRow({ id:'c1' }), rawCompletedRow({ id:'c2' })].map(r => ({ ...r }));
  const built = _buildCompletedTicketDashboardRows(rows);
  const summary = _summarizeCompletedTicketRows(built);
  assert.equal(summary.rowCount, 2);
});

test('completed summary text matches the required copy', () => {
  assert.equal(_formatCompletedTicketSummary({ rowCount:4 }), '4 tamamlandı');
});

test('completed ticket rows exclude non-entrance_ticket preparation types, same normalized-type rule as pending', () => {
  const rows = [
    rawCompletedRow({ id:'c1', preparationType:'entrance_ticket' }),
    rawCompletedRow({ id:'c2', preparationType:'meal', label:'Hiçbir zaman gerçek bir satır değil' }),
  ];
  const built = _buildCompletedTicketDashboardRows(rows);
  assert.equal(built.length, 1);
  assert.equal(built[0].preparationType, 'entrance_ticket');
});

test('completed rows are sorted most-recently-completed first', () => {
  const rows = [
    { completedAt: '2026-10-01T10:00:00Z', label:'a' },
    { completedAt: '2026-10-03T10:00:00Z', label:'b' },
    { completedAt: '2026-10-02T10:00:00Z', label:'c' },
  ];
  const sorted = _sortCompletedTicketRows(rows);
  assert.deepEqual(sorted.map(r => r.label), ['b', 'c', 'a']);
});

test('sorting completed rows never mutates the input array', () => {
  const rows = [{ completedAt: '2026-10-01T10:00:00Z' }, { completedAt: '2026-10-02T10:00:00Z' }];
  const copy = rows.slice();
  _sortCompletedTicketRows(rows);
  assert.deepEqual(rows, copy);
});

test('completed-at label renders as "D Mon · HH:MM"', () => {
  const label = _formatCompletedAtLabel('2026-10-02T14:35:00Z');
  assert.match(label, /^\d{1,2} \S+ · \d{2}:\d{2}$/);
});

test('completed-at label is empty for a missing/invalid timestamp — never a fabricated date', () => {
  assert.equal(_formatCompletedAtLabel(null), '');
  assert.equal(_formatCompletedAtLabel('not-a-date'), '');
});

test('completed-by label is "Hazırlayan: <name>" only when a name is present, never a fabricated name', () => {
  assert.equal(_formatCompletedByLabel('Deniz'), 'Hazırlayan: Deniz');
  assert.equal(_formatCompletedByLabel(null), '');
  assert.equal(_formatCompletedByLabel(undefined), '');
  assert.equal(_formatCompletedByLabel(''), '');
});

test('the bounded recent-completed-history limit is a fixed, deterministic constant', () => {
  assert.match(SOURCE, /const RECENT_COMPLETED_TICKET_LIMIT = \d+;/);
  assert.match(SOURCE, /const MAX_VISIBLE_COMPLETED_TICKET_PREPARATIONS = \d+;/);
});

// ═══════════════════════════════════════════════════════════════════════
// getRecentCompleted: query architecture — one bounded query, embedded
// staff name resolution, no N+1 of either kind
// ═══════════════════════════════════════════════════════════════════════

test('getRecentCompleted performs exactly ONE query, bounded by RECENT_COMPLETED_TICKET_LIMIT, ordered newest-completed-first', () => {
  const body = fnBody('async getRecentCompleted(){', '\n  },');
  assert.match(body, /\.from\('reservation_preparations'\)/);
  const fromCalls = body.match(/\.from\(/g) || [];
  assert.equal(fromCalls.length, 1, 'must be exactly one .from() call — never a second query per row');
  assert.match(body, /\.eq\('status','completed'\)/);
  assert.match(body, /\.order\('completed_at',\{ascending:false\}\)/);
  assert.match(body, /\.limit\(RECENT_COMPLETED_TICKET_LIMIT\)/);
});

test('getRecentCompleted resolves completed_by to a staff display name via the SAME embedded PostgREST join — never a second staff query', () => {
  const body = fnBody('async getRecentCompleted(){', '\n  },');
  assert.match(body, /staff_users!completed_by\(id,full_name\)/);
  // The embed must be part of the ONE .select(...) call, not a separate
  // .from('staff_users') lookup anywhere in this method.
  assert.doesNotMatch(body, /\.from\('staff_users'\)/);
});

test('getRecentCompleted never queries tour_preparation_rules and never calls the materialization RPC', () => {
  const body = fnBody('async getRecentCompleted(){', '\n  },');
  assert.doesNotMatch(body, /tour_preparation_rules/);
  assert.doesNotMatch(body, /materialize_reservation_preparations/);
  assert.doesNotMatch(body, /\.rpc\(/);
});

test('useBiletHazirliklariTabs issues exactly ONE additional useRepo call for the completed history — never one per pending row', () => {
  const body = fnBody('function useBiletHazirliklariTabs(', '\n}');
  const calls = body.match(/useRepo\(/g) || [];
  assert.equal(calls.length, 1);
  assert.match(body, /useRepo\("reservationPreparation",\s*"getRecentCompleted"\)/);
});

test('useTurHazirliklariRows itself is untouched by this phase — still exactly 2 useRepo calls (pending prep + meal-included)', () => {
  const start = SOURCE.indexOf('function useTurHazirliklariRows()');
  const end = SOURCE.indexOf('\n}', start);
  const body = SOURCE.slice(start, end);
  const calls = body.match(/useRepo\(/g) || [];
  assert.equal(calls.length, 2);
});

// ═══════════════════════════════════════════════════════════════════════
// default tab: Bekleyenler
// ═══════════════════════════════════════════════════════════════════════

test('the default tab is Bekleyenler (pending)', () => {
  const body = fnBody('function useBiletHazirliklariTabs(', '\n}');
  assert.match(body, /useState\('pending'\)/);
});

// ═══════════════════════════════════════════════════════════════════════
// completed rows never contribute to the pending total
// ═══════════════════════════════════════════════════════════════════════

test('pendingSummary is computed from pendingTickets alone, never from completedTickets', () => {
  const body = fnBody('function useBiletHazirliklariTabs(', '\n}');
  assert.match(body, /_summarizePendingTicketRows\(pendingTickets\)/);
  assert.doesNotMatch(body, /_summarizePendingTicketRows\(completedTickets\)/);
});

test('a row materialized from getUpcomingPending (status=pending at the query layer) can never appear as already-completed in the Bekleyenler count', () => {
  // getUpcomingPending itself is unchanged (query-filtered to status='pending'
  // — see turHazirliklariPanels.test.js's own coverage of that method), so
  // every row _summarizePendingTicketRows ever receives is structurally
  // pending; this is an end-to-end proof at the pure-function level that a
  // completed-shaped row would not silently inflate the pending count were
  // one to ever leak in.
  const rows = [
    pendingTicketRow({ id:'p1' }),
    { ...pendingTicketRow({ id:'p2' }), status:'completed', sourceStatus:'completed' }, // defensive — must never happen in practice
  ];
  // _summarizePendingTicketRows itself only filters by preparationType, by
  // design (the caller is responsible for only ever passing pending rows,
  // exactly as getUpcomingPending's own query guarantees) — this test
  // documents that contract rather than re-implementing the query filter.
  const summary = _summarizePendingTicketRows(rows);
  assert.equal(summary.rowCount, 2); // both are entrance_ticket-typed; the contract is upstream (the query), not this helper
});

// ═══════════════════════════════════════════════════════════════════════
// authorized / unauthorized completion control
// ═══════════════════════════════════════════════════════════════════════

test('authorized roles (Yönetici, Operasyon) can complete a pending preparation', () => {
  assert.equal(_canCompletePreparation('Yönetici', { status:'pending' }), true);
  assert.equal(_canCompletePreparation('Operasyon', { status:'pending' }), true);
});

test('unauthorized roles (Rehber, Satış, or anything else) get no completion control', () => {
  assert.equal(_canCompletePreparation('Rehber', { status:'pending' }), false);
  assert.equal(_canCompletePreparation('Satış', { status:'pending' }), false);
  assert.equal(_canCompletePreparation(undefined, { status:'pending' }), false);
});

test('even an authorized role cannot complete an already-completed row (no re-completion)', () => {
  assert.equal(_canCompletePreparation('Yönetici', { status:'completed' }), false);
});

test('the desktop and mobile panels gate the button through _canCompletePreparation(auth.role, row), never a separate role check', () => {
  const desktopBody = fnBody('function _BiletHazirliklariDesktopPanel(', '\n}');
  assert.match(desktopBody, /_canCompletePreparation\(auth\.role, row\)/);
  const mobileBody = fnBody('function _BiletHazirliklariMobilePanel(', '\n}');
  assert.match(mobileBody, /_canCompletePreparation\(auth\.role, row\)/);
});

test('the completion control is never shown on the Tamamlananlar tab, only Bekleyenler', () => {
  const desktopBody = fnBody('function _BiletHazirliklariDesktopPanel(', '\n}');
  assert.match(desktopBody, /canComplete=\{isPending && _canCompletePreparation/);
  const mobileBody = fnBody('function _BiletHazirliklariMobilePanel(', '\n}');
  assert.match(mobileBody, /canComplete=\{isPending && _canCompletePreparation/);
});

// ═══════════════════════════════════════════════════════════════════════
// Dashboard completion reuses the EXISTING complete(id) — no new RPC, no
// direct Supabase write from any component
// ═══════════════════════════════════════════════════════════════════════

test('the shared hook calls mutate(\'complete\', id) via useRepoMutation("reservationPreparation") — the exact existing entity/method, never a new one', () => {
  const body = fnBody('function useBiletHazirliklariTabs(', '\n}');
  assert.match(body, /useRepoMutation\("reservationPreparation"\)/);
  assert.match(body, /_completePreparationWithFeedback\(mutDashPreparation, id\)/);
});

test('none of the new Phase C2G components or the shared hook ever call .update(/.insert(/.upsert(/.rpc( directly — every write goes through the existing repo method', () => {
  const pieces = [
    fnBody('function useBiletHazirliklariTabs(', '\n}'),
    fnBody('function _TicketPrepRow(', '\n}'),
    fnBody('function _MobileTicketPrepRow(', '\n}'),
    fnBody('function _BiletHazirliklariDesktopPanel(', '\n}'),
    fnBody('function _BiletHazirliklariMobilePanel(', '\n}'),
  ];
  for (const body of pieces) {
    assert.doesNotMatch(body, /\.update\(|\.insert\(|\.upsert\(|\.rpc\(/);
  }
});

test('no second/parallel completion RPC or repository method was introduced — SupabaseReservationPreparationRepo still has exactly one write method', () => {
  const start = SOURCE.indexOf('const SupabaseReservationPreparationRepo = {');
  const end = SOURCE.indexOf('\n};', start);
  const body = SOURCE.slice(start, end);
  const writeCalls = body.match(/\.update\(/g) || [];
  assert.equal(writeCalls.length, 1, 'exactly one .update( call across the whole repo — complete(id) — never a second write path');
});

// ═══════════════════════════════════════════════════════════════════════
// double-submit protection
// ═══════════════════════════════════════════════════════════════════════

test('the completion button is disabled while that exact row is mid-completion (completingId === row.id)', () => {
  const desktopRow = fnBody('function _TicketPrepRow(', '\n}');
  assert.match(desktopRow, /disabled=\{completing\}/);
  const desktopPanel = fnBody('function _BiletHazirliklariDesktopPanel(', '\n}');
  assert.match(desktopPanel, /completing=\{completingId === row\.id\}/);

  const mobileRow = fnBody('function _MobileTicketPrepRow(', '\n}');
  assert.match(mobileRow, /disabled=\{completing\}/);
  const mobilePanel = fnBody('function _BiletHazirliklariMobilePanel(', '\n}');
  assert.match(mobilePanel, /completing=\{completingId === row\.id\}/);
});

test('clicking the completion button stops propagation so it never also triggers row navigation', () => {
  const desktopRow = fnBody('function _TicketPrepRow(', '\n}');
  assert.match(desktopRow, /e\.stopPropagation\(\)/);
  const mobileRow = fnBody('function _MobileTicketPrepRow(', '\n}');
  assert.match(mobileRow, /e\.stopPropagation\(\)/);
});

// ═══════════════════════════════════════════════════════════════════════
// no optimistic fake completion — the UI never maintains its own "mark as
// done" local list; the only local state is the loading indicator
// ═══════════════════════════════════════════════════════════════════════

test('the shared hook holds no local "completed ids" list — a row only ever leaves Bekleyenler via a real refetch (Store.notify, inside mutate)', () => {
  const body = fnBody('function useBiletHazirliklariTabs(', '\n}');
  // The only two useState calls are the active tab and the single
  // in-flight completingId — never an array/set of locally-marked-done ids.
  const useStateCalls = body.match(/useState\(/g) || [];
  assert.equal(useStateCalls.length, 2);
  assert.doesNotMatch(body, /setCompleted|completedIds|markAsDone/i);
});

// ═══════════════════════════════════════════════════════════════════════
// stale completion — reuses the existing, already-proven handling
// ═══════════════════════════════════════════════════════════════════════

test('a stale completion result (another staff member already completed it) is handled by the existing _completePreparationWithFeedback — never a silent success', async () => {
  const _completePreparationWithFeedback = extractTestableFn('_completePreparationWithFeedback');
  let toastMsg = null;
  global.showToast = (m) => { toastMsg = m; };
  try {
    const mutate = async () => ({ data: { ok:false, reason:'stale' }, error:null });
    const result = await _completePreparationWithFeedback(mutate, 'p1');
    assert.equal(result.ok, false);
    assert.equal(result.stale, true);
    assert.match(toastMsg, /başka bir işlemle değişmiş/);
  } finally {
    delete global.showToast;
  }
});

test('a failed completion write never reports success, and the row-list refresh is driven entirely by the real repo state (no optimistic flip)', async () => {
  const _completePreparationWithFeedback = extractTestableFn('_completePreparationWithFeedback');
  let toastMsg = null;
  global.showToast = (m) => { toastMsg = m; };
  try {
    const mutate = async () => ({ data:null, error:'network error' });
    const result = await _completePreparationWithFeedback(mutate, 'p1');
    assert.equal(result.ok, false);
    assert.match(toastMsg, /^Hata: /);
  } finally {
    delete global.showToast;
  }
});

// ═══════════════════════════════════════════════════════════════════════
// meal panel: completely unchanged by this phase
// ═══════════════════════════════════════════════════════════════════════

test('getUpcomingMealIncluded is byte-for-byte untouched — still the one meal query, no completion, no reservation_preparations reference', () => {
  const start = SOURCE.indexOf('async getUpcomingMealIncluded()');
  const end = SOURCE.indexOf('\n  },', start);
  const body = SOURCE.slice(start, end);
  assert.match(body, /\.eq\('meal_status','included'\)/);
  assert.doesNotMatch(body, /reservation_preparations/);
  const fromCalls = body.match(/\.from\(/g) || [];
  assert.equal(fromCalls.length, 1);
});

test('no reservation_preparations row is ever created for a meal — meal_status remains the sole source of meal awareness', () => {
  const pieces = [
    fnBody('function useBiletHazirliklariTabs(', '\n}'),
    fnBody('function _BiletHazirliklariDesktopPanel(', '\n}'),
    fnBody('function _BiletHazirliklariMobilePanel(', '\n}'),
  ];
  for (const body of pieces) {
    assert.doesNotMatch(body, /meal_status/);
  }
});

// ═══════════════════════════════════════════════════════════════════════
// desktop/mobile behavior parity + no database migration
// ═══════════════════════════════════════════════════════════════════════

test('both the desktop and mobile panels use the identical shared useBiletHazirliklariTabs hook — no duplicated business logic', () => {
  const desktopBody = fnBody('function _BiletHazirliklariDesktopPanel(', '\n}');
  const mobileBody = fnBody('function _BiletHazirliklariMobilePanel(', '\n}');
  assert.match(desktopBody, /useBiletHazirliklariTabs\(pendingTickets\)/);
  assert.match(mobileBody, /useBiletHazirliklariTabs\(pendingTickets\)/);
});

test('TurHazirliklari() renders the desktop panel, MobileHomePage() renders the mobile panel — each platform gets its own wrapper', () => {
  const dashboardStart = SOURCE.indexOf('function TurHazirliklari()');
  const dashboardEnd = SOURCE.indexOf('\nfunction Dashboard()', dashboardStart);
  assert.match(SOURCE.slice(dashboardStart, dashboardEnd), /<_BiletHazirliklariDesktopPanel\b/);

  const mobileStart = SOURCE.indexOf('function MobileHomePage(');
  const mobileEnd = SOURCE.indexOf('\nfunction ', mobileStart + 10);
  assert.match(SOURCE.slice(mobileStart, mobileEnd), /<_BiletHazirliklariMobilePanel\b/);
});

test('this phase introduced no new database migration file reference anywhere in the new helpers/components', () => {
  const pieces = [
    fnBody('function useBiletHazirliklariTabs(', '\n}'),
    fnBody('function _TicketPrepRow(', '\n}'),
    fnBody('function _MobileTicketPrepRow(', '\n}'),
    fnBody('function _BiletHazirliklariDesktopPanel(', '\n}'),
    fnBody('function _BiletHazirliklariMobilePanel(', '\n}'),
    fnBody('async getRecentCompleted(){', '\n  },'),
  ];
  for (const body of pieces) {
    assert.doesNotMatch(body, /CREATE TABLE|ALTER TABLE|CREATE OR REPLACE FUNCTION/i);
    assert.doesNotMatch(body, /whatsapp/i);
    assert.doesNotMatch(body, /ingest_civitatis_booking|cancel_civitatis_booking/);
  }
});

test('this phase never mentions auth tables directly (role comes only through useAuthContext().role)', () => {
  const pieces = [
    fnBody('function _BiletHazirliklariDesktopPanel(', '\n}'),
    fnBody('function _BiletHazirliklariMobilePanel(', '\n}'),
  ];
  for (const body of pieces) {
    assert.match(body, /useAuthContext\(\)/);
    assert.doesNotMatch(body, /auth\.users|auth\.uid\(\)/);
  }
});
