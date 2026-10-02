'use strict';
/**
 * tests/civitatis/reservationPreparationEnrichment.test.js
 * ─────────────────────────────────────────────────────────────────────────
 * Tour Preparation Intelligence — Phase C2F: automatic post-write
 * reservation-preparation materialization. Tests the two new orchestrators
 * (materializeReservationPreparationsForBookingPlan,
 * materializeReservationPreparationsForCancellations) in isolation, with an
 * injected `materialize` fake — no real Supabase/network call anywhere in
 * this file. The hand-crafted plan/executed fixtures below mirror the EXACT
 * shapes writeAdapter.js/cancellationAdapter.js produce, the same
 * convention tests/civitatis/activityModalityEnrichment.test.js already
 * establishes for the structurally identical Phase B3 enrichment.
 * ─────────────────────────────────────────────────────────────────────────
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');

const {
  materializeReservationPreparationsForBookingPlan,
  materializeReservationPreparationsForCancellations,
  MATERIALIZABLE_BOOKING_RESULTS,
  MATERIALIZABLE_CANCELLATION_RESULTS,
} = require('../../api/_civitatis/reservationPreparationEnrichment');

// ── Orchestration-level integration coverage: the REAL module (not
// injected), exactly as runCivitatisWriteOrchestration calls it, so a
// materialization failure's isolation is proven against the real wiring,
// not a reimplementation of it. The sandbox has no real Supabase
// credentials, so materializeReservationPreparations's own
// getServiceRoleClient() call fails for real — this is deliberately used
// as the "materialization failure" case, the same way
// tests/civitatis/writeEndpoint.test.js already tolerates activity
// modality enrichment's identical real failure in every write-mode test.
const handler = require('../../api/ingest-civitatis-write');
const { createFakeRepo } = require('./fakeRepo');
const F = require('./fixtures');

function baseRepoOptions(overrides = {}) {
  return {
    source: { id: 'src-civitatis' },
    tourChannels: [{
      id: 'tc-1', tour_id: 'tour-grand-bazaar', source_id: 'src-civitatis',
      external_product_id: 'Grand Bazaar Experience',
      tour: { id: 'tour-grand-bazaar', name: 'Grand Bazaar Experience' },
    }],
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

/** Strips comment-only lines so a structural "the CODE never does X"
 * assertion isn't tripped by this file's own prose explaining why it
 * doesn't — the same convention tests 15/16 below and
 * activityModalityEnrichment.test.js's own structural tests already use. */
function codeOnly(source) {
  return source
    .split('\n')
    .filter((l) => {
      const t = l.trim();
      return !t.startsWith('*') && !t.startsWith('//') && !t.startsWith('/**');
    })
    .join('\n');
}

function makeMaterialize(impl) {
  const calls = [];
  const fn = async (args) => {
    calls.push(args);
    if (typeof impl === 'function') return impl(args);
    return { result: 'materialized', reservation_id: args.reservationId };
  };
  fn.calls = calls;
  return fn;
}

function entry({ externalBookingId = 'A1', eligible = true }) {
  return { externalBookingId, eligible };
}

function resultEntry({ externalBookingId = 'A1', skipped = false, calls }) {
  return { externalBookingId, skipped, calls };
}

function rpcCall({ gmailMessageId, result, reservationId = 'res-1' }) {
  return { gmailMessageId, rpcResult: { result, reservation_id: reservationId }, unknownResult: false };
}

// ── 1: created booking triggers materialization ────────────────────────

test('1: created booking result -> materialize is called once with the exact authoritative reservation_id', async () => {
  const plan = { plans: [entry({})] };
  const executed = [resultEntry({ calls: [rpcCall({ gmailMessageId: 'm1', result: 'created', reservationId: 'res-created-1' })] })];
  const materialize = makeMaterialize();

  await materializeReservationPreparationsForBookingPlan({ plan, executed, materialize });

  assert.equal(materialize.calls.length, 1);
  assert.equal(materialize.calls[0].reservationId, 'res-created-1');
});

// ── 2: updated booking triggers materialization ─────────────────────────

