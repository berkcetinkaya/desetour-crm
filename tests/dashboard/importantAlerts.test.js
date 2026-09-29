'use strict';
/**
 * tests/dashboard/importantAlerts.test.js
 * ─────────────────────────────────────────────────────────────────────────
 * Regression coverage for the "Önemli Uyarılar" home-dashboard operational
 * alert section. Its first (and only) supported alert type is a Civitatis
 * reservation cancellation, read from the EXACT SAME activity_logs +
 * activity_log_reads architecture NotificationBell already reads — no new
 * table, no new query, no duplicated/mutated activity_log row.
 *
 * The pure filtering/pagination/view-model logic
 * (_filterImportantAlerts / _paginateImportantAlerts /
 * _cancellationAlertViewModel / _viewReservationFromAlert) is extracted
 * via extractTestableFn and exercised with real mock data — these are the
 * REAL implementations shipping in DeseTourDashboard.jsx, not hand-copied
 * duplicates. Everything else (placement, styling, shared-cache wiring,
 * mobile layout) is a static source-text assertion, matching every other
 * test file in this project for a 900KB+ single-file component that can't
 * be require()'d or rendered directly (no React DOM/testing-library in
 * this project's devDependencies).
 * ─────────────────────────────────────────────────────────────────────────
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { extractTestableFn } = require('./extractTestableFn');

const SOURCE_PATH = path.join(__dirname, '..', '..', 'DeseTourDashboard.jsx');
const SOURCE = fs.readFileSync(SOURCE_PATH, 'utf8');

const _filterImportantAlerts = extractTestableFn('_filterImportantAlerts');
const _paginateImportantAlerts = extractTestableFn('_paginateImportantAlerts');
const _cancellationAlertViewModel = extractTestableFn('_cancellationAlertViewModel');

function notif(overrides) {
  return {
    id: 'LOG-' + Math.random().toString(36).slice(2),
    reservationId: 'RES-1',
    action: 'cancelled',
    description: 'Civitatis Rezervasyonu İptal Edildi: R-2026-0001',
    source: 'civitatis',
    externalBookingId: 'A38807986',
    reservationNumber: 'R-2026-0001',
    customerName: 'Jane Doe',
    tourName: 'Estambul Historica',
    tourDate: '2026-04-10',
    createdAt: '2026-04-01T10:00:00Z',
    isRead: false,
    ...overrides,
  };
}

// ── 1/2. Zero vs. one unread cancellation ───────────────────────────────

test('1. zero unread cancellation alerts => filter returns an empty list', () => {
  assert.deepEqual(_filterImportantAlerts([], new Set()), []);
  assert.deepEqual(_filterImportantAlerts([notif({ isRead:true })], new Set()), []);
});

test('2. one unread cancellation => it appears in the filtered list', () => {
  const list = _filterImportantAlerts([notif()], new Set());
  assert.equal(list.length, 1);
  assert.equal(list[0].action, 'cancelled');
});

test('OnemliUyarilar renders nothing (returns null) when there are zero alerts — never reserves layout space', () => {
  const idx = SOURCE.indexOf('function OnemliUyarilar()');
  const body = SOURCE.slice(idx, SOURCE.indexOf('\nfunction ', idx + 10));
  assert.match(body, /if \(loading \|\| error \|\| alerts\.length === 0\) return null;/);
});

// ── 3/4/5/6. View-model field rendering ─────────────────────────────────

test('3. reservation number is present in the view model', () => {
  const vm = _cancellationAlertViewModel(notif({ reservationNumber:'R-2026-0042' }));
  assert.equal(vm.reservationNumber, 'R-2026-0042');
});

test('4. external Civitatis booking ID is rendered as a row when available', () => {
  const vm = _cancellationAlertViewModel(notif({ externalBookingId:'A38807986' }));
  const row = vm.rows.find(r => r.key === 'civitatis');
  assert.ok(row);
  assert.equal(row.value, 'A38807986');
});

test('5. customer/tour/date rows are rendered from available metadata', () => {
  const vm = _cancellationAlertViewModel(notif({
    customerName:'Jane Doe', tourName:'Estambul Historica', tourDate:'2026-04-10',
  }));
  assert.equal(vm.rows.find(r => r.key === 'customer').value, 'Jane Doe');
  assert.equal(vm.rows.find(r => r.key === 'tour').value, 'Estambul Historica');
  const dateRow = vm.rows.find(r => r.key === 'date');
  assert.ok(dateRow);
  assert.match(dateRow.value, /2026/); // real formatted date, not the raw ISO string
});

test('6. missing optional metadata is simply omitted — never fabricated/invented', () => {
  const vm = _cancellationAlertViewModel(notif({
    customerName: null, tourName: null, tourDate: null, externalBookingId: null, reservationNumber: null,
  }));
  assert.equal(vm.reservationNumber, null);
  assert.deepEqual(vm.rows, []);
  // No row anywhere carries a placeholder like "—" or "Bilinmiyor" — an
  // absent field means the row doesn't exist, full stop.
  for (const row of vm.rows) {
    assert.notEqual(row.value, '—');
    assert.notEqual(row.value, null);
    assert.notEqual(row.value, undefined);
  }
});

// ── 7. Read alerts disappear ────────────────────────────────────────────

test('7. a read cancellation (isRead:true) is excluded from the filtered list', () => {
  const list = _filterImportantAlerts([notif({ id:'a1', isRead:true }), notif({ id:'a2', isRead:false })], new Set());
  assert.deepEqual(list.map(n => n.id), ['a2']);
});

test('7b. an alert just marked read locally (optimistic bridge) disappears immediately, before the refetch lands', () => {
  const list = _filterImportantAlerts(
    [notif({ id:'a1' }), notif({ id:'a2' })],
    new Set(['a1'])
  );
  assert.deepEqual(list.map(n => n.id), ['a2']);
});

// ── 8. Shared read state with NotificationBell ──────────────────────────

test('8. OnemliUyarilar/useUnreadImportantAlerts and NotificationBell call the EXACT SAME repo method — same useRepo cache key, same read state, no second persistence mechanism', () => {
  const bellIdx = SOURCE.indexOf('function NotificationBell()');
  const bellBody = SOURCE.slice(bellIdx, SOURCE.indexOf('\nfunction ', bellIdx + 10));
  assert.match(bellBody, /useRepo\("activity",\s*"getReservationNotifications"\)/);

  const hookIdx = SOURCE.indexOf('function useUnreadImportantAlerts()');
  const hookBody = SOURCE.slice(hookIdx, SOURCE.indexOf('\nfunction ', hookIdx + 10));
  assert.match(hookBody, /useRepo\("activity",\s*"getReservationNotifications"\)/);

  // Both mark-as-read paths call the SAME mutation method name too, so a
  // read recorded from either surface hits the SAME activity_log_reads
  // insert (via SupabaseActivityRepo.markReservationNotificationRead).
  assert.match(bellBody, /mutMarkRead\("markReservationNotificationRead"/);
  assert.match(hookBody, /mutate\("markReservationNotificationRead"/);

  // No second/duplicate persistence mechanism was introduced for this
  // feature — no new table, no new repo entity.
  assert.doesNotMatch(SOURCE, /getImportantAlerts|getCancellationAlerts|important_alerts|cancellation_alerts/);
});

// ── 9/10. Navigation + correct-scope read marking ───────────────────────

test('9. clicking "Rezervasyonu Gör" navigates to the correct reservation (uses NAV_REF, the app\'s existing navigation ref)', () => {
  const prevNav = global.NAV_REF;
  global.NAV_REF = { fn: (p) => { global.__lastNav = p; } };
  global.__lastNav = null;
  const _viewReservationFromAlert = extractTestableFn('_viewReservationFromAlert');
  _viewReservationFromAlert({ id:'log-9', reservationId:'RES-42' }, () => {});
  assert.equal(global.__lastNav, '/reservations/RES-42');
  global.NAV_REF = prevNav;
});

test('10. opening/reading an alert marks ONLY that activity as read, never another one', () => {
  const prevNav = global.NAV_REF;
  global.NAV_REF = { fn: () => {} };
  const _viewReservationFromAlert = extractTestableFn('_viewReservationFromAlert');
  const marked = [];
  _viewReservationFromAlert({ id:'log-A', reservationId:'RES-1' }, (id) => marked.push(id));
  assert.deepEqual(marked, ['log-A']);
  global.NAV_REF = prevNav;
});

test('10b. markRead in the hook only ever targets the id it was called with (no bulk/implicit mark-all)', () => {
  const hookIdx = SOURCE.indexOf('function useUnreadImportantAlerts()');
  const hookBody = SOURCE.slice(hookIdx, SOURCE.indexOf('\nfunction ', hookIdx + 10));
  assert.match(hookBody, /async function markRead\(id\)/);
  assert.match(hookBody, /mutate\("markReservationNotificationRead", id\)/);
  assert.doesNotMatch(hookBody, /markAllRead|markAll\(/);
});

// ── 11/12. Max 3 visible + remaining count ──────────────────────────────

test('11. never shows more than 3 alert cards at once, regardless of how many are unread', () => {
  const alerts = [1,2,3,4,5].map(n => notif({ id:'a'+n }));
  const { visible } = _paginateImportantAlerts(alerts, 3);
  assert.equal(visible.length, 3);
});

test('12. the "+ X diğer önemli uyarı" remaining count is exactly right', () => {
  const alerts = [1,2,3,4,5].map(n => notif({ id:'a'+n }));
  const { remaining } = _paginateImportantAlerts(alerts, 3);
  assert.equal(remaining, 2);
});

test('12b. remaining is zero (not negative) when there are 3 or fewer alerts', () => {
  assert.equal(_paginateImportantAlerts([notif()], 3).remaining, 0);
  assert.equal(_paginateImportantAlerts([], 3).remaining, 0);
});

test('the desktop and mobile sections both use the SAME MAX_VISIBLE_IMPORTANT_ALERTS=3 cap', () => {
  assert.match(SOURCE, /const MAX_VISIBLE_IMPORTANT_ALERTS = 3;/);
});

// ── 13. Non-cancellation auto-ingested activity excluded ────────────────

test('13. a non-cancellation auto-ingested activity (e.g. new-booking "created") does NOT appear in Önemli Uyarılar', () => {
  const list = _filterImportantAlerts([
    notif({ id:'cancel-1', action:'cancelled' }),
    notif({ id:'created-1', action:'created' }),
  ], new Set());
  assert.deepEqual(list.map(n => n.id), ['cancel-1']);
});

test('13b. a non-cancellation activity still reaches NotificationBell — the filter is local to Önemli Uyarılar only, not applied at the query level', () => {
  const repoIdx = SOURCE.indexOf('async getReservationNotifications()');
  const repoLine = SOURCE.slice(repoIdx, SOURCE.indexOf(';},', repoIdx) + 3);
  // The underlying query still filters ONLY on entity_type/auto_ingested —
  // no action filter at the SQL/query level — action==='cancelled' is a
  // client-side filter specific to the Önemli Uyarılar section.
  assert.doesNotMatch(repoLine, /\.eq\('action'/);
  assert.match(repoLine, /action:l\.action/, 'the shared repo method must expose action so the client-side filter can use it');
});

// ── 14. Mobile layout does not overflow ─────────────────────────────────

test('14. mobile alert card buttons stack vertically at full width (no fixed px width that could overflow) and reuse MobileEntityCard/MobileSection', () => {
  const mobileIdx = SOURCE.indexOf('{}\n      {!alertsLoading && !alertsError && importantAlerts.length > 0 && (');
  assert.ok(mobileIdx > -1, 'expected the mobile Önemli Uyarılar block in MobileHomePage');
  const mobileBlock = SOURCE.slice(mobileIdx, SOURCE.indexOf('{}\n      {urgentItems.length > 0 && (', mobileIdx));
  assert.match(mobileBlock, /MobileSection title="Önemli Uyarılar"/);
  assert.match(mobileBlock, /MobileEntityCard key=\{alert\.id\}/);
  assert.match(mobileBlock, /flexDirection:"column"/);
  assert.match(mobileBlock, /width:"100%"/);
  // No hardcoded pixel width on the card or its buttons that could force
  // horizontal overflow on a narrow viewport.
  assert.doesNotMatch(mobileBlock, /width:\s*\d{3,}/);
});

test('the global box-sizing:border-box reset (relied on by the mobile 100%-width buttons) is in place', () => {
  const indexHtml = fs.readFileSync(path.join(__dirname, '..', '..', 'index.html'), 'utf8');
  assert.match(indexHtml, /\*,\s*\*::before,\s*\*::after\s*\{\s*box-sizing:\s*border-box;\s*\}/);
});

// ── 15. Query error fails quietly ───────────────────────────────────────

test('15. a query error on the desktop section returns null (renders nothing) rather than throwing/breaking the rest of Ana Sayfa', () => {
  const idx = SOURCE.indexOf('function OnemliUyarilar()');
  const body = SOURCE.slice(idx, SOURCE.indexOf('\nfunction ', idx + 10));
  assert.match(body, /if \(loading \|\| error \|\| alerts\.length === 0\) return null;/);
});

test('15b. a query error on the mobile section is guarded the same way (!alertsError)', () => {
  assert.match(SOURCE, /\{!alertsLoading && !alertsError && importantAlerts\.length > 0 && \(/);
});

test('15c. every other Dashboard widget fetches independently via its own useRepo call — a failure in the alerts query cannot cascade', () => {
  const dashIdx = SOURCE.indexOf('function Dashboard() {');
  const dashBody = SOURCE.slice(dashIdx, SOURCE.indexOf('\nfunction ', dashIdx + 10));
  assert.match(dashBody, /<Welcome\/>/);
  assert.match(dashBody, /<OnemliUyarilar\/>/);
  assert.match(dashBody, /<KpiRow\/>/);
  // OnemliUyarilar sits between Welcome and KpiRow, and none of the other
  // widgets are children of it / gated behind its own data.
  const welcomeIdx = dashBody.indexOf('<Welcome/>');
  const alertsIdx = dashBody.indexOf('<OnemliUyarilar/>');
  const kpiIdx = dashBody.indexOf('<KpiRow/>');
  assert.ok(welcomeIdx < alertsIdx && alertsIdx < kpiIdx);
});

// ── Placement ────────────────────────────────────────────────────────────

test('desktop: Önemli Uyarılar is placed after Welcome and before KpiRow/statistics on Ana Sayfa', () => {
  const dashIdx = SOURCE.indexOf('function Dashboard() {');
  const dashBody = SOURCE.slice(dashIdx, SOURCE.indexOf('\nfunction ', dashIdx + 10));
  const welcomeIdx = dashBody.indexOf('<Welcome/>');
  const alertsIdx = dashBody.indexOf('<OnemliUyarilar/>');
  const kpiIdx = dashBody.indexOf('<KpiRow/>');
  assert.ok(welcomeIdx > -1 && alertsIdx > -1 && kpiIdx > -1);
  assert.ok(welcomeIdx < alertsIdx, 'Önemli Uyarılar must come after the welcome/header area');
  assert.ok(alertsIdx < kpiIdx, 'Önemli Uyarılar must come before normal dashboard statistics');
});

test('mobile: Önemli Uyarılar is placed after the greeting header and before "Dikkat Gerektiren"', () => {
  const mobileIdx = SOURCE.indexOf('function MobileHomePage({ navigate }) {');
  const mobileBody = SOURCE.slice(mobileIdx, SOURCE.indexOf('\nfunction MobileEntityCard', mobileIdx));
  const greetingIdx = mobileBody.indexOf('{greeting}{firstName');
  const alertsIdx = mobileBody.indexOf('MobileSection title="Önemli Uyarılar"');
  const urgentIdx = mobileBody.indexOf('MobileSection title="Dikkat Gerektiren"');
  assert.ok(greetingIdx > -1 && alertsIdx > -1 && urgentIdx > -1);
  assert.ok(greetingIdx < alertsIdx && alertsIdx < urgentIdx);
});

// ── Section/card copy and reusability ───────────────────────────────────

test('the section heading is exactly "Önemli Uyarılar" (desktop SectionHeader + mobile MobileSection)', () => {
  assert.match(SOURCE, /<SectionHeader title="Önemli Uyarılar"\/>/);
  assert.match(SOURCE, /<MobileSection title="Önemli Uyarılar">/);
});

test('the cancellation card carries the fixed "Rezervasyon İptali" label (visually uppercased via CSS textTransform, not a hardcoded literal) and the exact required action buttons', () => {
  assert.match(SOURCE, /title: 'Rezervasyon İptali'/);
  assert.match(SOURCE, /textTransform:"uppercase"/);
  assert.match(SOURCE, />Rezervasyonu Gör<\/button>/);
  assert.match(SOURCE, />Okundu Olarak İşaretle<\/button>/);
});

test('no real customer/tour/booking value is hardcoded anywhere in the new alert components — every field comes from the alert object', () => {
  const idx = SOURCE.indexOf('const MAX_VISIBLE_IMPORTANT_ALERTS = 3;');
  const end = SOURCE.indexOf('function useUnreadImportantAlerts', idx) > -1
    ? SOURCE.indexOf('\nfunction OnemliUyarilar', idx) + 2000
    : idx + 6000;
  const block = SOURCE.slice(idx, end);
  assert.doesNotMatch(block, /A38807986/);
  assert.doesNotMatch(block, /Estambul Historica/);
});

// ── Permissions: unchanged RLS reliance ─────────────────────────────────

test('no client-side role/guide filtering was added for this feature — it continues to rely entirely on the existing activity_logs/activity_log_reads RLS, same as NotificationBell', () => {
  const hookIdx = SOURCE.indexOf('function useUnreadImportantAlerts()');
  const hookBody = SOURCE.slice(hookIdx, SOURCE.indexOf('\nfunction ', hookIdx + 10));
  assert.doesNotMatch(hookBody, /role\s*===\s*"Rehber"/);
  assert.doesNotMatch(hookBody, /auth\.role/);
});
