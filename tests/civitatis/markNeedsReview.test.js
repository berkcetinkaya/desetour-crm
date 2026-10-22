'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildMarkNeedsReviewPayload, planCivitatisIngestion, executeCivitatisIngestionPlan,
  KNOWN_MARK_NEEDS_REVIEW_RESULTS,
} = require('../../api/_civitatis/writeAdapter');
const writeEndpoint = require('../../api/ingest-civitatis-write');
const { createFakeRepo } = require('./fakeRepo');
const F = require('./fixtures');

// Covers the Civitatis silent-loss fix: every pre-RPC safety gate that
// used to leave ZERO persisted trace (POSSIBLE_EXISTING_MATCH in any of
// its three variants, a booking-chain parse failure, and an unresolved
// external booking id) now produces one or more
// mark_civitatis_email_needs_review RPC call intents — never auto-
// binding an ambiguous customer, never auto-linking an ambiguous
// reservation, never writing the real booking RPC for an ineligible
// chain. No network/Gmail/Supabase access anywhere in this file; the
// real RPC's own idempotency/never-writes-business-tables guarantees
// are proven separately in
// tests/civitatis/sql/mark_civitatis_email_needs_review_manual_tests.sql
// (validated this phase against a disposable local PostgreSQL 16
// instance — see the implementation report).

const CIVITATIS_SOURCE = { id: 'src-civitatis' };
const GRAND_BAZAAR_TOUR_CHANNEL = {
  id: 'tc-1', tour_id: 'tour-grand-bazaar', source_id: 'src-civitatis',
  external_product_id: 'Grand Bazaar Experience',
  tour: { id: 'tour-grand-bazaar', name: 'Grand Bazaar Experience' },
};
function baseRepoOptions(overrides = {}) {
  return {
    source: CIVITATIS_SOURCE, tourChannels: [GRAND_BAZAAR_TOUR_CHANNEL],
    reservations: [], reservationGuests: {}, customers: [], ...overrides,
  };
}
function makeSpyCaller(responses) {
  const calls = [];
  let i = 0;
  const caller = async (payload) => {
    calls.push(payload);
    const response = responses[Math.min(i, responses.length - 1)];
    i += 1;
    return typeof response === 'function' ? response(payload) : response;
  };
  caller.calls = calls;
  return caller;
}

// ── buildMarkNeedsReviewPayload: pure payload construction ─────────────
test('buildMarkNeedsReviewPayload maps to the exact RPC parameter names, never a reservation/customer/tour field', () => {
  const parsedEvent = require('../../api/_civitatis/parser').parseCivitatisEmail(F.italianNewBooking);
  const payload = buildMarkNeedsReviewPayload({
    event: parsedEvent, rawBody: F.italianNewBooking.body, civitatisSourceId: 'src-civitatis',
    reasonCode: 'POSSIBLE_EXISTING_MATCH_EXACT_NAME', reasonDetail: 'candidate customer id(s): cust-1',
  });
  assert.deepEqual(Object.keys(payload).sort(), [
    'p_event_type', 'p_external_booking_id', 'p_gmail_message_id', 'p_gmail_thread_id',
    'p_reason_code', 'p_reason_detail', 'p_raw_body_snapshot', 'p_raw_subject', 'p_received_at', 'p_source_id',
  ].sort());
  assert.equal(payload.p_gmail_message_id, 'msg-it-new-001');
  assert.equal(payload.p_reason_code, 'POSSIBLE_EXISTING_MATCH_EXACT_NAME');
  assert.equal(payload.p_reason_detail, 'candidate customer id(s): cust-1');
});

test('KNOWN_MARK_NEEDS_REVIEW_RESULTS is the exact, exhaustive vocabulary the marker RPC can return, including already_needs_review', () => {
  assert.deepEqual([...KNOWN_MARK_NEEDS_REVIEW_RESULTS].sort(), ['already_processed', 'already_needs_review', 'failed', 'manual_review_required'].sort());
});

// ── 1/2. exact-name-only match now persists a marker, never auto-binds ──
test('exact-name-only match: ineligible plan entry now carries one needsReviewMarkers entry with reasonCode POSSIBLE_EXISTING_MATCH_EXACT_NAME, referencing the candidate id in reasonDetail only', async () => {
  const repo = createFakeRepo(baseRepoOptions({
    customers: [{ id: 'cust-juan', full_name: 'Juan Armas Puente', email: null, phone: null }],
  }));
  const plan = await planCivitatisIngestion({ messages: [F.juanArmasPuenteBooking], repo });
  const entry = plan.plans[0];
  assert.equal(entry.eligible, false);
  assert.equal(entry.customerId, undefined); // never set at all on an ineligible entry — never bound
  assert.equal(entry.needsReviewMarkers.length, 1);
  assert.equal(entry.needsReviewMarkers[0].p_reason_code, 'POSSIBLE_EXISTING_MATCH_EXACT_NAME');
  assert.ok(entry.needsReviewMarkers[0].p_reason_detail.includes('cust-juan'));
});

