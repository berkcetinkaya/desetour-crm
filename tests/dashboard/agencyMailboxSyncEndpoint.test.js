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