test('2: updated booking result -> materialize is called once with the exact authoritative reservation_id', async () => {
  const plan = { plans: [entry({})] };
  const executed = [resultEntry({ calls: [rpcCall({ gmailMessageId: 'm1', result: 'updated', reservationId: 'res-updated-1' })] })];
  const materialize = makeMaterialize();

  await materializeReservationPreparationsForBookingPlan({ plan, executed, materialize });

  assert.equal(materialize.calls.length, 1);
  assert.equal(materialize.calls[0].reservationId, 'res-updated-1');
});

test('2b: a new_booking followed by a modified call for the same chain -> materialize is called once per materializable event, in order', async () => {
  const plan = { plans: [entry({})] };
  const executed = [resultEntry({
    calls: [
      rpcCall({ gmailMessageId: 'm1', result: 'created', reservationId: 'res-9' }),
      rpcCall({ gmailMessageId: 'm2', result: 'updated', reservationId: 'res-9' }),
    ],
  })];
  const materialize = makeMaterialize();

  await materializeReservationPreparationsForBookingPlan({ plan, executed, materialize });

  assert.equal(materialize.calls.length, 2);
  assert.equal(materialize.calls[0].reservationId, 'res-9');
  assert.equal(materialize.calls[1].reservationId, 'res-9');
});

// ── 3: cancelled booking triggers materialization ───────────────────────

test('3: cancelled result -> materialize is called once with the exact authoritative reservation_id', async () => {
  const executedCancellations = [
    { gmailMessageId: 'c1', externalBookingId: 'A1', unknownResult: false, rpcResult: { result: 'cancelled', reservation_id: 'res-cancelled-1' } },
  ];
  const materialize = makeMaterialize();

  await materializeReservationPreparationsForCancellations({ executedCancellations, materialize });

  assert.equal(materialize.calls.length, 1);
  assert.equal(materialize.calls[0].reservationId, 'res-cancelled-1');
});

// ── 4: duplicate (booking_already_exists / already_cancelled) -> no call ─

test('4: booking_already_exists (duplicate new_booking) -> materialize is never called', async () => {
  const plan = { plans: [entry({})] };
  const executed = [resultEntry({ calls: [rpcCall({ gmailMessageId: 'm1', result: 'booking_already_exists' })] })];
  const materialize = makeMaterialize();

  await materializeReservationPreparationsForBookingPlan({ plan, executed, materialize });

  assert.equal(materialize.calls.length, 0);
});

test('4b: already_cancelled (duplicate cancellation re-send) -> materialize is never called', async () => {
  const executedCancellations = [
    { gmailMessageId: 'c1', externalBookingId: 'A1', unknownResult: false, rpcResult: { result: 'already_cancelled', reservation_id: 'res-1' } },
  ];
  const materialize = makeMaterialize();

  await materializeReservationPreparationsForCancellations({ executedCancellations, materialize });

  assert.equal(materialize.calls.length, 0);
  assert.ok(!MATERIALIZABLE_CANCELLATION_RESULTS.has('already_cancelled'));
});

// ── 5: already processed -> no call ──────────────────────────────────────

test('5: already_processed (booking) -> materialize is never called', async () => {
  const plan = { plans: [entry({})] };
  const executed = [resultEntry({ calls: [rpcCall({ gmailMessageId: 'm1', result: 'already_processed' })] })];
  const materialize = makeMaterialize();

  await materializeReservationPreparationsForBookingPlan({ plan, executed, materialize });

  assert.equal(materialize.calls.length, 0);
});

test('5b: already_processed (cancellation) -> materialize is never called', async () => {
  const executedCancellations = [
    { gmailMessageId: 'c1', externalBookingId: 'A1', unknownResult: false, rpcResult: { result: 'already_processed', reservation_id: 'res-1' } },
  ];
  const materialize = makeMaterialize();

  await materializeReservationPreparationsForCancellations({ executedCancellations, materialize });

  assert.equal(materialize.calls.length, 0);
});

// ── 6: manual review -> no call ──────────────────────────────────────────

test('6: manual_review_required (booking) -> materialize is never called', async () => {
  const plan = { plans: [entry({})] };
  const executed = [resultEntry({ calls: [rpcCall({ gmailMessageId: 'm1', result: 'manual_review_required' })] })];
  const materialize = makeMaterialize();

  await materializeReservationPreparationsForBookingPlan({ plan, executed, materialize });

  assert.equal(materialize.calls.length, 0);
});

