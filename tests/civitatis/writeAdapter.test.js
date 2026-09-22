'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

const { buildRpcPayload, planCivitatisIngestion, executeCivitatisIngestionPlan } = require('../../api/_civitatis/writeAdapter');
const { parseCivitatisEmail } = require('../../api/_civitatis/parser');
const { createFakeRepo } = require('./fakeRepo');
const F = require('./fixtures');

// PLANNING/GATING TESTS ONLY — no network access, no real Gmail mailbox,
// no Supabase connection, and (critically) no real RPC call: every test
// below passes a fake in-memory rpcCaller, or never reaches rpcCaller at
// all. These are the JS-provable parts of the write architecture (test
// plan items 15-19: gating and payload construction). The genuinely
// transactional/idempotency/race-condition guarantees (test plan items
// 1-14, 20-21) require a real PostgreSQL instance and are NOT faked here
// — see supabase_migration_civitatis_write.sql's own verification
// section and the separate manual SQL test plan.

const CIVITATIS_SOURCE = { id: 'src-civitatis' };
const GRAND_BAZAAR_TOUR_CHANNEL = {
  id: 'tc-1', tour_id: 'tour-grand-bazaar', source_id: 'src-civitatis',
  external_product_id: 'Grand Bazaar Experience',
  tour: { id: 'tour-grand-bazaar', name: 'Grand Bazaar Experience' },
};

function baseRepoOptions(overrides = {}) {
  return {
    source: CIVITATIS_SOURCE,
    tourChannels: [GRAND_BAZAAR_TOUR_CHANNEL],
    reservations: [],
    reservationGuests: {},
    customers: [],
    ...overrides,
  };
}

/** A fake rpcCaller that records every call it receives instead of
 * touching a database, and lets a test script a canned response
 * sequence. */
