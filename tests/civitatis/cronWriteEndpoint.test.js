'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const handler = require('../../api/cron-ingest-civitatis-write');
const writeEndpoint = require('../../api/ingest-civitatis-write');
const gmailClient = require('../../api/_civitatis/gmailClient');

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

// ── isAuthorizedSchedulerRequest: pure shared-secret truth table ────────
test('isAuthorizedSchedulerRequest requires the exact "Bearer <secret>" header against a configured, non-empty secret', () => {
  assert.equal(handler.isAuthorizedSchedulerRequest({ configuredSecret: 'xyz', authorizationHeader: 'Bearer xyz' }), true);
  assert.equal(handler.isAuthorizedSchedulerRequest({ configuredSecret: 'xyz', authorizationHeader: 'Bearer wrong' }), false);
  assert.equal(handler.isAuthorizedSchedulerRequest({ configuredSecret: 'xyz', authorizationHeader: 'xyz' }), false); // missing "Bearer " prefix
  assert.equal(handler.isAuthorizedSchedulerRequest({ configuredSecret: 'xyz', authorizationHeader: undefined }), false);
  assert.equal(handler.isAuthorizedSchedulerRequest({ configuredSecret: undefined, authorizationHeader: 'Bearer undefined' }), false); // fails closed even against a literal "Bearer undefined" guess
  assert.equal(handler.isAuthorizedSchedulerRequest({ configuredSecret: '', authorizationHeader: 'Bearer ' }), false); // an empty configured secret is never "configured"
});

// ── computeSinceUnixSeconds: the Gmail discovery overlap-window math ────
test('computeSinceUnixSeconds subtracts the fixed OVERLAP_WINDOW_MS from the last known watermark', () => {
  const nowMs = Date.UTC(2026, 5, 15, 12, 0, 0); // 2026-06-15T12:00:00Z
  const lastReceivedAtIso = '2026-06-15T10:00:00.000Z'; // 2h before "now"
  const since = handler.computeSinceUnixSeconds({ lastReceivedAtIso, nowMs });
  const expectedMs = new Date(lastReceivedAtIso).getTime() - handler.OVERLAP_WINDOW_MS;
  assert.equal(since, Math.floor(expectedMs / 1000));
  // The window is anchored to the watermark, NOT to "now" — a scheduler
  // that has been down for hours must still search from the watermark's
  // own time minus the overlap, not from whenever it happens to wake up.
  assert.notEqual(since, Math.floor((nowMs - handler.OVERLAP_WINDOW_MS) / 1000));
});

test('computeSinceUnixSeconds falls back to (now - OVERLAP_WINDOW_MS) only when there is no watermark yet (first-ever run)', () => {
  const nowMs = Date.UTC(2026, 5, 15, 12, 0, 0);
  const since = handler.computeSinceUnixSeconds({ lastReceivedAtIso: null, nowMs });
  assert.equal(since, Math.floor((nowMs - handler.OVERLAP_WINDOW_MS) / 1000));
});

test('the overlap window is generous (well beyond the 15-minute run interval) and the ceiling is well above the previous single-page cap', () => {
  assert.equal(handler.OVERLAP_WINDOW_MS, 24 * 60 * 60 * 1000); // 24 hours
  assert.ok(handler.OVERLAP_WINDOW_MS > 15 * 60 * 1000 * 4); // comfortably more than one run interval
  assert.equal(handler.FETCH_CEILING, 300);
  assert.ok(handler.FETCH_CEILING > writeEndpoint.HARD_MAX_MESSAGES); // strictly more headroom than the manual endpoint's own single-page cap
});

// ── gmailClient.fetchAllMessagesWithinCeiling: pagination + safety ceiling,
// entirely fake — no real Gmail I/O, via the injectable fetchPageFn. ────
function makeFakePaginator(pages) {
  const calls = [];
  const fetchPageFn = async (query, { pageToken, maxResults }) => {
    calls.push({ query, pageToken, maxResults });
    const page = pages[calls.length - 1];
    if (!page) throw new Error('makeFakePaginator: no more canned pages configured');
    return page;
  };
  fetchPageFn.calls = calls;
  return fetchPageFn;
}

test('fetchAllMessagesWithinCeiling follows nextPageToken across multiple pages when the first page alone is not everything', async () => {
  const fetchPageFn = makeFakePaginator([
    { messages: [{ gmailMessageId: 'm1' }, { gmailMessageId: 'm2' }], nextPageToken: 'p2' },
    { messages: [{ gmailMessageId: 'm3' }], nextPageToken: null },
  ]);
  const result = await gmailClient.fetchAllMessagesWithinCeiling('q', { maxTotal: 300, fetchPageFn });
  assert.equal(result.messages.length, 3);
  assert.deepEqual(result.messages.map(m => m.gmailMessageId), ['m1', 'm2', 'm3']);
  assert.equal(result.pagesFetched, 2);
  assert.equal(result.truncated, false); // Gmail itself reported no further page
  assert.equal(fetchPageFn.calls.length, 2);
  assert.equal(fetchPageFn.calls[1].pageToken, 'p2'); // second call actually resumed from the first page's token
});

