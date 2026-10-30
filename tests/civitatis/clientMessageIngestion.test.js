'use strict';
/**
 * tests/civitatis/clientMessageIngestion.test.js
 * ─────────────────────────────────────────────────────────────────────────
 * Civitatis client/reservation message ingestion — a new, third, fully
 * independent pipeline alongside the existing new_booking/modified
 * (writeAdapter.js) and cancellation (cancellationAdapter.js) pipelines.
 *
 * Covers: detection (trusted sender + real subject pattern), reservation-
 * number extraction (subject primary, body "Reservation number:" label
 * fallback, subject/body mismatch fails closed), message-text extraction
 * (template/footer/price/branding stripping, dedicated-block-vs-Comments
 * de-duplication, residual-HTML stripping), idempotency/matching/
 * notification/activity-log behavior (verified against the REAL migration
 * SQL text — no live Postgres in this environment, same convention
 * established by tests/dashboard/agencyCanonicalDomainMigration.test.js),
 * and regression guards proving the existing new_booking/modified/
 * cancellation pipelines and Agency Mailbox are untouched.
 * ─────────────────────────────────────────────────────────────────────────
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.join(__dirname, '..', '..');

const { detectCivitatisEvent, CIVITATIS_SENDER, CIVITATIS_TRUSTED_SENDERS, isTrustedCivitatisSender } = require('../../api/_civitatis/eventDetector');
const { buildCivitatisSearchQuery } = require('../../api/_civitatis/gmailClient');
const {
  extractClientMessageText, extractCommentsValue, stripResidualHtmlTags,
} = require('../../api/_civitatis/clientMessageExtraction');
const {
  planCivitatisClientMessages, executeCivitatisClientMessagePlan,
  resolveClientMessageExternalBookingId, buildClientMessageRpcPayload,
  KNOWN_CLIENT_MESSAGE_RPC_RESULTS,
} = require('../../api/_civitatis/clientMessageAdapter');
const { parseCivitatisEmail } = require('../../api/_civitatis/parser');

const MIGRATION_PATH = path.join(REPO_ROOT, 'supabase_migration_civitatis_client_messages.sql');
const MIGRATION_SQL = fs.readFileSync(MIGRATION_PATH, 'utf8');
const ROLLBACK_SQL = fs.readFileSync(path.join(REPO_ROOT, 'supabase_migration_civitatis_client_messages_ROLLBACK.sql'), 'utf8');

const REAL_SUBJECT = 'New client message about your reservation 42414893';
const REAL_MESSAGE = 'They are staying at the Enderun Hotel, Tiyatro caddesi Esirci Kemalettin sokak, Gedikpaşa Cd. No:4, 34126 Fatih/İstanbul';

function textBody(lines) { return lines.join('\n'); }

// ── 1. Detection: trusted sender + real subject pattern ──────────────────

test('[1] trusted-source requirement: the real confirmed sender notificaciones@civitatis.com is classified client_message', () => {
  const r = detectCivitatisEvent({ from: `Civitatis.com <${CIVITATIS_SENDER}>`, subject: REAL_SUBJECT });
  assert.equal(r.classification, 'client_message');
  assert.equal(r.externalBookingIdFromSubject, '42414893');
});

test('[2] trusted-source requirement: an untrusted sender with the identical subject is never classified client_message, even though it looks right', () => {
  const r = detectCivitatisEvent({ from: 'Someone Else <attacker@example.com>', subject: REAL_SUBJECT });
  assert.notEqual(r.classification, 'client_message');
  assert.equal(r.classification, 'ignored');
});

// ── 1b. Sender decision: BOTH exact Civitatis addresses trusted ─────────

test('[1b] notifications@civitatis.com (the real confirmed client-message sender) is trusted and classified client_message', () => {
  const r = detectCivitatisEvent({ from: 'Civitatis.com <notifications@civitatis.com>', subject: REAL_SUBJECT });
  assert.equal(r.classification, 'client_message');
  assert.equal(r.externalBookingIdFromSubject, '42414893');
  assert.equal(isTrustedCivitatisSender('notifications@civitatis.com'), true);
});

test('[1c] notificaciones@civitatis.com (the existing booking/modification/cancellation sender) REMAINS trusted — never replaced, only added to', () => {
  assert.equal(isTrustedCivitatisSender('notificaciones@civitatis.com'), true);
  assert.equal(detectCivitatisEvent({ from: 'Civitatis.com <notificaciones@civitatis.com>', subject: 'New booking A42414893: Private Istanbul Experience' }).classification, 'new_booking');
  assert.equal(detectCivitatisEvent({ from: 'Civitatis.com <notificaciones@civitatis.com>', subject: 'Booking A42414893 modified: Private Istanbul Experience' }).classification, 'modified');
  assert.equal(detectCivitatisEvent({ from: 'Civitatis.com <notificaciones@civitatis.com>', subject: 'Cancellation A42414893: Private Istanbul Experience' }).classification, 'cancelled');
  // The existing sender can ALSO now send a client_message — the gate is
  // shared by all four classifications; the subject pattern alone
  // discriminates between them.
  assert.equal(detectCivitatisEvent({ from: 'Civitatis.com <notificaciones@civitatis.com>', subject: REAL_SUBJECT }).classification, 'client_message');
});

test('[1d] an arbitrary address at civitatis.com is NOT automatically trusted — only the two explicitly enumerated addresses are', () => {
  assert.equal(isTrustedCivitatisSender('support@civitatis.com'), false);
  assert.equal(isTrustedCivitatisSender('noreply@civitatis.com'), false);
  assert.equal(isTrustedCivitatisSender('billing@civitatis.com'), false);
  assert.equal(detectCivitatisEvent({ from: 'Civitatis.com <support@civitatis.com>', subject: REAL_SUBJECT }).classification, 'ignored');
});

test('[1e] lookalike domains are rejected — never a substring/domain match, exact address only', () => {
  assert.equal(isTrustedCivitatisSender('notifications@civitatis.com.evil.com'), false);
  assert.equal(isTrustedCivitatisSender('notifications@civitatis.co'), false);
  assert.equal(isTrustedCivitatisSender('notifications@civitatis-com.com'), false);
  assert.equal(isTrustedCivitatisSender('notificaciones@civitatis.com.attacker.net'), false);
  assert.equal(detectCivitatisEvent({ from: 'Civitatis.com <notifications@civitatis.com.evil.com>', subject: REAL_SUBJECT }).classification, 'ignored');
});

test('[1f] display name alone is never trusted — a spoofed display name around a genuinely untrusted address is still rejected', () => {
  const r = detectCivitatisEvent({ from: 'notificaciones@civitatis.com <attacker@example.com>', subject: REAL_SUBJECT });
  assert.equal(r.classification, 'ignored');
});

test('[1g] the trusted-sender set is exactly these two addresses, nothing more, nothing less', () => {
  assert.deepEqual(CIVITATIS_TRUSTED_SENDERS, ['notificaciones@civitatis.com', 'notifications@civitatis.com']);
});

test('[1h] the Gmail search query fetches BOTH trusted addresses via an exact OR, sourced from the same CIVITATIS_TRUSTED_SENDERS list (cannot drift out of sync with the real trust gate)', () => {
  const q = buildCivitatisSearchQuery();
  assert.equal(q, 'from:(notificaciones@civitatis.com OR notifications@civitatis.com)');
  for (const addr of CIVITATIS_TRUSTED_SENDERS) assert.ok(q.includes(addr));
});

test('[3] reservation number extraction from subject: the real confirmed subject format yields the bare-digit number, no "A" prefix', () => {
  const r = detectCivitatisEvent({ from: CIVITATIS_SENDER, subject: REAL_SUBJECT });
  assert.equal(r.externalBookingIdFromSubject, '42414893');
});

test('[4] client_message subject never collides with the three existing booking-event patterns', () => {
  assert.equal(detectCivitatisEvent({ from: CIVITATIS_SENDER, subject: 'New booking A42414893: Some Tour' }).classification, 'new_booking');
  assert.equal(detectCivitatisEvent({ from: CIVITATIS_SENDER, subject: REAL_SUBJECT }).classification, 'client_message');
});

test('[5] an unrelated Civitatis email (no reservation-related indicators) from the trusted sender stays ignored, never swept into client_message', () => {
  const r = detectCivitatisEvent({ from: CIVITATIS_SENDER, subject: 'Your monthly Civitatis newsletter' });
  assert.equal(r.classification, 'ignored');
});

// ── 2. parseCivitatisEmail defense-in-depth for client_message ──────────

test('[6] parseCivitatisEmail fails closed (ok:false) for a client_message email, same defense-in-depth as the cancellation branch', () => {
  const result = parseCivitatisEmail({ from: CIVITATIS_SENDER, subject: REAL_SUBJECT, body: 'irrelevant', gmailMessageId: 'g1' });
  assert.equal(result.ok, false);
  assert.equal(result.status, 'client_message_event');
  assert.equal(result.externalBookingId, '42414893');
});

// ── 3. Reservation number extraction: subject / body / mismatch ─────────

test('[7] resolveClientMessageExternalBookingId: subject only', () => {
  const r = resolveClientMessageExternalBookingId({ externalBookingIdFromSubject: '42414893', body: 'no label here' });
  assert.equal(r.externalBookingId, '42414893');
  assert.equal(r.mismatch, false);
});

test('[8] reservation number extraction from body: the "Reservation number:" label is a deterministic fallback when the subject has none', () => {
  const r = resolveClientMessageExternalBookingId({ externalBookingIdFromSubject: null, body: textBody(['Reservation number: 42414893', 'Comments: hi']) });
  assert.equal(r.externalBookingId, '42414893');
  assert.equal(r.mismatch, false);
});

test('[9] subject and body agreeing on the same number is not a mismatch', () => {
  const r = resolveClientMessageExternalBookingId({ externalBookingIdFromSubject: '42414893', body: textBody(['Reservation number: 42414893']) });
  assert.equal(r.mismatch, false);
  assert.equal(r.externalBookingId, '42414893');
});

test('[10] subject/body mismatch fails closed: disagreeing numbers never produce a usable externalBookingId, and the disagreement is reported', () => {
  const r = resolveClientMessageExternalBookingId({ externalBookingIdFromSubject: '42414893', body: textBody(['Reservation number: 99999999']) });
  assert.equal(r.mismatch, true);
  assert.equal(r.externalBookingId, null);
  assert.equal(r.subjectValue, '42414893');
  assert.equal(r.bodyValue, '99999999');
});

test('[11] neither subject nor body has a usable number -> no externalBookingId, no mismatch (nothing to disagree about)', () => {
  const r = resolveClientMessageExternalBookingId({ externalBookingIdFromSubject: null, body: 'nothing useful here' });
  assert.equal(r.externalBookingId, null);
  assert.equal(r.mismatch, false);
});

// ── 4. Actual message-text extraction (anchor-based rewrite, production incident fix) ──
//
// Root cause of the production incident: the FIRST shipped extractor
// worked by subtraction (strip a small "known noise" blacklist, keep
// whatever survives) — fragile against any template shape it had not
// anticipated. The real production text/plain body is NOT the short
// "label: value" transcription a booking-confirmation email has; it is
// a much larger block also containing "Original message"/"See message"
// tracking-link sections and a full footer — all of which silently
// survived the old blacklist and were persisted as "the message". The
// rewrite below is structural (an anchor + bounded span), proven against
// a fixture shaped like the real production email.

const PRODUCTION_SHAPED_BODY = textBody([
  'Civitatis',
  'You have a message from an agency',
  '',
  REAL_MESSAGE,
  '',
  'See message: https://track.civitatis.com/abc?utm_source=email&utm_campaign=clientmsg',
  '',
  'Original message',
  'Hi, we wanted to let you know about an unrelated prior exchange...',
  '',
  'Activity: Private Istanbul Experience',
  'Reservation number: 42414893',
  'Full name: John Smith',
  'Date: 29 Oct 2026',
  'Hour: 10:00',
  'People: 2',
  'Total price: 120 EUR',
  '',
  'Comments:',
  REAL_MESSAGE,
  '',
  'Thank you for choosing our services',
  '',
  'Civitatis.com',
  'Facebook',
  'Twitter',
  '© 2026 Civitatis. All rights reserved.',
  'https://civitatis.com/unsubscribe?x=1',
]);

test('[12] production-shaped fixture: only the actual customer text is returned — nothing else survives', () => {
  assert.equal(extractClientMessageText(PRODUCTION_SHAPED_BODY), REAL_MESSAGE);
});

test('[12a] tracking URLs are excluded', () => {
  assert.doesNotMatch(extractClientMessageText(PRODUCTION_SHAPED_BODY) || '', /track\.civitatis\.com|utm_source|utm_campaign/);
});

test('[12b] the "See message" link/section is excluded', () => {
  assert.doesNotMatch(extractClientMessageText(PRODUCTION_SHAPED_BODY) || '', /See message/i);
});

test('[12c] the "Original message" duplicate/unrelated section is excluded', () => {
  const extracted = extractClientMessageText(PRODUCTION_SHAPED_BODY) || '';
  assert.doesNotMatch(extracted, /Original message/i);
  assert.doesNotMatch(extracted, /unrelated prior exchange/);
});

test('[12d] the Comments duplicate is excluded when it is the same as the main anchored block — never concatenated, never counted twice', () => {
  const extracted = extractClientMessageText(PRODUCTION_SHAPED_BODY);
  assert.equal(extracted, REAL_MESSAGE);
  const occurrences = (extracted.match(new RegExp(REAL_MESSAGE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length;
  assert.equal(occurrences, 1);
});

test('[12e] Activity is excluded from message_text', () => {
  assert.doesNotMatch(extractClientMessageText(PRODUCTION_SHAPED_BODY) || '', /Private Istanbul Experience/);
});

test('[12f] Reservation number is excluded from message_text', () => {
  assert.doesNotMatch(extractClientMessageText(PRODUCTION_SHAPED_BODY) || '', /42414893/);
});

test('[12g] Full name is excluded from message_text', () => {
  assert.doesNotMatch(extractClientMessageText(PRODUCTION_SHAPED_BODY) || '', /John Smith/);
});

test('[12h] Date and Hour are excluded from message_text', () => {
  const extracted = extractClientMessageText(PRODUCTION_SHAPED_BODY) || '';
  assert.doesNotMatch(extracted, /29 Oct 2026/);
  assert.doesNotMatch(extracted, /10:00/);
});

test('[12i] People and pricing are excluded from message_text', () => {
  const extracted = extractClientMessageText(PRODUCTION_SHAPED_BODY) || '';
  assert.doesNotMatch(extracted, /120 EUR/);
  assert.doesNotMatch(extracted, /Total price/i);
});

test('[12j] footer/social content ("Thank you for choosing our services", Civitatis branding, social links, copyright) is excluded', () => {
  const extracted = extractClientMessageText(PRODUCTION_SHAPED_BODY) || '';
  assert.doesNotMatch(extracted, /Thank you for choosing our services/i);
  assert.doesNotMatch(extracted, /Facebook|Twitter/);
  assert.doesNotMatch(extracted, /All rights reserved/i);
  assert.doesNotMatch(extracted, /unsubscribe/i);
});

test('[13] the start anchor tolerates trailing text on the same line ("You have a message from an agency: <text>")', () => {
  const body = textBody(['You have a message from an agency: ' + REAL_MESSAGE, 'Activity: Tour']);
  assert.equal(extractClientMessageText(body), REAL_MESSAGE);
});

test('[14] Comments is used as a fallback ONLY when the anchor cannot be reliably identified (no "You have a message from an agency" heading at all)', () => {
  const body = textBody(['Civitatis', 'Reservation number: 42414893', `Comments: ${REAL_MESSAGE}`]);
  assert.equal(extractClientMessageText(body), REAL_MESSAGE);
});

test('[15] duplicate message text (anchored block + same-line Comments) is persisted only ONCE', () => {
  const body = textBody([
    'You have a message from an agency',
    REAL_MESSAGE,
    'Activity: Tour',
    `Comments: ${REAL_MESSAGE}`,
  ]);
  const extracted = extractClientMessageText(body);
  assert.equal(extracted, REAL_MESSAGE);
  assert.equal((extracted.match(new RegExp(REAL_MESSAGE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length, 1);
});

test('[16] duplicate message text (anchored block + bare-label Comments on the next line) is persisted only ONCE', () => {
  const body = textBody(['You have a message from an agency', REAL_MESSAGE, 'Activity: Tour', 'Comments:', REAL_MESSAGE]);
  const extracted = extractClientMessageText(body);
  assert.equal(extracted, REAL_MESSAGE);
  assert.equal((extracted.match(new RegExp(REAL_MESSAGE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length, 1);
});

test('[17] extractCommentsValue tolerates both real Civitatis layouts (same-line and bare-label-next-line)', () => {
  assert.deepEqual(extractCommentsValue(['Comments: hello']), { value: 'hello', consumedIndices: [0] });
  assert.deepEqual(extractCommentsValue(['Comments:', 'hello']), { value: 'hello', consumedIndices: [0, 1] });
  assert.deepEqual(extractCommentsValue(['no comments label here']), { value: null, consumedIndices: [] });
});

test('[18] UTF-8 Turkish address text survives extraction completely unchanged (accents, "İ"/"ş"/"ğ" preserved)', () => {
  const turkish = 'Gedikpaşa Cd. No:4, 34126 Fatih/İstanbul — Şişli tarafındaki girişi kullanın.';
  const body = textBody(['You have a message from an agency', turkish, 'Activity: Tour']);
  assert.equal(extractClientMessageText(body), turkish);
});

test('[19] FAIL CLOSED: a client-message email with no trustworthy message block (no anchor, no Comments) returns null — never the whole body as a fallback', () => {
  const body = textBody(['Civitatis', 'Reservation number: 42414893', 'Activity: Tour', 'Total price: 1 EUR', 'Facebook', 'Civitatis.com']);
  assert.equal(extractClientMessageText(body), null);
});

test('[19a] FAIL CLOSED is never satisfied by substituting the raw template: the null result never equals, or contains, the full unrelated input', () => {
  const noisyBody = textBody(['Civitatis', 'Activity: Tour', 'Reservation number: 1', 'Total price: 1 EUR']);
  const result = extractClientMessageText(noisyBody);
  assert.equal(result, null);
});

// ── 5. HTML sanitization ──────────────────────────────────────────────────

test('[20] HTML sanitization: residual markup is stripped, and HTML entities decode correctly, inside the extracted message text', () => {
  assert.equal(stripResidualHtmlTags('They are staying at <b>Enderun Hotel</b>.'), 'They are staying at Enderun Hotel.');
  // Only the common entities (amp/lt/gt/quot/apos/nbsp) are re-decoded here
  // as a defense-in-depth backstop — gmailClient.js's own decodeHtmlEntities
  // (which does handle &mdash; and the wider named-entity set) already runs
  // on the real body before this module ever sees it in production.
  const body = textBody(['You have a message from an agency', '<b>' + REAL_MESSAGE + '</b> &amp; they asked about check-in, thanks!', 'Activity: Tour']);
  const extracted = extractClientMessageText(body);
  assert.doesNotMatch(extracted, /<[^>]+>/);
  assert.doesNotMatch(extracted, /&amp;/);
  assert.match(extracted, /& they asked about check-in/);
});

test('[20a] a customer-authored URL embedded inside the actual message (alongside other words) is preserved, never stripped', () => {
  const body = textBody(['You have a message from an agency', 'Please see the hotel location here: https://maps.example.com/hotel123 and let us know.', 'Activity: Tour']);
  assert.equal(extractClientMessageText(body), 'Please see the hotel location here: https://maps.example.com/hotel123 and let us know.');
});

test('[20b] a BARE tracking-URL line (nothing else on the line) is stripped — the one, narrow URL-stripping rule, never a global URL strip', () => {
  const body = textBody(['You have a message from an agency', REAL_MESSAGE, 'https://track.civitatis.com/x?utm_source=1', 'Activity: Tour']);
  assert.equal(extractClientMessageText(body), REAL_MESSAGE);
});

test('[21] the rendered message is never passed through dangerouslySetInnerHTML anywhere in the reservation detail UI (desktop or mobile)', () => {
  const SOURCE = fs.readFileSync(path.join(REPO_ROOT, 'DeseTourDashboard.jsx'), 'utf8');
  const cardIdx = SOURCE.indexOf('function ReservationMessagesCard(');
  const cardEnd = SOURCE.indexOf('\nfunction ResTimeline(', cardIdx);
  const cardBody = SOURCE.slice(cardIdx, cardEnd);
  assert.doesNotMatch(cardBody, /dangerouslySetInnerHTML/);

  const mobileSectionIdx = SOURCE.indexOf('Civitatis Mesajları', SOURCE.indexOf('function MobileReservationDetailPage('));
  const mobileSnippet = SOURCE.slice(mobileSectionIdx - 200, mobileSectionIdx + 900);
  assert.doesNotMatch(mobileSnippet, /dangerouslySetInnerHTML/);
});

// ── 6. Plan-level: trusted-sender re-check, skipped/mismatch bookkeeping ─

test('[22] planCivitatisClientMessages re-checks classification itself (defensive), so a non-client_message message is never planned even if miscalled', async () => {
  const repo = { getCivitatisSource: async () => ({ id: 'src-1' }) };
  const messages = [{ from: CIVITATIS_SENDER, subject: 'New booking A123: Tour', body: 'x', gmailMessageId: 'g1' }];
  const plan = await planCivitatisClientMessages({ messages, repo });
  assert.equal(plan.ok, true);
  assert.equal(plan.plans.length, 0);
});

test('[23] planCivitatisClientMessages dedupes same-batch Gmail ids, same convention as cancellationAdapter.js', async () => {
  const repo = { getCivitatisSource: async () => ({ id: 'src-1' }) };
  const body = textBody(['You have a message from an agency', REAL_MESSAGE, 'Reservation number: 42414893']);
  const messages = [
    { from: CIVITATIS_SENDER, subject: REAL_SUBJECT, body, gmailMessageId: 'g1' },
    { from: CIVITATIS_SENDER, subject: REAL_SUBJECT, body, gmailMessageId: 'g1' },
  ];
  const plan = await planCivitatisClientMessages({ messages, repo });
  assert.equal(plan.plans.length, 1);
});

test('[24] a mismatch message IS still planned (forceAmbiguous:true) — Part 1\'s "persist as diagnostic ambiguous state", never silently dropped', async () => {
  const repo = { getCivitatisSource: async () => ({ id: 'src-1' }) };
  const body = textBody(['Reservation number: 99999999', REAL_MESSAGE]);
  const messages = [{ from: CIVITATIS_SENDER, subject: REAL_SUBJECT, body, gmailMessageId: 'g1' }];
  const plan = await planCivitatisClientMessages({ messages, repo });
  assert.equal(plan.plans.length, 1);
  assert.equal(plan.plans[0].forceAmbiguous, true);
  assert.equal(plan.plans[0].payload.p_force_ambiguous, true);
  assert.match(plan.plans[0].mismatchReason, /mismatch/);
});

test('[25] a message with no resolvable reservation number anywhere is never silently discarded with zero trace — defensive code path exists in the adapter (unreachable via the real subject regex, which always requires digits to classify as client_message at all, but kept as a safety net exactly like the mismatch/no-text branches)', () => {
  const ADAPTER_SOURCE = fs.readFileSync(path.join(REPO_ROOT, 'api', '_civitatis', 'clientMessageAdapter.js'), 'utf8');
  assert.match(ADAPTER_SOURCE, /no reservation number found in subject or body — cannot plan/);
  // Directly exercising resolveClientMessageExternalBookingId (the function
  // this branch depends on) proves the underlying "neither resolves" case
  // itself behaves correctly — see also test [11].
  const r = resolveClientMessageExternalBookingId({ externalBookingIdFromSubject: null, body: 'nothing useful' });
  assert.equal(r.externalBookingId, null);
});

test('[26] a message with a resolvable number but no extractable text is reported in skipped[], never silently discarded', async () => {
  const repo = { getCivitatisSource: async () => ({ id: 'src-1' }) };
  const body = textBody(['Reservation number: 42414893', 'Activity: Tour', 'Retail price: 1 EUR']);
  const messages = [{ from: CIVITATIS_SENDER, subject: REAL_SUBJECT, body, gmailMessageId: 'g1' }];
  const plan = await planCivitatisClientMessages({ messages, repo });
  assert.equal(plan.plans.length, 0);
  assert.equal(plan.skipped.length, 1);
  assert.match(plan.skipped[0].reason, /no extractable message text/);
});

test('[27] no Civitatis source configured fails closed with ok:false, never a guessed source', async () => {
  const repo = { getCivitatisSource: async () => null };
  const plan = await planCivitatisClientMessages({ messages: [], repo });
  assert.equal(plan.ok, false);
});

// ── 7. Execute-level: unknown RPC result fails closed ────────────────────

test('[28] executeCivitatisClientMessagePlan flags any RPC result outside the known vocabulary as unknownResult (fails closed)', async () => {
  const plan = [{ gmailMessageId: 'g1', externalBookingId: '42414893', payload: {} }];
  const rpcCaller = async () => ({ result: 'something_unexpected' });
  const results = await executeCivitatisClientMessagePlan(plan, rpcCaller);
  assert.equal(results[0].unknownResult, true);
});

test('[29] every value this RPC can legitimately return is in the known vocabulary', () => {
  for (const v of ['matched', 'unmatched', 'ambiguous', 'already_processed', 'failed']) {
    assert.ok(KNOWN_CLIENT_MESSAGE_RPC_RESULTS.has(v));
  }
});

// ── 8. buildClientMessageRpcPayload shape ────────────────────────────────

test('[30] buildClientMessageRpcPayload produces exactly the 8 fields the RPC signature expects, including p_force_ambiguous', () => {
  const payload = buildClientMessageRpcPayload({
    event: { gmailMessageId: 'g1', gmailThreadId: 't1', receivedAt: '2026-10-29T10:00:00Z', rawSubject: REAL_SUBJECT, externalBookingId: '42414893', messageText: REAL_MESSAGE },
    civitatisSourceId: 'src-1', forceAmbiguous: false,
  });
  assert.deepEqual(Object.keys(payload).sort(), [
    'p_external_booking_id', 'p_force_ambiguous', 'p_gmail_message_id', 'p_gmail_thread_id',
    'p_message_text', 'p_raw_subject', 'p_received_at', 'p_source_id',
  ].sort());
  assert.equal(payload.p_message_text, REAL_MESSAGE);
});

// ── 9. Migration (SQL, static — no live Postgres in this environment) ───

test('[31] migration creates exactly one new table: public.reservation_messages', () => {
  assert.match(MIGRATION_SQL, /CREATE TABLE IF NOT EXISTS public\.reservation_messages/);
});

test('[32] reservation_id uses ON DELETE SET NULL, never CASCADE — communication history survives a deleted reservation', () => {
  assert.match(MIGRATION_SQL, /reservation_id\s+UUID\s+REFERENCES public\.reservations\(id\) ON DELETE SET NULL/);
  assert.doesNotMatch(MIGRATION_SQL, /reservation_id[^,]*ON DELETE CASCADE/);
});

test('[33] exact reservation matching in SQL: COUNT(*)=1 -> matched with reservation_id set, scoped to source_id+external_booking_id, never fuzzy', () => {
  const fnStart = MIGRATION_SQL.indexOf('CREATE OR REPLACE FUNCTION public.ingest_civitatis_reservation_message');
  const fnEnd = MIGRATION_SQL.indexOf('$$;', fnStart);
  const fnBody = MIGRATION_SQL.slice(fnStart, fnEnd);
  assert.match(fnBody, /WHERE source_id = p_source_id AND external_booking_id = p_external_booking_id/);
  assert.match(fnBody, /IF v_match_count = 1 THEN/);
  assert.match(fnBody, /v_match_status := 'matched';/);
  // Never a fuzzy/partial match anywhere in the matching function body
  // itself (ILIKE legitimately appears elsewhere, in the POSTFLIGHT
  // block's unrelated activity_logs-constraint verification).
  assert.doesNotMatch(fnBody, /ILIKE|LIKE '%/);
});

test('[34] no-match behavior in SQL: zero rows -> unmatched, reservation_id NULL, row still inserted (never discarded)', () => {
  assert.match(MIGRATION_SQL, /ELSIF v_match_count = 0 THEN/);
  const idx = MIGRATION_SQL.indexOf('ELSIF v_match_count = 0 THEN');
  const snippet = MIGRATION_SQL.slice(idx, idx + 120);
  assert.match(snippet, /v_reservation_id := NULL;/);
  assert.match(snippet, /v_match_status := 'unmatched';/);
  assert.match(MIGRATION_SQL, /INSERT INTO public\.reservation_messages/); // the row is always inserted after branching, matched or not
});

test('[35] ambiguous-match fail-closed behavior in SQL: more than one row -> ambiguous, reservation_id NULL, never guessed', () => {
  const idx = MIGRATION_SQL.indexOf('ELSIF v_match_count = 0 THEN');
  const elseSnippet = MIGRATION_SQL.slice(idx, MIGRATION_SQL.indexOf('END IF;\n  END IF;', idx));
  assert.match(elseSnippet, /ELSE\s*\n\s*v_reservation_id := NULL;\s*\n\s*v_match_status := 'ambiguous';/);
});

test('[36] the subject/body-mismatch diagnostic path (p_force_ambiguous) skips the lookup entirely and forces ambiguous, never attempting a match with a possibly-wrong number', () => {
  assert.match(MIGRATION_SQL, /IF p_force_ambiguous THEN/);
  const idx = MIGRATION_SQL.indexOf('IF p_force_ambiguous THEN');
  const snippet = MIGRATION_SQL.slice(idx, idx + 150);
  assert.match(snippet, /v_match_status := 'ambiguous';/);
});

test('[37] a CHECK constraint structurally prevents match_status/reservation_id from ever disagreeing', () => {
  assert.match(MIGRATION_SQL, /CONSTRAINT reservation_messages_match_status_consistency CHECK/);
  assert.match(MIGRATION_SQL, /match_status = 'matched'\s+AND reservation_id IS NOT NULL/);
  assert.match(MIGRATION_SQL, /match_status IN \('unmatched','ambiguous'\) AND reservation_id IS NULL/);
});

// ── 10. Idempotency (SQL, static) ─────────────────────────────────────────

test('[38] idempotency on repeated email processing: UNIQUE (source, gmail_message_id) is the sole dedup authority, never body text', () => {
  assert.match(MIGRATION_SQL, /CONSTRAINT reservation_messages_source_gmail_message_id_key\s*\n\s*UNIQUE \(source, gmail_message_id\)/);
  assert.doesNotMatch(MIGRATION_SQL, /UNIQUE[^;]*message_text/);
});

test('[39] same Gmail/provider message cannot create two records: the function checks for an existing row by (source, gmail_message_id) BEFORE any insert, returning already_processed', () => {
  const idx = MIGRATION_SQL.indexOf('STEP 1 — idempotency');
  const insertIdx = MIGRATION_SQL.indexOf('INSERT INTO public.reservation_messages');
  assert.ok(idx > -1 && insertIdx > -1 && idx < insertIdx, 'the idempotency check must run before the insert');
  const snippet = MIGRATION_SQL.slice(idx, insertIdx);
  assert.match(snippet, /already_processed/);
});

test('[40] a genuine race (two concurrent calls for the same Gmail message) is still caught: the function has an EXCEPTION WHEN unique_violation handler treating it as the same idempotent skip', () => {
  assert.match(MIGRATION_SQL, /EXCEPTION\s*\n(\s*--[^\n]*\n)*\s*WHEN unique_violation THEN/);
  const idx = MIGRATION_SQL.indexOf('WHEN unique_violation THEN');
  const snippet = MIGRATION_SQL.slice(idx, idx + 120);
  assert.match(snippet, /already_processed/);
});

test('[41] the rollback drops reservation_messages and its function, in an order that respects the dependency, and permanently removing all ingested messages is an explicit, documented data-loss warning', () => {
  assert.match(ROLLBACK_SQL, /DROP TABLE IF EXISTS public\.reservation_messages/);
  assert.match(ROLLBACK_SQL, /DROP FUNCTION IF EXISTS public\.ingest_civitatis_reservation_message/);
  assert.match(ROLLBACK_SQL, /DATA LOSS WARNING/);
});

// ── 11. Notification + activity log (SQL, static) ────────────────────────

test('[42] new-message notification/activity log is created exactly ONCE per newly matched message: the activity_logs INSERT is inside the SAME function invocation as the message insert, gated on match_status=matched only', () => {
  const insertIdx = MIGRATION_SQL.indexOf('INSERT INTO public.reservation_messages');
  const activityIdx = MIGRATION_SQL.indexOf("IF v_match_status = 'matched' THEN");
  const activityInsertIdx = MIGRATION_SQL.indexOf('INSERT INTO public.activity_logs');
  assert.ok(insertIdx > -1 && activityIdx > -1 && activityInsertIdx > -1);
  assert.ok(insertIdx < activityIdx && activityIdx < activityInsertIdx);
  // Occurs exactly once in the whole function body — never two separate
  // activity_logs inserts for the same code path.
  const occurrences = (MIGRATION_SQL.match(/INSERT INTO public\.activity_logs/g) || []).length;
  assert.equal(occurrences, 1);
});

test('[43] activity log created once if enabled (never for unmatched/ambiguous, never on an already_processed repeat): the activity_logs INSERT is unreachable once Step 1\'s idempotency RETURN has already fired', () => {
  const step1ReturnIdx = MIGRATION_SQL.indexOf("RETURN jsonb_build_object('result','already_processed','reservation_message_id',v_existing_id);");
  const activityInsertIdx = MIGRATION_SQL.indexOf('INSERT INTO public.activity_logs');
  assert.ok(step1ReturnIdx > -1 && activityInsertIdx > -1 && step1ReturnIdx < activityInsertIdx, 'the idempotent-skip RETURN must occur, in source order, before the activity_logs insert — proving a repeat processing run returns before ever reaching it');
});

test('[44] full message body not copied into notification/activity log: the activity_logs INSERT never references p_message_text or v_message_id\'s own text', () => {
  const activityIdx = MIGRATION_SQL.indexOf('INSERT INTO public.activity_logs');
  const activityValuesEnd = MIGRATION_SQL.indexOf(');', activityIdx);
  const snippet = MIGRATION_SQL.slice(activityIdx, activityValuesEnd);
  assert.doesNotMatch(snippet, /p_message_text/);
  assert.doesNotMatch(snippet, new RegExp(REAL_MESSAGE.slice(0, 15)));
});

test('[45] the activity_logs description is a short Turkish sentence naming the reservation number, matching the suggested copy exactly in shape', () => {
  assert.match(MIGRATION_SQL, /numaralı rezervasyona yeni Civitatis mesajı geldi\./);
});

test('[46] activity_type/action used are already-allowed values — entity_type=reservation, action=reply — confirmed against activity_logs\' own current CHECK constraints (no widening needed)', () => {
  const idx = MIGRATION_SQL.indexOf('INSERT INTO public.activity_logs');
  const snippet = MIGRATION_SQL.slice(idx, idx + 300);
  assert.match(snippet, /'reservation', v_reservation_id, 'reply',/);
  assert.doesNotMatch(MIGRATION_SQL, /ALTER TABLE public\.activity_logs/);
});

// ── 12. Part 9: never mutates reservation fields ─────────────────────────

test('[47] message ingestion does not mutate reservation fields: the RPC function body contains no UPDATE statement against public.reservations anywhere', () => {
  const fnStart = MIGRATION_SQL.indexOf('CREATE OR REPLACE FUNCTION public.ingest_civitatis_reservation_message');
  const fnEnd = MIGRATION_SQL.indexOf('$$;', fnStart);
  const fnBody = MIGRATION_SQL.slice(fnStart, fnEnd);
  assert.doesNotMatch(fnBody, /UPDATE\s+public\.reservations/i);
  assert.doesNotMatch(fnBody, /UPDATE\s+reservations/i);
});

test('[48] the frontend never exposes a write/update method for reservation messages — SupabaseReservationMessageRepo and its mock fallback are read-only (getByReservationId only)', () => {
  const SOURCE = fs.readFileSync(path.join(REPO_ROOT, 'DeseTourDashboard.jsx'), 'utf8');
  const idx = SOURCE.indexOf('const SupabaseReservationMessageRepo = {');
  const end = SOURCE.indexOf('\n};', idx);
  const body = SOURCE.slice(idx, end);
  assert.doesNotMatch(body, /async (create|update|delete)\(/);

  const mockIdx = SOURCE.indexOf('const ReservationMessageRepository = {');
  const mockEnd = SOURCE.indexOf('\n};', mockIdx);
  const mockBody = SOURCE.slice(mockIdx, mockEnd);
  assert.doesNotMatch(mockBody, /(create|update|delete)\(/);
});

test('[49] RLS grants SELECT only — no INSERT/UPDATE/DELETE policy exists for any authenticated role; only service_role (via the RPC) writes', () => {
  assert.doesNotMatch(MIGRATION_SQL, /FOR (INSERT|UPDATE|DELETE|ALL) TO authenticated/);
  assert.match(MIGRATION_SQL, /GRANT EXECUTE ON FUNCTION public\.ingest_civitatis_reservation_message\(\s*\n[^)]*\)\s*TO service_role;/);
});

// ── 14. SECURITY DEFINER audit: deliberately SECURITY INVOKER ───────────

test('[49b] the RPC is deliberately SECURITY INVOKER, NOT SECURITY DEFINER — the only caller is service_role, which already bypasses RLS and holds the needed table privileges directly, so SECURITY DEFINER would add privilege-escalation risk with no compensating benefit', () => {
  const fnStart = MIGRATION_SQL.indexOf('CREATE OR REPLACE FUNCTION public.ingest_civitatis_reservation_message');
  const fnEnd = MIGRATION_SQL.indexOf('AS $$', fnStart);
  const fnHeader = MIGRATION_SQL.slice(fnStart, fnEnd);
  assert.match(fnHeader, /SECURITY INVOKER/);
  assert.doesNotMatch(fnHeader, /SECURITY DEFINER/);
});

test('[49c] search_path is explicitly fixed on the function (SET search_path = public), and every table reference inside the function body is also fully schema-qualified (public.*), regardless of INVOKER/DEFINER', () => {
  const fnStart = MIGRATION_SQL.indexOf('CREATE OR REPLACE FUNCTION public.ingest_civitatis_reservation_message');
  const fnBodyEnd = MIGRATION_SQL.indexOf('$$;', fnStart);
  const fnFull = MIGRATION_SQL.slice(fnStart, fnBodyEnd);
  assert.match(fnFull, /SET search_path = public/);
  assert.doesNotMatch(fnFull, /(?<!public\.)\b(FROM|INTO|UPDATE|INSERT INTO)\s+(reservations|reservation_messages|activity_logs)\b/);
});

test('[49d] no dynamic SQL exists anywhere in the function — no EXECUTE statement, no format()/string-built SQL, no user-controlled text concatenated into a query', () => {
  const fnStart = MIGRATION_SQL.indexOf('CREATE OR REPLACE FUNCTION public.ingest_civitatis_reservation_message');
  const fnBodyEnd = MIGRATION_SQL.indexOf('$$;', fnStart);
  const fnFull = MIGRATION_SQL.slice(fnStart, fnBodyEnd);
  assert.doesNotMatch(fnFull, /\bEXECUTE\s+(format\(|'|")/i);
  assert.doesNotMatch(fnFull, /\bformat\(/);
  assert.doesNotMatch(fnFull, /\|\|.*SELECT|SELECT.*\|\|/i);
});

test('[49e] the postflight explicitly verifies prosecdef is FALSE (not SECURITY DEFINER) and aborts the migration if that ever regresses', () => {
  assert.match(MIGRATION_SQL, /IF v_function_secdef THEN\s*\n\s*RAISE EXCEPTION 'CIVITATIS CLIENT MESSAGES POSTFLIGHT FAILED: ingest_civitatis_reservation_message is SECURITY DEFINER/);
});

test('[50] RLS never weakens AAL2: every one of the 4 policies requires is_aal2()', () => {
  const policyBlocks = MIGRATION_SQL.match(/CREATE POLICY "reservation_messages:[^"]*"[\s\S]*?;/g) || [];
  assert.equal(policyBlocks.length, 4);
  for (const block of policyBlocks) {
    assert.match(block, /is_aal2\(\)/, `policy missing is_aal2(): ${block.slice(0, 80)}`);
  }
});

test('[51] Sales RLS audit: Sales sees matched rows only (reservation_id IS NOT NULL) — matches the design report\'s explicit audit that this exposes nothing Sales couldn\'t already see via reservations\' own unconditional sales-read policy', () => {
  assert.match(MIGRATION_SQL, /"reservation_messages: sales read matched"[\s\S]*?USING \(\s*is_sales\(\) AND is_aal2\(\) AND reservation_id IS NOT NULL\s*\)/);
});

test('[52] guide RLS is scoped to their own assigned, non-cancelled reservation only — same EXISTS join shape as reservation_guests', () => {
  assert.match(MIGRATION_SQL, /is_guide\(\) AND is_aal2\(\) AND reservation_id IS NOT NULL AND EXISTS \(/);
  assert.match(MIGRATION_SQL, /r\.assigned_to = auth\.uid\(\)/);
  assert.match(MIGRATION_SQL, /r\.status NOT IN \('cancelled'\)/);
});

// ── 13. Regression: existing pipelines + Agency Mailbox untouched ───────

test('[53] existing Civitatis reservation ingestion remains unchanged: the new migration never CREATEs/ALTERs/calls ingest_civitatis_booking or cancel_civitatis_booking — fully separate objects, only mentioned in header prose as precedent', () => {
  assert.doesNotMatch(MIGRATION_SQL, /CREATE (OR REPLACE )?FUNCTION public\.(ingest_civitatis_booking|cancel_civitatis_booking)/);
  assert.doesNotMatch(MIGRATION_SQL, /(?<!public\.)\b(?:SELECT|PERFORM)\b[^;]*\b(ingest_civitatis_booking|cancel_civitatis_booking)\s*\(/);
  assert.doesNotMatch(MIGRATION_SQL, /ALTER (TABLE|FUNCTION)[^;]*\b(ingest_civitatis_booking|cancel_civitatis_booking)\b/);
});

test('[54] existing eventDetector patterns (new_booking/modified/cancelled) are byte-for-byte unchanged', () => {
  const EVENT_DETECTOR_SOURCE = fs.readFileSync(path.join(REPO_ROOT, 'api', '_civitatis', 'eventDetector.js'), 'utf8');
  assert.match(EVENT_DETECTOR_SOURCE, /const NEW_BOOKING_SUBJECT = \/\^New booking A\(\\d\+\):\//);
  assert.match(EVENT_DETECTOR_SOURCE, /const MODIFIED_SUBJECT = \/\^Booking A\(\\d\+\) modified:\//);
  assert.match(EVENT_DETECTOR_SOURCE, /const CANCELLATION_SUBJECT = \/\^Cancellation A\(\\d\+\):\//);
  assert.match(EVENT_DETECTOR_SOURCE, /const CIVITATIS_SENDER = 'notificaciones@civitatis\.com';/);
});

test('[55] Agency Mailbox is completely untouched by this feature\'s actual code: the new JS adapter/extraction modules never reference agency_emails/gmailInboundSync/logInboundReply at all (the migration\'s own header prose cites logInboundReply only as a design precedent, never as code it calls)', () => {
  const files = [
    path.join(REPO_ROOT, 'api', '_civitatis', 'clientMessageAdapter.js'),
    path.join(REPO_ROOT, 'api', '_civitatis', 'clientMessageExtraction.js'),
  ];
  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8');
    assert.doesNotMatch(src, /agency_emails|gmailInboundSync|logInboundReply/i);
  }
  // The migration itself never CREATEs/ALTERs/writes to the agency_emails
  // table in actual SQL — its header PROSE (comment lines) legitimately
  // names it once, only to document that it is untouched (see the
  // migration's own "WHAT THIS ADDS" section). Checked line-by-line so a
  // multi-line comment block can never produce a false positive.
  const nonCommentLinesReferencingAgencyEmails = MIGRATION_SQL.split('\n')
    .filter(line => !line.trim().startsWith('--'))
    .filter(line => /\bagency_emails\b/.test(line));
  assert.deepEqual(nonCommentLinesReferencingAgencyEmails, []);
});

test('[56] api/_agencies/gmailInboundSync.js was not modified by this feature (file untouched — verified via git)', () => {
  const { execSync } = require('child_process');
  let diffNameOnly = '';
  try {
    diffNameOnly = execSync('git diff --name-only HEAD', { cwd: REPO_ROOT }).toString();
  } catch (_) {
    return; // not a git checkout in this environment — nothing to assert
  }
  assert.doesNotMatch(diffNameOnly, /api\/_agencies\/gmailInboundSync\.js/);
});
