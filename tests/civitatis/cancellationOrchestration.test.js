'use strict';
/**
 * tests/civitatis/cancellationOrchestration.test.js
 * ─────────────────────────────────────────────────────────────────────────
 * runCivitatisWriteOrchestration-level integration coverage: proves the
 * cancellation split/plan/execute steps are correctly wired into the SAME
 * orchestration function both api/ingest-civitatis-write.js's handler and
 * api/cron-ingest-civitatis-write.js already call, and — critically —
 * that a cancellation message present in the SAME fetched batch as a
 * new_booking message never affects the existing new_booking pipeline's
 * plan/result at all. No network, no real Supabase/RPC call anywhere in
 * this file.
 * ─────────────────────────────────────────────────────────────────────────
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const handler = require('../../api/ingest-civitatis-write');
const { createFakeRepo } = require('./fakeRepo');
const F = require('./fixtures');

const CIVITATIS_SOURCE = { id: 'src-civitatis' };

function baseRepoOptions(overrides = {}) {
  return {
    source: CIVITATIS_SOURCE,
    tourChannels: [],
    reservations: [],
    reservationGuests: {},
    customers: [],
    ...overrides,
  };
}

function makeSpyRpcCaller(result) {
  const calls = [];
  const caller = async (payload) => { calls.push(payload); return typeof result === 'function' ? result(payload) : result; };
  caller.calls = calls;
  return caller;
}

// ── splitCancellationMessages ────────────────────────────────────────────

test('splitCancellationMessages routes a cancellation message to cancellations and everything else to other, unmixed', () => {
  const { cancellations, other } = handler.splitCancellationMessages([
    F.civitatisCancellationA38807986,
    F.civitatisNewBookingA38807986,
    F.italianNewBooking,
  ]);
  assert.equal(cancellations.length, 1);
  assert.equal(cancellations[0].gmailMessageId, F.civitatisCancellationA38807986.gmailMessageId);
  assert.equal(other.length, 2);
  assert.ok(other.some(m => m.gmailMessageId === F.civitatisNewBookingA38807986.gmailMessageId));
  assert.ok(other.some(m => m.gmailMessageId === F.italianNewBooking.gmailMessageId));
});

test('an empty/no-cancellation batch produces an empty cancellations array and an untouched other array', () => {
  const { cancellations, other } = handler.splitCancellationMessages([F.italianNewBooking]);
  assert.deepEqual(cancellations, []);
  assert.equal(other.length, 1);
});

// ── Dry-run orchestration: both pipelines report correctly, independently

test('dry-run: a batch with BOTH a new_booking and an unrelated cancellation message reports both, in their own separate result arrays', async () => {
  const repo = createFakeRepo(baseRepoOptions());
  const outcome = await handler.runCivitatisWriteOrchestration({
    messages: [F.italianNewBooking, F.civitatisCancellationA38807986],
    repo, externalBookingId: null, writeModeActive: false, rpcCaller: null, cancellationRpcCaller: null,
  });
  assert.equal(outcome.ok, true);
  assert.equal(outcome.results.length, 1);
  assert.equal(outcome.results[0].externalBookingId, '41629692'); // italianNewBooking's own booking id, unaffected
  assert.equal(outcome.cancellations.length, 1);
  assert.equal(outcome.cancellations[0].externalBookingId, '38807986');
  assert.match(outcome.cancellations[0].decision, /WOULD_CANCEL/);
  assert.equal(outcome.cancellations[0].rpcResult, null);
});

test('existing new_booking pipeline is byte-for-byte unaffected by an unrelated cancellation message being present in the same batch', async () => {
  const repo1 = createFakeRepo(baseRepoOptions());
  const withoutCancellation = await handler.runCivitatisWriteOrchestration({
    messages: [F.italianNewBooking], repo: repo1, externalBookingId: null, writeModeActive: false, rpcCaller: null, cancellationRpcCaller: null,
  });

  const repo2 = createFakeRepo(baseRepoOptions());
  const withCancellation = await handler.runCivitatisWriteOrchestration({
    messages: [F.italianNewBooking, F.civitatisCancellationA38807986], repo: repo2, externalBookingId: null, writeModeActive: false, rpcCaller: null, cancellationRpcCaller: null,
  });

  assert.deepEqual(withCancellation.results, withoutCancellation.results);
});

test('a cancellation message for the SAME external_booking_id as a new_booking message in the same batch never marks that booking\'s new_booking chain ineligible', async () => {
  const repo = createFakeRepo(baseRepoOptions());
  const outcome = await handler.runCivitatisWriteOrchestration({
    messages: [F.civitatisNewBookingA38807986, F.civitatisCancellationA38807986],
    repo, externalBookingId: null, writeModeActive: false, rpcCaller: null, cancellationRpcCaller: null,
  });
  const bookingEntry = outcome.results.find(r => r.externalBookingId === '38807986');
  assert.ok(bookingEntry, 'expected a plan entry for booking 38807986');
  assert.equal(bookingEntry.skipped, false, `booking 38807986 must NOT be marked skipped/ineligible just because a cancellation email for the same id was also in the batch: ${JSON.stringify(bookingEntry)}`);
  assert.equal(outcome.cancellations.length, 1);
  assert.equal(outcome.cancellations[0].externalBookingId, '38807986');
});

// ── Write-mode orchestration: cancellation RPC is called, isolated from
// the booking RPC ────────────────────────────────────────────────────────

test('write mode: the cancellation rpcCaller is called once per cancellation email, the booking rpcCaller is never called for it', async () => {
  const repo = createFakeRepo(baseRepoOptions());
  const bookingRpc = makeSpyRpcCaller({ result: 'created', reservation_id: 'res-x' });
  const cancellationRpc = makeSpyRpcCaller({ result: 'cancelled', reservation_id: 'res-38807986' });

  const outcome = await handler.runCivitatisWriteOrchestration({
    messages: [F.civitatisCancellationA38807986],
    repo, externalBookingId: null, writeModeActive: true, rpcCaller: bookingRpc, cancellationRpcCaller: cancellationRpc,
  });

  assert.equal(bookingRpc.calls.length, 0, 'the booking RPC must never be called for a cancellation-only batch');
  assert.equal(cancellationRpc.calls.length, 1);
  assert.deepEqual(Object.keys(cancellationRpc.calls[0]).sort(), [
    'p_external_booking_id', 'p_gmail_message_id', 'p_gmail_thread_id',
    'p_raw_body_snapshot', 'p_raw_subject', 'p_received_at', 'p_source_id',
  ].sort());
  assert.equal(outcome.cancellations.length, 1);
  assert.equal(outcome.cancellations[0].rpcResult, 'cancelled');
  assert.equal(outcome.cancellations[0].reservationId, 'res-38807986');
});

test('write mode: a batch with both event types calls each rpcCaller only for its own kind of event', async () => {
  const repo = createFakeRepo(baseRepoOptions());
  const bookingRpc = makeSpyRpcCaller({ result: 'created', reservation_id: 'res-x' });
  const cancellationRpc = makeSpyRpcCaller({ result: 'cancelled', reservation_id: 'res-y' });

  await handler.runCivitatisWriteOrchestration({
    messages: [F.italianNewBooking, F.civitatisCancellationA38807986],
    repo, externalBookingId: null, writeModeActive: true, rpcCaller: bookingRpc, cancellationRpcCaller: cancellationRpc,
  });

  assert.equal(bookingRpc.calls.length, 1);
  assert.equal(cancellationRpc.calls.length, 1);
});

test('write mode: an unknown cancellation RPC result is reported as UNKNOWN_RPC_RESULT (fail-closed), never silently accepted', async () => {
  const repo = createFakeRepo(baseRepoOptions());
  const cancellationRpc = makeSpyRpcCaller({ result: 'something_new' });
  const outcome = await handler.runCivitatisWriteOrchestration({
    messages: [F.civitatisCancellationA38807986],
    repo, externalBookingId: null, writeModeActive: true, rpcCaller: makeSpyRpcCaller({ result: 'created' }), cancellationRpcCaller: cancellationRpc,
  });
  assert.match(outcome.cancellations[0].decision, /UNKNOWN_RPC_RESULT/);
});

// ── Manual single-booking mode: cancellation still correctly filtered ──

test('the manual single-booking (?externalBookingId=) filter correctly includes a cancellation message for that same booking id', () => {
  const filtered = handler.filterMessagesByExternalBookingId(
    [F.civitatisNewBookingA38807986, F.civitatisCancellationA38807986, F.italianNewBooking],
    '38807986'
  );
  assert.equal(filtered.length, 2);
  assert.ok(filtered.some(m => m.gmailMessageId === F.civitatisNewBookingA38807986.gmailMessageId));
  assert.ok(filtered.some(m => m.gmailMessageId === F.civitatisCancellationA38807986.gmailMessageId));
});

test('a single-booking-mode request with no matching messages of either kind reports both results and cancellations as empty', async () => {
  const repo = createFakeRepo(baseRepoOptions());
  const outcome = await handler.runCivitatisWriteOrchestration({
    messages: [], repo, externalBookingId: '38807986', writeModeActive: false, rpcCaller: null, cancellationRpcCaller: null,
  });
  assert.equal(outcome.ok, true);
  assert.equal(outcome.results.length, 0);
  assert.equal(outcome.cancellations.length, 0);
});
