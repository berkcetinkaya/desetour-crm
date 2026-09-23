'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

const handler = require('../../api/cron-ingest-civitatis-write');
const writeEndpoint = require('../../api/ingest-civitatis-write');

// No network access, no Gmail mailbox, no real Supabase connection anywhere
// in this file — same convention as tests/civitatis/ingestEndpoint.test.js:
// the sandbox this test runs in genuinely has no Gmail/Supabase credentials
// configured, so a request that gets PAST this file's own auth gate is
// expected to reach the pre-existing "clear 503 configuration error" stage,
// never a real network call.

function makeRes() {
  const res = {
    statusCode: null,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
  };
  return res;
}

// ── isAuthorizedCronRequest: pure Vercel-cron-secret truth table ────────
test('isAuthorizedCronRequest requires the exact "Bearer <secret>" header against a configured, non-empty secret', () => {
  assert.equal(handler.isAuthorizedCronRequest({ configuredSecret: 'xyz', authorizationHeader: 'Bearer xyz' }), true);
  assert.equal(handler.isAuthorizedCronRequest({ configuredSecret: 'xyz', authorizationHeader: 'Bearer wrong' }), false);
  assert.equal(handler.isAuthorizedCronRequest({ configuredSecret: 'xyz', authorizationHeader: 'xyz' }), false); // missing "Bearer " prefix
  assert.equal(handler.isAuthorizedCronRequest({ configuredSecret: 'xyz', authorizationHeader: undefined }), false);
  assert.equal(handler.isAuthorizedCronRequest({ configuredSecret: undefined, authorizationHeader: 'Bearer undefined' }), false); // fails closed even against a literal "Bearer undefined" guess
  assert.equal(handler.isAuthorizedCronRequest({ configuredSecret: '', authorizationHeader: 'Bearer ' }), false); // an empty configured secret is never "configured"
});

// ── buildCronFetchOptions: the pagination safety property ───────────────
test('buildCronFetchOptions never includes a pageToken and uses the SAME HARD_MAX_MESSAGES ceiling the manual endpoint enforces (no duplicated constant)', () => {
  const opts = handler.buildCronFetchOptions();
  assert.equal('pageToken' in opts, false);
  assert.equal(opts.maxResults, writeEndpoint.HARD_MAX_MESSAGES);
  assert.equal(opts.maxResults, 100);
});

// ── Contract: the cron file imports these from the manual endpoint rather
// than reimplementing them — if any of these exports ever disappeared,
// this file would silently start duplicating logic (or crash); this test
// exists to catch that regression directly. ─────────────────────────────
test('the manual endpoint exports everything the cron handler depends on', () => {
  assert.equal(typeof writeEndpoint.isWriteModeActive, 'function');
  assert.equal(typeof writeEndpoint.buildRealRpcCaller, 'function');
  assert.equal(typeof writeEndpoint.runCivitatisWriteOrchestration, 'function');
  assert.equal(typeof writeEndpoint.HARD_MAX_MESSAGES, 'number');
});

// ── HTTP-level auth gate — real handler(req,res), no network/creds ever
// reached for the rejection paths. ───────────────────────────────────────
test('rejects non-GET methods with 405, before the auth check', async () => {
  const req = { method: 'POST', headers: {} };
  const res = makeRes();
  await handler(req, res);
  assert.equal(res.statusCode, 405);
});

test('rejects a request with no Authorization header at all with 401, before any Gmail/Supabase call', async () => {
  delete process.env.CRON_SECRET;
  const req = { method: 'GET', headers: {} };
  const res = makeRes();
  await handler(req, res);
  assert.equal(res.statusCode, 401);
});

test('rejects a request with a wrong Authorization value with 401 — the URL alone is never enough to trigger ingestion', async () => {
  process.env.CRON_SECRET = 'the-real-cron-secret';
  const req = { method: 'GET', headers: { authorization: 'Bearer someone-guessed-this' } };
  const res = makeRes();
  await handler(req, res);
  assert.equal(res.statusCode, 401);
  delete process.env.CRON_SECRET;
});

test('rejects every request when CRON_SECRET is not configured at all, even one carrying a plausible-looking Authorization header', async () => {
  delete process.env.CRON_SECRET;
  const req = { method: 'GET', headers: { authorization: 'Bearer whatever-someone-tries' } };
  const res = makeRes();
  await handler(req, res);
  assert.equal(res.statusCode, 401);
});

