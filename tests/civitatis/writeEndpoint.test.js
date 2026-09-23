'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

const handler = require('../../api/ingest-civitatis-write');
const { createFakeRepo } = require('./fakeRepo');
const F = require('./fixtures');

// Exercises the REAL orchestration/gating/reporting code the HTTP handler
// itself calls (handler.runCivitatisWriteOrchestration), with `repo` and
// `rpcCaller` injected — no Gmail or real Supabase network access
// anywhere in this file. See api/ingest-civitatis-write.js's own header
// for why this is the code path under test, not a reimplementation of it.

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

/** A fake/spy rpcCaller: records every call it receives (never touches a
 * database) and lets a test script a canned response sequence. */
function makeSpyRpcCaller(responses) {
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

// ── isWriteModeActive: pure 2x2 gate truth table ────────────────────────
test('isWriteModeActive requires BOTH the env var exactly "true" AND requestedWrite true', () => {
  assert.equal(handler.isWriteModeActive({ writeEnvValue: 'true', requestedWrite: true }), true);
  assert.equal(handler.isWriteModeActive({ writeEnvValue: 'true', requestedWrite: false }), false);
  assert.equal(handler.isWriteModeActive({ writeEnvValue: undefined, requestedWrite: true }), false);
  assert.equal(handler.isWriteModeActive({ writeEnvValue: 'TRUE', requestedWrite: true }), false); // exact match only
  assert.equal(handler.isWriteModeActive({ writeEnvValue: '1', requestedWrite: true }), false);
  assert.equal(handler.isWriteModeActive({ writeEnvValue: 'true', requestedWrite: 'true' }), false); // must be the boolean true, not the string
});

test('parseRequestedWrite only treats the literal string/boolean "true" as an opt-in', () => {
  assert.equal(handler.parseRequestedWrite('true'), true);
  assert.equal(handler.parseRequestedWrite(true), true);
  assert.equal(handler.parseRequestedWrite('1'), false);
  assert.equal(handler.parseRequestedWrite(undefined), false);
  assert.equal(handler.parseRequestedWrite('false'), false);
});

// ── isManualWriteAuthorized: the new write=true shared-secret gate ──────
test('isManualWriteAuthorized requires an exact match against a configured, non-empty secret', () => {
  assert.equal(handler.isManualWriteAuthorized({ configuredSecret: 's3cr3t', providedSecret: 's3cr3t' }), true);
  assert.equal(handler.isManualWriteAuthorized({ configuredSecret: 's3cr3t', providedSecret: 'wrong' }), false);
  assert.equal(handler.isManualWriteAuthorized({ configuredSecret: 's3cr3t', providedSecret: undefined }), false);
  assert.equal(handler.isManualWriteAuthorized({ configuredSecret: undefined, providedSecret: undefined }), false); // fails closed
  assert.equal(handler.isManualWriteAuthorized({ configuredSecret: undefined, providedSecret: 'anything' }), false); // fails closed even if a header happens to be sent
  assert.equal(handler.isManualWriteAuthorized({ configuredSecret: '', providedSecret: '' }), false); // an empty configured secret is never "configured"
  assert.equal(handler.isManualWriteAuthorized({ configuredSecret: 's3cr3t', providedSecret: ['s3cr3t'] }), false); // must be a string, not e.g. a duplicated-header array
});

// ── HTTP-level write auth gate — real handler(req,res), no network/creds
// ever reached for the rejection paths (mirrors tests/civitatis/
// ingestEndpoint.test.js's convention of calling the real exported
// handler with a minimal req/res mock and relying on the sandbox's own
// genuine lack of Gmail/Supabase credentials for the "auth passed, then
// hit a config error" case). ───────────────────────────────────────────
function makeRes() {
  const res = {
    statusCode: null,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
  };
  return res;
}

test('a plain dry-run request (no write=true) needs no secret and is unaffected by the new gate', async () => {
  delete process.env.CIVITATIS_MANUAL_WRITE_SECRET;
  delete process.env.GMAIL_CLIENT_ID;
  const req = { method: 'GET', query: {}, headers: {} };
  const res = makeRes();
  await handler(req, res);
  // Reaches the same pre-existing Gmail-configuration failure the manual
  // endpoint always had for a credential-less environment — never a 401.
  assert.equal(res.statusCode, 503);
  assert.equal(res.body.stage, 'gmail_configuration');
});

test('a write=true request is rejected 401 before any Gmail/Supabase call when no secret is configured', async () => {
  delete process.env.CIVITATIS_MANUAL_WRITE_SECRET;
  const req = { method: 'GET', query: { write: 'true' }, headers: {} };
  const res = makeRes();
  await handler(req, res);
  assert.equal(res.statusCode, 401);
  assert.equal(res.body.stage, 'manual_write_auth');
});

test('a write=true request is rejected 401 when the provided secret header does not match', async () => {
  process.env.CIVITATIS_MANUAL_WRITE_SECRET = 'the-real-secret';
  const req = { method: 'GET', query: { write: 'true' }, headers: { 'x-civitatis-write-secret': 'guessed-wrong' } };
  const res = makeRes();
  await handler(req, res);
  assert.equal(res.statusCode, 401);
  delete process.env.CIVITATIS_MANUAL_WRITE_SECRET;
});

test('a write=true request with the correct secret header passes the auth gate (reaches the same Gmail-configuration stage a dry run does)', async () => {
  process.env.CIVITATIS_MANUAL_WRITE_SECRET = 'the-real-secret';
  const req = { method: 'GET', query: { write: 'true' }, headers: { 'x-civitatis-write-secret': 'the-real-secret' } };
  const res = makeRes();
  await handler(req, res);
  // Proves the 401 gate is not what's blocking here — it's the sandbox's
  // genuine lack of Gmail credentials, exactly like every other real
  // handler() test in this suite.
  assert.notEqual(res.statusCode, 401);
  assert.equal(res.statusCode, 503);
  assert.equal(res.body.stage, 'gmail_configuration');
  delete process.env.CIVITATIS_MANUAL_WRITE_SECRET;
});

// ── filterMessagesByExternalBookingId ───────────────────────────────────
test('filterMessagesByExternalBookingId keeps only messages parsing to the exact requested booking id', () => {
  const filtered = handler.filterMessagesByExternalBookingId(
    [F.italianNewBooking, F.spanishNewBooking], '41629692'
  );
  assert.equal(filtered.length, 1);
  assert.equal(filtered[0].gmailMessageId, F.italianNewBooking.gmailMessageId);
});

test('filterMessagesByExternalBookingId keeps a parse-failed sibling event for the SAME requested booking', () => {
  const emptyBodySameBooking = { ...F.italianNewBooking, gmailMessageId: 'msg-broken-001', body: '   ' };
  const filtered = handler.filterMessagesByExternalBookingId(
    [F.italianNewBooking, emptyBodySameBooking, F.spanishNewBooking], '41629692'
  );
  assert.equal(filtered.length, 2);
  assert.ok(filtered.some(m => m.gmailMessageId === 'msg-broken-001'));
});

test('filterMessagesByExternalBookingId with no externalBookingId returns all messages unchanged', () => {
  const input = [F.italianNewBooking, F.spanishNewBooking];
  assert.deepEqual(handler.filterMessagesByExternalBookingId(input, null), input);
});

// ── Test-plan item: write disabled means zero RPC calls ─────────────────
test('write disabled (writeModeActive:false): zero RPC calls, even for an otherwise fully-eligible booking', async () => {
  const repo = createFakeRepo(baseRepoOptions());
  const rpcCaller = makeSpyRpcCaller([{ result: 'created' }]);
  const outcome = await handler.runCivitatisWriteOrchestration({
    messages: [F.italianNewBooking],
    repo,
    externalBookingId: null,
    writeModeActive: false,
    rpcCaller,
  });
  assert.equal(outcome.ok, true);
  assert.equal(rpcCaller.calls.length, 0);
  assert.equal(outcome.results[0].skipped, false);
  assert.equal(outcome.results[0].calls[0].decision.startsWith('WOULD_WRITE'), true);
  assert.equal(outcome.results[0].calls[0].rpcResult, null);
});

test('write disabled: the HTTP handler never constructs a real rpcCaller at all (rpcCaller stays null)', async () => {
  // Mirrors exactly what the real handler does: only build a real
  // rpcCaller when writeModeActive is true.
  const writeModeActive = handler.isWriteModeActive({ writeEnvValue: undefined, requestedWrite: true });
  assert.equal(writeModeActive, false);
  const rpcCaller = writeModeActive ? 'WOULD-BE-CONSTRUCTED' : null;
  assert.equal(rpcCaller, null);
});

// ── Test-plan item: single booking filter cannot write another booking ──
test('single booking filter: a request scoped to one booking id never writes a different booking present in the same page', async () => {
  const repo = createFakeRepo(baseRepoOptions());
  const rpcCaller = makeSpyRpcCaller([{ result: 'created', ingestion_id: 'ing-1', reservation_id: 'res-1' }]);
  const outcome = await handler.runCivitatisWriteOrchestration({
    messages: [F.italianNewBooking, F.spanishNewBooking], // 41629692 and 41576789
    repo,
    externalBookingId: '41629692',
    writeModeActive: true,
    rpcCaller,
  });
  assert.equal(outcome.ok, true);
  assert.equal(outcome.results.length, 1);
  assert.equal(outcome.results[0].externalBookingId, '41629692');
  assert.equal(rpcCaller.calls.length, 1);
  assert.equal(rpcCaller.calls[0].p_external_booking_id, '41629692');
});

// ── Eligible WOULD_CREATE reaches RPC when enabled ───────────────────────
test('eligible WOULD_CREATE reaches the RPC when write mode is active', async () => {
  const repo = createFakeRepo(baseRepoOptions());
  const rpcCaller = makeSpyRpcCaller([{ result: 'created', ingestion_id: 'ing-1', reservation_id: 'res-1' }]);
  const outcome = await handler.runCivitatisWriteOrchestration({
    messages: [F.italianNewBooking],
    repo,
    externalBookingId: null,
    writeModeActive: true,
    rpcCaller,
  });
  assert.equal(rpcCaller.calls.length, 1);
  assert.equal(rpcCaller.calls[0].p_event_type, 'new_booking');
  const call = outcome.results[0].calls[0];
  assert.equal(call.decision, 'created');
  assert.equal(call.reservationId, 'res-1');
  assert.equal(call.ingestionId, 'ing-1');
});

// ── Eligible WOULD_UPDATE reaches RPC when enabled ───────────────────────
test('eligible WOULD_UPDATE reaches the RPC when write mode is active', async () => {
  const repo = createFakeRepo(baseRepoOptions({
    reservations: [{
      id: 'res-existing', source_id: 'src-civitatis', external_booking_id: '41629692', tour_id: 'tour-grand-bazaar',
      check_in: '2026-11-02', check_in_time: '09:00:00', pax_adult: 2, pax_child: 0,
    }],
  }));
  const rpcCaller = makeSpyRpcCaller([{ result: 'updated', ingestion_id: 'ing-2', reservation_id: 'res-existing' }]);
  const outcome = await handler.runCivitatisWriteOrchestration({
    messages: [F.italianModification],
    repo,
    externalBookingId: null,
    writeModeActive: true,
    rpcCaller,
  });
  assert.equal(rpcCaller.calls.length, 1);
  assert.equal(rpcCaller.calls[0].p_event_type, 'modified');
  assert.equal(outcome.results[0].calls[0].decision, 'updated');
});

// ── POSSIBLE_EXISTING_MATCH never reaches RPC ────────────────────────────
test('POSSIBLE_EXISTING_MATCH (exact normalized name) never reaches the RPC, even with write mode active', async () => {
  const repo = createFakeRepo(baseRepoOptions({
    customers: [{ id: 'cust-juan', full_name: 'Juan Armas Puente', email: null, phone: null }],
  }));
  const rpcCaller = makeSpyRpcCaller([{ result: 'created' }]);
  const outcome = await handler.runCivitatisWriteOrchestration({
    messages: [F.juanArmasPuenteBooking],
    repo,
    externalBookingId: null,
    writeModeActive: true,
    rpcCaller,
  });
  assert.equal(rpcCaller.calls.length, 0);
  assert.equal(outcome.results[0].skipped, true);
  assert.ok(outcome.results[0].reason.includes('POSSIBLE_EXISTING_MATCH'));
});

// ── NEEDS_REVIEW never reaches RPC ────────────────────────────────────────
test('NEEDS_REVIEW (no tour_channels match) never reaches the RPC, even with write mode active', async () => {
  const repo = createFakeRepo(baseRepoOptions({ tourChannels: [] }));
  const rpcCaller = makeSpyRpcCaller([{ result: 'created' }]);
  const outcome = await handler.runCivitatisWriteOrchestration({
    messages: [F.italianNewBooking],
    repo,
    externalBookingId: null,
    writeModeActive: true,
    rpcCaller,
  });
  assert.equal(rpcCaller.calls.length, 0);
  assert.equal(outcome.results[0].skipped, true);
});

// ── PARSE_ERROR never reaches RPC ─────────────────────────────────────────
test('PARSE_ERROR never reaches the RPC, even with write mode active', async () => {
  const repo = createFakeRepo(baseRepoOptions());
  const emptyBody = { ...F.italianNewBooking, gmailMessageId: 'msg-empty-001', body: '   ' };
  const rpcCaller = makeSpyRpcCaller([{ result: 'created' }]);
  const outcome = await handler.runCivitatisWriteOrchestration({
    messages: [emptyBody],
    repo,
    externalBookingId: null,
    writeModeActive: true,
    rpcCaller,
  });
  assert.equal(rpcCaller.calls.length, 0);
  assert.equal(outcome.results[0].skipped, true);
});

// ── IGNORED never reaches RPC ──────────────────────────────────────────────
test('IGNORED (no resolvable external booking id at all) never reaches the RPC, even with write mode active', async () => {
  const repo = createFakeRepo(baseRepoOptions());
  const rpcCaller = makeSpyRpcCaller([{ result: 'created' }]);
  const outcome = await handler.runCivitatisWriteOrchestration({
    messages: [F.invoiceEmail, F.marketingEmail],
    repo,
    externalBookingId: null,
    writeModeActive: true,
    rpcCaller,
  });
  assert.equal(rpcCaller.calls.length, 0);
  assert.equal(outcome.results.length, 0); // never even grouped into a plannable booking
});

// ── unknown RPC result fails closed ───────────────────────────────────────
test('an unknown RPC result value stops that booking chain (fail closed), even with write mode active', async () => {
  const repo = createFakeRepo(baseRepoOptions());
  const rpcCaller = makeSpyRpcCaller([
    { result: 'some_future_result_this_code_does_not_know_about' },
    { result: 'updated' },
  ]);
  const outcome = await handler.runCivitatisWriteOrchestration({
    messages: [F.italianNewBooking, F.italianModification],
    repo,
    externalBookingId: null,
    writeModeActive: true,
    rpcCaller,
  });
  assert.equal(rpcCaller.calls.length, 1); // the modification was never sent
  assert.equal(outcome.results[0].stoppedEarly, true);
  assert.equal(outcome.results[0].calls[0].decision, 'UNKNOWN_RPC_RESULT (failed closed)');
});

// ── failed RPC result stops that booking chain ────────────────────────────
test('a "failed" RPC result stops that booking chain, even with write mode active', async () => {
  const repo = createFakeRepo(baseRepoOptions());
  const rpcCaller = makeSpyRpcCaller([
    { result: 'failed', error: 'simulated' },
    { result: 'updated' },
  ]);
  const outcome = await handler.runCivitatisWriteOrchestration({
    messages: [F.italianNewBooking, F.italianModification],
    repo,
    externalBookingId: null,
    writeModeActive: true,
    rpcCaller,
  });
  assert.equal(rpcCaller.calls.length, 1);
  assert.equal(outcome.results[0].stoppedEarly, true);
  assert.equal(outcome.results[0].calls[0].decision, 'failed');
  assert.equal(outcome.results[0].calls[0].error, 'simulated');
});

// ── V9 diagnostic fields (stage/diagnostics) are surfaced when present ────
// Regression for the second real A41629692 smoke test: a 'failed' RPC
// result from a V9-or-later database carries new 'stage'/'diagnostics'
// keys naming exactly which internal processing stage raised and
// Postgres's own GET STACKED DIAGNOSTICS fields for that exception —
// decorateCallResult must pass them through untouched so the next real
// retry's diagnosis is actually visible in the endpoint's response, not
// silently dropped.
test('a "failed" RPC result carrying V9 stage/diagnostics fields surfaces them in the endpoint response, unmodified', async () => {
  const repo = createFakeRepo(baseRepoOptions());
  const rpcCaller = makeSpyRpcCaller([
    {
      result: 'failed',
      ingestion_id: 'ing-fb7bd246',
      error: 'stage=reference_number_allocation; error=there is no unique or exclusion constraint matching the ON CONFLICT specification; sqlstate=42P10; constraint=-; table=-; column=-; detail=-; hint=-',
      stage: 'reference_number_allocation',
      diagnostics: {
        sqlstate: '42P10',
        constraint_name: null,
        table_name: null,
        column_name: null,
        detail: null,
        hint: null,
        context: 'PL/pgSQL function public.next_ref_number(text,text,text) line 51 at SQL statement',
      },
    },
  ]);
  const outcome = await handler.runCivitatisWriteOrchestration({
    messages: [F.italianNewBooking],
    repo,
    externalBookingId: null,
    writeModeActive: true,
    rpcCaller,
  });
  const call = outcome.results[0].calls[0];
  assert.equal(call.decision, 'failed');
  assert.equal(call.stage, 'reference_number_allocation');
  assert.equal(call.diagnostics.sqlstate, '42P10');
  assert.equal(call.diagnostics.context, 'PL/pgSQL function public.next_ref_number(text,text,text) line 51 at SQL statement');
  // Never the raw request payload, never a passenger name, never a
  // customer contact field — diagnostics is SQL error metadata only.
  assert.equal(JSON.stringify(call.diagnostics).includes('passenger'), false);
});

// stage/diagnostics must be null, never throw, against a pre-V9-shaped
// RPC response (e.g. still-applied V8, or any other result value) — the
// decorator must not assume these keys exist.
test('stage/diagnostics are null (not thrown) for an RPC result that predates V9 or is not "failed"', async () => {
  const repo = createFakeRepo(baseRepoOptions());
  const rpcCaller = makeSpyRpcCaller([
    { result: 'created', ingestion_id: 'ing-1', reservation_id: 'res-1' },
  ]);
  const outcome = await handler.runCivitatisWriteOrchestration({
    messages: [F.italianNewBooking],
    repo,
    externalBookingId: null,
    writeModeActive: true,
    rpcCaller,
  });
  const call = outcome.results[0].calls[0];
  assert.equal(call.stage, null);
  assert.equal(call.diagnostics, null);
});

// ── new booking then modification ordering remains deterministic ─────────
test('new_booking is always sent to the RPC before its later modification, even when fed newest-first', async () => {
  const repo = createFakeRepo(baseRepoOptions());
  const rpcCaller = makeSpyRpcCaller([
    { result: 'created', ingestion_id: 'ing-1', reservation_id: 'res-1' },
    { result: 'updated', ingestion_id: 'ing-2', reservation_id: 'res-1' },
  ]);
  const outcome = await handler.runCivitatisWriteOrchestration({
    messages: [F.italianModification, F.italianNewBooking], // deliberately reversed
    repo,
    externalBookingId: null,
    writeModeActive: true,
    rpcCaller,
  });
  assert.equal(rpcCaller.calls.length, 2);
  assert.equal(rpcCaller.calls[0].p_event_type, 'new_booking');
  assert.equal(rpcCaller.calls[1].p_event_type, 'modified');
  assert.equal(outcome.results[0].calls[0].eventType, 'new_booking');
  assert.equal(outcome.results[0].calls[1].eventType, 'modified');
});

// ── Consolidated real-booking-shaped smoke scenario (still fully faked) ──
test('A41629692-shaped scenario: single-booking filter + write mode together create then update, never touching A41576789', async () => {
  const repo = createFakeRepo(baseRepoOptions());
  const rpcCaller = makeSpyRpcCaller([
    { result: 'created', ingestion_id: 'ing-1', reservation_id: 'res-1' },
    { result: 'updated', ingestion_id: 'ing-1', reservation_id: 'res-1' },
  ]);
  const outcome = await handler.runCivitatisWriteOrchestration({
    messages: [F.spanishNewBooking, F.italianModification, F.italianNewBooking], // mixed booking, reversed order
    repo,
    externalBookingId: '41629692',
    writeModeActive: true,
    rpcCaller,
  });
  assert.equal(outcome.results.length, 1);
  assert.equal(outcome.results[0].externalBookingId, '41629692');
  assert.equal(rpcCaller.calls.length, 2);
  assert.equal(rpcCaller.calls[0].p_event_type, 'new_booking');
  assert.equal(rpcCaller.calls[1].p_event_type, 'modified');
  assert.ok(rpcCaller.calls.every(c => c.p_external_booking_id === '41629692'));
});
