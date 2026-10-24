'use strict';
/**
 * tests/dashboard/agencyMailboxSyncEndpoint.test.js
 * ─────────────────────────────────────────────────────────────────────────
 * Agency Mailbox Phase 2/8 — api/agency-mailbox-sync.js: scheduler auth,
 * GET-only, mode dispatch (incremental vs backfill), and the safe
 * classified-only 503 response on a capability preflight failure (never
 * Gmail's raw error text, never a token). gmailInboundSync's own sync
 * logic is stubbed via deps — this file only exercises the HTTP/auth
 * wiring around it.
 * ─────────────────────────────────────────────────────────────────────────
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const REPO_ROOT = path.join(__dirname, '..', '..');
const handler = require(path.join(REPO_ROOT, 'api', 'agency-mailbox-sync'));

function makeRes() {
  const res = {
    statusCode: null,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
  };
  return res;
}

function makeReq({ method = 'GET', authorization, query = {} } = {}) {
  return { method, headers: authorization ? { authorization } : {}, query };
}

function withSecretEnv(fn) {
  const keys = ['AGENCY_MAILBOX_SYNC_SECRET', 'SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'];
  const prev = {};
  for (const k of keys) prev[k] = process.env[k];
  process.env.AGENCY_MAILBOX_SYNC_SECRET = 'test-secret';
  process.env.SUPABASE_URL = 'https://example.supabase.co';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key';
  return (async () => {
    try { return await fn(); }
    finally {
      for (const k of keys) { if (prev[k] === undefined) delete process.env[k]; else process.env[k] = prev[k]; }
    }
  })();
}

const fakeCreateClient = () => ({ __fake: 'adminClient' });

// ── Auth gate ────────────────────────────────────────────────────────────

test('isAuthorizedSchedulerRequest requires the exact "Bearer <secret>" header against a configured, non-empty secret', () => {
  assert.equal(handler.isAuthorizedSchedulerRequest({ configuredSecret: 'xyz', authorizationHeader: 'Bearer xyz' }), true);
  assert.equal(handler.isAuthorizedSchedulerRequest({ configuredSecret: 'xyz', authorizationHeader: 'Bearer wrong' }), false);
  assert.equal(handler.isAuthorizedSchedulerRequest({ configuredSecret: '', authorizationHeader: 'Bearer ' }), false);
  assert.equal(handler.isAuthorizedSchedulerRequest({ configuredSecret: undefined, authorizationHeader: 'Bearer undefined' }), false);
});

// ── TEMPORARY DIAGNOSTIC (401 troubleshooting) ──────────────────────────
// Covers _diagnoseUnauthorizedRequest, added to distinguish between a
// missing Vercel env, a missing/malformed Authorization header, a length
// mismatch, hidden whitespace, or a same-length-but-different value — all
// without ever exposing the secret, the header, a substring of either, or
// any reversible encoding. Remove this section when the diagnostic itself
// is removed.

test('TEMP DIAGNOSTIC: reports presence/absence of the configured secret and the header independently', () => {
  const d1 = handler._diagnoseUnauthorizedRequest({ configuredSecret: undefined, authorizationHeader: undefined });
  assert.equal(d1.configuredSecretPresent, false);
  assert.equal(d1.authorizationHeaderPresent, false);
  assert.equal(d1.configuredSecretLength, 0);
  assert.equal(d1.providedBearerValueLength, 0);
  assert.equal(d1.exactMatch, false);

  const d2 = handler._diagnoseUnauthorizedRequest({ configuredSecret: 'abc', authorizationHeader: undefined });
  assert.equal(d2.configuredSecretPresent, true);
  assert.equal(d2.configuredSecretLength, 3);
  assert.equal(d2.authorizationHeaderPresent, false);
  assert.equal(d2.authorizationSchemeIsBearer, false);
});

test('TEMP DIAGNOSTIC: flags a non-Bearer or malformed scheme distinctly from a missing header', () => {
  const noScheme = handler._diagnoseUnauthorizedRequest({ configuredSecret: 'abc', authorizationHeader: 'abc' });
  assert.equal(noScheme.authorizationHeaderPresent, true);
  assert.equal(noScheme.authorizationSchemeIsBearer, false);
  assert.equal(noScheme.providedBearerValueLength, 0);

  const basicScheme = handler._diagnoseUnauthorizedRequest({ configuredSecret: 'abc', authorizationHeader: 'Basic abc' });
  assert.equal(basicScheme.authorizationSchemeIsBearer, false);

  const noSpaceAfterBearer = handler._diagnoseUnauthorizedRequest({ configuredSecret: 'abc', authorizationHeader: 'Bearerabc' });
  assert.equal(noSpaceAfterBearer.authorizationSchemeIsBearer, false);
});

test('TEMP DIAGNOSTIC: reports exact lengths and exactMatch for a same-length-but-different value', () => {
  const d = handler._diagnoseUnauthorizedRequest({ configuredSecret: 'abcdef', authorizationHeader: 'Bearer abcxyz' });
  assert.equal(d.authorizationSchemeIsBearer, true);
  assert.equal(d.configuredSecretLength, 6);
  assert.equal(d.providedBearerValueLength, 6);
  assert.equal(d.exactMatch, false);
  assert.equal(d.trimmedMatch, false);
});

test('TEMP DIAGNOSTIC: exactMatch and trimmedMatch are both true for a genuinely matching value', () => {
  const d = handler._diagnoseUnauthorizedRequest({ configuredSecret: 'same-value', authorizationHeader: 'Bearer same-value' });
  assert.equal(d.exactMatch, true);
  assert.equal(d.trimmedMatch, true);
  assert.equal(d.configuredHasLeadingOrTrailingWhitespace, false);
  assert.equal(d.providedHasLeadingOrTrailingWhitespace, false);
});

test('TEMP DIAGNOSTIC: catches hidden leading/trailing whitespace that exactMatch alone would hide the reason for', () => {
  // Configured secret has a trailing newline (e.g. pasted from a terminal/file into Vercel's UI).
  const d1 = handler._diagnoseUnauthorizedRequest({ configuredSecret: 'same-value\n', authorizationHeader: 'Bearer same-value' });
  assert.equal(d1.exactMatch, false, 'raw values differ because of the trailing newline');
  assert.equal(d1.trimmedMatch, true, 'once trimmed, the underlying values are identical');
  assert.equal(d1.configuredHasLeadingOrTrailingWhitespace, true);
  assert.equal(d1.providedHasLeadingOrTrailingWhitespace, false);

  // Header value has a leading space (e.g. "Bearer  value" — two spaces).
  const d2 = handler._diagnoseUnauthorizedRequest({ configuredSecret: 'value', authorizationHeader: 'Bearer  value' });
  assert.equal(d2.providedHasLeadingOrTrailingWhitespace, true);
  assert.equal(d2.trimmedMatch, true);
  assert.equal(d2.exactMatch, false);
});

test('TEMP DIAGNOSTIC: the returned metadata never contains the secret or header value itself, or any substring of either', () => {
  const configuredSecret = 'super-secret-value-12345';
  const authorizationHeader = 'Bearer super-secret-value-12345';
  const d = handler._diagnoseUnauthorizedRequest({ configuredSecret, authorizationHeader });
  const serialized = JSON.stringify(d);
  // Every value in the returned object must be a boolean or a number —
  // never a string that could carry (part of) the secret.
  for (const [key, value] of Object.entries(d)) {
    assert.ok(typeof value === 'boolean' || typeof value === 'number', `${key} must be a boolean or number, got ${typeof value}`);
  }
  assert.doesNotMatch(serialized, /super-secret-value/);
  // Even partial substrings of meaningful length must not leak.
  for (let i = 0; i + 6 <= configuredSecret.length; i++) {
    const chunk = configuredSecret.slice(i, i + 6);
    assert.doesNotMatch(serialized, new RegExp(chunk.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
});

test('TEMP DIAGNOSTIC: on a real 401, the handler logs ONLY the safe diagnostic (never the secret/header) and the HTTP response body is completely unchanged', () => withSecretEnv(async () => {
  const originalConsoleError = console.error;
  const calls = [];
  console.error = (...args) => { calls.push(args); };
  try {
    const req = makeReq({ authorization: 'Bearer wrong-secret' });
    const res = makeRes();
    await handler(req, res, {});
    assert.equal(res.statusCode, 401);
    // Response body is exactly what it always was — no diagnostic leaks into the HTTP response.
    assert.deepEqual(res.body, { error: 'Unauthorized.' });

    const diagnosticCall = calls.find(args => args[0] === '[agency-mailbox-sync][TEMP-DIAGNOSTIC-401]');
    assert.ok(diagnosticCall, 'expected the temporary diagnostic to be logged on an unauthorized request');
    const logged = diagnosticCall[1];
    const serialized = JSON.stringify(logged);
    assert.doesNotMatch(serialized, /test-secret/);
    assert.doesNotMatch(serialized, /wrong-secret/);
    assert.equal(logged.exactMatch, false);
    assert.equal(logged.configuredSecretPresent, true);
    assert.equal(logged.authorizationSchemeIsBearer, true);
  } finally {
    console.error = originalConsoleError;
  }
}));

test('rejects non-GET methods with 405 before even checking auth', () => withSecretEnv(async () => {
  const req = makeReq({ method: 'POST', authorization: 'Bearer test-secret' });
  const res = makeRes();
  await handler(req, res, {});
  assert.equal(res.statusCode, 405);
}));

test('rejects a missing/wrong Authorization header with 401, never reaching Supabase or Gmail', () => withSecretEnv(async () => {
  let createClientCalled = false;
  const req = makeReq({ authorization: 'Bearer wrong-secret' });
  const res = makeRes();
  await handler(req, res, { createClient: () => { createClientCalled = true; return fakeCreateClient(); } });
  assert.equal(res.statusCode, 401);
  assert.equal(createClientCalled, false);
}));

test('rejects a request with no Authorization header at all with 401', () => withSecretEnv(async () => {
  const req = makeReq({});
  const res = makeRes();
  await handler(req, res, {});
  assert.equal(res.statusCode, 401);
}));

// ── Mode dispatch ────────────────────────────────────────────────────────

test('defaults to incremental mode (syncAgencyMailbox) when ?mode is omitted', () => withSecretEnv(async () => {
  const req = makeReq({ authorization: 'Bearer test-secret' });
  const res = makeRes();
  let calledWith = null;
  const gmailInboundSync = {
    syncAgencyMailbox: async (args) => { calledWith = args; return { ok: true, stage: 'synced', matched: 0, skipped: 0, processed: 0 }; },
    runBoundedBackfill: async () => { throw new Error('should not be called'); },
  };
  await handler(req, res, { createClient: fakeCreateClient, gmailInboundSync });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.mode, 'incremental');
  assert.ok(calledWith);
}));

test('dispatches to runBoundedBackfill only when ?mode=backfill, forwarding ?since as sinceUnixSeconds', () => withSecretEnv(async () => {
  const req = makeReq({ authorization: 'Bearer test-secret', query: { mode: 'backfill', since: '1700000000' } });
  const res = makeRes();
  let capturedArgs = null;
  const gmailInboundSync = {
    syncAgencyMailbox: async () => { throw new Error('should not be called in backfill mode'); },
    runBoundedBackfill: async (args) => { capturedArgs = args; return { ok: true, stage: 'backfilled', matched: 2, skipped: 0, processed: 2 }; },
  };
  await handler(req, res, { createClient: fakeCreateClient, gmailInboundSync });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.mode, 'backfill');
  assert.equal(capturedArgs.sinceUnixSeconds, 1700000000);
}));

test('an unrecognized ?mode value falls back to incremental rather than backfilling by accident', () => withSecretEnv(async () => {
  const req = makeReq({ authorization: 'Bearer test-secret', query: { mode: 'something-else' } });
  const res = makeRes();
  const gmailInboundSync = {
    syncAgencyMailbox: async () => ({ ok: true, stage: 'synced', matched: 0, skipped: 0, processed: 0 }),
    runBoundedBackfill: async () => { throw new Error('should not be called'); },
  };
  await handler(req, res, { createClient: fakeCreateClient, gmailInboundSync });
  assert.equal(res.body.mode, 'incremental');
}));

// ── Capability-failure safe response ─────────────────────────────────────

test('a capability_check_failed result is reported as a safe classified 503 — never Gmail\'s raw error text, never a token', () => withSecretEnv(async () => {
  const req = makeReq({ authorization: 'Bearer test-secret' });
  const res = makeRes();
  const gmailInboundSync = {
    syncAgencyMailbox: async () => ({ ok: false, stage: 'capability_check_failed', capability: 'insufficient_scope' }),
    runBoundedBackfill: async () => { throw new Error('should not be called'); },
  };
  await handler(req, res, { createClient: fakeCreateClient, gmailInboundSync });
  assert.equal(res.statusCode, 503);
  assert.equal(res.body.stage, 'capability_check_failed');
  assert.equal(res.body.capability, 'insufficient_scope');
  const serialized = JSON.stringify(res.body);
  assert.doesNotMatch(serialized, /ya29\.|refresh_token|access_token|Bearer /i);
  assert.doesNotMatch(serialized, /scope doesn't allow|insufficient authentication scopes/i);
}));

test('an unknown_error capability classification is also a safe 503, with its own distinct message', () => withSecretEnv(async () => {
  const req = makeReq({ authorization: 'Bearer test-secret' });
  const res = makeRes();
  const gmailInboundSync = {
    syncAgencyMailbox: async () => ({ ok: false, stage: 'capability_check_failed', capability: 'unknown_error' }),
    runBoundedBackfill: async () => { throw new Error('should not be called'); },
  };
  await handler(req, res, { createClient: fakeCreateClient, gmailInboundSync });
  assert.equal(res.statusCode, 503);
  assert.equal(res.body.capability, 'unknown_error');
}));

test('a successful run returns 200 with the ok:true envelope and the raw diagnostics counts, unmodified', () => withSecretEnv(async () => {
  const req = makeReq({ authorization: 'Bearer test-secret' });
  const res = makeRes();
  const gmailInboundSync = {
    syncAgencyMailbox: async () => ({ ok: true, stage: 'synced', matched: 3, skipped: 1, processed: 4, historyId: '12345' }),
    runBoundedBackfill: async () => { throw new Error('should not be called'); },
  };
  await handler(req, res, { createClient: fakeCreateClient, gmailInboundSync });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.matched, 3);
  assert.equal(res.body.historyId, '12345');
}));

test('an unexpected thrown error is reported as a generic 500, never leaking the raw error message to the response body', () => withSecretEnv(async () => {
  const req = makeReq({ authorization: 'Bearer test-secret' });
  const res = makeRes();
  const gmailInboundSync = {
    syncAgencyMailbox: async () => { throw new Error('leaked-internal-detail-marker'); },
    runBoundedBackfill: async () => { throw new Error('should not be called'); },
  };
  await handler(req, res, { createClient: fakeCreateClient, gmailInboundSync });
  assert.equal(res.statusCode, 500);
  assert.doesNotMatch(JSON.stringify(res.body), /leaked-internal-detail-marker/);
}));

// ── mode=capability — strictly read-only pre-production probe ──────────
// A dedicated, dead-end branch: requires the SAME scheduler secret as
// every other mode, calls ONLY gmailInboundSync.checkMailboxCapability,
// never falls through to incremental/backfill, and returns the minimal
// {ok, capability} shape — nothing else, never a raw Gmail error.

test('capability mode requires the same scheduler secret as every other mode', () => withSecretEnv(async () => {
  const req = makeReq({ query: { mode: 'capability' }, authorization: 'Bearer wrong-secret' });
  const res = makeRes();
  let called = false;
  const gmailInboundSync = { checkMailboxCapability: async () => { called = true; return { ok: true, capability: 'full_body_ok' }; } };
  await handler(req, res, { createClient: fakeCreateClient, gmailInboundSync });
  assert.equal(res.statusCode, 401);
  assert.equal(called, false, 'the capability checker must never be called without a valid scheduler secret');
}));

test('capability mode calls gmailInboundSync.checkMailboxCapability exactly once', () => withSecretEnv(async () => {
  const req = makeReq({ query: { mode: 'capability' }, authorization: 'Bearer test-secret' });
  const res = makeRes();
  let callCount = 0;
  const gmailInboundSync = { checkMailboxCapability: async () => { callCount += 1; return { ok: true, capability: 'full_body_ok' }; } };
  await handler(req, res, { createClient: fakeCreateClient, gmailInboundSync });
  assert.equal(callCount, 1);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { ok: true, capability: 'full_body_ok' });
}));

test('capability mode performs zero Supabase writes end-to-end, through the REAL checkMailboxCapability (not stubbed) — only one read, never an insert/update/upsert', () => withSecretEnv(async () => {
  const req = makeReq({ query: { mode: 'capability' }, authorization: 'Bearer test-secret' });
  const res = makeRes();
  const calls = [];
  const adminClient = {
    from(table) {
      const b = {
        select() { return b; },
        eq() { return b; },
        not() { return b; },
        order() { return b; },
        limit() { return b; },
        maybeSingle() { calls.push({ table, method: 'read' }); return Promise.resolve({ data: { provider_message_id: 'gm-sample' }, error: null }); },
        insert(payload) { calls.push({ table, method: 'insert', payload }); return Promise.resolve({ error: null }); },
        update(payload) { calls.push({ table, method: 'update', payload }); return b; },
        upsert(payload, opts) { calls.push({ table, method: 'upsert', payload, opts }); return Promise.resolve({ error: null }); },
      };
      return b;
    },
  };
  const gmailDeps = { fetch: async (url) => {
    if (String(url).includes('oauth2.googleapis.com')) return { ok: true, json: async () => ({ access_token: 'tok', expires_in: 3600 }) };
    return { ok: true, json: async () => ({ id: 'gm-sample', payload: { headers: [] } }) };
  } };
  const gmailEnvKeys = ['AGENCY_GMAIL_CLIENT_ID', 'AGENCY_GMAIL_CLIENT_SECRET', 'AGENCY_GMAIL_REFRESH_TOKEN', 'AGENCY_GMAIL_FROM'];
  const prevGmailEnv = {};
  for (const k of gmailEnvKeys) prevGmailEnv[k] = process.env[k];
  process.env.AGENCY_GMAIL_CLIENT_ID = 'x'; process.env.AGENCY_GMAIL_CLIENT_SECRET = 'x';
  process.env.AGENCY_GMAIL_REFRESH_TOKEN = 'x'; process.env.AGENCY_GMAIL_FROM = 'hello@desetour.com';
  try {
    // No `gmailInboundSync` passed in deps here — this exercises the real
    // module (gmailSendClient's real checkInboundBodyCapability included),
    // not a stub, so "zero writes" is a genuine guarantee, not an artifact
    // of a test double.
    await handler(req, res, { createClient: () => adminClient, gmailDeps });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body, { ok: true, capability: 'full_body_ok' });
    assert.ok(!calls.some(c => c.method !== 'read'), 'capability mode must never insert/update/upsert anything');
    assert.equal(calls.filter(c => c.method === 'read').length, 1, 'exactly one read — the sample outbound message id lookup — nothing else');
  } finally {
    for (const k of gmailEnvKeys) { if (prevGmailEnv[k] === undefined) delete process.env[k]; else process.env[k] = prevGmailEnv[k]; }
  }
}));

test('capability mode never calls syncAgencyMailbox (incremental sync)', () => withSecretEnv(async () => {
  const req = makeReq({ query: { mode: 'capability' }, authorization: 'Bearer test-secret' });
  const res = makeRes();
  const gmailInboundSync = {
    checkMailboxCapability: async () => ({ ok: true, capability: 'full_body_ok' }),
    syncAgencyMailbox: async () => { throw new Error('syncAgencyMailbox must never be called in capability mode'); },
    runBoundedBackfill: async () => { throw new Error('runBoundedBackfill must never be called in capability mode'); },
  };
  await handler(req, res, { createClient: fakeCreateClient, gmailInboundSync });
  assert.equal(res.statusCode, 200);
}));

test('capability mode never calls runBoundedBackfill, even if ?since is also present', () => withSecretEnv(async () => {
  const req = makeReq({ query: { mode: 'capability', since: '1700000000' }, authorization: 'Bearer test-secret' });
  const res = makeRes();
  const gmailInboundSync = {
    checkMailboxCapability: async () => ({ ok: true, capability: 'full_body_ok' }),
    runBoundedBackfill: async () => { throw new Error('runBoundedBackfill must never be called in capability mode'); },
    syncAgencyMailbox: async () => { throw new Error('syncAgencyMailbox must never be called in capability mode'); },
  };
  await handler(req, res, { createClient: fakeCreateClient, gmailInboundSync });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { ok: true, capability: 'full_body_ok' });
}));

test('capability mode: insufficient_scope returns a safe 503 with only {ok:false, capability} — no scope name, no token, no raw error', () => withSecretEnv(async () => {
  const req = makeReq({ query: { mode: 'capability' }, authorization: 'Bearer test-secret' });
  const res = makeRes();
  const gmailInboundSync = { checkMailboxCapability: async () => ({ ok: false, capability: 'insufficient_scope' }) };
  await handler(req, res, { createClient: fakeCreateClient, gmailInboundSync });
  assert.equal(res.statusCode, 503);
  assert.deepEqual(res.body, { ok: false, capability: 'insufficient_scope' });
  // 'insufficient_scope' itself is the safe, intended classification
  // value — what must never appear is an actual OAuth scope name, a
  // bearer token, or any other raw credential/provider detail.
  const serialized = JSON.stringify(res.body);
  assert.doesNotMatch(serialized, /gmail\.readonly|gmail\.metadata|Bearer |ya29\.|refresh_token|access_token/i);
}));

test('capability mode: an unknown Gmail failure never exposes raw provider details, only the safe classification', () => withSecretEnv(async () => {
  const req = makeReq({ query: { mode: 'capability' }, authorization: 'Bearer test-secret' });
  const res = makeRes();
  const gmailInboundSync = { checkMailboxCapability: async () => ({ ok: false, capability: 'unknown_error' }) };
  await handler(req, res, { createClient: fakeCreateClient, gmailInboundSync });
  assert.equal(res.statusCode, 503);
  assert.deepEqual(res.body, { ok: false, capability: 'unknown_error' });
}));

test('capability mode: an unexpected thrown error (e.g. a Gmail transport failure) is reported as a safe 500 — never the raw error message', () => withSecretEnv(async () => {
  const req = makeReq({ query: { mode: 'capability' }, authorization: 'Bearer test-secret' });
  const res = makeRes();
  const gmailInboundSync = { checkMailboxCapability: async () => { throw new Error('leaked-internal-gmail-error-marker'); } };
  await handler(req, res, { createClient: fakeCreateClient, gmailInboundSync });
  assert.equal(res.statusCode, 500);
  assert.doesNotMatch(JSON.stringify(res.body), /leaked-internal-gmail-error-marker/);
  assert.equal(res.body.ok, false);
}));

test('capability mode response never carries extra fields (mode/matched/skipped/historyId/...) — exactly {ok, capability}', () => withSecretEnv(async () => {
  const req = makeReq({ query: { mode: 'capability' }, authorization: 'Bearer test-secret' });
  const res = makeRes();
  const gmailInboundSync = { checkMailboxCapability: async () => ({ ok: true, capability: 'full_body_ok' }) };
  await handler(req, res, { createClient: fakeCreateClient, gmailInboundSync });
  assert.deepEqual(Object.keys(res.body).sort(), ['capability', 'ok']);
}));

// ── Missing Supabase configuration ───────────────────────────────────────

test('missing Supabase env vars produce a 503 db_configuration response rather than throwing', () => withSecretEnv(async () => {
  const req = makeReq({ authorization: 'Bearer test-secret' });
  const res = makeRes();
  const prevUrl = process.env.SUPABASE_URL;
  const prevKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  delete process.env.SUPABASE_URL;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  try {
    await handler(req, res, {});
    assert.equal(res.statusCode, 503);
    assert.equal(res.body.stage, 'db_configuration');
  } finally {
    if (prevUrl === undefined) delete process.env.SUPABASE_URL; else process.env.SUPABASE_URL = prevUrl;
    if (prevKey === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY; else process.env.SUPABASE_SERVICE_ROLE_KEY = prevKey;
  }
}));
