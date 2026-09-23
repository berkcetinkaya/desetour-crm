'use strict';
/**
 * tests/civitatis/liveMissingBookingA41748096.test.js
 * ─────────────────────────────────────────────────────────────────────────
 * Regression coverage for the production incident: real Civitatis
 * booking A41748096 ("Tour del Grande Bazar", Italiano, 2 Oct 2026 9:00)
 * arrived in reservation@desetour.com Gmail but never appeared in the
 * CRM.
 *
 * ROOT CAUSE (proven by running the exact reported email body through
 * the UNMODIFIED parser — see the session's investigation): this
 * email's booking-contact block has no "Client details:" header at all
 * — it uses top-level "Client name:" / "Surname:" lines instead — and
 * its passenger lines are the shorter "Passenger N: NAME" form (name
 * inline) rather than "Passenger information N:" + a separate value
 * line. Before the fix, extractClientDetails found no "Client details:"
 * header, so clientName/clientSurname stayed null, which alone was
 * enough to route the whole email to needs_review
 * ("missing \"Client details:\" booking contact"). A needs_review
 * verdict at the PLANNING stage (api/_civitatis/writeAdapter.js) never
 * reaches the RPC, so no email_ingestions row is ever written for it —
 * meaning the SAME Gmail message would be silently re-fetched and
 * re-rejected on every subsequent scheduled run, forever, never created
 * and never distinguishable from "not yet discovered" in the scheduler
 * response.
 *
 * The Gmail discovery path itself (watermark/window math, exhaustive
 * pagination, ordering-independence) was audited and found sound — see
 * tests/civitatis/cronWriteEndpoint.test.js's own extensive existing
 * coverage of that layer, unmodified and still passing. This file's
 * job is narrower: prove the parser fix generically handles this real
 * email shape end-to-end, without hardcoding booking 41748096 anywhere
 * in application code (only this test file and its fixture reference
 * the real booking number, exactly like every other real-booking
 * regression test already in this suite — e.g. A41629692/A41534177 in
 * tests/civitatis/writeAdapter.test.js).
 * ─────────────────────────────────────────────────────────────────────────
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { parseCivitatisEmail } = require('../../api/_civitatis/parser');
const { detectCivitatisEvent } = require('../../api/_civitatis/eventDetector');
const { matchTourChannel } = require('../../api/_civitatis/matching');
const { runCivitatisDryRun, OUTCOME } = require('../../api/_civitatis/dryRun');
const { planCivitatisIngestion, executeCivitatisIngestionPlan, buildRpcPayload } = require('../../api/_civitatis/writeAdapter');
const gmailClient = require('../../api/_civitatis/gmailClient');
const { createFakeRepo } = require('./fakeRepo');
const F = require('./fixtures');

const SOURCE_ID = 'src-civitatis';
const PRODUCT = 'Grand Bazaar Experience';
// The real, already-live production mapping given for this incident —
// never fabricated, used exactly as reported.
const SPANISH_TOUR_ID = 'c5e42d88-0a6c-4703-9c22-90eec5a278bd';
const ITALIAN_TOUR_ID = 'bed4fba3-e6ad-435a-b971-64606d8a46f4';

const SPANISH_ROW = {
  id: 'tc-es', tour_id: SPANISH_TOUR_ID, source_id: SOURCE_ID,
  external_product_id: PRODUCT, booking_language: 'İspanyolca',
  tour: { id: SPANISH_TOUR_ID, name: 'Grand Bazaar Experience' },
};
const ITALIAN_ROW = {
  id: 'tc-it', tour_id: ITALIAN_TOUR_ID, source_id: SOURCE_ID,
  external_product_id: PRODUCT, booking_language: 'İtalyanca',
  tour: { id: ITALIAN_TOUR_ID, name: 'Grand Bazaar Experience' },
};

function repoWithLanguageMappings(overrides = {}) {
  return {
    source: { id: SOURCE_ID },
    tourChannels: [SPANISH_ROW, ITALIAN_ROW],
    reservations: [],
    reservationGuests: {},
    customers: [],
    ...overrides,
  };
}

// ── 2. Subject is recognized as new_booking ─────────────────────────────

test('2. the real subject "New booking A41748096: Tour del Grande Bazar" is recognized as new_booking (not ignored/needs_review)', () => {
  const detection = detectCivitatisEvent({ from: F.italianA41748096Booking.from, subject: F.italianA41748096Booking.subject });
  assert.equal(detection.classification, 'new_booking');
  assert.equal(detection.externalBookingIdFromSubject, '41748096');
});

// ── Parsing: the fixed parser now succeeds on the real email shape ─────

const parsed = parseCivitatisEmail(F.italianA41748096Booking);

test('the fix: this exact real email now parses successfully (ok:true) — before the fix it was needs_review ("missing Client details")', () => {
  assert.equal(parsed.ok, true, `expected ok:true, got needs_review with reasons: ${JSON.stringify(parsed.reasons)}`);
  assert.equal(parsed.status, 'parsed');
  assert.deepEqual(parsed.reasons, []);
});

// ── 3. Reservation number parses as 41748096 ────────────────────────────

test('3. reservation number parses as 41748096', () => {
  assert.equal(parsed.externalBookingId, '41748096');
});

// ── 4. Italiano maps to İtalyanca ───────────────────────────────────────

test('4. Language "Italiano" normalizes to the canonical "İtalyanca" — reuses the existing languageMap.js, no new mapping added', () => {
  assert.equal(parsed.languageRaw, 'Italiano');
  assert.equal(parsed.tourLanguage, 'İtalyanca');
  assert.equal(parsed.languageCode, 'it');
});

// ── 5. Internal code maps to Grand Bazaar Experience ────────────────────

test('5. Internal code parses as "Grand Bazaar Experience"', () => {
  assert.equal(parsed.internalCode, 'Grand Bazaar Experience');
});

// ── 6. Italian language-aware tour mapping selects the real production tour ──

test('6. the real production language-aware mapping resolves this booking to the Italian tour bed4fba3-e6ad-435a-b971-64606d8a46f4, never the Spanish one', () => {
  const match = matchTourChannel({
    internalCode: parsed.internalCode,
    civitatisSourceId: SOURCE_ID,
    bookingLanguage: parsed.tourLanguage,
    tourChannels: [SPANISH_ROW, ITALIAN_ROW],
  });
  assert.equal(match.matched, true);
  assert.equal(match.tour.id, ITALIAN_TOUR_ID);
});

// ── 7. Both passengers parse correctly (the "Passenger N:" inline shape) ──

test('7. both passengers parse correctly from the "Passenger N: NAME" inline shape, never rewritten/renormalized', () => {
  assert.deepEqual(parsed.passengers, [
    { fullName: 'GIANGUGLIELMO DALMONTE', sortOrder: 0 },
    { fullName: 'COLETTE FICCHI', sortOrder: 1 },
  ]);
});

test('passengers stay passengers, never mistaken for the booking contact/customer', () => {
  assert.notEqual(parsed.clientFullName, 'GIANGUGLIELMO DALMONTE');
  assert.notEqual(parsed.clientFullName, 'COLETTE FICCHI');
  assert.equal(parsed.clientFullName, 'Gianguglielmo Dalmonte');
});

// ── 8/9. Retail and net amounts ─────────────────────────────────────────

test('8. retail amount is 4800 TL', () => {
  assert.equal(parsed.retailAmount, 4800);
  assert.equal(parsed.retailCurrency, 'TL');
});

test('9. net amount is 3600 TL', () => {
  assert.equal(parsed.netAmount, 3600);
  assert.equal(parsed.netCurrency, 'TL');
});

test('pax_adult = 2, pax_child = 0 (matches the expected post-fix reservation shape)', () => {
  assert.equal(parsed.adultCount, 2);
  assert.equal(parsed.childCount, null); // buildRpcPayload/the RPC apply the documented 0-default; parser itself never fabricates a count
});

// ── Booking contact: derived from Client details per existing rules ────

test('the booking contact is derived from "Client name:"/"Surname:" exactly like the existing customer-matching rules already expect (full name, no email/phone here)', () => {
  assert.equal(parsed.clientName, 'Gianguglielmo');
  assert.equal(parsed.clientSurname, 'Dalmonte');
  assert.equal(parsed.clientEmail, null);
  assert.deepEqual(parsed.phones, []);
});

// ── 10. First execution is eligible for CREATE ──────────────────────────

test('10. dry run classifies a first-time sighting of this booking as WOULD_CREATE, resolved to the Italian tour', async () => {
  const repo = createFakeRepo(repoWithLanguageMappings());
  const report = await runCivitatisDryRun({ messages: [F.italianA41748096Booking], repo });
  assert.equal(report.ok, true);
  const booking = report.bookings[0];
  assert.equal(booking.externalBookingId, '41748096');
  assert.equal(booking.outcome, OUTCOME.WOULD_CREATE);
  assert.equal(booking.tourMatch.tour.id, ITALIAN_TOUR_ID);
});

test('10 (write path). planCivitatisIngestion plans exactly one eligible CREATE call for a first-time sighting, with the correct RPC payload shape', async () => {
  const repo = createFakeRepo(repoWithLanguageMappings());
  const plan = await planCivitatisIngestion({ messages: [F.italianA41748096Booking], repo });
  assert.equal(plan.ok, true);
  assert.equal(plan.plans.length, 1);
  const entry = plan.plans[0];
  assert.equal(entry.eligible, true);
  assert.equal(entry.tourId, ITALIAN_TOUR_ID);
  assert.equal(entry.calls.length, 1);
  const payload = entry.calls[0];
  assert.equal(payload.p_external_booking_id, '41748096');
  assert.equal(payload.p_tour_id, ITALIAN_TOUR_ID);
  assert.equal(payload.p_tour_language, 'İtalyanca');
  assert.equal(payload.p_pax_adult, 2);
  assert.equal(payload.p_retail_amount, 4800);
  assert.equal(payload.p_total_amount, 3600); // Civitatis "Net price" -> total_amount (DeseTour's own revenue figure)
  assert.equal(payload.p_currency, 'TL');
  assert.ok(Array.isArray(payload.p_passengers));
  assert.deepEqual(payload.p_passengers, [
    { fullName: 'GIANGUGLIELMO DALMONTE', sortOrder: 0 },
    { fullName: 'COLETTE FICCHI', sortOrder: 1 },
  ]);
});

// ── 11. Second execution is idempotent ──────────────────────────────────

test('11. a second scheduled run, after this booking is already linked to a reservation, stays on the update (never re-create) path with the same tourId', async () => {
  const repoFirstRun = createFakeRepo(repoWithLanguageMappings());
  const plan1 = await planCivitatisIngestion({ messages: [F.italianA41748096Booking], repo: repoFirstRun });
  const rpcCaller1 = async (payload) => {
    assert.equal(payload.p_gmail_message_id, F.italianA41748096Booking.gmailMessageId);
    return { result: 'created', reservation_id: 'res-41748096', ingestion_id: 'ing-1' };
  };
  const executed1 = await executeCivitatisIngestionPlan(plan1, rpcCaller1);
  assert.equal(executed1[0].skipped, false);
  assert.equal(executed1[0].calls[0].rpcResult.result, 'created');

  // Second run: the repo now reflects the reservation the first run
  // (via the real RPC, simulated here) would have created.
  const repoSecondRun = createFakeRepo(repoWithLanguageMappings({
    reservations: [{
      id: 'res-41748096', source_id: SOURCE_ID, external_booking_id: '41748096',
      tour_id: ITALIAN_TOUR_ID, customer_id: 'cust-1',
    }],
  }));
  const plan2 = await planCivitatisIngestion({ messages: [F.italianA41748096Booking], repo: repoSecondRun });
  assert.equal(plan2.plans.length, 1, 'must still be exactly one booking — never a second/duplicate plan entry');
  assert.equal(plan2.plans[0].tourId, ITALIAN_TOUR_ID);
  const rpcCaller2 = async (payload) => {
    assert.equal(payload.p_gmail_message_id, F.italianA41748096Booking.gmailMessageId, 'the SAME gmail_message_id is sent again — this is exactly what the RPC\'s UNIQUE(gmail_message_id) guard keys its idempotency off of');
    return { result: 'already_processed', reservation_id: 'res-41748096' };
  };
  const executed2 = await executeCivitatisIngestionPlan(plan2, rpcCaller2);
  assert.equal(executed2[0].calls[0].rpcResult.result, 'already_processed');
  assert.equal(executed2[0].calls[0].rpcResult.reservation_id, 'res-41748096', 'points at the SAME reservation, never a new one');
});

// ── 12. Spanish Grand Bazaar behavior remains unchanged ─────────────────

test('12. the pre-existing Spanish Grand Bazaar booking still parses and resolves correctly — unaffected by this fix (regression)', async () => {
  const spanishParsed = parseCivitatisEmail(F.spanishNewBooking);
  assert.equal(spanishParsed.ok, true);
  assert.equal(spanishParsed.tourLanguage, 'İspanyolca');

  const match = matchTourChannel({
    internalCode: spanishParsed.internalCode,
    civitatisSourceId: SOURCE_ID,
    bookingLanguage: spanishParsed.tourLanguage,
    tourChannels: [SPANISH_ROW, ITALIAN_ROW],
  });
  assert.equal(match.matched, true);
  assert.equal(match.tour.id, SPANISH_TOUR_ID);
});

// ── 13. Existing processed bookings remain unchanged ────────────────────

test('13. the two already-corrected real Italian bookings (A41629692, A41534177) still parse and resolve to the Italian tour exactly as before — this fix changes no existing behavior for them', async () => {
  for (const fixture of [F.italianNewBooking, F.sampleSafeCreateBooking]) {
    const p = parseCivitatisEmail(fixture);
    assert.equal(p.ok, true);
    assert.equal(p.tourLanguage, 'İtalyanca');
    const match = matchTourChannel({
      internalCode: p.internalCode, civitatisSourceId: SOURCE_ID,
      bookingLanguage: p.tourLanguage, tourChannels: [SPANISH_ROW, ITALIAN_ROW],
    });
    assert.equal(match.matched, true);
    assert.equal(match.tour.id, ITALIAN_TOUR_ID);
  }
});

test('13 (real-format fixtures). the existing "PASSENGER INFORMATION N:" / "CLIENT DETAILS" block-shaped fixtures still parse exactly as before — the new inline shapes are additive, not a replacement', () => {
  for (const fixture of [F.italianRealFormatBooking, F.spanishRealFormatBooking]) {
    const p = parseCivitatisEmail(fixture);
    assert.equal(p.ok, true);
    assert.ok(p.passengers.length >= 2);
    assert.ok(p.clientFullName);
  }
});

// ── 14. Discovery does not rely on Gmail result ordering ────────────────

test('14. this booking is still discovered when Gmail returns it on a LATER page than other messages — discovery does not depend on result ordering', async () => {
  const calls = [];
  const fetchPageFn = async (query, { pageToken }) => {
    calls.push(pageToken);
    if (!pageToken) {
      // Page 1: an older, already-processed booking only — the new
      // booking is NOT here, exactly like the real incident's reported
      // scheduler response.
      return { messages: [{ ...F.italianNewBooking, gmailMessageId: 'm-old-41736033' }], nextPageToken: 'page-2' };
    }
    // Page 2: the real new booking, discovered only by continuing to paginate.
    return { messages: [F.italianA41748096Booking], nextPageToken: null };
  };
  const result = await gmailClient.fetchAllMessagesWithinCeiling('q', { maxTotal: 300, fetchPageFn });
  assert.equal(calls.length, 2, 'must have followed the nextPageToken to the second page, never assumed page 1 was complete');
  assert.ok(result.messages.some(m => m.gmailMessageId === F.italianA41748096Booking.gmailMessageId));
});

// ── 15. Pagination still works (multi-page fetch, ceiling respected) ────

test('15. pagination still fetches every page up to the ceiling and reports truncation honestly, with the new booking anywhere in the sequence', async () => {
  const fetchPageFn = async (query, { pageToken }) => {
    if (!pageToken) return { messages: [{ gmailMessageId: 'm1' }, { gmailMessageId: 'm2' }], nextPageToken: 'p2' };
    return { messages: [F.italianA41748096Booking], nextPageToken: null };
  };
  const result = await gmailClient.fetchAllMessagesWithinCeiling('q', { maxTotal: 300, fetchPageFn });
  assert.equal(result.pagesFetched, 2);
  assert.equal(result.truncated, false);
  assert.equal(result.messages.length, 3);
});

// ── 1. Gmail discovery includes the new message inside the polling window ──

test('1. the computed since-timestamp for a recent watermark is safely before this booking\'s received time, so the after: window would include it', () => {
  // computeSinceUnixSeconds is exported by the cron handler, not gmailClient —
  // imported directly here to avoid re-deriving the arithmetic.
  const { computeSinceUnixSeconds, OVERLAP_WINDOW_MS } = require('../../api/cron-ingest-civitatis-write');
  const watermarkIso = '2026-09-22T10:00:00.000Z'; // last known email_ingestions.received_at, well before this booking
  const nowMs = new Date('2026-09-23T16:50:00.000Z').getTime(); // shortly after the booking arrived (16:47)
  const sinceUnixSeconds = computeSinceUnixSeconds({ lastReceivedAtIso: watermarkIso, nowMs });
  const bookingReceivedUnixSeconds = Math.floor(new Date(F.italianA41748096Booking.receivedAt).getTime() / 1000);
  assert.ok(sinceUnixSeconds < bookingReceivedUnixSeconds, 'the 24h-overlap since-timestamp must fall before this booking\'s own received time');
  assert.equal(OVERLAP_WINDOW_MS, 24 * 60 * 60 * 1000);
});

// ── 16. No secrets are emitted in logs ──────────────────────────────────

test('16. buildRpcPayload / the plan entries never carry an OAuth token, Supabase key, scheduler secret, or manual-write secret for this booking', () => {
  const parsedEvent = parseCivitatisEmail(F.italianA41748096Booking);
  const payload = buildRpcPayload({
    parsedEvent, rawBody: F.italianA41748096Booking.body,
    civitatisSourceId: SOURCE_ID, tourId: ITALIAN_TOUR_ID, customerId: null,
  });
  const serialized = JSON.stringify(payload);
  assert.doesNotMatch(serialized, /GMAIL_REFRESH_TOKEN|GMAIL_CLIENT_SECRET|SUPABASE_SERVICE_ROLE_KEY|CIVITATIS_SCHEDULER_SECRET|CIVITATIS_MANUAL_WRITE_SECRET/i);
});

test('16 (source check). gmailClient never logs an access token, and the OAuth token exchange response is never console.logged anywhere', () => {
  const fs = require('fs');
  const path = require('path');
  const source = fs.readFileSync(path.join(__dirname, '..', '..', 'api', '_civitatis', 'gmailClient.js'), 'utf8');
  assert.doesNotMatch(source, /console\.(log|warn|error)\([^)]*access_token/i);
  assert.doesNotMatch(source, /console\.(log|warn|error)\([^)]*refreshToken/i);
});