// ── 4. contact conflict now persists a marker ───────────────────────────
test('contact conflict: ineligible plan entry carries needsReviewMarkers with reasonCode POSSIBLE_EXISTING_MATCH_CONTACT_CONFLICT', async () => {
  const repo = createFakeRepo(baseRepoOptions({
    customers: [
      { id: 'cust-A', full_name: 'A', email: 'shared@example.com', phone: '0000000000' },
      { id: 'cust-B', full_name: 'B', email: 'other@example.com', phone: '3714261643' },
    ],
  }));
  const messageWithEmail = {
    ...F.italianModification,
    body: F.italianModification.body.replace(
      'Client details:\nName: No Stop Viaggi Di Fam Srl\nSurname: Neri Francesca',
      'Client details:\nName: No Stop Viaggi Di Fam Srl\nSurname: Neri Francesca\nEmail: shared@example.com'
    ),
  };
  const plan = await planCivitatisIngestion({ messages: [F.italianNewBooking, messageWithEmail], repo });
  const entry = plan.plans[0];
  assert.equal(entry.eligible, false);
  assert.equal(entry.needsReviewMarkers.length, 2); // one per Gmail message in this booking's chain
  for (const marker of entry.needsReviewMarkers) {
    assert.equal(marker.p_reason_code, 'POSSIBLE_EXISTING_MATCH_CONTACT_CONFLICT');
    assert.ok(marker.p_reason_detail.includes('cust-A') && marker.p_reason_detail.includes('cust-B'));
  }
});

// ── 5. legacy reservation match now persists a marker ───────────────────
test('legacy unlinked reservation match: ineligible plan entry carries needsReviewMarkers with reasonCode POSSIBLE_EXISTING_MATCH_LEGACY_RESERVATION', async () => {
  const repo = createFakeRepo(baseRepoOptions({
    reservations: [{
      id: 'res-legacy-1', source_id: null, external_booking_id: null, tour_id: 'tour-grand-bazaar',
      check_in: '2026-11-02', check_in_time: '09:00:00', pax_adult: 2, pax_child: 0,
    }],
  }));
  const plan = await planCivitatisIngestion({ messages: [F.italianNewBooking], repo });
  const entry = plan.plans[0];
  assert.equal(entry.eligible, false);
  assert.equal(entry.needsReviewMarkers.length, 1);
  assert.equal(entry.needsReviewMarkers[0].p_reason_code, 'POSSIBLE_EXISTING_MATCH_LEGACY_RESERVATION');
  assert.ok(entry.needsReviewMarkers[0].p_reason_detail.includes('res-legacy-1'));
});

// ── 6. parse-failure chain now persists a marker for EVERY gmailMessageId
// in the chain, including one that itself parsed fine ───────────────────
test('parse-failure chain: needsReviewMarkers has one entry per gmailMessageId in the chain, with reasonCode PARSE_FAILURE_CHAIN, even for the sibling event that parsed fine', async () => {
  const repo = createFakeRepo(baseRepoOptions());
  const brokenModification = { ...F.italianModification, gmailMessageId: 'msg-it-mod-broken', body: '   ' }; // parse_error
  const plan = await planCivitatisIngestion({ messages: [F.italianNewBooking, brokenModification], repo });
  const entry = plan.plans[0];
  assert.equal(entry.eligible, false);
  assert.ok(entry.reason.startsWith('PARSE_FAILURE_CHAIN'));
  assert.equal(entry.needsReviewMarkers.length, 2);
  const ids = entry.needsReviewMarkers.map(m => m.p_gmail_message_id).sort();
  assert.deepEqual(ids, ['msg-it-mod-broken', 'msg-it-new-001'].sort());
  for (const marker of entry.needsReviewMarkers) {
    assert.equal(marker.p_reason_code, 'PARSE_FAILURE_CHAIN');
  }
});

// ── 7. unresolved external booking id (subject/body mismatch) persists
// its own single-message plan entry, via gmailMessageId alone ──────────
test('externalBookingId unresolved (subject/body reservation-number mismatch): a standalone plan entry with externalBookingId:null still carries exactly one needsReviewMarkers entry', async () => {
  const repo = createFakeRepo(baseRepoOptions());
  const mismatched = { ...F.italianNewBooking, gmailMessageId: 'msg-mismatch-001', body: F.italianNewBooking.body.replace('41629692\n', '99999099\n') };
  const plan = await planCivitatisIngestion({ messages: [mismatched], repo });
  assert.equal(plan.plans.length, 1);
  const entry = plan.plans[0];
  assert.equal(entry.externalBookingId, null);
  assert.equal(entry.eligible, false);
  assert.ok(entry.reason.startsWith('EXTERNAL_BOOKING_ID_UNRESOLVED'));
  assert.equal(entry.needsReviewMarkers.length, 1);
  assert.equal(entry.needsReviewMarkers[0].p_gmail_message_id, 'msg-mismatch-001');
  assert.equal(entry.needsReviewMarkers[0].p_external_booking_id, null);
  assert.equal(entry.needsReviewMarkers[0].p_reason_code, 'EXTERNAL_BOOKING_ID_UNRESOLVED');
});

// ── 8. genuinely non-booking (ignored) messages remain fully ignored —
// zero plan entries, zero markers, exactly as before this phase ────────
test('ignored (non-Civitatis-booking) messages produce zero plan entries and zero needsReviewMarkers', async () => {
  const repo = createFakeRepo(baseRepoOptions());
  const plan = await planCivitatisIngestion({ messages: [F.invoiceEmail, F.marketingEmail], repo });
  assert.equal(plan.plans.length, 0);
});