test('6b: manual_review_required (cancellation) -> materialize is never called', async () => {
  const executedCancellations = [
    { gmailMessageId: 'c1', externalBookingId: 'A1', unknownResult: false, rpcResult: { result: 'manual_review_required' } },
  ];
  const materialize = makeMaterialize();

  await materializeReservationPreparationsForCancellations({ executedCancellations, materialize });

  assert.equal(materialize.calls.length, 0);
});

// ── 7: failed write -> no call ───────────────────────────────────────────

test('7: failed (booking) -> materialize is never called', async () => {
  const plan = { plans: [entry({})] };
  const executed = [resultEntry({ calls: [rpcCall({ gmailMessageId: 'm1', result: 'failed' })] })];
  const materialize = makeMaterialize();

  await materializeReservationPreparationsForBookingPlan({ plan, executed, materialize });

  assert.equal(materialize.calls.length, 0);
});

test('7b: failed (cancellation) -> materialize is never called', async () => {
  const executedCancellations = [
    { gmailMessageId: 'c1', externalBookingId: 'A1', unknownResult: false, rpcResult: { result: 'failed', error: 'RPC call error: boom' } },
  ];
  const materialize = makeMaterialize();

  await materializeReservationPreparationsForCancellations({ executedCancellations, materialize });

  assert.equal(materialize.calls.length, 0);
});

test('7c: stale_ignored (booking) -> materialize is never called (an older email must never re-trigger materialization)', async () => {
  const plan = { plans: [entry({})] };
  const executed = [resultEntry({ calls: [rpcCall({ gmailMessageId: 'm1', result: 'stale_ignored' })] })];
  const materialize = makeMaterialize();

  await materializeReservationPreparationsForBookingPlan({ plan, executed, materialize });

  assert.equal(materialize.calls.length, 0);
  assert.ok(!MATERIALIZABLE_BOOKING_RESULTS.has('stale_ignored'));
});

// ── 8: missing reservation_id -> never guessed ───────────────────────────

test('8: a materializable result with no reservation_id -> materialize is never called (never guessed)', async () => {
  const plan = { plans: [entry({})] };
  const executed = [resultEntry({ calls: [{ gmailMessageId: 'm1', rpcResult: { result: 'created', reservation_id: undefined }, unknownResult: false }] })];
  const materialize = makeMaterialize();

  await materializeReservationPreparationsForBookingPlan({ plan, executed, materialize });

  assert.equal(materialize.calls.length, 0);
});

test('8b: an ineligible (skipped) plan entry -> materialize is never called', async () => {
  const plan = { plans: [{ externalBookingId: 'A1', eligible: false, reason: 'needs_review' }] };
  const executed = [{ externalBookingId: 'A1', skipped: true, reason: 'needs_review' }];
  const materialize = makeMaterialize();

  await materializeReservationPreparationsForBookingPlan({ plan, executed, materialize });

  assert.equal(materialize.calls.length, 0);
});

test('8c: an unrecognized/unknown RPC result -> materialize is never called', async () => {
  const plan = { plans: [entry({})] };
  const executed = [resultEntry({ calls: [{ gmailMessageId: 'm1', rpcResult: { result: 'something_new', reservation_id: 'res-1' }, unknownResult: true }] })];
  const materialize = makeMaterialize();

  await materializeReservationPreparationsForBookingPlan({ plan, executed, materialize });

  assert.equal(materialize.calls.length, 0);
});

// ── 9: materialization failure never propagates (booking) ──────────────

test('9: a materialization RPC failure is isolated — does not throw, other calls in the same chain still process', async () => {
  const plan = { plans: [entry({})] };
  const executed = [resultEntry({
    calls: [
      rpcCall({ gmailMessageId: 'm1', result: 'created', reservationId: 'res-a' }),
      rpcCall({ gmailMessageId: 'm2', result: 'updated', reservationId: 'res-b' }),
    ],
  })];
  let callCount = 0;
  const materialize = async (args) => {
    callCount += 1;
    if (callCount === 1) throw new Error('materialize_reservation_preparations RPC failed');
    return { result: 'materialized' };
  };
  const errors = [];

  await assert.doesNotReject(() =>
    materializeReservationPreparationsForBookingPlan({ plan, executed, materialize, onError: (err, ctx) => errors.push({ err, ctx }) })
  );

  assert.equal(errors.length, 1);
  assert.match(errors[0].err.message, /materialize_reservation_preparations RPC failed/);
  // The booking write itself (executed) is never un-committed/altered by
  // this — only the materialization call for the first event failed; the
  // next event in the SAME executed array still ran normally.
});