test('fetchAllMessagesWithinCeiling never assumes a single page is complete, even when the first page alone is under the ceiling', async () => {
  // Regression for the exact bug this redesign fixes: the OLD
  // implementation fetched one page (maxResults=100, no pageToken) and
  // stopped, trusting that Gmail's first page already held everything —
  // an undocumented ordering assumption. This proves a 2nd page is
  // always requested when Gmail reports one exists, regardless of how
  // few messages the first page contained.
  const fetchPageFn = makeFakePaginator([
    { messages: [{ gmailMessageId: 'only-one-on-page-1' }], nextPageToken: 'p2' },
    { messages: [{ gmailMessageId: 'the-one-that-would-have-been-missed' }], nextPageToken: null },
  ]);
  const result = await gmailClient.fetchAllMessagesWithinCeiling('q', { maxTotal: 300, fetchPageFn });
  assert.equal(fetchPageFn.calls.length, 2);
  assert.ok(result.messages.some(m => m.gmailMessageId === 'the-one-that-would-have-been-missed'));
});

test('fetchAllMessagesWithinCeiling stops requesting further pages once the ceiling is met, and reports truncated:true', async () => {
  const fetchPageFn = makeFakePaginator([
    { messages: Array.from({ length: 100 }, (_, i) => ({ gmailMessageId: `a${i}` })), nextPageToken: 'p2' },
    { messages: Array.from({ length: 100 }, (_, i) => ({ gmailMessageId: `b${i}` })), nextPageToken: 'p3' },
    { messages: Array.from({ length: 100 }, (_, i) => ({ gmailMessageId: `c${i}` })), nextPageToken: 'p4' }, // Gmail says there's a 4th page
  ]);
  const result = await gmailClient.fetchAllMessagesWithinCeiling('q', { maxTotal: 300, fetchPageFn });
  assert.equal(result.messages.length, 300);
  assert.equal(fetchPageFn.calls.length, 3); // never asked for the 4th page
  assert.equal(result.truncated, true); // but Gmail said one still existed
});

test('fetchAllMessagesWithinCeiling reports truncated:false when the ceiling and genuine exhaustion coincide exactly', async () => {
  const fetchPageFn = makeFakePaginator([
    { messages: Array.from({ length: 300 }, (_, i) => ({ gmailMessageId: `x${i}` })), nextPageToken: null },
  ]);
  const result = await gmailClient.fetchAllMessagesWithinCeiling('q', { maxTotal: 300, fetchPageFn });
  assert.equal(result.messages.length, 300);
  assert.equal(result.truncated, false);
});

test('fetchAllMessagesWithinCeiling uses the real fetchMessagePage by default (contract check only — no network call made because a single-page, already-exhausted fake is not exercised here)', () => {
  assert.equal(typeof gmailClient.fetchAllMessagesWithinCeiling, 'function');
  assert.equal(typeof gmailClient.buildCivitatisSearchQueryWithWindow, 'function');
});

// ── buildCivitatisSearchQueryWithWindow: documented `after:` operator ───
test('buildCivitatisSearchQueryWithWindow narrows the existing sender query with a documented after: operator, never changing the sender filter itself', () => {
  const q = gmailClient.buildCivitatisSearchQueryWithWindow(1750000000);
  assert.equal(q, `${gmailClient.buildCivitatisSearchQuery()} after:1750000000`);
  assert.ok(q.includes('from:(notificaciones@civitatis.com)'));
  assert.ok(q.includes('after:1750000000'));
});

// ── Contract: the cron file imports these from the manual endpoint rather
// than reimplementing them. ──────────────────────────────────────────────
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
  delete process.env.CIVITATIS_SCHEDULER_SECRET;
  const req = { method: 'GET', headers: {} };
  const res = makeRes();
  await handler(req, res);
  assert.equal(res.statusCode, 401);
});

test('rejects a request with a wrong Authorization value with 401 — the URL alone is never enough to trigger ingestion', async () => {
  process.env.CIVITATIS_SCHEDULER_SECRET = 'the-real-scheduler-secret';
  const req = { method: 'GET', headers: { authorization: 'Bearer someone-guessed-this' } };
  const res = makeRes();
  await handler(req, res);
  assert.equal(res.statusCode, 401);
  delete process.env.CIVITATIS_SCHEDULER_SECRET;
});