// ── 9/10. dry run performs zero marker RPC calls; write mode calls the
// marker RPC exactly once per needsReviewMarkers entry ──────────────────
test('dry run (writeModeActive:false) never calls the marker RPC — reports wouldMarkNeedsReview instead, from the plan alone', async () => {
  const repo = createFakeRepo(baseRepoOptions({
    customers: [{ id: 'cust-juan', full_name: 'Juan Armas Puente', email: null, phone: null }],
  }));
  const outcome = await writeEndpoint.runCivitatisWriteOrchestration({
    messages: [F.juanArmasPuenteBooking], repo, externalBookingId: null, writeModeActive: false, rpcCaller: null,
  });
  assert.equal(outcome.results[0].skipped, true);
  assert.equal(outcome.results[0].wouldMarkNeedsReview.length, 1);
  assert.equal(outcome.results[0].wouldMarkNeedsReview[0].reasonCode, 'POSSIBLE_EXISTING_MATCH_EXACT_NAME');
});

test('write mode: executeCivitatisIngestionPlan calls markNeedsReviewRpcCaller once per needsReviewMarkers entry, and reports each result', async () => {
  const repo = createFakeRepo(baseRepoOptions({
    customers: [{ id: 'cust-juan', full_name: 'Juan Armas Puente', email: null, phone: null }],
  }));
  const plan = await planCivitatisIngestion({ messages: [F.juanArmasPuenteBooking], repo });
  const rpcCaller = makeSpyCaller([{ result: 'created' }]);
  const markCaller = makeSpyCaller([{ result: 'manual_review_required', ingestion_id: 'ing-marker-1' }]);
  const results = await executeCivitatisIngestionPlan(plan, rpcCaller, markCaller);
  assert.equal(rpcCaller.calls.length, 0); // ineligible — the real booking RPC is never called
  assert.equal(markCaller.calls.length, 1);
  assert.equal(markCaller.calls[0].p_reason_code, 'POSSIBLE_EXISTING_MATCH_EXACT_NAME');
  assert.equal(results[0].skipped, true);
  assert.equal(results[0].markerResults[0].rpcResult.ingestion_id, 'ing-marker-1');
});

test('executeCivitatisIngestionPlan without a markNeedsReviewRpcCaller (every pre-existing caller) performs zero marker calls and reports an empty markerResults array — fully backward compatible', async () => {
  const repo = createFakeRepo(baseRepoOptions({
    customers: [{ id: 'cust-juan', full_name: 'Juan Armas Puente', email: null, phone: null }],
  }));
  const plan = await planCivitatisIngestion({ messages: [F.juanArmasPuenteBooking], repo });
  const rpcCaller = makeSpyCaller([{ result: 'created' }]);
  const results = await executeCivitatisIngestionPlan(plan, rpcCaller); // no 3rd argument
  assert.equal(results[0].markerResults.length, 0);
});

// ── end-to-end via the real endpoint orchestration: write mode threads
// the real marker caller through, through runCivitatisWriteOrchestration ─
test('runCivitatisWriteOrchestration (write mode) threads markNeedsReviewRpcCaller through to the marker RPC for an ineligible booking', async () => {
  const repo = createFakeRepo(baseRepoOptions({
    customers: [{ id: 'cust-juan', full_name: 'Juan Armas Puente', email: null, phone: null }],
  }));
  const rpcCaller = makeSpyCaller([{ result: 'created' }]);
  const markCaller = makeSpyCaller([{ result: 'manual_review_required', ingestion_id: 'ing-1' }]);
  const outcome = await writeEndpoint.runCivitatisWriteOrchestration({
    messages: [F.juanArmasPuenteBooking], repo, externalBookingId: null, writeModeActive: true,
    rpcCaller, cancellationRpcCaller: makeSpyCaller([]), markNeedsReviewRpcCaller: markCaller,
  });
  assert.equal(rpcCaller.calls.length, 0);
  assert.equal(markCaller.calls.length, 1);
  assert.equal(outcome.results[0].markerResults[0].reasonCode, 'POSSIBLE_EXISTING_MATCH_EXACT_NAME');
  assert.equal(outcome.results[0].markerResults[0].decision, 'manual_review_required');
});

// ── Explicit two-way identity decision — replaces the removed
// confirmNotSameCustomerFor one-way override ────────────────────────────
function makeRes() {
  const res = {
    statusCode: null, body: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
  };
  return res;
}

// 1. The old override no longer exists anywhere in the implementation,
// and passing its old parameter name has no special effect at all —
// planCivitatisIngestion simply ignores an unrecognized property and
// falls back to the one true default: a persisted needs_review marker.
test('1. confirmNotSameCustomerFor/confirmNotSameCustomerForBookingId no longer exists anywhere in the implementation', () => {
  const writeAdapterSource = require('fs').readFileSync(require.resolve('../../api/_civitatis/writeAdapter'), 'utf8');
  const ingestEndpointSource = require('fs').readFileSync(require.resolve('../../api/ingest-civitatis-write'), 'utf8');
  assert.doesNotMatch(writeAdapterSource, /confirmNotSameCustomerFor/);
  // ingest-civitatis-write.js may still mention the OLD name only inside
  // historical-context comments explaining why it was replaced — never
  // as a live query-parameter read, request field, or function
  // parameter.
  assert.doesNotMatch(ingestEndpointSource, /q\.confirmNotSameCustomerFor/);
  assert.doesNotMatch(ingestEndpointSource, /confirmNotSameCustomerForBookingId\s*[,:=]/);
});