function makeFakeRpcCaller(responses) {
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

// ── buildRpcPayload: pure payload construction ──────────────────────────
test('buildRpcPayload maps a parsed event to the exact RPC parameter names, preserving passenger names exactly', () => {
  const parsedEvent = parseCivitatisEmail(F.italianNewBooking);
  const payload = buildRpcPayload({
    parsedEvent, rawBody: F.italianNewBooking.body,
    civitatisSourceId: 'src-civitatis', tourId: 'tour-grand-bazaar', customerId: null,
  });
  assert.equal(payload.p_gmail_message_id, 'msg-it-new-001');
  assert.equal(payload.p_event_type, 'new_booking');
  assert.equal(payload.p_source_id, 'src-civitatis');
  assert.equal(payload.p_external_booking_id, '41629692');
  assert.equal(payload.p_tour_id, 'tour-grand-bazaar');
  assert.equal(payload.p_check_in, '2026-11-02');
  assert.equal(payload.p_check_in_time, '09:00');
  assert.equal(payload.p_pax_adult, 2);
  assert.equal(payload.p_total_amount, 3600); // Civitatis Net price
  assert.equal(payload.p_retail_amount, 4800); // Civitatis Retail price, separate
  assert.equal(payload.p_customer_id, null);
  assert.equal(payload.p_customer_full_name, 'No Stop Viaggi Di Fam Srl Neri Francesca');
  const passengers = JSON.parse(payload.p_passengers);
  assert.deepEqual(passengers, [
    { fullName: 'ROMANO JUS', sortOrder: 0 },
    { fullName: 'GRAZIELLA MINETTO', sortOrder: 1 },
  ]);
});

test('buildRpcPayload passes an already-matched customerId through unchanged', () => {
  const parsedEvent = parseCivitatisEmail(F.italianNewBooking);
  const payload = buildRpcPayload({
    parsedEvent, rawBody: null, civitatisSourceId: 'src-civitatis', tourId: 'tour-grand-bazaar', customerId: 'cust-existing-1',
  });
  assert.equal(payload.p_customer_id, 'cust-existing-1');
});

// ── planCivitatisIngestion: gating ──────────────────────────────────────

// 15. POSSIBLE_EXISTING_MATCH (legacy reservation) never plans a write
test('a booking that would classify as POSSIBLE_EXISTING_MATCH via an unlinked legacy reservation is never eligible', async () => {
  const repo = createFakeRepo(baseRepoOptions({
    reservations: [{
      id: 'res-legacy-1', source_id: null, external_booking_id: null, tour_id: 'tour-grand-bazaar',
      check_in: '2026-11-02', check_in_time: '09:00:00', pax_adult: 2, pax_child: 0,
    }],
  }));
  const plan = await planCivitatisIngestion({ messages: [F.italianNewBooking], repo });
  assert.equal(plan.ok, true);
  assert.equal(plan.plans.length, 1);
  assert.equal(plan.plans[0].eligible, false);
  assert.ok(plan.plans[0].reason.includes('POSSIBLE_EXISTING_MATCH'));
  assert.equal(plan.plans[0].calls, undefined);
});

// 15 (contact conflict / exact-name variants of POSSIBLE_EXISTING_MATCH)
test('a booking that would classify as POSSIBLE_EXISTING_MATCH via exact normalized customer name is never eligible', async () => {
  const repo = createFakeRepo(baseRepoOptions({
    customers: [{ id: 'cust-1', full_name: 'No Stop Viaggi Di Fam Srl Neri Francesca', email: null, phone: null }],
  }));
  const plan = await planCivitatisIngestion({ messages: [F.italianNewBooking], repo });
  assert.equal(plan.plans[0].eligible, false);
  assert.ok(plan.plans[0].reason.includes('POSSIBLE_EXISTING_MATCH'));
});

// 16. NEEDS_REVIEW never plans a write
test('a booking that would classify as NEEDS_REVIEW (no tour_channels match) is never eligible', async () => {
  const repo = createFakeRepo(baseRepoOptions({ tourChannels: [] }));
  const plan = await planCivitatisIngestion({ messages: [F.italianNewBooking], repo });
  assert.equal(plan.plans[0].eligible, false);
  assert.ok(plan.plans[0].reason.includes('tour_channels'));
});

// 16 (NEEDS_REVIEW via missing Internal code / any parse failure in the chain)
test('a booking whose chain includes an unparseable event is never eligible', async () => {
  const repo = createFakeRepo(baseRepoOptions());
  const plan = await planCivitatisIngestion({ messages: [F.missingInternalCode], repo });
  assert.equal(plan.plans[0].eligible, false);
  assert.ok(plan.plans[0].reason.includes('failed to parse'));
});

// 17. PARSE_ERROR never plans a write
test('an empty/unreadable body (parse_error) is never eligible and is never grouped into a booking at all if it has no resolvable external ID', async () => {
  const repo = createFakeRepo(baseRepoOptions());
  const emptyBody = { ...F.italianNewBooking, gmailMessageId: 'msg-empty-001', body: '   ' };
  const plan = await planCivitatisIngestion({ messages: [emptyBody], repo });
  // parse_error still carries an externalBookingId from the subject, so it
  // IS grouped, but must still be ineligible.
  assert.equal(plan.plans.length, 1);
  assert.equal(plan.plans[0].eligible, false);
});

// Contact conflict must also be ineligible
test('a booking whose email/phone conflict between two different existing customers is never eligible', async () => {
  // mergedState.clientEmail is null for this fixture pair, so the
  // conflict must come from the phone alone matching one customer while
  // no email is present to disambiguate — instead we exercise the
  // conflict path directly via matchCustomer's own contract by giving
  // two customers where the SAME phone Civitatis provides happens to
  // also be recorded (by coincidence) against a second customer's email
  // field is not representable through findCustomersByContact's OR
  // query with only a phone present, so this scenario is more directly
  // covered by the matchCustomer unit tests in customerMatching.test.js;
  // here we confirm planCivitatisIngestion correctly propagates a
  // conflict result when one occurs.
  const repo = createFakeRepo(baseRepoOptions({
    customers: [
      { id: 'cust-A', full_name: 'A', email: 'shared@example.com', phone: '0000000000' },
      { id: 'cust-B', full_name: 'B', email: 'other@example.com', phone: '3714261643' },
    ],
  }));
  const messageWithEmail = {
    ...F.italianModification,
    body: F.italianModification.body.replace('Client details:\nName: No Stop Viaggi Di Fam Srl\nSurname: Neri Francesca', 'Client details:\nName: No Stop Viaggi Di Fam Srl\nSurname: Neri Francesca\nEmail: shared@example.com'),
  };
  const plan = await planCivitatisIngestion({ messages: [F.italianNewBooking, messageWithEmail], repo });
  assert.equal(plan.plans[0].eligible, false);
  assert.ok(plan.plans[0].reason.includes('POSSIBLE_EXISTING_MATCH'));
  assert.ok(plan.plans[0].reason.includes('conflict'));
});

// 18. Authoritative existing customer is reused (not re-created)
test('an eligible plan reuses an authoritatively-matched existing customer id, never creating a new one', async () => {
  const repo = createFakeRepo(baseRepoOptions({
    customers: [{ id: 'cust-real', full_name: 'Whatever Name', email: null, phone: '3714261643' }],
  }));
  const plan = await planCivitatisIngestion({ messages: [F.italianNewBooking, F.italianModification], repo });
  assert.equal(plan.plans[0].eligible, true);
  assert.equal(plan.plans[0].customerId, 'cust-real');
  for (const call of plan.plans[0].calls) {
    assert.equal(call.p_customer_id, 'cust-real');
  }
});

// 19. Unresolved safe booking plans a customer CREATE (customerId null, contact fields present)
test('an eligible plan with no resolvable existing customer plans a create, using ONLY booking-contact fields (never a passenger)', async () => {
  const repo = createFakeRepo(baseRepoOptions()); // no customers at all
  const plan = await planCivitatisIngestion({ messages: [F.italianNewBooking], repo });
  assert.equal(plan.plans[0].eligible, true);
  assert.equal(plan.plans[0].customerId, null);
  const call = plan.plans[0].calls[0];
  assert.equal(call.p_customer_id, null);
  assert.equal(call.p_customer_full_name, 'No Stop Viaggi Di Fam Srl Neri Francesca');
  // Never a passenger name:
  assert.notEqual(call.p_customer_full_name, 'ROMANO JUS');
});

// New + modification: one booking, calls in chronological order
test('an eligible new_booking + modification plans TWO ordered RPC calls for the same booking, one per Gmail message', async () => {
  const repo = createFakeRepo(baseRepoOptions());
  const plan = await planCivitatisIngestion({ messages: [F.italianModification, F.italianNewBooking], repo }); // deliberately out of order input
  assert.equal(plan.plans.length, 1);
  assert.equal(plan.plans[0].eligible, true);
  assert.equal(plan.plans[0].calls.length, 2);
  assert.equal(plan.plans[0].calls[0].p_gmail_message_id, 'msg-it-new-001'); // sorted by receivedAt
  assert.equal(plan.plans[0].calls[1].p_gmail_message_id, 'msg-it-mod-001');
  assert.equal(plan.plans[0].calls[0].p_event_type, 'new_booking');
  assert.equal(plan.plans[0].calls[1].p_event_type, 'modified');
});

// A booking that already has a linked reservation still plans (as an
// eligible "update") rather than being blocked — this is the normal
// modification path, distinct from the legacy-unlinked-match block.
test('a booking already linked to a reservation via external_booking_id is still eligible (update path), skipping the legacy-match check', async () => {
  const repo = createFakeRepo(baseRepoOptions({
    reservations: [{
      id: 'res-1', source_id: 'src-civitatis', external_booking_id: '41629692', tour_id: 'tour-grand-bazaar',
      check_in: '2026-11-02', check_in_time: '09:00:00', pax_adult: 2, pax_child: 0,
    }],
  }));
  const plan = await planCivitatisIngestion({ messages: [F.italianModification], repo });
  assert.equal(plan.plans[0].eligible, true);
});

// ── executeCivitatisIngestionPlan: never calls rpcCaller for ineligible entries ──
test('executeCivitatisIngestionPlan never invokes rpcCaller for an ineligible (manual-review) booking', async () => {
  const repo = createFakeRepo(baseRepoOptions({ tourChannels: [] })); // forces NEEDS_REVIEW
  const plan = await planCivitatisIngestion({ messages: [F.italianNewBooking], repo });
  const rpcCaller = makeFakeRpcCaller([{ result: 'created' }]);
  const results = await executeCivitatisIngestionPlan(plan, rpcCaller);
  assert.equal(rpcCaller.calls.length, 0);
  assert.equal(results[0].skipped, true);
});

test('executeCivitatisIngestionPlan invokes rpcCaller once per call, in order, for an eligible booking', async () => {
  const repo = createFakeRepo(baseRepoOptions());
  const plan = await planCivitatisIngestion({ messages: [F.italianNewBooking, F.italianModification], repo });
  const rpcCaller = makeFakeRpcCaller([{ result: 'created' }, { result: 'updated' }]);
  const results = await executeCivitatisIngestionPlan(plan, rpcCaller);
  assert.equal(rpcCaller.calls.length, 2);
  assert.equal(rpcCaller.calls[0].p_event_type, 'new_booking');
  assert.equal(rpcCaller.calls[1].p_event_type, 'modified');
  assert.equal(results[0].calls[0].rpcResult.result, 'created');
  assert.equal(results[0].calls[1].rpcResult.result, 'updated');
});

test('executeCivitatisIngestionPlan stops calling rpcCaller for a booking after a failed result, but continues to the next booking', async () => {
  const repo = createFakeRepo(baseRepoOptions());
  const plan = await planCivitatisIngestion({ messages: [F.italianNewBooking, F.italianModification, F.spanishNewBooking], repo });
  assert.equal(plan.plans.length, 2); // two distinct external booking ids
  const rpcCaller = makeFakeRpcCaller([{ result: 'failed', error: 'simulated' }, { result: 'created' }]);
  const results = await executeCivitatisIngestionPlan(plan, rpcCaller);
  const grandBazaarResult = results.find(r => r.externalBookingId === '41629692');
  assert.equal(grandBazaarResult.calls.length, 1); // stopped after the failure, never sent the modification
});

// Never fake a real database transaction: this module makes no claim of
// atomicity by itself — it only orchestrates calls to a caller-supplied
// rpcCaller, which in production is the ONLY place atomicity is actually
// guaranteed (inside public.ingest_civitatis_booking's own transaction).
test('planCivitatisIngestion and executeCivitatisIngestionPlan never call any Supabase client method (repo is fully swappable/fake)', async () => {
  const repo = createFakeRepo(baseRepoOptions());
  // If this module imported @supabase/supabase-js or called anything
  // beyond the given repo/rpcCaller, this test's fully-fake repo (a
  // plain object of async functions over in-memory arrays) would not be
  // sufficient to exercise it end-to-end — it is.
  const plan = await planCivitatisIngestion({ messages: [F.italianNewBooking], repo });
  assert.equal(plan.ok, true);
});

// ── FINAL APPLICATION LAYER AUDIT (pre-write-enablement) ────────────────
// The tests below were added specifically to prove the audit's ordering
// (4/5) and RPC-result fail-closed (7) guarantees, and to pin down
// expected behavior for the 5 known real Civitatis booking IDs (8) using
// the newly-added F.juanArmasPuenteBooking / F.sampleSafeCreateBooking
// fixtures alongside the already-existing real-format fixtures.

// AUDIT 4/5: Gmail does not guarantee chronological order (in practice it
// is typically newest-first) — feeding a 3-event chain in strict
// newest-first order must still produce calls in ascending receivedAt
// order, new_booking first.
test('a 3-event chain fed to planCivitatisIngestion in strict newest-first Gmail order is reordered to chronological (new_booking first)', async () => {
  const repo = createFakeRepo(baseRepoOptions());
  const secondModification = {
    ...F.italianModification,
    gmailMessageId: 'msg-it-mod-002',
    receivedAt: '2026-06-10T10:00:00.000Z',
  };
  // Deliberately supplied newest-first, exactly as Gmail's own listing
  // order typically returns messages.
  const plan = await planCivitatisIngestion({
    messages: [secondModification, F.italianModification, F.italianNewBooking],
    repo,
  });
  assert.equal(plan.plans.length, 1);
  assert.equal(plan.plans[0].eligible, true);
  const ids = plan.plans[0].calls.map(c => c.p_gmail_message_id);
  assert.deepEqual(ids, ['msg-it-new-001', 'msg-it-mod-001', 'msg-it-mod-002']);
  assert.equal(plan.plans[0].calls[0].p_event_type, 'new_booking');
});

// AUDIT 4: equal receivedAt timestamps must fall back to a deterministic,
// stable tie-breaker (gmailMessageId) so repeated runs over the same
// input — regardless of the order the messages happen to arrive in —
// always produce the exact same RPC call order.
test('two events with an identical receivedAt are ordered deterministically by gmailMessageId, independent of input order', async () => {
  const repo = createFakeRepo(baseRepoOptions());
  const sameInstant = '2026-06-01T10:00:00.000Z';
  const eventA = { ...F.italianNewBooking, gmailMessageId: 'msg-aaa', receivedAt: sameInstant };
  const eventB = { ...F.italianModification, gmailMessageId: 'msg-bbb', receivedAt: sameInstant };

  const planForward = await planCivitatisIngestion({ messages: [eventA, eventB], repo });
  const planReversed = await planCivitatisIngestion({ messages: [eventB, eventA], repo });

  const idsForward = planForward.plans[0].calls.map(c => c.p_gmail_message_id);
  const idsReversed = planReversed.plans[0].calls.map(c => c.p_gmail_message_id);
  assert.deepEqual(idsForward, ['msg-aaa', 'msg-bbb']); // 'msg-aaa' < 'msg-bbb'
  assert.deepEqual(idsReversed, ['msg-aaa', 'msg-bbb']); // same regardless of input order
});

// AUDIT 7: a completely unrecognized RPC result value must stop
// processing the rest of that booking's chain, exactly like 'failed'
// does — it must never be silently treated as safe-to-continue.
test('executeCivitatisIngestionPlan stops a booking\'s remaining calls on an unrecognized RPC result value (fails closed)', async () => {
  const repo = createFakeRepo(baseRepoOptions());
  const plan = await planCivitatisIngestion({ messages: [F.italianNewBooking, F.italianModification], repo });
  const rpcCaller = makeFakeRpcCaller([{ result: 'some_future_result_this_code_does_not_know_about' }, { result: 'updated' }]);
  const results = await executeCivitatisIngestionPlan(plan, rpcCaller);
  assert.equal(rpcCaller.calls.length, 1); // never sent the second (modification) call
  assert.equal(results[0].calls.length, 1);
  assert.equal(results[0].calls[0].unknownResult, true);
  assert.equal(results[0].stoppedEarly, true);
});

// AUDIT 7: 'failed' itself must still be reported as unambiguously not
// an unknown result (it IS known, it is just terminal for this chain).
test('executeCivitatisIngestionPlan marks a known "failed" result as known (not unknownResult), while still stopping', async () => {
  const repo = createFakeRepo(baseRepoOptions());
  const plan = await planCivitatisIngestion({ messages: [F.italianNewBooking], repo });
  const rpcCaller = makeFakeRpcCaller([{ result: 'failed', error: 'simulated' }]);
  const results = await executeCivitatisIngestionPlan(plan, rpcCaller);
  assert.equal(results[0].calls[0].unknownResult, false);
  assert.equal(results[0].stoppedEarly, true);
});

// AUDIT 7: every other known RPC result value must be accepted and
// recorded without being confused for a failure or an unknown result.
for (const knownResult of ['stale_ignored', 'booking_already_exists', 'manual_review_required', 'already_processed']) {
  test(`executeCivitatisIngestionPlan records a known "${knownResult}" result without treating it as unknown or as a failure`, async () => {
    const repo = createFakeRepo(baseRepoOptions());
    const plan = await planCivitatisIngestion({ messages: [F.italianNewBooking], repo });
    const rpcCaller = makeFakeRpcCaller([{ result: knownResult }]);
    const results = await executeCivitatisIngestionPlan(plan, rpcCaller);
    assert.equal(results[0].calls[0].unknownResult, false);
    assert.equal(results[0].calls[0].rpcResult.result, knownResult);
  });
}

// AUDIT 3/8: the real A41629692 sequence — a genuine new_booking followed
// later by a genuine "Booking modified" email for the SAME reservation
// number, using the real mixed-label-format fixtures — must always reach
// the RPC as create-then-update, NEVER modified-first, even when the
// caller happens to fetch/batch them in reverse order.
test('the real A41629692 new+modified sequence executes as create-then-update, never modified-first, however the input is ordered', async () => {
  const repo = createFakeRepo(baseRepoOptions());
  const plan = await planCivitatisIngestion({
    messages: [F.italianRealFormatModification, F.italianRealFormatBooking], // fed newest-first
    repo,
  });
  assert.equal(plan.plans.length, 1);
  assert.equal(plan.plans[0].externalBookingId, '41629692');
  const rpcCaller = makeFakeRpcCaller([{ result: 'created' }, { result: 'updated' }]);
  const results = await executeCivitatisIngestionPlan(plan, rpcCaller);
  assert.equal(rpcCaller.calls.length, 2);
  assert.equal(rpcCaller.calls[0].p_event_type, 'new_booking');
  assert.equal(rpcCaller.calls[0].p_gmail_message_id, 'msg-it-real-new-001');
  assert.equal(rpcCaller.calls[1].p_event_type, 'modified');
  assert.equal(rpcCaller.calls[1].p_gmail_message_id, 'msg-it-real-mod-001');
  assert.equal(results[0].calls[0].rpcResult.result, 'created');
  assert.equal(results[0].calls[1].rpcResult.result, 'updated');
  assert.equal(results[0].stoppedEarly, false);
});

// AUDIT 8: consolidated expectation for all 5 known real booking IDs,
// mixed into a single shuffled batch exactly as a real Gmail fetch might
// return them. Expected automatic writes = 4 reservations: A41629692's
// two emails collapse into ONE eligible plan (create+update), A41576789/
// A41534177/A41659924 are each a safe standalone create, and A41474069
// (booking-contact name "Juan Armas Puente", matching an existing
// customer's exact normalized name) is never eligible.
test('the 5 known real Civitatis bookings, mixed together, plan exactly 4 eligible reservations and leave A41474069 for manual review', async () => {
  const repo = createFakeRepo(baseRepoOptions({
    customers: [{ id: 'cust-juan', full_name: 'Juan Armas Puente', email: null, phone: null }],
  }));
  const messages = [
    F.italianRealFormatModification, // A41629692 (modification, deliberately before its own new_booking)
    F.spanishRealFormatBooking,      // A41659924
    F.juanArmasPuenteBooking,        // A41474069
    F.italianRealFormatBooking,      // A41629692 (new_booking)
    F.sampleSafeCreateBooking,       // A41534177
    F.spanishNewBooking,             // A41576789
  ];
  const plan = await planCivitatisIngestion({ messages, repo });
  assert.equal(plan.plans.length, 5); // 5 distinct booking IDs

  const byId = Object.fromEntries(plan.plans.map(p => [p.externalBookingId, p]));

  assert.equal(byId['41629692'].eligible, true);
  assert.equal(byId['41629692'].calls.length, 2); // one reservation, two RPC calls
  assert.equal(byId['41629692'].calls[0].p_event_type, 'new_booking');
  assert.equal(byId['41629692'].calls[1].p_event_type, 'modified');

  assert.equal(byId['41576789'].eligible, true);
  assert.equal(byId['41576789'].calls.length, 1);

  assert.equal(byId['41534177'].eligible, true);
  assert.equal(byId['41534177'].calls.length, 1);

  assert.equal(byId['41659924'].eligible, true);
  assert.equal(byId['41659924'].calls.length, 1);

  assert.equal(byId['41474069'].eligible, false);
  assert.ok(byId['41474069'].reason.includes('POSSIBLE_EXISTING_MATCH'));

  const eligibleCount = plan.plans.filter(p => p.eligible).length;
  assert.equal(eligibleCount, 4); // total automatic reservations
});
