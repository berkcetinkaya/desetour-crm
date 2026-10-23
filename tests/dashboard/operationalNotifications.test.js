'use strict';
/**
 * tests/dashboard/operationalNotifications.test.js
 * ─────────────────────────────────────────────────────────────────────────
 * Operational notification system — new reservations + new Agency inbound
 * replies, surfaced via NotificationBell (desktop + mobile) and the
 * "Son Bildirimler" homepage panels (desktop + mobile).
 *
 * No new persistence layer was introduced: every surface reads the SAME
 * activity_logs + activity_log_reads tables, through the SAME
 * SupabaseActivityRepo.getReservationNotifications /
 * markReservationNotificationRead methods OnemliUyarilar/NotificationBell
 * already used before this change — widened additively to also include
 * entity_type='agency_email' rows written by
 * api/_agencies/gmailInboundSync.js's logInboundReply(). See
 * tests/dashboard/agencyInboundSync.test.js ("H6" section) for the
 * write-side correctness/idempotency coverage of that event, and
 * tests/dashboard/agencyCrmPlusSummary.test.js for the Agency CRM+
 * homepage summary's own pure-selector coverage.
 *
 * As with every other test file for this single-file component, pure
 * logic is extracted via extractTestableFn and exercised directly; every
 * placement/wiring/gating claim is a static source-text assertion (no
 * React DOM/testing-library in this project).
 * ─────────────────────────────────────────────────────────────────────────
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { extractTestableFn } = require('./extractTestableFn');

const SOURCE_PATH = path.join(__dirname, '..', '..', 'DeseTourDashboard.jsx');
const SOURCE = fs.readFileSync(SOURCE_PATH, 'utf8');

const _allowedOperationalEntityTypes = extractTestableFn('_allowedOperationalEntityTypes');
const _filterOperationalNotificationsForRole = extractTestableFn('_filterOperationalNotificationsForRole');
const _operationalNotificationDisplay = extractTestableFn('_operationalNotificationDisplay');
const _operationalNotificationTarget = extractTestableFn('_operationalNotificationTarget');

// Real ROLE_PERMISSIONS/canAccess implementation, same extraction pattern
// already used by tests/dashboard/agenciesPhase1.test.js and
// tests/dashboard/reservationQuickActionsRoleSafety.test.js.
const rolePermIdx = SOURCE.indexOf('const ROLE_PERMISSIONS');
const canAccessEnd = SOURCE.indexOf('\n}', SOURCE.indexOf('function canAccess(role, page)', rolePermIdx));
const canAccess = new Function(`${SOURCE.slice(rolePermIdx, canAccessEnd + 2)}\nreturn canAccess;`)();

const ROLES = { admin: 'Yönetici', sales: 'Satış', operations: 'Operasyon', guide: 'Rehber' };

function reservationNotif(overrides) {
  return {
    id: 'LOG-' + Math.random().toString(36).slice(2),
    entityType: 'reservation',
    reservationId: 'RES-1',
    agencyEmailId: null,
    agencyId: null,
    agencyName: null,
    subject: null,
    bodyPreview: null,
    action: 'created',
    description: 'Yeni Rezervasyon Geldi',
    source: 'civitatis',
    externalBookingId: 'A1',
    reservationNumber: 'R-2026-0001',
    customerName: 'Jane Doe',
    tourName: 'Estambul Historica',
    tourDate: '2026-04-10',
    createdAt: '2026-04-01T10:00:00Z',
    isRead: false,
    ...overrides,
  };
}

function agencyReplyNotif(overrides) {
  return {
    id: 'LOG-' + Math.random().toString(36).slice(2),
    entityType: 'agency_email',
    reservationId: null,
    agencyEmailId: 'AEM-1',
    agencyId: 'AGN-1',
    agencyName: 'Deniz Tur',
    subject: 'Re: Teklif',
    bodyPreview: 'Çok teşekkürler, uygun görünüyor.',
    action: 'reply',
    description: 'Acenteden yanıt alındı.',
    source: null,
    externalBookingId: null,
    reservationNumber: null,
    customerName: null,
    tourName: null,
    tourDate: null,
    createdAt: '2026-04-01T11:00:00Z',
    isRead: false,
    ...overrides,
  };
}

// ── Repo query: additive widening to include agency_email ─────────────────

test('getReservationNotifications selects entity_type IN (reservation, agency_email), not just reservation', () => {
  const idx = SOURCE.indexOf('async getReservationNotifications()');
  const line = SOURCE.slice(idx, SOURCE.indexOf(';},', idx) + 3);
  assert.match(line, /\.in\('entity_type',\s*\['reservation','agency_email'\]\)/);
  // Still the same auto_ingested convention, unchanged.
  assert.match(line, /\.eq\('metadata->>auto_ingested','true'\)/);
});

test('getReservationNotifications maps entityType/agencyId/agencyName/subject/bodyPreview additively, never dropping the existing reservation fields', () => {
  const idx = SOURCE.indexOf('async getReservationNotifications()');
  const line = SOURCE.slice(idx, SOURCE.indexOf(';},', idx) + 3);
  for (const field of [
    'entityType:l.entity_type', 'agencyId:l.metadata?.agency_id',
    'agencyName:l.metadata?.agency_name', 'subject:l.metadata?.subject',
    'bodyPreview:l.metadata?.body_preview',
    'reservationId:l.entity_type===\'reservation\'?l.entity_id:null',
    'customerName:l.metadata?.customer_name', 'tourName:l.metadata?.tour_name',
    'isRead:(l.activity_log_reads||[]).length>0',
  ]) {
    assert.ok(line.includes(field), `expected mapped field: ${field}`);
  }
});

test('markReservationNotificationRead is unchanged — still generic over any activity_log_id, no entity_type branching', () => {
  const idx = SOURCE.indexOf('async markReservationNotificationRead(activityLogId)');
  const line = SOURCE.slice(idx, SOURCE.indexOf(';},', idx) + 3);
  assert.doesNotMatch(line, /entity_type/);
  assert.match(line, /activity_log_reads/);
  assert.match(line, /error\.code\s*!==\s*'23505'/);
});

// ── _allowedOperationalEntityTypes: role → entity-type allowlist ──────────

test('admin (Yönetici) is allowed both reservation and agency_email notifications', () => {
  const allowed = _allowedOperationalEntityTypes(ROLES.admin, canAccess);
  assert.deepEqual(allowed, ['reservation', 'agency_email']);
});

test('Satış (has both reservations and agencies access) is allowed both entity types', () => {
  const allowed = _allowedOperationalEntityTypes(ROLES.sales, canAccess);
  assert.deepEqual(allowed, ['reservation', 'agency_email']);
});

test('Operasyon (reservations access, no agencies access) is allowed reservation notifications only', () => {
  const allowed = _allowedOperationalEntityTypes(ROLES.operations, canAccess);
  assert.deepEqual(allowed, ['reservation']);
});

test('a role with neither reservations nor agencies access is allowed nothing', () => {
  const allowed = _allowedOperationalEntityTypes('NoSuchRole', canAccess);
  assert.deepEqual(allowed, []);
});

// ── _filterOperationalNotificationsForRole: authorization enforcement ─────

test('an agency_email notification is excluded for a role not allowed to see it, even if the row came back from the query', () => {
  const list = [reservationNotif({ id: 'r1' }), agencyReplyNotif({ id: 'a1' })];
  const filtered = _filterOperationalNotificationsForRole(list, ['reservation']);
  assert.deepEqual(filtered.map(n => n.id), ['r1']);
});

test('both entity types pass through when both are allowed', () => {
  const list = [reservationNotif({ id: 'r1' }), agencyReplyNotif({ id: 'a1' })];
  const filtered = _filterOperationalNotificationsForRole(list, ['reservation', 'agency_email']);
  assert.deepEqual(filtered.map(n => n.id).sort(), ['a1', 'r1']);
});

test('an empty allowlist excludes everything — never a fail-open default', () => {
  const list = [reservationNotif(), agencyReplyNotif()];
  assert.deepEqual(_filterOperationalNotificationsForRole(list, []), []);
  assert.deepEqual(_filterOperationalNotificationsForRole(list, undefined), []);
});

// ── _operationalNotificationDisplay: safe, short content only ─────────────

test('an agency_email notification displays "<Agency> yanıt verdi" plus subject, never raw/full body', () => {
  const display = _operationalNotificationDisplay(agencyReplyNotif({ agencyName: 'Deniz Tur', subject: 'Re: Teklif', bodyPreview: 'Kısa önizleme.' }));
  assert.equal(display.kind, 'agency_email');
  assert.equal(display.title, 'Deniz Tur yanıt verdi');
  assert.equal(display.subtitle, 'Re: Teklif');
  assert.equal(display.preview, 'Kısa önizleme.');
});

test('a missing agency name falls back to a generic "Acente" label rather than a blank/undefined title', () => {
  const display = _operationalNotificationDisplay(agencyReplyNotif({ agencyName: null }));
  assert.equal(display.title, 'Acente yanıt verdi');
});

test('a reservation notification displays its description as the title and customer/tour as the subtitle', () => {
  const display = _operationalNotificationDisplay(reservationNotif({ description: 'Yeni Rezervasyon Geldi', customerName: 'Jane Doe', tourName: 'Estambul Historica' }));
  assert.equal(display.kind, 'reservation');
  assert.equal(display.title, 'Yeni Rezervasyon Geldi');
  assert.equal(display.subtitle, 'Jane Doe · Estambul Historica');
  assert.equal(display.preview, null);
});

test('the display helper never reads/exposes a raw full-body field — only the already-truncated bodyPreview', () => {
  const helperIdx = SOURCE.indexOf('function _operationalNotificationDisplay(n) {');
  const helperBody = SOURCE.slice(helperIdx, SOURCE.indexOf('// TESTABLE:_operationalNotificationDisplay:end', helperIdx));
  assert.doesNotMatch(helperBody, /\bn\.body\b/);
  assert.match(helperBody, /n\.bodyPreview/);
});

// ── _operationalNotificationTarget: click-through routing ─────────────────

test('an agency_email notification routes to its agencyId', () => {
  const target = _operationalNotificationTarget(agencyReplyNotif({ agencyId: 'AGN-42' }));
  assert.deepEqual(target, { type: 'agency', id: 'AGN-42' });
});

test('a reservation notification routes to its reservationId', () => {
  const target = _operationalNotificationTarget(reservationNotif({ reservationId: 'RES-42' }));
  assert.deepEqual(target, { type: 'reservation', id: 'RES-42' });
});

test('a notification missing the id its own entity type needs routes to null (no crash, no wrong navigation)', () => {
  assert.equal(_operationalNotificationTarget(agencyReplyNotif({ agencyId: null })), null);
  assert.equal(_operationalNotificationTarget(reservationNotif({ reservationId: null })), null);
});

// ── useOperationalNotifications: shared hook wiring ────────────────────────

test('useOperationalNotifications reads the SAME shared query/cache key as before — one cache entry for the whole feature', () => {
  const idx = SOURCE.indexOf('function useOperationalNotifications()');
  const body = SOURCE.slice(idx, SOURCE.indexOf('\n}', idx) + 2);
  assert.match(body, /useRepo\("activity",\s*"getReservationNotifications"\)/);
  assert.match(body, /mutate\("markReservationNotificationRead",\s*id\)/);
});

test('useOperationalNotifications navigates via the app\'s existing NAV_REF, to /agencies/:id or /reservations/:id depending on entity type', () => {
  const idx = SOURCE.indexOf('function useOperationalNotifications()');
  const body = SOURCE.slice(idx, SOURCE.indexOf('\n}', idx) + 2);
  assert.match(body, /'\/agencies\/'\s*\+\s*target\.id/);
  assert.match(body, /'\/reservations\/'\s*\+\s*target\.id/);
  assert.match(body, /NAV_REF\.fn/);
});

test('select() marks a notification read before navigating, and only when it was actually unread', () => {
  const idx = SOURCE.indexOf('function useOperationalNotifications()');
  const body = SOURCE.slice(idx, SOURCE.indexOf('\n}', idx) + 2);
  assert.match(body, /if \(!n\.isRead\) await markRead\(n\.id\);/);
});

// ── NotificationBell (desktop): shared hook, unread badge, safe rendering ──

test('NotificationBell is built on useOperationalNotifications — no separate/duplicate query', () => {
  const idx = SOURCE.indexOf('function NotificationBell() {');
  const body = SOURCE.slice(idx, SOURCE.indexOf('\nfunction ', idx + 10));
  assert.match(body, /useOperationalNotifications\(\)/);
  assert.doesNotMatch(body, /useRepo\("activity"/, 'NotificationBell must not call useRepo directly anymore — it goes through the shared hook');
});

test('NotificationBell\'s unread badge count is unread.length from the shared hook', () => {
  const idx = SOURCE.indexOf('function NotificationBell() {');
  const body = SOURCE.slice(idx, SOURCE.indexOf('\nfunction ', idx + 10));
  assert.match(body, /unread\.length > 0/);
  assert.match(body, /\{unread\.length\}/);
});

test('NotificationBell renders rows through NotificationPanelBody/NotificationListItem — never inlines raw n.description for an agency_email row (that path goes through the safe display helper)', () => {
  const idx = SOURCE.indexOf('function NotificationBell() {');
  const body = SOURCE.slice(idx, SOURCE.indexOf('\nfunction ', idx + 10));
  assert.match(body, /<NotificationPanelBody/);
});

test('NotificationBell remains hidden/disabled for Rehber — unchanged gate', () => {
  const idx = SOURCE.indexOf('function NotificationBell() {');
  const body = SOURCE.slice(idx, SOURCE.indexOf('\nfunction ', idx + 10));
  assert.match(body, /auth\.role !== "Rehber"/);
});

test('NotificationListItem never renders the full stored email body — only display.preview (the pre-truncated snippet) in quotes', () => {
  const idx = SOURCE.indexOf('function NotificationListItem(');
  const body = SOURCE.slice(idx, SOURCE.indexOf('\nfunction ', idx + 10));
  assert.match(body, /display\.preview/);
  assert.doesNotMatch(body, /\bn\.body\b/);
});

// ── Mobile notification bell ────────────────────────────────────────────

test('MobileNotificationBell exists, uses the same shared hook, and is also hidden for Rehber', () => {
  const idx = SOURCE.indexOf('function MobileNotificationBell() {');
  assert.ok(idx > -1, 'expected a MobileNotificationBell component');
  const body = SOURCE.slice(idx, SOURCE.indexOf('\nfunction ', idx + 10));
  assert.match(body, /useOperationalNotifications\(\)/);
  assert.match(body, /auth\.role !== "Rehber"/);
  assert.match(body, /<NotificationPanelBody/);
});

// The mobile-homepage/header redesign ("simpler operational philosophy"
// phase) removed the Dese logo from the mobile header entirely (wasted
// vertical space, per that phase's explicit brief) and replaced its slot
// with a menu control routed to the existing "Diğer" page — the bell
// itself is untouched, just repositioned.
test('MobileNotificationBell is actually mounted in the mobile fixed header, which has a menu control but no logo', () => {
  const headerIdx = SOURCE.indexOf('{isMobile && (\n        <div style={{\n          position:"fixed", top:0, left:0, right:0, zIndex:200,');
  assert.ok(headerIdx > -1, 'expected the mobile fixed header block in App()');
  const headerBlock = SOURCE.slice(headerIdx, SOURCE.indexOf('{isMobile && <BottomNav', headerIdx));
  assert.match(headerBlock, /<MobileNotificationBell\/>/);
  assert.match(headerBlock, /onClick=\{\(\)=>navigate\('\/more'\)\}/, 'expected a menu control routing to the existing /more page');
  assert.doesNotMatch(headerBlock, /seffafdeselogo\.png/, 'the Dese logo must be removed from the mobile header');
});

test('the desktop bell is NOT also rendered on mobile, and vice versa — DesktopTopBar (which holds NotificationBell) is gated by !isMobile', () => {
  assert.match(SOURCE, /\{!isMobile && <DesktopTopBar/);
});

// ── Homepage "Son Bildirimler" panels (desktop + mobile) ──────────────────

test('desktop: SonBildirimlerPanel is mounted in Dashboard(), after KpiRow and before AgencyCrmPlusSection', () => {
  const dashIdx = SOURCE.indexOf('function Dashboard() {');
  const dashBody = SOURCE.slice(dashIdx, SOURCE.indexOf('\nfunction ', dashIdx + 10));
  const kpiIdx = dashBody.indexOf('<KpiRow/>');
  const sonIdx = dashBody.indexOf('<SonBildirimlerPanel/>');
  const agencyIdx = dashBody.indexOf('<AgencyCrmPlusSection/>');
  assert.ok(kpiIdx > -1 && sonIdx > -1 && agencyIdx > -1);
  assert.ok(kpiIdx < sonIdx && sonIdx < agencyIdx);
});

test('SonBildirimlerPanel uses the shared hook (never a separate query) and hides entirely while loading, when empty, or for Rehber', () => {
  const idx = SOURCE.indexOf('function SonBildirimlerPanel() {');
  const body = SOURCE.slice(idx, SOURCE.indexOf('\n}', idx) + 2);
  assert.match(body, /useOperationalNotifications\(\)/);
  assert.match(body, /if \(!eligible \|\| loading \|\| notifications\.length === 0\) return null;/);
});

test('SonBildirimlerPanel caps the visible list at SON_BILDIRIMLER_MAX and renders newest-first order as returned by the shared query', () => {
  const idx = SOURCE.indexOf('function SonBildirimlerPanel() {');
  const body = SOURCE.slice(idx, SOURCE.indexOf('\n}', idx) + 2);
  assert.match(body, /notifications\.slice\(0, SON_BILDIRIMLER_MAX\)/);
  assert.match(SOURCE, /const SON_BILDIRIMLER_MAX = 5;/);
});

test('SonBildirimlerRow click calls the shared select() — marks read + navigates, same as the bell', () => {
  const idx = SOURCE.indexOf('function SonBildirimlerPanel() {');
  const body = SOURCE.slice(idx, SOURCE.indexOf('\n}', idx) + 2);
  assert.match(body, /async function handleSelect\(n\) \{ await select\(n\); \}/);
});

test('SonBildirimlerRow never shows a full email body — only title/subtitle from the safe display helper', () => {
  const idx = SOURCE.indexOf('function SonBildirimlerRow(');
  const body = SOURCE.slice(idx, SOURCE.indexOf('\nfunction ', idx + 10));
  assert.match(body, /_operationalNotificationDisplay\(n\)/);
  assert.doesNotMatch(body, /\bn\.body\b/);
});

// The mobile-homepage redesign ("simpler operational philosophy" phase)
// removed the "Son Bildirimler" MobileSection from MobileHomePage
// entirely — it duplicated what the header's own MobileNotificationBell
// already surfaces (same data, same hook), and the new homepage
// hierarchy (Bugünkü/Yarınki Turlar, Yaklaşan Rezervasyonlar, Bilet/
// Yemek Hazırlıkları) isn't meant to compete with it. The bell — and the
// useOperationalNotifications hook it calls — is untouched; this is a
// homepage-presentation removal, not a feature or query removal.
test('MobileHomePage no longer renders a "Son Bildirimler" section — covered by the header\'s MobileNotificationBell (same hook) instead', () => {
  const mobileBody = require('./extractTestableFn').extractFunctionSource('MobileHomePage');
  assert.doesNotMatch(mobileBody, /Son Bildirimler/);
  assert.doesNotMatch(mobileBody, /useOperationalNotifications/);
});

test('the mobile header\'s MobileNotificationBell still uses the SAME useOperationalNotifications hook as the desktop panel (no separate mobile-only query)', () => {
  const idx = SOURCE.indexOf('function MobileNotificationBell(');
  assert.ok(idx > -1, 'expected MobileNotificationBell to exist');
  const body = SOURCE.slice(idx, SOURCE.indexOf('\nfunction ', idx + 10));
  assert.match(body, /useOperationalNotifications\(\)/);
});

// ── Agency CRM+ homepage mount (item 1/2 of the spec) ──────────────────────

test('desktop: AgencyCrmPlusSection is unconditionally mounted inside Dashboard() — no early return in Dashboard() can skip past it', () => {
  const dashIdx = SOURCE.indexOf('function Dashboard() {');
  const dashBody = SOURCE.slice(dashIdx, SOURCE.indexOf('\nfunction ', dashIdx + 10));
  assert.match(dashBody, /<AgencyCrmPlusSection\/>/);
  assert.doesNotMatch(dashBody, /if\s*\(/, 'Dashboard() itself must contain no conditional that could skip a later child');
});

test('AgencyCrmPlusSection\'s own visibility gate is canAccess(role, "agencies") — matches the real ROLE_PERMISSIONS matrix (admin yes, Satış yes, Operasyon/Rehber no)', () => {
  const idx = SOURCE.indexOf('function AgencyCrmPlusSection() {');
  const body = SOURCE.slice(idx, SOURCE.indexOf('\nfunction ', idx + 10));
  assert.match(body, /if \(!canAccess\(role,\s*"agencies"\)\) return null;/);
  assert.equal(canAccess(ROLES.admin, 'agencies'), true);
  assert.equal(canAccess(ROLES.sales, 'agencies'), true);
  assert.equal(canAccess(ROLES.operations, 'agencies'), false);
  assert.equal(canAccess(ROLES.guide, 'agencies'), false);
});

// The mobile-homepage redesign ("simpler operational philosophy" phase)
// removed the Agency CRM+ MobileSection from MobileHomePage — it's a
// large Agency-CRM summary/table the new hierarchy (Bugünkü/Yarınki
// Turlar, Yaklaşan Rezervasyonlar, Bilet/Yemek Hazırlıkları) isn't meant
// to compete with. The feature itself is untouched and still reachable
// on mobile via Acenteler (see tests/dashboard/agencyConversationAndMobile.test.js).
test('MobileHomePage no longer renders an "Agency CRM+" section — removed from the mobile homepage, still reachable via Acenteler', () => {
  const mobileBody = require('./extractTestableFn').extractFunctionSource('MobileHomePage');
  assert.doesNotMatch(mobileBody, /MobileSection title="Agency CRM\+"/);
});

test('a real inbound reply (as persistInboundMessage writes it: direction "inbound", with agencyName/subject) is counted in Bugün Yanıt Geldi and listed in Gelen Yanıtlar', () => {
  const computeAgencyCrmPlusSummary = extractTestableFn('computeAgencyCrmPlusSummary');
  const todayISO = '2026-10-23T12:00:00.000Z';
  const email = {
    id: 'AEM-real', agencyId: 'AGN-1', direction: 'inbound', status: 'received',
    receivedAt: '2026-10-23T09:00:00.000Z', createdAt: '2026-10-23T09:00:00.000Z',
    subject: 'Re: Teklif', body: 'Çok teşekkürler, uygun görünüyor.', fromEmail: 'contact@acme.com',
    agencyName: 'Deniz Tur',
  };
  const result = computeAgencyCrmPlusSummary([], [email], todayISO);
  assert.equal(result.repliesTodayCount, 1);
  assert.equal(result.recentReplies.length, 1);
  assert.equal(result.recentReplies[0].agencyName, 'Deniz Tur');
});

// ── Idempotency — pointers to the structural guarantees (not re-tested here) ─

test('a reply notification is only ever logged when persistInboundMessage reports a genuinely new row (never on a duplicate) — same guard the write-side test suite exercises end to end', () => {
  const callIdx = SOURCE_PATH; // no-op; guard lives in gmailInboundSync.js, asserted below via its own file
  const syncPath = path.join(__dirname, '..', '..', 'api', '_agencies', 'gmailInboundSync.js');
  const syncSrc = fs.readFileSync(syncPath, 'utf8');
  const fnIdx = syncSrc.indexOf('async function processCandidateMessage(');
  const fnBody = syncSrc.slice(fnIdx, syncSrc.indexOf('\n}', fnIdx) + 2);
  assert.match(fnBody, /if \(!persistResult\.duplicate\) \{\s*await logInboundReply\(/);
});