test('1b. passing the OLD parameter name directly to planCivitatisIngestion has zero effect — behaves exactly as if no decision were supplied at all', async () => {
  const repo = createFakeRepo(baseRepoOptions({
    customers: [{ id: 'cust-juan', full_name: 'Juan Armas Puente', email: null, phone: null }],
  }));
  const plan = await planCivitatisIngestion({
    messages: [F.juanArmasPuenteBooking], repo, confirmNotSameCustomerForBookingId: '41474069', // old, dead parameter name
  });
  const entry = plan.plans[0];
  assert.equal(entry.eligible, false); // the old name no longer bypasses anything
  assert.equal(entry.needsReviewMarkers.length, 1); // the one true default: persisted needs_review
});

// 2. default (no decision) behavior, explicitly with the NEW parameter
// name present-but-null, confirming it matches the established V14 default.
test('2. no identityDecision supplied: exact-name ambiguity becomes a persisted needs_review marker, exactly as the V14 default establishes', async () => {
  const repo = createFakeRepo(baseRepoOptions({
    customers: [{ id: 'cust-juan', full_name: 'Juan Armas Puente', email: null, phone: null }],
  }));
  const plan = await planCivitatisIngestion({ messages: [F.juanArmasPuenteBooking], repo, identityDecision: null });
  const entry = plan.plans[0];
  assert.equal(entry.eligible, false);
  assert.ok(entry.reason.includes('POSSIBLE_EXISTING_MATCH (exact normalized name)'));
  assert.equal(entry.needsReviewMarkers[0].p_reason_code, 'POSSIBLE_EXISTING_MATCH_EXACT_NAME');
});

// 3/11. existing_customer requires confirmedCustomerId; identity params require write=true
test('3/11. existing_customer without confirmedCustomerId, and any identity param without write=true, are both rejected 400 before any Gmail/Supabase call', async () => {
  const handler = writeEndpoint;

  const req1 = { method: 'GET', query: { externalBookingId: '42264118', identityDecisionFor: '42264118', identityDecision: 'existing_customer', write: 'true' }, headers: {} };
  const res1 = makeRes();
  await handler(req1, res1);
  assert.equal(res1.statusCode, 400);
  assert.equal(res1.body.stage, 'identity_decision_validation');
  assert.match(res1.body.error, /requires confirmedCustomerId/);

  const req2 = { method: 'GET', query: { externalBookingId: '42264118', identityDecisionFor: '42264118', identityDecision: 'existing_customer', confirmedCustomerId: '98597686-1d18-4062-83b0-84fcbd9e36a1' }, headers: {} }; // no write=true
  const res2 = makeRes();
  await handler(req2, res2);
  assert.equal(res2.statusCode, 400);
  assert.equal(res2.body.stage, 'identity_decision_validation');
  assert.match(res2.body.error, /manual write-mode operations only/);
});

// 4/5/6. existing_customer: only an ACTUAL candidate id is accepted
test('4/6. existing_customer with a VALID candidate id sets customerId to exactly that id and proceeds as a normal eligible write', async () => {
  const repo = createFakeRepo(baseRepoOptions({
    customers: [{ id: '98597686-1d18-4062-83b0-84fcbd9e36a1', full_name: 'Juan Armas Puente', email: null, phone: null }],
  }));
  const plan = await planCivitatisIngestion({
    messages: [F.juanArmasPuenteBooking], repo,
    identityDecision: { externalBookingId: '41474069', decision: 'existing_customer', confirmedCustomerId: '98597686-1d18-4062-83b0-84fcbd9e36a1' },
  });
  assert.equal(plan.ok, true);
  const entry = plan.plans[0];
  assert.equal(entry.eligible, true);
  assert.equal(entry.customerId, '98597686-1d18-4062-83b0-84fcbd9e36a1');
  assert.ok(entry.calls.every(c => c.p_customer_id === '98597686-1d18-4062-83b0-84fcbd9e36a1'));
  assert.equal(entry.needsReviewMarkers, undefined);
});

test('5. existing_customer with an ARBITRARY (non-candidate) customer id aborts planning with a dedicated, pre-write-RPC validation failure', async () => {
  const repo = createFakeRepo(baseRepoOptions({
    customers: [{ id: 'cust-juan-real', full_name: 'Juan Armas Puente', email: null, phone: null }],
  }));
  const plan = await planCivitatisIngestion({
    messages: [F.juanArmasPuenteBooking], repo,
    identityDecision: { externalBookingId: '41474069', decision: 'existing_customer', confirmedCustomerId: 'some-made-up-id-not-a-candidate' },
  });
  assert.equal(plan.ok, false);
  assert.equal(plan.stage, 'identity_decision_invalid_candidate');
  assert.match(plan.error, /not among the exact-normalized-name match candidates/);
});

// 5 (HTTP-level): the same invalid-candidate case must surface as a 400,
// never a 422, and never reach any write RPC.
test('5b. an invalid confirmedCustomerId surfaces as HTTP 400 (never 422), via runCivitatisWriteOrchestration passthrough', async () => {
  const repo = createFakeRepo(baseRepoOptions({
    customers: [{ id: 'cust-juan-real', full_name: 'Juan Armas Puente', email: null, phone: null }],
  }));
  const rpcCaller = makeSpyCaller([{ result: 'created' }]);
  const outcome = await writeEndpoint.runCivitatisWriteOrchestration({
    messages: [F.juanArmasPuenteBooking], repo, externalBookingId: '41474069', writeModeActive: true, rpcCaller,
    identityDecision: { externalBookingId: '41474069', decision: 'existing_customer', confirmedCustomerId: 'not-a-real-candidate' },
  });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.stage, 'identity_decision_invalid_candidate');
  assert.equal(rpcCaller.calls.length, 0); // never reached the write RPC
});