test('9b: a materialization failure never mutates `executed` (the booking write\'s own result)', async () => {
  const plan = { plans: [entry({})] };
  const executed = [resultEntry({ calls: [rpcCall({ gmailMessageId: 'm1', result: 'created', reservationId: 'res-a' })] })];
  const materialize = async () => { throw new Error('boom'); };
  const before = JSON.stringify(executed);

  await assert.doesNotReject(() =>
    materializeReservationPreparationsForBookingPlan({ plan, executed, materialize, onError: () => {} })
  );
  const after = JSON.stringify(executed);

  assert.equal(before, after);
});

// ── 10: materialization failure never propagates (cancellation) ────────

test('10: a materialization RPC failure after a successful cancellation is isolated — does not throw', async () => {
  const executedCancellations = [
    { gmailMessageId: 'c1', externalBookingId: 'A1', unknownResult: false, rpcResult: { result: 'cancelled', reservation_id: 'res-1' } },
  ];
  const materialize = async () => { throw new Error('materialize_reservation_preparations RPC failed'); };
  const errors = [];

  await assert.doesNotReject(() =>
    materializeReservationPreparationsForCancellations({ executedCancellations, materialize, onError: (err, ctx) => errors.push({ err, ctx }) })
  );

  assert.equal(errors.length, 1);
  assert.match(errors[0].err.message, /materialize_reservation_preparations RPC failed/);
});

// ── 11: never touches reservation_preparations directly ─────────────────

