'use strict';
/**
 * tests/civitatis/cancellationAdapter.test.js
 * ─────────────────────────────────────────────────────────────────────────
 * api/_civitatis/cancellationAdapter.js — planning and execution, with a
 * fake repo and a fake/spy rpcCaller. No network, no real Supabase, no
 * real RPC call anywhere in this file.
 * ─────────────────────────────────────────────────────────────────────────
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  planCivitatisCancellations,
  executeCivitatisCancellationPlan,
  buildCancellationRpcPayload,
  KNOWN_CANCELLATION_RPC_RESULTS,
} = require('../../api/_civitatis/cancellationAdapter');
const { createFakeRepo } = require('./fakeRepo');
const F = require('./fixtures');

const CIVITATIS_SOURCE = { id: 'src-civitatis' };

function repo() {
  return createFakeRepo({ source: CIVITATIS_SOURCE });
}

// ── Planning ─────────────────────────────────────────────────────────────

test('plans exactly one entry for the real A38807986 cancellation email, with the correct payload shape', async () => {
  const plan = await planCivitatisCancellations({ messages: [F.civitatisCancellationA38807986], repo: repo() });
  assert.equal(plan.ok, true);
  assert.equal(plan.plans.length, 1);
  const entry = plan.plans[0];
  assert.equal(entry.externalBookingId, '38807986');
  assert.equal(entry.gmailMessageId, F.civitatisCancellationA38807986.gmailMessageId);
  assert.deepEqual(entry.payload, {
    p_gmail_message_id: F.civitatisCancellationA38807986.gmailMessageId,
    p_gmail_thread_id: F.civitatisCancellationA38807986.gmailThreadId,
    p_received_at: F.civitatisCancellationA38807986.receivedAt,
    p_raw_subject: F.civitatisCancellationA38807986.subject,
    p_raw_body_snapshot: F.civitatisCancellationA38807986.body,
    p_source_id: CIVITATIS_SOURCE.id,
    p_external_booking_id: '38807986',
  });
});

test('two independent cancellation emails for the SAME booking produce two independent plan entries — no merging/deduping by booking id', async () => {
  const plan = await planCivitatisCancellations({
    messages: [F.civitatisCancellationA38807986, F.civitatisCancellationA38807986Duplicate],
    repo: repo(),
  });
  assert.equal(plan.plans.length, 2);
  assert.equal(plan.plans[0].externalBookingId, '38807986');
  assert.equal(plan.plans[1].externalBookingId, '38807986');
  assert.notEqual(plan.plans[0].gmailMessageId, plan.plans[1].gmailMessageId);
});

test('the SAME gmailMessageId appearing twice in one batch is deduped to one plan entry', async () => {
  const plan = await planCivitatisCancellations({
    messages: [F.civitatisCancellationA38807986, F.civitatisCancellationA38807986],
    repo: repo(),
  });
  assert.equal(plan.plans.length, 1);
});

test('a non-cancellation message (new_booking) is never planned as a cancellation, even if handed to planCivitatisCancellations directly (defensive re-check)', async () => {
  const plan = await planCivitatisCancellations({ messages: [F.civitatisNewBookingA38807986], repo: repo() });
  assert.equal(plan.plans.length, 0);
});

test('a non-Civitatis sender is never planned as a cancellation', async () => {
  const spoofed = { ...F.civitatisCancellationA38807986, from: F.FROM_OTHER };
  const plan = await planCivitatisCancellations({ messages: [spoofed], repo: repo() });
  assert.equal(plan.plans.length, 0);
});

test('no Civitatis source configured -> ok:false, never silently plans an empty result', async () => {
  const emptyRepo = createFakeRepo({ source: null });
  const plan = await planCivitatisCancellations({ messages: [F.civitatisCancellationA38807986], repo: emptyRepo });
  assert.equal(plan.ok, false);
  assert.match(plan.error, /No Civitatis source/);
});

test('buildCancellationRpcPayload never includes any field beyond the 7 the RPC expects (no passenger/price/date data — cancellation never carries booking fields)', () => {
  const payload = buildCancellationRpcPayload({
    event: { gmailMessageId: 'm1', gmailThreadId: 't1', receivedAt: '2026-01-01T00:00:00.000Z', rawSubject: 'Cancellation A1: X', externalBookingId: '1' },
    rawBody: 'body',
    civitatisSourceId: 'src-1',
  });
  assert.deepEqual(Object.keys(payload).sort(), [
    'p_external_booking_id', 'p_gmail_message_id', 'p_gmail_thread_id',
    'p_raw_body_snapshot', 'p_raw_subject', 'p_received_at', 'p_source_id',
  ].sort());
});

// ── Execution ────────────────────────────────────────────────────────────

test('executeCivitatisCancellationPlan calls rpcCaller once per plan entry, in order, and reports each result', async () => {
  const plan = (await planCivitatisCancellations({
    messages: [F.civitatisCancellationA38807986, F.civitatisCancellationA38807986Duplicate],
    repo: repo(),
  })).plans;

  const calls = [];
  const rpcCaller = async (payload) => { calls.push(payload); return { result: 'cancelled', reservation_id: 'res-1' }; };
  const results = await executeCivitatisCancellationPlan(plan, rpcCaller);

  assert.equal(calls.length, 2);
  assert.equal(results.length, 2);
  assert.equal(results[0].rpcResult.result, 'cancelled');
  assert.equal(results[0].unknownResult, false);
});

test('every documented RPC result value is recognized as known (never a false "unknown result" for a legitimate outcome)', async () => {
  const plan = (await planCivitatisCancellations({ messages: [F.civitatisCancellationA38807986], repo: repo() })).plans;
  for (const known of KNOWN_CANCELLATION_RPC_RESULTS) {
    const rpcCaller = async () => ({ result: known });
    const [r] = await executeCivitatisCancellationPlan(plan, rpcCaller);
    assert.equal(r.unknownResult, false, `expected "${known}" to be a known result`);
  }
});

test('an unrecognized RPC result value fails closed (unknownResult:true), never silently trusted', async () => {
  const plan = (await planCivitatisCancellations({ messages: [F.civitatisCancellationA38807986], repo: repo() })).plans;
  const rpcCaller = async () => ({ result: 'something_new_and_unexpected' });
  const [r] = await executeCivitatisCancellationPlan(plan, rpcCaller);
  assert.equal(r.unknownResult, true);
});

test('KNOWN_CANCELLATION_RPC_RESULTS matches exactly the vocabulary documented in cancellationAdapter.js/the V13 migration', () => {
  assert.deepEqual([...KNOWN_CANCELLATION_RPC_RESULTS].sort(), [
    'already_cancelled', 'already_processed', 'cancelled', 'failed', 'manual_review_required',
  ].sort());
});