// 7/8. new_customer: customerId stays null; confirmedCustomerId forbidden
test('7. new_customer keeps customerId null and proceeds as a normal eligible write (identical to the pre-existing "no match at all" create path)', async () => {
  const repo = createFakeRepo(baseRepoOptions({
    customers: [{ id: 'cust-juan', full_name: 'Juan Armas Puente', email: null, phone: null }],
  }));
  const plan = await planCivitatisIngestion({
    messages: [F.juanArmasPuenteBooking], repo,
    identityDecision: { externalBookingId: '41474069', decision: 'new_customer', confirmedCustomerId: null },
  });
  const entry = plan.plans[0];
  assert.equal(entry.eligible, true);
  assert.equal(entry.customerId, null); // never 'cust-juan'
  assert.ok(entry.calls.every(c => c.p_customer_id === null));
});

test('8. new_customer with confirmedCustomerId supplied is rejected 400, before any Gmail/Supabase call', async () => {
  const handler = writeEndpoint;
  const req = { method: 'GET', query: { externalBookingId: '42264118', identityDecisionFor: '42264118', identityDecision: 'new_customer', confirmedCustomerId: 'cust-x', write: 'true' }, headers: {} };
  const res = makeRes();
  await handler(req, res);
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.stage, 'identity_decision_validation');
  assert.match(res.body.error, /must not supply confirmedCustomerId/);
});

// 9. identityDecisionFor must exactly equal externalBookingId
test('9. identityDecisionFor that differs from (or is missing alongside) externalBookingId is rejected 400', async () => {
  const handler = writeEndpoint;
  const req1 = { method: 'GET', query: { externalBookingId: '42264118', identityDecisionFor: '99999999', identityDecision: 'new_customer', write: 'true' }, headers: {} };
  const res1 = makeRes();
  await handler(req1, res1);
  assert.equal(res1.statusCode, 400);
  assert.match(res1.body.error, /must exactly equal externalBookingId/);

  const req2 = { method: 'GET', query: { identityDecisionFor: '42264118', identityDecision: 'new_customer', write: 'true' }, headers: {} }; // no externalBookingId
  const res2 = makeRes();
  await handler(req2, res2);
  assert.equal(res2.statusCode, 400);
});

// 10. unsupported decision value
test('10. an unsupported identityDecision value is rejected 400', async () => {
  const handler = writeEndpoint;
  const req = { method: 'GET', query: { externalBookingId: '42264118', identityDecisionFor: '42264118', identityDecision: 'merge_customers', write: 'true' }, headers: {} };
  const res = makeRes();
  await handler(req, res);
  assert.equal(res.statusCode, 400);
  assert.match(res.body.error, /Unsupported identityDecision/);
});

// 12. a well-formed identity decision still requires the EXISTING manual
// write secret — no new/weaker authentication path.
test('12. a well-formed identityDecision with write=true but a WRONG secret is rejected 401, never silently applied', async () => {
  process.env.CIVITATIS_MANUAL_WRITE_SECRET = 'the-real-secret';
  const handler = writeEndpoint;
  const req = {
    method: 'GET',
    query: { externalBookingId: '42264118', identityDecisionFor: '42264118', identityDecision: 'new_customer', write: 'true' },
    headers: { 'x-civitatis-write-secret': 'guessed-wrong' },
  };
  const res = makeRes();
  await handler(req, res);
  assert.equal(res.statusCode, 401);
  delete process.env.CIVITATIS_MANUAL_WRITE_SECRET;
});

test('a well-formed identityDecision with write=true and the CORRECT secret passes both gates (reaches the normal credential-less-sandbox configuration stage, never 400/401)', async () => {
  process.env.CIVITATIS_MANUAL_WRITE_SECRET = 'the-real-secret';
  const handler = writeEndpoint;
  const req = {
    method: 'GET',
    query: { externalBookingId: '42264118', identityDecisionFor: '42264118', identityDecision: 'new_customer', write: 'true' },
    headers: { 'x-civitatis-write-secret': 'the-real-secret' },
  };
  const res = makeRes();
  await handler(req, res);
  assert.notEqual(res.statusCode, 400);
  assert.notEqual(res.statusCode, 401);
  delete process.env.CIVITATIS_MANUAL_WRITE_SECRET;
});

// 13-16. identityDecision cannot bypass any OTHER safety gate — each of
// these scenarios never even reaches the exact-name branch where
// identityDecision is consulted, by construction (unchanged control
// flow), so the decision is simply irrelevant/unused in each case.
test('13. identityDecision cannot bypass a contact conflict for the SAME booking id', async () => {
  const repo = createFakeRepo(baseRepoOptions({
    customers: [
      { id: 'cust-A', full_name: 'A', email: 'shared@example.com', phone: '0000000000' },
      { id: 'cust-B', full_name: 'B', email: 'other@example.com', phone: '3714261643' },
    ],
  }));
  const messageWithEmail = {
    ...F.italianModification,
    body: F.italianModification.body.replace(
      'Client details:\nName: No Stop Viaggi Di Fam Srl\nSurname: Neri Francesca',
      'Client details:\nName: No Stop Viaggi Di Fam Srl\nSurname: Neri Francesca\nEmail: shared@example.com'
    ),
  };
  const plan = await planCivitatisIngestion({
    messages: [F.italianNewBooking, messageWithEmail], repo,
    identityDecision: { externalBookingId: '41629692', decision: 'existing_customer', confirmedCustomerId: 'cust-A' },
  });
  assert.equal(plan.ok, true); // never aborted — the decision was simply never consulted
  assert.equal(plan.plans[0].eligible, false);
  assert.ok(plan.plans[0].reason.includes('contact conflict'));
});