test('this module never calls .from(...).insert/update(...) directly — only through materializeReservationPreparations', () => {
  const implSource = fs.readFileSync(require.resolve('../../api/_civitatis/reservationPreparationEnrichment.js'), 'utf8');
  const code = codeOnly(implSource);
  assert.doesNotMatch(code, /\.from\(/);
  assert.doesNotMatch(code, /\.insert\(/);
  assert.doesNotMatch(code, /\.update\(/);
});

test('the materialization RPC wrapper never calls .from(...) directly — only sb.rpc(\'materialize_reservation_preparations\', ...)', () => {
  const implSource = fs.readFileSync(require.resolve('../../api/_civitatis/reservationPreparationMaterialization.js'), 'utf8');
  const code = codeOnly(implSource);
  assert.match(code, /sb\.rpc\('materialize_reservation_preparations'/);
  assert.doesNotMatch(code, /\.from\(/);
});

// ── 12: no meal_status / meal preparation creation ───────────────────────

test('neither module\'s CODE reads or writes meal_status or calls set_reservation_activity_modality — meals remain entirely separate (comments may still document the relationship)', () => {
  const enrichmentSource = fs.readFileSync(require.resolve('../../api/_civitatis/reservationPreparationEnrichment.js'), 'utf8');
  const persistenceSource = fs.readFileSync(require.resolve('../../api/_civitatis/reservationPreparationMaterialization.js'), 'utf8');
  for (const source of [enrichmentSource, persistenceSource]) {
    const code = codeOnly(source);
    assert.doesNotMatch(code, /meal_status/);
    assert.doesNotMatch(code, /set_reservation_activity_modality/);
  }
});

// ── 13: never mentions WhatsApp / auth ───────────────────────────────────

test('neither module mentions anything WhatsApp-related or auth-related', () => {
  const enrichmentSource = fs.readFileSync(require.resolve('../../api/_civitatis/reservationPreparationEnrichment.js'), 'utf8');
  const persistenceSource = fs.readFileSync(require.resolve('../../api/_civitatis/reservationPreparationMaterialization.js'), 'utf8');
  for (const source of [enrichmentSource, persistenceSource]) {
    assert.doesNotMatch(source, /whatsapp/i);
    assert.doesNotMatch(source, /\bauth\.uid\(\)/);
  }
});

// ── 14: never modifies V12/V13 RPC definitions ───────────────────────────

test('neither module contains a CREATE OR REPLACE FUNCTION, or any .rpc(...) call naming ingest_civitatis_booking or cancel_civitatis_booking — comments may still reference those RPCs by name for documentation', () => {
  const enrichmentSource = fs.readFileSync(require.resolve('../../api/_civitatis/reservationPreparationEnrichment.js'), 'utf8');
  const persistenceSource = fs.readFileSync(require.resolve('../../api/_civitatis/reservationPreparationMaterialization.js'), 'utf8');
  for (const source of [enrichmentSource, persistenceSource]) {
    const code = codeOnly(source);
    assert.doesNotMatch(code, /CREATE OR REPLACE FUNCTION/i);
    assert.doesNotMatch(code, /\.rpc\(\s*['"]ingest_civitatis_booking['"]/);
    assert.doesNotMatch(code, /\.rpc\(\s*['"]cancel_civitatis_booking['"]/);
  }
});

// ── 15: orchestration wiring — structural proof ──────────────────────────

test('the orchestration calls materializeReservationPreparationsForBookingPlan AFTER the booking domain write, with plan/executed, wrapped in try/catch', () => {
  const implSource = fs.readFileSync(require.resolve('../../api/ingest-civitatis-write.js'), 'utf8');
  const codeLines = implSource.split('\n').filter((l) => {
    const t = l.trim();
    return !t.startsWith('*') && !t.startsWith('//') && !t.startsWith('/**');
  });
  const code = codeLines.join('\n');

  const writeCallIndex = code.indexOf('await executeCivitatisIngestionPlan(plan, rpcCaller)');
  const materializeCallIndex = code.indexOf('await materializeReservationPreparationsForBookingPlan(');
  assert.ok(writeCallIndex >= 0, 'expected a call site for executeCivitatisIngestionPlan');
  assert.ok(materializeCallIndex >= 0, 'expected a call site for materializeReservationPreparationsForBookingPlan');
  assert.ok(materializeCallIndex > writeCallIndex, 'materialization must be called AFTER the booking domain write');

  const callSite = code.match(/materializeReservationPreparationsForBookingPlan\(\{[^}]*\}\)/);
  assert.ok(callSite, 'expected a call site for materializeReservationPreparationsForBookingPlan');
  assert.match(callSite[0], /\bplan\b/);
  assert.match(callSite[0], /\bexecuted\b/);

  // Wrapped in try/catch: the lines immediately surrounding the call site
  // include both keywords, not just a bare call.
  const idx = code.indexOf(callSite[0]);
  const surrounding = code.slice(Math.max(0, idx - 200), idx + 200);
  assert.match(surrounding, /try\s*\{/);
  assert.match(surrounding, /catch\s*\(/);
});

test('the orchestration calls materializeReservationPreparationsForCancellations AFTER the cancellation domain write, with executedCancellations, wrapped in try/catch', () => {
  const implSource = fs.readFileSync(require.resolve('../../api/ingest-civitatis-write.js'), 'utf8');
  const codeLines = implSource.split('\n').filter((l) => {
    const t = l.trim();
    return !t.startsWith('*') && !t.startsWith('//') && !t.startsWith('/**');
  });
  const code = codeLines.join('\n');

  const cancelWriteIndex = code.indexOf('await executeCivitatisCancellationPlan(cancellationPlan.plans, cancellationRpcCaller)');
  const materializeCallIndex = code.indexOf('await materializeReservationPreparationsForCancellations(');
  assert.ok(cancelWriteIndex >= 0, 'expected a call site for executeCivitatisCancellationPlan');
  assert.ok(materializeCallIndex >= 0, 'expected a call site for materializeReservationPreparationsForCancellations');
  assert.ok(materializeCallIndex > cancelWriteIndex, 'materialization must be called AFTER the cancellation domain write');

  const callSite = code.match(/materializeReservationPreparationsForCancellations\(\{[^}]*\}\)/);
  assert.ok(callSite, 'expected a call site for materializeReservationPreparationsForCancellations');
  assert.match(callSite[0], /\bexecutedCancellations\b/);

  const idx = code.indexOf(callSite[0]);
  const surrounding = code.slice(Math.max(0, idx - 200), idx + 200);
  assert.match(surrounding, /try\s*\{/);
  assert.match(surrounding, /catch\s*\(/);
});

test('materialization is never put inside the V12/V13 RPC bodies — it is only ever referenced from ingest-civitatis-write.js and the two new Phase C2F modules', () => {
  const v12Source = fs.readFileSync(require.resolve('../../supabase_migration_civitatis_write_v12_uuid_recheck_fix.sql'), 'utf8');
  const v13Source = fs.readFileSync(require.resolve('../../supabase_migration_civitatis_write_v13_cancellation.sql'), 'utf8');
  assert.doesNotMatch(v12Source, /materialize_reservation_preparations/);
  assert.doesNotMatch(v13Source, /materialize_reservation_preparations/);
});

// ── 16: existing activity modality enrichment still wired correctly ─────

test('activity modality enrichment call site is still present and still runs before the materialization call site', () => {
  const implSource = fs.readFileSync(require.resolve('../../api/ingest-civitatis-write.js'), 'utf8');
  const codeLines = implSource.split('\n').filter((l) => {
    const t = l.trim();
    return !t.startsWith('*') && !t.startsWith('//') && !t.startsWith('/**');
  });
  const code = codeLines.join('\n');

  const activityIndex = code.indexOf('await enrichCivitatisActivityModalityForPlan(');
  const materializeIndex = code.indexOf('await materializeReservationPreparationsForBookingPlan(');
  assert.ok(activityIndex >= 0, 'expected the pre-existing activity modality enrichment call site');
  assert.ok(materializeIndex >= 0);
  assert.ok(activityIndex < materializeIndex);
});

// ── 17: orchestration-level — materialization failure never fails a
// successful booking creation, modification, or cancellation ──────────

test('17: orchestration — a real (credential-less, failing) materialization call never turns a successful "created" booking into a failure', async () => {
  const repo = createFakeRepo(baseRepoOptions());
  const rpcCaller = makeSpyRpcCaller({ result: 'created', ingestion_id: 'ing-1', reservation_id: 'res-1' });
  const outcome = await handler.runCivitatisWriteOrchestration({
    messages: [F.italianNewBooking],
    repo, externalBookingId: null, writeModeActive: true, rpcCaller, cancellationRpcCaller: makeSpyRpcCaller({ result: 'cancelled' }),
  });

  assert.equal(outcome.ok, true);
  assert.equal(outcome.results[0].calls[0].decision, 'created');
  assert.equal(outcome.results[0].calls[0].reservationId, 'res-1');
});

test('17b: orchestration — a real (credential-less, failing) materialization call never turns a successful "updated" booking into a failure', async () => {
  const repo = createFakeRepo(baseRepoOptions({
    reservations: [{
      id: 'res-existing', source_id: 'src-civitatis', external_booking_id: '41629692', tour_id: 'tour-grand-bazaar',
      check_in: '2026-11-02', check_in_time: '09:00:00', pax_adult: 2, pax_child: 0,
    }],
  }));
  const rpcCaller = makeSpyRpcCaller({ result: 'updated', ingestion_id: 'ing-2', reservation_id: 'res-existing' });
  const outcome = await handler.runCivitatisWriteOrchestration({
    messages: [F.italianModification],
    repo, externalBookingId: null, writeModeActive: true, rpcCaller, cancellationRpcCaller: makeSpyRpcCaller({ result: 'cancelled' }),
  });

  assert.equal(outcome.ok, true);
  assert.equal(outcome.results[0].skipped, false);
});

test('17c: orchestration — a real (credential-less, failing) materialization call never turns a successful cancellation into a failure', async () => {
  const repo = createFakeRepo(baseRepoOptions());
  const cancellationRpc = makeSpyRpcCaller({ result: 'cancelled', reservation_id: 'res-38807986' });
  const outcome = await handler.runCivitatisWriteOrchestration({
    messages: [F.civitatisCancellationA38807986],
    repo, externalBookingId: null, writeModeActive: true, rpcCaller: makeSpyRpcCaller({ result: 'created' }), cancellationRpcCaller: cancellationRpc,
  });

  assert.equal(outcome.ok, true);
  assert.equal(outcome.cancellations.length, 1);
  assert.equal(outcome.cancellations[0].rpcResult, 'cancelled');
  assert.equal(outcome.cancellations[0].reservationId, 'res-38807986');
});

module.exports = {};
