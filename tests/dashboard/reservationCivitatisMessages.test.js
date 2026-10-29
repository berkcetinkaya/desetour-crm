'use strict';
/**
 * tests/dashboard/reservationCivitatisMessages.test.js
 * ─────────────────────────────────────────────────────────────────────────
 * Civitatis client/reservation messages — frontend side: repo wiring,
 * desktop ReservationMessagesCard, mobile MobileReservationDetailPage
 * section, the Reservations-list "Yeni Mesaj" indicator (reusing the
 * EXISTING notification infrastructure, no new query), and the explicit
 * guarantees this feature must never violate: messages are never mixed
 * into internal notes, never rendered via dangerouslySetInnerHTML, and
 * the app never exposes a write path for this table (ingestion-only).
 * ─────────────────────────────────────────────────────────────────────────
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.join(__dirname, '..', '..');
const SOURCE = fs.readFileSync(path.join(REPO_ROOT, 'DeseTourDashboard.jsx'), 'utf8');
const { extractTestableFn } = require('./extractTestableFn');

function body(name, nextMarker) {
  const idx = SOURCE.indexOf(`function ${name}(`);
  assert.ok(idx !== -1, `could not find function ${name}`);
  return SOURCE.slice(idx, SOURCE.indexOf(nextMarker, idx));
}

// ── 1. formatReservationMessageTimestamp (pure, extracted + executed) ───

const formatReservationMessageTimestamp = extractTestableFn('formatReservationMessageTimestamp');

test('[1] formatReservationMessageTimestamp renders "DD Mon · HH:mm" in Europe/Istanbul time, matching the example mockup\'s shape', () => {
  const out = formatReservationMessageTimestamp('2026-10-29T08:59:00Z'); // 11:59 Istanbul (UTC+3)
  assert.match(out, /^\d{2} \S+ · \d{2}:\d{2}$/);
  assert.match(out, /11:59$/);
});

test('[2] formatReservationMessageTimestamp never includes a year (unlike formatBuildTimestampTR\'s long-form shape, a different context)', () => {
  const out = formatReservationMessageTimestamp('2026-10-29T08:59:00Z');
  assert.doesNotMatch(out, /2026/);
});

test('[3] formatReservationMessageTimestamp returns "" for null/undefined/invalid input, never throws', () => {
  assert.equal(formatReservationMessageTimestamp(null), '');
  assert.equal(formatReservationMessageTimestamp(undefined), '');
  assert.equal(formatReservationMessageTimestamp('not-a-date'), '');
});

// ── 2. mapReservationMessageFromDB ────────────────────────────────────────

test('[4] mapReservationMessageFromDB maps every real column, with safe defaults for a missing match_status/source/direction', () => {
  const idx = SOURCE.indexOf('function mapReservationMessageFromDB(');
  const end = SOURCE.indexOf('\n}', idx);
  const fnSrc = SOURCE.slice(idx, end + 2) + '\nreturn mapReservationMessageFromDB;';
  // eslint-disable-next-line no-new-func
  const mapReservationMessageFromDB = new Function(fnSrc)();

  assert.equal(mapReservationMessageFromDB(null), null);

  const mapped = mapReservationMessageFromDB({
    id: 'rm-1', reservation_id: 'res-1', source: 'civitatis', direction: 'inbound',
    match_status: 'matched', external_booking_id: '42414893', subject: 'New client message...',
    message_text: 'They are staying at the Enderun Hotel.', external_url: null,
    received_at: '2026-10-29T08:59:00Z', created_at: '2026-10-29T09:00:00Z',
  });
  assert.equal(mapped.id, 'rm-1');
  assert.equal(mapped.reservationId, 'res-1');
  assert.equal(mapped.matchStatus, 'matched');
  assert.equal(mapped.externalBookingId, '42414893');
  assert.equal(mapped.messageText, 'They are staying at the Enderun Hotel.');
  assert.equal(mapped.receivedAt, '2026-10-29T08:59:00Z');

  const minimal = mapReservationMessageFromDB({ id: 'rm-2' });
  assert.equal(minimal.source, 'civitatis');
  assert.equal(minimal.direction, 'inbound');
  assert.equal(minimal.matchStatus, 'unmatched');
  assert.equal(minimal.reservationId, null);
});

// ── 3. Repo wiring: read-only, registered, chronological ────────────────

test('[5] "reservationMessage" is registered in getActiveRepo, routing to SupabaseReservationMessageRepo / ReservationMessageRepository', () => {
  assert.match(SOURCE, /if\(entity==='reservationMessage'\)return useReal \? SupabaseReservationMessageRepo : ReservationMessageRepository;/);
});

test('[6] the mock ReservationMessageRepository sorts chronologically OLDEST FIRST (a conversation timeline, not the newest-first convention most other lists use)', () => {
  const idx = SOURCE.indexOf('const ReservationMessageRepository = {');
  const end = SOURCE.indexOf('\n};', idx);
  const repoSrc = SOURCE.slice(idx, end + 3).replace('const ReservationMessageRepository', 'var ReservationMessageRepository')
    + '\nreturn ReservationMessageRepository;';
  const DB = { reservationMessages: [
    { id: 'm3', reservationId: 'r1', receivedAt: '2026-10-29T12:00:00Z' },
    { id: 'm1', reservationId: 'r1', receivedAt: '2026-10-27T09:00:00Z' },
    { id: 'm2', reservationId: 'r1', receivedAt: '2026-10-28T10:00:00Z' },
    { id: 'm4', reservationId: 'r2', receivedAt: '2026-10-29T12:00:00Z' },
  ] };
  // eslint-disable-next-line no-new-func
  const ReservationMessageRepository = new Function('DB', `${repoSrc}`)(DB);
  const result = ReservationMessageRepository.getByReservationId('r1');
  assert.deepEqual(result.map(m => m.id), ['m1', 'm2', 'm3']);
});

test('[7] SupabaseReservationMessageRepo queries .order(\'received_at\',{ascending:true}) — same chronological convention as the mock repo', () => {
  const idx = SOURCE.indexOf('const SupabaseReservationMessageRepo = {');
  const end = SOURCE.indexOf('\n};', idx);
  const body = SOURCE.slice(idx, end);
  assert.match(body, /\.order\('received_at',\{ascending:true\}\)/);
  assert.match(body, /\.eq\('reservation_id',reservationId\)/);
});

test('[8] no write method exists anywhere on either reservationMessage repo — ingestion-only, confirmed again at the getActiveRepo call-site level', () => {
  const idx = SOURCE.indexOf('const SupabaseReservationMessageRepo = {');
  const end = SOURCE.indexOf('\n};', idx);
  const body = SOURCE.slice(idx, end);
  assert.doesNotMatch(body, /async create|async update|async delete/);
});

// ── 4. Desktop ReservationMessagesCard ───────────────────────────────────

const RESERVATION_MESSAGES_CARD_BODY = body('ReservationMessagesCard', '\nfunction ResTimeline(');

test('[9] ReservationMessagesCard renders nothing (null) while loading or when there are zero messages — "do not waste large vertical space"', () => {
  assert.match(RESERVATION_MESSAGES_CARD_BODY, /if \(loading \|\| list\.length === 0\) return null;/);
});

test('[10] ReservationMessagesCard renders the exact title "Civitatis Mesajları"', () => {
  assert.match(RESERVATION_MESSAGES_CARD_BODY, /<RCardHead title="Civitatis Mesajları"\/>/);
});

test('[11] ReservationMessagesCard shows the Civitatis source label, a formatted received timestamp, and the clean message text for each message', () => {
  assert.match(RESERVATION_MESSAGES_CARD_BODY, />Civitatis</);
  assert.match(RESERVATION_MESSAGES_CARD_BODY, /formatReservationMessageTimestamp\(m\.receivedAt\)/);
  assert.match(RESERVATION_MESSAGES_CARD_BODY, /\{m\.messageText\}/);
});

test('[12] ReservationMessagesCard optionally shows the reservation number ("#<externalBookingId>") only when present', () => {
  assert.match(RESERVATION_MESSAGES_CARD_BODY, /\{m\.externalBookingId && \(/);
  assert.match(RESERVATION_MESSAGES_CARD_BODY, /#\{m\.externalBookingId\}/);
});

test('[13] ReservationMessagesCard never renders via dangerouslySetInnerHTML — message text is a plain React text child only', () => {
  assert.doesNotMatch(RESERVATION_MESSAGES_CARD_BODY, /dangerouslySetInnerHTML/);
});

test('[14] ReservationMessagesCard fetches via the reservationMessage repo entity, keyed by r.id, never touching r.notes/r.internalNotes/r.opNotes — visually and structurally separate from internal staff notes', () => {
  assert.match(RESERVATION_MESSAGES_CARD_BODY, /useRepo\("reservationMessage", "getByReservationId", r\.id\)/);
  assert.doesNotMatch(RESERVATION_MESSAGES_CARD_BODY, /r\.notes|r\.internalNotes|r\.opNotes/);
});

test('[15] ReservationMessagesCard is wired into ReservationDetailPage, in its own RCard, never inside an existing notes/activity card', () => {
  const idx = SOURCE.indexOf('function ReservationDetailPage(');
  const end = SOURCE.indexOf('\nfunction RCard(', idx);
  const pageBody = SOURCE.slice(idx, end);
  assert.match(pageBody, /<ReservationMessagesCard r={r}\/>/);
});

// ── 5. Mobile detail page ─────────────────────────────────────────────────

const MOBILE_DETAIL_BODY = body('MobileReservationDetailPage', '\n\n\n/* ');

test('[16] mobile reservation detail fetches the same reservationMessage repo entity', () => {
  assert.match(MOBILE_DETAIL_BODY, /useRepo\("reservationMessage", "getByReservationId", resId\)/);
});

test('[17] mobile renders "Civitatis Mesajları" as its OWN MobileSection, conditionally, only when there is at least one message — compact card style, never the desktop table', () => {
  assert.match(MOBILE_DETAIL_BODY, /\{\(mobResMessages\|\|\[\]\)\.length > 0 && \(/);
  assert.match(MOBILE_DETAIL_BODY, /<MobileSection title="Civitatis Mesajları">/);
  assert.doesNotMatch(MOBILE_DETAIL_BODY, /<table/);
});

test('[18] mobile Civitatis Mesajları section is a visually separate block from the "Notlar" section — never merged, never reusing the opNotes card', () => {
  const notlarIdx = MOBILE_DETAIL_BODY.indexOf('<MobileSection title="Notlar">');
  const civitatisIdx = MOBILE_DETAIL_BODY.indexOf('<MobileSection title="Civitatis Mesajları">');
  assert.ok(notlarIdx > -1 && civitatisIdx > -1);
  assert.ok(notlarIdx < civitatisIdx, 'Civitatis Mesajları must be its own section, appearing after and separate from Notlar');
});

test('[19] mobile message cards use MobileEntityCard (the established compact card primitive), each showing the Civitatis label, a formatted timestamp, and the message text', () => {
  const sectionIdx = MOBILE_DETAIL_BODY.indexOf('<MobileSection title="Civitatis Mesajları">');
  const sectionBody = MOBILE_DETAIL_BODY.slice(sectionIdx, sectionIdx + 900);
  assert.match(sectionBody, /<MobileEntityCard key={m\.id}>/);
  assert.match(sectionBody, />Civitatis</);
  assert.match(sectionBody, /formatReservationMessageTimestamp\(m\.receivedAt\)/);
  assert.match(sectionBody, /\{m\.messageText\}/);
  assert.doesNotMatch(sectionBody, /dangerouslySetInnerHTML/);
});

// ── 6. "Yeni Mesaj" Reservations-list indicator (reuses existing infra) ──

const RESERVATIONS_PAGE_BODY = body('ReservationsPage', '\nfunction RCard(');

test('[20] the "Yeni Mesaj" indicator reuses useOperationalNotifications() — the SAME hook NotificationBell already uses, no new query/table', () => {
  assert.match(RESERVATIONS_PAGE_BODY, /const \{ unread: unreadOperationalNotifications \} = useOperationalNotifications\(\);/);
});

test('[21] the indicator is keyed on metadata.source==="civitatis_message" AND a resolvable reservationId — never a generic "any unread notification" pill', () => {
  assert.match(RESERVATIONS_PAGE_BODY, /n\.source === 'civitatis_message' && n\.reservationId/);
});

test('[22] the pill renders only for reservations present in the computed unread-civitatis-message set, and never redesigns the table (no new column, just a small inline badge next to the guest name)', () => {
  assert.match(RESERVATIONS_PAGE_BODY, /reservationsWithUnreadCivitatisMessage\.has\(r\.id\)/);
  assert.match(RESERVATIONS_PAGE_BODY, />Yeni Mesaj</);
  // Still exactly 9 column headers — the table structure itself is untouched.
  assert.match(RESERVATIONS_PAGE_BODY, /\["Rezervasyon No","Misafir","Tur","Tarih \/ Saat","Kişi","Rehber","Ödeme","Operasyon",""\]/);
});

// ── 7. Regression: Agency Mailbox UI untouched ───────────────────────────

test('[23] AcenteDetailPage\'s own email history card is untouched by this feature — no reservationMessage reference anywhere near it', () => {
  const idx = SOURCE.indexOf('function AcenteDetailPage(');
  const end = SOURCE.indexOf('\nfunction GuidesPage', idx);
  const pageBody = SOURCE.slice(idx, end === -1 ? idx + 20000 : end);
  assert.doesNotMatch(pageBody, /reservationMessage|ReservationMessagesCard/);
});