test('14. identityDecision cannot bypass a legacy-reservation possible match for the SAME booking id', async () => {
  const repo = createFakeRepo(baseRepoOptions({
    reservations: [{
      id: 'res-legacy-1', source_id: null, external_booking_id: null, tour_id: 'tour-grand-bazaar',
      check_in: '2026-11-02', check_in_time: '09:00:00', pax_adult: 2, pax_child: 0,
    }],
  }));
  const plan = await planCivitatisIngestion({
    messages: [F.italianNewBooking], repo,
    identityDecision: { externalBookingId: '41629692', decision: 'new_customer', confirmedCustomerId: null },
  });
  assert.equal(plan.plans[0].eligible, false);
  assert.ok(plan.plans[0].reason.includes('unlinked legacy reservation'));
});

test('15. identityDecision cannot bypass a parser/chain failure for the SAME booking id', async () => {
  const repo = createFakeRepo(baseRepoOptions());
  const brokenModification = { ...F.italianModification, gmailMessageId: 'msg-it-mod-broken', body: '   ' };
  const plan = await planCivitatisIngestion({
    messages: [F.italianNewBooking, brokenModification], repo,
    identityDecision: { externalBookingId: '41629692', decision: 'new_customer', confirmedCustomerId: null },
  });
  assert.equal(plan.plans[0].eligible, false);
  assert.ok(plan.plans[0].reason.startsWith('PARSE_FAILURE_CHAIN'));
});

test('16. identityDecision cannot bypass genuinely fail-closed tour-mapping safety for the SAME booking id', async () => {
  const duplicateRow = { ...GRAND_BAZAAR_TOUR_CHANNEL, id: 'tc-2', tour_id: 'tour-grand-bazaar-2' };
  const repo = createFakeRepo(baseRepoOptions({ tourChannels: [GRAND_BAZAAR_TOUR_CHANNEL, duplicateRow] }));
  const plan = await planCivitatisIngestion({
    messages: [F.italianNewBooking], repo,
    identityDecision: { externalBookingId: '41629692', decision: 'new_customer', confirmedCustomerId: null },
  });
  // Still sent to the RPC (tourId:null, pre-existing item-9 behavior) —
  // the identity decision is never even reached for this scenario.
  assert.equal(plan.plans[0].eligible, true);
  assert.equal(plan.plans[0].tourId, null);
  assert.equal(plan.plans[0].autoProvisionTour, false);
});

// 17. dry run remains write-free even if an identityDecision somehow
// reaches the orchestration layer (defensive — the HTTP handler itself
// already guarantees this can never happen for a real request, since
// identity params without write=true are rejected 400 before here).
test('17. dry run performs zero RPC calls even for a booking an identityDecision makes "eligible"', async () => {
  const repo = createFakeRepo(baseRepoOptions({
    customers: [{ id: '98597686-1d18-4062-83b0-84fcbd9e36a1', full_name: 'Juan Armas Puente', email: null, phone: null }],
  }));
  const rpcCaller = makeSpyCaller([{ result: 'created' }]);
  const outcome = await writeEndpoint.runCivitatisWriteOrchestration({
    messages: [F.juanArmasPuenteBooking], repo, externalBookingId: '41474069', writeModeActive: false, rpcCaller,
    identityDecision: { externalBookingId: '41474069', decision: 'existing_customer', confirmedCustomerId: '98597686-1d18-4062-83b0-84fcbd9e36a1' },
  });
  assert.equal(outcome.ok, true);
  assert.equal(rpcCaller.calls.length, 0); // writeModeActive:false — never invoked, regardless of eligibility
  assert.equal(outcome.results[0].skipped, false);
  assert.equal(outcome.results[0].calls[0].rpcResult, null); // WOULD_WRITE report only
});

// 18. idempotency: re-planning with the identical, valid decision is
// fully deterministic — the real duplicate-prevention guarantee lives in
// the unmodified RPC's own gmail_message_id UNIQUE constraint (see
// tests/civitatis/sql/mark_civitatis_email_needs_review_manual_tests.sql
// and ingest_civitatis_booking's own, untouched Step 0/1), not re-tested
// here.
test('18. re-planning the same booking with the identical valid identityDecision twice produces an identical, deterministic plan', async () => {
  const repo = createFakeRepo(baseRepoOptions({
    customers: [{ id: '98597686-1d18-4062-83b0-84fcbd9e36a1', full_name: 'Juan Armas Puente', email: null, phone: null }],
  }));
  const decision = { externalBookingId: '41474069', decision: 'existing_customer', confirmedCustomerId: '98597686-1d18-4062-83b0-84fcbd9e36a1' };
  const plan1 = await planCivitatisIngestion({ messages: [F.juanArmasPuenteBooking], repo, identityDecision: decision });
  const plan2 = await planCivitatisIngestion({ messages: [F.juanArmasPuenteBooking], repo, identityDecision: decision });
  assert.deepEqual(plan1.plans[0].customerId, plan2.plans[0].customerId);
  assert.deepEqual(plan1.plans[0].calls.map(c => c.p_gmail_message_id), plan2.plans[0].calls.map(c => c.p_gmail_message_id));
});