test('a correctly authenticated scheduled invocation passes the auth gate and reaches the same Gmail-configuration stage the manual endpoint does (proves it is a real, wired invocation, not a bypass)', async () => {
  process.env.CRON_SECRET = 'the-real-cron-secret';
  delete process.env.GMAIL_CLIENT_ID;
  const req = { method: 'GET', headers: { authorization: 'Bearer the-real-cron-secret' } };
  const res = makeRes();
  await handler(req, res);
  assert.notEqual(res.statusCode, 401);
  assert.equal(res.statusCode, 503);
  assert.equal(res.body.stage, 'gmail_configuration');
  delete process.env.CRON_SECRET;
});

// ── Write gate stays independent of cron authentication: an authenticated
// cron request is not itself "the write gate" — see writeEndpoint's own
// isWriteModeActive tests for the full truth table this file reuses
// unmodified. This confirms the specific value the cron handler always
// passes (requestedWrite: true) combines correctly with both states of
// CIVITATIS_WRITE_ENABLED. ────────────────────────────────────────────────
test('an authenticated scheduled run only ever computes write mode active when CIVITATIS_WRITE_ENABLED is exactly "true" — never because the request was a cron request', () => {
  assert.equal(writeEndpoint.isWriteModeActive({ writeEnvValue: undefined, requestedWrite: true }), false);
  assert.equal(writeEndpoint.isWriteModeActive({ writeEnvValue: 'false', requestedWrite: true }), false);
  assert.equal(writeEndpoint.isWriteModeActive({ writeEnvValue: 'true', requestedWrite: true }), true);
});

// ── Already-processed / idempotent / failure behavior on the exact path
// the cron handler delegates to — proves the scheduled entry point
// inherits these guarantees rather than needing (or risking) its own
// reimplementation. Uses the same fake repo/rpcCaller injection pattern
// as writeEndpoint.test.js and writeAdapter.test.js — no Gmail/Supabase
// network access. ─────────────────────────────────────────────────────
const { createFakeRepo } = require('./fakeRepo');
const F = require('./fixtures');

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

test('an already-processed Gmail message stays already_processed via the exact function the cron handler calls — no duplicate reservation logic', async () => {
  const repo = createFakeRepo(baseRepoOptions());
  const rpcCaller = makeSpyRpcCaller([{ result: 'already_processed', ingestion_id: 'ing-1', processing_status: 'processed' }]);
  const outcome = await writeEndpoint.runCivitatisWriteOrchestration({
    messages: [F.italianNewBooking], repo, externalBookingId: null, writeModeActive: true, rpcCaller,
  });
  assert.equal(outcome.ok, true);
  assert.equal(outcome.results[0].calls[0].rpcResult, 'already_processed');
  assert.equal(outcome.results[0].stoppedEarly, false);
});

test('a failed RPC result on a scheduled run stops that booking chain (fail closed), exactly as the manual endpoint already requires', async () => {
  const repo = createFakeRepo(baseRepoOptions());
  const rpcCaller = makeSpyRpcCaller([{ result: 'failed', error: 'simulated' }, { result: 'updated' }]);
  const outcome = await writeEndpoint.runCivitatisWriteOrchestration({
    messages: [F.italianNewBooking, F.italianModification], repo, externalBookingId: null, writeModeActive: true, rpcCaller,
  });
  assert.equal(outcome.ok, true);
  assert.equal(rpcCaller.calls.length, 1); // never sent the modification after the failure
  assert.equal(outcome.results[0].stoppedEarly, true);
});

test('POSSIBLE_EXISTING_MATCH never reaches the RPC on a scheduled (unfiltered) run, exactly as on a manual one', async () => {
  const repo = createFakeRepo(baseRepoOptions({
    customers: [{ id: 'cust-1', full_name: 'No Stop Viaggi Di Fam Srl Neri Francesca', email: null, phone: null }],
  }));
  const rpcCaller = makeSpyRpcCaller([{ result: 'created' }]);
  const outcome = await writeEndpoint.runCivitatisWriteOrchestration({
    messages: [F.italianNewBooking], repo, externalBookingId: null, writeModeActive: true, rpcCaller,
  });
  assert.equal(rpcCaller.calls.length, 0);
  assert.equal(outcome.results[0].skipped, true);
  assert.ok(outcome.results[0].reason.includes('POSSIBLE_EXISTING_MATCH'));
});

test('when write mode is not active (CIVITATIS_WRITE_ENABLED off), a scheduled run produces the same dry-run report shape and never touches rpcCaller', async () => {
  const repo = createFakeRepo(baseRepoOptions());
  const outcome = await writeEndpoint.runCivitatisWriteOrchestration({
    messages: [F.italianNewBooking], repo, externalBookingId: null, writeModeActive: false, rpcCaller: null,
  });
  assert.equal(outcome.ok, true);
  assert.equal(outcome.results[0].calls[0].decision.includes('WOULD_WRITE'), true);
  assert.equal(outcome.results[0].calls[0].rpcResult, null);
});