test('rejects every request when CIVITATIS_SCHEDULER_SECRET is not configured at all, even one carrying a plausible-looking Authorization header', async () => {
  delete process.env.CIVITATIS_SCHEDULER_SECRET;
  const req = { method: 'GET', headers: { authorization: 'Bearer whatever-someone-tries' } };
  const res = makeRes();
  await handler(req, res);
  assert.equal(res.statusCode, 401);
});

test('a correctly authenticated scheduled invocation passes the auth gate and reaches the configuration stage (proves it is a real, wired invocation, not a bypass)', async () => {
  process.env.CIVITATIS_SCHEDULER_SECRET = 'the-real-scheduler-secret';
  delete process.env.SUPABASE_URL;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  delete process.env.GMAIL_CLIENT_ID;
  const req = { method: 'GET', headers: { authorization: 'Bearer the-real-scheduler-secret' } };
  const res = makeRes();
  await handler(req, res);
  assert.notEqual(res.statusCode, 401);
  // Supabase config is read FIRST now (the watermark read happens before
  // any Gmail call), so a credential-less sandbox reaches
  // supabase_configuration, not gmail_configuration, for this handler.
  assert.equal(res.statusCode, 503);
  assert.equal(res.body.stage, 'supabase_configuration');
  delete process.env.CIVITATIS_SCHEDULER_SECRET;
});

// ── Write gate stays independent of scheduler authentication. ───────────
test('an authenticated scheduled run only ever computes write mode active when CIVITATIS_WRITE_ENABLED is exactly "true" — never because the request was a scheduled request', () => {
  assert.equal(writeEndpoint.isWriteModeActive({ writeEnvValue: undefined, requestedWrite: true }), false);
  assert.equal(writeEndpoint.isWriteModeActive({ writeEnvValue: 'false', requestedWrite: true }), false);
  assert.equal(writeEndpoint.isWriteModeActive({ writeEnvValue: 'true', requestedWrite: true }), true);
});

// ── Already-processed / idempotent / failure / ceiling-adjacent behavior
// on the exact path the scheduled handler delegates to — proves the
// scheduled entry point inherits these guarantees rather than needing
// (or risking) its own reimplementation. Uses the same fake repo/
// rpcCaller injection pattern as writeEndpoint.test.js and
// writeAdapter.test.js — no Gmail/Supabase network access. ──────────────
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

test('a Gmail message re-encountered inside the overlap window (already processed on a prior run) stays already_processed — proves overlap-driven re-fetching is safe, not a duplicate-write risk', async () => {
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

// ── GitHub Actions workflow configuration — static assertions against the
// raw YAML text. No YAML parser dependency is added to this project just
// for this test: `on:` is intentionally unquoted (standard, universally
// used GitHub Actions syntax — generic YAML 1.1 parsers resolve a bare
// `on` as the boolean true, which is a well-known, harmless quirk that
// does not affect GitHub's own workflow parser), so plain text/regex
// assertions are actually the more accurate tool here, not a workaround. */
const WORKFLOW_PATH = path.join(__dirname, '../../.github/workflows/civitatis-scheduled-ingestion.yml');
const workflowText = fs.readFileSync(WORKFLOW_PATH, 'utf8');

test('the scheduled workflow file exists and runs every 15 minutes', () => {
  assert.match(workflowText, /^\s*schedule:\s*$/m);
  assert.match(workflowText, /^\s*-\s*cron:\s*'\*\/15 \* \* \* \*'\s*$/m);
});

test('the scheduled workflow supports workflow_dispatch for manual production verification', () => {
  assert.match(workflowText, /workflow_dispatch:\s*\{\}/);
});

test('the scheduled workflow authenticates via a GitHub Actions secret, never a literal token', () => {
  assert.match(workflowText, /secrets\.CIVITATIS_SCHEDULER_SECRET/);
  assert.match(workflowText, /Authorization: Bearer \$\{SCHEDULER_SECRET\}/);
  // No literal-looking bearer token value anywhere in the file — only
  // the ${{ secrets.* }} / ${VAR} expression forms.
  assert.doesNotMatch(workflowText, /Authorization: Bearer [A-Za-z0-9_-]{10,}/);
});

test('the scheduled workflow targets the ingestion endpoint via a non-secret repository variable, not a hardcoded URL', () => {
  assert.match(workflowText, /vars\.CIVITATIS_CRON_URL/);
});

test('the scheduled workflow has concurrency protection against overlapping runs', () => {
  assert.match(workflowText, /concurrency:\s*\n\s*group:\s*civitatis-scheduled-ingestion/);
  assert.match(workflowText, /cancel-in-progress:\s*false/);
});

test('the scheduled workflow fails the step visibly on a non-2xx response', () => {
  assert.match(workflowText, /http_status.*-lt 200.*-ge 300/s);
  assert.match(workflowText, /exit 1/);
});

test('the scheduled workflow requests minimal GITHUB_TOKEN permissions', () => {
  assert.match(workflowText, /permissions:\s*\{\}/);
});