// ── 16. Summary counts ───────────────────────────────────────────────────
test('buildIngestionSummary counts created/updated/duplicates/needsReview/failed/skipped and collects ids, from a fixture result set', () => {
  const results = [
    { externalBookingId: 'A1', skipped: false, calls: [{ decision: 'created' }] },
    { externalBookingId: 'A2', skipped: false, calls: [{ decision: 'updated' }] },
    { externalBookingId: 'A3', skipped: false, calls: [{ decision: 'already_processed' }] },
    { externalBookingId: 'A4', skipped: false, calls: [{ decision: 'manual_review_required' }] },
    { externalBookingId: 'A5', skipped: false, calls: [{ decision: 'failed' }] },
    { externalBookingId: 'A6', skipped: true, reason: 'POSSIBLE_EXISTING_MATCH (exact normalized name): ...', wouldMarkNeedsReview: [{ gmailMessageId: 'm1', reasonCode: 'POSSIBLE_EXISTING_MATCH_EXACT_NAME' }] },
  ];
  const cancellations = [
    { externalBookingId: 'C1', decision: 'cancelled' },
    { externalBookingId: 'C2', decision: 'failed' },
  ];
  const summary = writeEndpoint.buildIngestionSummary({ results, cancellations, discoveredCount: 10 });
  assert.equal(summary.discovered, 10);
  assert.equal(summary.created, 1);
  assert.equal(summary.updated, 1);
  assert.equal(summary.duplicates, 1);
  assert.equal(summary.needsReview, 2); // A4 (manual_review_required) + A6 (wouldMarkNeedsReview)
  assert.equal(summary.failed, 2); // A5 + C2
  assert.equal(summary.skipped, 1); // A6 only
  assert.deepEqual(summary.needsReviewBookingIds.sort(), ['A4', 'A6'].sort());
  assert.deepEqual(summary.failedBookingIds.sort(), ['A5', 'C2'].sort());
  // No customer PII, no email body, no email address, no phone anywhere
  // in the summary object.
  const asText = JSON.stringify(summary);
  assert.doesNotMatch(asText, /@/); // no email addresses
});

test('buildIngestionSummary against a real dry-run outcome (POSSIBLE_EXISTING_MATCH_EXACT_NAME) reports needsReview:1, not failed', async () => {
  const repo = createFakeRepo(baseRepoOptions({
    customers: [{ id: 'cust-juan', full_name: 'Juan Armas Puente', email: null, phone: null }],
  }));
  const outcome = await writeEndpoint.runCivitatisWriteOrchestration({
    messages: [F.juanArmasPuenteBooking], repo, externalBookingId: null, writeModeActive: false, rpcCaller: null,
  });
  const summary = writeEndpoint.buildIngestionSummary({ results: outcome.results, cancellations: outcome.cancellations, discoveredCount: 1 });
  assert.equal(summary.needsReview, 1);
  assert.equal(summary.failed, 0);
  assert.deepEqual(summary.needsReviewBookingIds, ['41474069']);
});

// ── Pre-production review FIX 1: classifyMarkerOutcome — a marker call
// happening at all is NEVER sufficient evidence of success ─────────────
test('classifyMarkerOutcome: manual_review_required counts as needsReview', () => {
  assert.equal(writeEndpoint.classifyMarkerOutcome({ decision: 'manual_review_required' }), 'needsReview');
});

test('classifyMarkerOutcome: already_needs_review counts as needsReview (the V14 retry-noise fix result)', () => {
  assert.equal(writeEndpoint.classifyMarkerOutcome({ decision: 'already_needs_review' }), 'needsReview');
});

test('classifyMarkerOutcome: failed counts as failed', () => {
  assert.equal(writeEndpoint.classifyMarkerOutcome({ decision: 'failed', error: 'simulated' }), 'failed');
});

test('classifyMarkerOutcome: an unexpected/unrecognized result value counts as failed (fails closed)', () => {
  assert.equal(writeEndpoint.classifyMarkerOutcome({ decision: 'UNKNOWN_RPC_RESULT (failed closed)' }), 'failed');
  assert.equal(writeEndpoint.classifyMarkerOutcome({ decision: 'some_future_value_this_code_does_not_know' }), 'failed');
});

test('classifyMarkerOutcome: a call-level marker RPC exception (translated to {result:"failed"} by buildRealMarkNeedsReviewRpcCaller, decorated the same as any other failure) counts as failed', () => {
  // decorateMarkerResult's own translation: marker.unknownResult is
  // false for a KNOWN 'failed' value (KNOWN_MARK_NEEDS_REVIEW_RESULTS
  // includes 'failed'), so decision becomes the literal string 'failed'
  // — exactly the same shape buildRealMarkNeedsReviewRpcCaller's own
  // call-level-error translation produces.
  const decorated = writeEndpoint.decorateMarkerResult({
    gmailMessageId: 'm1', reasonCode: 'POSSIBLE_EXISTING_MATCH_EXACT_NAME',
    rpcResult: { result: 'failed', error: 'RPC call error: network timeout' }, unknownResult: false,
  });
  assert.equal(decorated.decision, 'failed');
  assert.equal(writeEndpoint.classifyMarkerOutcome(decorated), 'failed');
});

test('classifyMarkerOutcome: already_processed counts as a duplicate ONLY when the reported processing_status is genuinely "processed" — never invented success', () => {
  assert.equal(writeEndpoint.classifyMarkerOutcome({ decision: 'already_processed', processingStatus: 'processed' }), 'duplicate');
  assert.equal(writeEndpoint.classifyMarkerOutcome({ decision: 'already_processed', processingStatus: 'needs_review' }), 'failed');
  assert.equal(writeEndpoint.classifyMarkerOutcome({ decision: 'already_processed', processingStatus: null }), 'failed');
});

// ── FIX 1 end-to-end: buildIngestionSummary must classify each marker
// result explicitly, never assume markerResults.length>0 means success ──
test('a skipped booking whose ONLY marker RPC call failed is counted in failed/failedBookingIds, never needsReview', () => {
  const results = [
    {
      externalBookingId: '42264118', skipped: true, reason: 'POSSIBLE_EXISTING_MATCH (exact normalized name): ...',
      markerResults: [{ gmailMessageId: 'm1', reasonCode: 'POSSIBLE_EXISTING_MATCH_EXACT_NAME', decision: 'failed', error: 'simulated' }],
    },
  ];
  const summary = writeEndpoint.buildIngestionSummary({ results, cancellations: [], discoveredCount: 1 });
  assert.equal(summary.failed, 1);
  assert.deepEqual(summary.failedBookingIds, ['42264118']);
  assert.equal(summary.needsReview, 0);
  assert.deepEqual(summary.needsReviewBookingIds, []);
});

test('a skipped booking where ANY marker RPC call failed is counted as failed even if ANOTHER marker in the same chain succeeded — failure wins for that booking', () => {
  const results = [
    {
      externalBookingId: '99999001', skipped: true, reason: 'PARSE_FAILURE_CHAIN: ...',
      markerResults: [
        { gmailMessageId: 'm1', reasonCode: 'PARSE_FAILURE_CHAIN', decision: 'manual_review_required' },
        { gmailMessageId: 'm2', reasonCode: 'PARSE_FAILURE_CHAIN', decision: 'failed', error: 'simulated' },
      ],
    },
  ];
  const summary = writeEndpoint.buildIngestionSummary({ results, cancellations: [], discoveredCount: 2 });
  assert.equal(summary.failed, 1);
  assert.deepEqual(summary.failedBookingIds, ['99999001']);
  assert.equal(summary.needsReview, 0);
});

// ── Pre-production review FIX 2: distinct-booking-count semantics ───────
test('the SAME booking id appearing across multiple needs-review marker messages is counted and listed exactly ONCE', () => {
  const results = [
    {
      externalBookingId: '99999002', skipped: true, reason: 'POSSIBLE_EXISTING_MATCH (contact conflict): ...',
      markerResults: [
        { gmailMessageId: 'm1', reasonCode: 'POSSIBLE_EXISTING_MATCH_CONTACT_CONFLICT', decision: 'manual_review_required' },
        { gmailMessageId: 'm2', reasonCode: 'POSSIBLE_EXISTING_MATCH_CONTACT_CONFLICT', decision: 'already_needs_review' },
      ],
    },
  ];
  const summary = writeEndpoint.buildIngestionSummary({ results, cancellations: [], discoveredCount: 2 });
  assert.equal(summary.needsReview, 1); // ONE booking, not two messages
  assert.deepEqual(summary.needsReviewBookingIds, ['99999002']);
});

test('needsReview equals the distinct booking-id count across multiple DIFFERENT bookings too, each counted once regardless of chain length', () => {
  const results = [
    { externalBookingId: 'A1', skipped: true, reason: '...', markerResults: [{ decision: 'manual_review_required' }, { decision: 'manual_review_required' }] },
    { externalBookingId: 'A2', skipped: true, reason: '...', markerResults: [{ decision: 'already_needs_review' }] },
    { externalBookingId: 'A1', skipped: false, calls: [{ decision: 'manual_review_required' }] }, // defensive: even if A1 somehow also appeared as an eligible entry (never happens in practice — one externalBookingId -> one plan entry), the Set still dedupes.
  ];
  const summary = writeEndpoint.buildIngestionSummary({ results, cancellations: [], discoveredCount: 3 });
  assert.equal(summary.needsReview, 2);
  assert.deepEqual(summary.needsReviewBookingIds.sort(), ['A1', 'A2'].sort());
});

test('a marker/call with no resolvable externalBookingId is tracked in needsReviewUnresolvedMessages, never invented into needsReviewBookingIds or needsReview', () => {
  const results = [
    {
      externalBookingId: null, skipped: true, reason: 'EXTERNAL_BOOKING_ID_UNRESOLVED: ...',
      markerResults: [{ gmailMessageId: 'm1', reasonCode: 'EXTERNAL_BOOKING_ID_UNRESOLVED', decision: 'manual_review_required' }],
    },
  ];
  const summary = writeEndpoint.buildIngestionSummary({ results, cancellations: [], discoveredCount: 1 });
  assert.equal(summary.needsReview, 0); // no booking id to count
  assert.deepEqual(summary.needsReviewBookingIds, []);
  assert.equal(summary.needsReviewUnresolvedMessages, 1); // tracked separately, clearly named
});

// ── 18/26. cancellation pipeline is completely untouched by this phase —
// sanity check that its exported shape is unchanged. The real regression
// proof is running tests/civitatis/cancellationAdapter.test.js and
// cancellationOrchestration.test.js unmodified (see the implementation
// report for that run's result). ────────────────────────────────────────
test('cancellationAdapter exports are unchanged by this phase (sanity check only — full regression run separately)', () => {
  const cancellationAdapter = require('../../api/_civitatis/cancellationAdapter');
  assert.deepEqual(Object.keys(cancellationAdapter).sort(), [
    'planCivitatisCancellations', 'executeCivitatisCancellationPlan',
    'buildCancellationRpcPayload', 'KNOWN_CANCELLATION_RPC_RESULTS',
  ].sort());
});
