'use strict';
/**
 * tests/dashboard/agencyMailboxPhaseA.test.js
 * ─────────────────────────────────────────────────────────────────────────
 * Agency Mailbox Phase A — api/agency-send-email.js end to end. Every
 * Supabase call (auth + data) and every Gmail call is injected — no live
 * network access anywhere, matching every other test in this project.
 *
 * The fake admin/anon client below is a small in-memory "script": each
 * table name maps to a queue of canned {data,error} results, consumed in
 * call order, so a single request's several sequential queries against
 * the SAME table (validate -> claim -> persist) can each be scripted
 * independently without a real database.
 * ─────────────────────────────────────────────────────────────────────────
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const REPO_ROOT = path.join(__dirname, '..', '..');
const handler = require(path.join(REPO_ROOT, 'api', 'agency-send-email'));
const gmailSendClient = require(path.join(REPO_ROOT, 'api', '_agencies', 'gmailSendClient'));

const ENV_KEYS = [
  'SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_ANON_KEY',
  'AGENCY_GMAIL_CLIENT_ID', 'AGENCY_GMAIL_CLIENT_SECRET', 'AGENCY_GMAIL_REFRESH_TOKEN', 'AGENCY_GMAIL_FROM',
];

function withEnv(fn) {
  const prev = {};
  for (const k of ENV_KEYS) prev[k] = process.env[k];
  process.env.SUPABASE_URL = 'https://example.supabase.co';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-test-key';
  process.env.SUPABASE_ANON_KEY = 'anon-test-key';
  process.env.AGENCY_GMAIL_CLIENT_ID = 'test-client-id';
  process.env.AGENCY_GMAIL_CLIENT_SECRET = 'test-client-secret';
  process.env.AGENCY_GMAIL_REFRESH_TOKEN = 'test-refresh-token';
  process.env.AGENCY_GMAIL_FROM = 'hello@desetour.com';
  return Promise.resolve().then(fn).finally(() => {
    for (const k of ENV_KEYS) { if (prev[k] === undefined) delete process.env[k]; else process.env[k] = prev[k]; }
  });
}

/** Thenable fake query-builder: every chain method returns itself; the
 * final await resolves to whatever result this specific call was
 * scripted to return. */
function makeThenable(result) {
  const obj = {
    select() { return obj; },
    update() { return obj; },
    insert() { return obj; },
    eq() { return obj; },
    is() { return obj; },
    maybeSingle() { return obj; },
    then(resolve, reject) { return Promise.resolve(result).then(resolve, reject); },
    catch(fn) { return Promise.resolve(result).catch(fn); },
  };
  return obj;
}

/**
 * script: { staff_users: [...], agencies: [...], agency_emails: [...], activity_logs: [...] }
 * Each array is consumed in call order (one entry per `.from(table)` call
 * made during the request); the last entry repeats if exhausted.
 * aal/staffRow drive requireAgencyRole's own identity/role/AAL2 checks.
 */
function fakeCreateClientFactory({ userId = 'staff-1', userError = null, aalLevel = 'aal2', aalError = null, script = {} }) {
  const counters = {};
  function fromImpl(table) {
    const idx = counters[table] || 0;
    counters[table] = idx + 1;
    const queue = script[table] || [];
    const entry = idx < queue.length ? queue[idx] : (queue.length ? queue[queue.length - 1] : null);
    // Each queued entry is either a plain row (auto-wrapped as its own
    // {data,error:null} result) or an already-{data,error}-shaped object
    // for a test that needs to simulate a DB error on that specific call.
    const looksLikeResult = entry && typeof entry === 'object' && ('error' in entry) && ('data' in entry);
    const result = looksLikeResult ? entry : { data: entry, error: null };
    return makeThenable(result);
  }
  return () => ({
    auth: {
      getUser: async () => ({ data: userError ? null : { user: { id: userId } }, error: userError }),
      mfa: { getAuthenticatorAssuranceLevel: async () => (aalError ? { data: null, error: aalError } : { data: { currentLevel: aalLevel, nextLevel: aalLevel, currentAuthenticationMethods: [] }, error: null }) },
    },
    from: fromImpl,
  });
}

const STAFF_ADMIN_ACTIVE = [{ role: 'admin', is_active: true }];
const STAFF_SALES_ACTIVE = [{ role: 'sales', is_active: true }];
const STAFF_OPERATIONS_ACTIVE = [{ role: 'operations', is_active: true }];
const STAFF_GUIDE_ACTIVE = [{ role: 'guide', is_active: true }];
const STAFF_ADMIN_INACTIVE = [{ role: 'admin', is_active: false }];

function req(body) {
  return { method: 'POST', headers: { authorization: 'Bearer faketoken' }, body };
}

function fakeRes() {
  const calls = { status: null, json: null };
  return {
    status(code) { calls.status = code; return this; },
    json(payload) { calls.json = payload; return calls; },
    _calls: calls,
  };
}

function fakeGmailDepsSuccess({ gmailMessageId = 'gm-1', gmailThreadId = 'th-1', messageIdHeader = '<abc@mail.gmail.com>' } = {}) {
  return {
    fetch: async (url) => {
      if (String(url).includes('oauth2.googleapis.com')) return { ok: true, json: async () => ({ access_token: 'tok', expires_in: 3600 }) };
      if (String(url).includes('/send')) return { ok: true, json: async () => ({ id: gmailMessageId, threadId: gmailThreadId }) };
      return { ok: true, json: async () => ({ payload: { headers: messageIdHeader ? [{ name: 'Message-Id', value: messageIdHeader }] : [] } }) };
    },
  };
}

function fakeGmailDepsRejected() {
  return {
    fetch: async (url) => {
      if (String(url).includes('oauth2.googleapis.com')) return { ok: true, json: async () => ({ access_token: 'tok', expires_in: 3600 }) };
      return { ok: false, status: 400, text: async () => 'Gmail rejected it' };
    },
  };
}

const AGENCY_ADAY = [{ id: 'agency-1', email: 'acente@example.com', status: 'Aday' }];
const DRAFT_ROW = [{ id: 'email-1', agency_id: 'agency-1', direction: 'outbound', status: 'draft', subject: 'Konu', body: 'Gövde metni', sent_at: null, provider_message_id: null, provider_thread_id: null }];

gmailSendClient._resetAccessTokenCacheForTests();

// ── A. Authorization chain (reuses requireAgencyRole, unchanged) ───────

test('[auth] admin at AAL2 is allowed through to the business logic', () => withEnv(async () => {
  const createClient = fakeCreateClientFactory({
    aalLevel: 'aal2',
    script: { staff_users: STAFF_ADMIN_ACTIVE, agencies: AGENCY_ADAY, agency_emails: [DRAFT_ROW[0], { ...DRAFT_ROW[0], send_claimed_at: new Date().toISOString() }] },
  });
  const res = fakeRes();
  await handler(req({ agency_id: 'agency-1', agency_email_id: 'email-1' }), res, { createClient, gmailDeps: fakeGmailDepsSuccess() });
  assert.equal(res._calls.status, 200);
}));

test('[auth] sales at AAL2 is allowed through to the business logic', () => withEnv(async () => {
  const createClient = fakeCreateClientFactory({
    aalLevel: 'aal2',
    script: { staff_users: STAFF_SALES_ACTIVE, agencies: AGENCY_ADAY, agency_emails: [DRAFT_ROW[0], { ...DRAFT_ROW[0], send_claimed_at: new Date().toISOString() }] },
  });
  const res = fakeRes();
  await handler(req({ agency_id: 'agency-1', agency_email_id: 'email-1' }), res, { createClient, gmailDeps: fakeGmailDepsSuccess() });
  assert.equal(res._calls.status, 200);
}));

test('[auth] operations is denied (requireAgencyRole, unchanged)', () => withEnv(async () => {
  const createClient = fakeCreateClientFactory({ aalLevel: 'aal2', script: { staff_users: STAFF_OPERATIONS_ACTIVE } });
  const res = fakeRes();
  await handler(req({ agency_id: 'agency-1', agency_email_id: 'email-1' }), res, { createClient });
  assert.equal(res._calls.status, 403);
}));

test('[auth] guide is denied (requireAgencyRole, unchanged)', () => withEnv(async () => {
  const createClient = fakeCreateClientFactory({ aalLevel: 'aal2', script: { staff_users: STAFF_GUIDE_ACTIVE } });
  const res = fakeRes();
  await handler(req({ agency_id: 'agency-1', agency_email_id: 'email-1' }), res, { createClient });
  assert.equal(res._calls.status, 403);
}));

test('[auth] inactive admin is denied (requireAgencyRole, unchanged)', () => withEnv(async () => {
  const createClient = fakeCreateClientFactory({ aalLevel: 'aal2', script: { staff_users: STAFF_ADMIN_INACTIVE } });
  const res = fakeRes();
  await handler(req({ agency_id: 'agency-1', agency_email_id: 'email-1' }), res, { createClient });
  assert.equal(res._calls.status, 403);
}));

test('[auth] AAL1 is denied even for admin (requireAgencyRole, unchanged)', () => withEnv(async () => {
  const createClient = fakeCreateClientFactory({ aalLevel: 'aal1', script: { staff_users: STAFF_ADMIN_ACTIVE } });
  const res = fakeRes();
  await handler(req({ agency_id: 'agency-1', agency_email_id: 'email-1' }), res, { createClient });
  assert.equal(res._calls.status, 403);
}));

// ── B. Validation ────────────────────────────────────────────────────────

test('[validate] draft must belong to the given agency', () => withEnv(async () => {
  const createClient = fakeCreateClientFactory({
    script: { staff_users: STAFF_ADMIN_ACTIVE, agencies: AGENCY_ADAY, agency_emails: [{ ...DRAFT_ROW[0], agency_id: 'some-other-agency' }] },
  });
  const res = fakeRes();
  await handler(req({ agency_id: 'agency-1', agency_email_id: 'email-1' }), res, { createClient });
  assert.equal(res._calls.status, 400);
}));

test('[validate] only an outbound draft can be sent (inbound direction rejected)', () => withEnv(async () => {
  const createClient = fakeCreateClientFactory({
    script: { staff_users: STAFF_ADMIN_ACTIVE, agencies: AGENCY_ADAY, agency_emails: [{ ...DRAFT_ROW[0], direction: 'inbound' }] },
  });
  const res = fakeRes();
  await handler(req({ agency_id: 'agency-1', agency_email_id: 'email-1' }), res, { createClient });
  assert.equal(res._calls.status, 400);
}));

test('[validate] a non-draft, non-sent status (e.g. "failed") is rejected, not silently sent', () => withEnv(async () => {
  const createClient = fakeCreateClientFactory({
    script: { staff_users: STAFF_ADMIN_ACTIVE, agencies: AGENCY_ADAY, agency_emails: [{ ...DRAFT_ROW[0], status: 'failed' }] },
  });
  const res = fakeRes();
  await handler(req({ agency_id: 'agency-1', agency_email_id: 'email-1' }), res, { createClient });
  assert.equal(res._calls.status, 409);
}));

test('[validate] missing recipient (agency has no valid email) fails before any Gmail call', () => withEnv(async () => {
  let gmailCalled = false;
  const createClient = fakeCreateClientFactory({
    script: { staff_users: STAFF_ADMIN_ACTIVE, agencies: [{ id: 'agency-1', email: null, status: 'Aday' }], agency_emails: DRAFT_ROW },
  });
  const res = fakeRes();
  const gmailDeps = { fetch: async () => { gmailCalled = true; return { ok: true, json: async () => ({}) }; } };
  await handler(req({ agency_id: 'agency-1', agency_email_id: 'email-1' }), res, { createClient, gmailDeps });
  assert.equal(res._calls.status, 400);
  assert.equal(gmailCalled, false);
}));

test('[validate] missing subject fails before any Gmail call', () => withEnv(async () => {
  let gmailCalled = false;
  const createClient = fakeCreateClientFactory({
    script: { staff_users: STAFF_ADMIN_ACTIVE, agencies: AGENCY_ADAY, agency_emails: [{ ...DRAFT_ROW[0], subject: '' }] },
  });
  const res = fakeRes();
  const gmailDeps = { fetch: async () => { gmailCalled = true; return { ok: true, json: async () => ({}) }; } };
  await handler(req({ agency_id: 'agency-1', agency_email_id: 'email-1' }), res, { createClient, gmailDeps });
  assert.equal(res._calls.status, 400);
  assert.equal(gmailCalled, false);
}));

test('[validate] missing body fails before any Gmail call', () => withEnv(async () => {
  let gmailCalled = false;
  const createClient = fakeCreateClientFactory({
    script: { staff_users: STAFF_ADMIN_ACTIVE, agencies: AGENCY_ADAY, agency_emails: [{ ...DRAFT_ROW[0], body: '   ' }] },
  });
  const res = fakeRes();
  const gmailDeps = { fetch: async () => { gmailCalled = true; return { ok: true, json: async () => ({}) }; } };
  await handler(req({ agency_id: 'agency-1', agency_email_id: 'email-1' }), res, { createClient, gmailDeps });
  assert.equal(res._calls.status, 400);
  assert.equal(gmailCalled, false);
}));

test('[validate] missing agency returns 404, never a crash', () => withEnv(async () => {
  const createClient = fakeCreateClientFactory({
    script: { staff_users: STAFF_ADMIN_ACTIVE, agencies: [null] },
  });
  const res = fakeRes();
  await handler(req({ agency_id: 'agency-1', agency_email_id: 'email-1' }), res, { createClient });
  assert.equal(res._calls.status, 404);
}));

test('[validate] missing agency_id or agency_email_id in the request body is rejected immediately', () => withEnv(async () => {
  const createClient = fakeCreateClientFactory({ script: { staff_users: STAFF_ADMIN_ACTIVE } });
  const res = fakeRes();
  await handler(req({ agency_id: 'agency-1' }), res, { createClient });
  assert.equal(res._calls.status, 400);
}));

test('[validate] never trusts a browser-supplied sender/role/status/provider id field — only agency_id/agency_email_id are read from the body', () => {
  const src = require('fs').readFileSync(path.join(REPO_ROOT, 'api', 'agency-send-email.js'), 'utf8');
  for (const forbidden of ['body.from', 'body.sender', 'body.role', 'body.status', 'body.provider', 'body.staff_id', 'body.created_by']) {
    assert.doesNotMatch(src, new RegExp(forbidden.replace('.', '\\.')));
  }
});

// ── C. Already-sent idempotency ──────────────────────────────────────────

test('[idempotent] an already-sent row returns a safe deterministic response, never a second send', () => withEnv(async () => {
  let gmailCalled = false;
  const createClient = fakeCreateClientFactory({
    script: { staff_users: STAFF_ADMIN_ACTIVE, agencies: AGENCY_ADAY, agency_emails: [{ ...DRAFT_ROW[0], status: 'sent', sent_at: '2026-01-01T00:00:00Z', provider_message_id: 'gm-old' }] },
  });
  const res = fakeRes();
  const gmailDeps = { fetch: async () => { gmailCalled = true; return { ok: true, json: async () => ({}) }; } };
  await handler(req({ agency_id: 'agency-1', agency_email_id: 'email-1' }), res, { createClient, gmailDeps });
  assert.equal(res._calls.status, 200);
  assert.equal(res._calls.json.alreadySent, true);
  assert.equal(res._calls.json.status, 'sent');
  assert.equal(gmailCalled, false);
}));

test('[idempotent] claim failing (already claimed/processed) returns 409, never attempts Gmail', () => withEnv(async () => {
  let gmailCalled = false;
  const createClient = fakeCreateClientFactory({
    script: { staff_users: STAFF_ADMIN_ACTIVE, agencies: AGENCY_ADAY, agency_emails: [DRAFT_ROW[0], null] }, // validate ok, claim returns no row
  });
  const res = fakeRes();
  const gmailDeps = { fetch: async () => { gmailCalled = true; return { ok: true, json: async () => ({}) }; } };
  await handler(req({ agency_id: 'agency-1', agency_email_id: 'email-1' }), res, { createClient, gmailDeps });
  assert.equal(res._calls.status, 409);
  assert.equal(gmailCalled, false);
}));

// ── D. Successful send — persistence + agency state + activity log ─────

test('[success] persists provider_message_id, provider_thread_id, status=sent, sent_at only after Gmail accepts', () => withEnv(async () => {
  let capturedUpdate = null;
  const createClient = fakeCreateClientFactory({
    script: {
      staff_users: STAFF_ADMIN_ACTIVE,
      agencies: [AGENCY_ADAY[0], { status: 'Aday' }],
      agency_emails: [DRAFT_ROW[0], { ...DRAFT_ROW[0], send_claimed_at: new Date().toISOString() }],
    },
  });
  const wrapped = () => {
    const c = createClient();
    const origFrom = c.from;
    c.from = (table) => {
      const builder = origFrom(table);
      if (table === 'agency_emails') {
        const origUpdate = builder.update;
        builder.update = (patch) => { if (patch.status === 'sent') capturedUpdate = patch; return origUpdate(patch); };
      }
      return builder;
    };
    return c;
  };
  const res = fakeRes();
  await handler(req({ agency_id: 'agency-1', agency_email_id: 'email-1' }), res, { createClient: wrapped, gmailDeps: fakeGmailDepsSuccess({ gmailMessageId: 'gm-42', gmailThreadId: 'th-42', messageIdHeader: '<real@mail.gmail.com>' }) });
  assert.equal(res._calls.status, 200);
  assert.ok(capturedUpdate, 'expected a status=sent update to have been issued');
  assert.equal(capturedUpdate.provider, 'gmail');
  assert.equal(capturedUpdate.provider_message_id, 'gm-42');
  assert.equal(capturedUpdate.provider_thread_id, 'th-42');
  assert.equal(capturedUpdate.internet_message_id, '<real@mail.gmail.com>');
  assert.ok(capturedUpdate.sent_at);
  assert.equal(capturedUpdate.to_email, 'acente@example.com');
  assert.equal(capturedUpdate.from_email, 'hello@desetour.com');
}));

test('[success] Aday moves to İletişime Geçildi only after a successful send', () => withEnv(async () => {
  let capturedAgencyPatch = null;
  const createClient = fakeCreateClientFactory({
    script: { staff_users: STAFF_ADMIN_ACTIVE, agencies: [{ id: 'agency-1', email: 'acente@example.com', status: 'Aday' }, { status: 'Aday' }], agency_emails: [DRAFT_ROW[0], { ...DRAFT_ROW[0], send_claimed_at: new Date().toISOString() }] },
  });
  const wrapped = () => {
    const c = createClient();
    const origFrom = c.from;
    c.from = (table) => {
      const builder = origFrom(table);
      if (table === 'agencies') {
        const origUpdate = builder.update;
        builder.update = (patch) => { capturedAgencyPatch = patch; return origUpdate(patch); };
      }
      return builder;
    };
    return c;
  };
  const res = fakeRes();
  await handler(req({ agency_id: 'agency-1', agency_email_id: 'email-1' }), res, { createClient: wrapped, gmailDeps: fakeGmailDepsSuccess() });
  assert.equal(res._calls.status, 200);
  assert.ok(capturedAgencyPatch);
  assert.equal(capturedAgencyPatch.status, 'İletişime Geçildi');
  assert.ok(capturedAgencyPatch.last_contact_at);
}));

for (const advancedStatus of ['Görüşülüyor', 'Partner', 'Uygun Değil']) {
  test(`[success] advanced agency status "${advancedStatus}" is never overwritten by a successful send`, () => withEnv(async () => {
    let capturedAgencyPatch = null;
    const createClient = fakeCreateClientFactory({
      script: { staff_users: STAFF_ADMIN_ACTIVE, agencies: [{ id: 'agency-1', email: 'acente@example.com', status: advancedStatus }, { status: advancedStatus }], agency_emails: [DRAFT_ROW[0], { ...DRAFT_ROW[0], send_claimed_at: new Date().toISOString() }] },
    });
    const wrapped = () => {
      const c = createClient();
      const origFrom = c.from;
      c.from = (table) => {
        const builder = origFrom(table);
        if (table === 'agencies') {
          const origUpdate = builder.update;
          builder.update = (patch) => { capturedAgencyPatch = patch; return origUpdate(patch); };
        }
        return builder;
      };
      return c;
    };
    const res = fakeRes();
    await handler(req({ agency_id: 'agency-1', agency_email_id: 'email-1' }), res, { createClient: wrapped, gmailDeps: fakeGmailDepsSuccess() });
    assert.equal(res._calls.status, 200);
    assert.ok(capturedAgencyPatch);
    assert.equal(capturedAgencyPatch.status, undefined, 'status key must not even be present in the patch — never downgraded/rewritten');
    assert.ok(capturedAgencyPatch.last_contact_at);
  }));
}

test('[success] writes exactly one activity_logs row, entity_type=agency_email, action=outreach_sent, no email body in it', () => withEnv(async () => {
  let capturedInsert = null;
  const createClient = fakeCreateClientFactory({
    script: { staff_users: STAFF_ADMIN_ACTIVE, agencies: [AGENCY_ADAY[0], { status: 'Aday' }], agency_emails: [DRAFT_ROW[0], { ...DRAFT_ROW[0], send_claimed_at: new Date().toISOString() }] },
  });
  const wrapped = () => {
    const c = createClient();
    const origFrom = c.from;
    c.from = (table) => {
      const builder = origFrom(table);
      if (table === 'activity_logs') {
        const origInsert = builder.insert;
        builder.insert = (row) => { capturedInsert = row; return origInsert(row); };
      }
      return builder;
    };
    return c;
  };
  const res = fakeRes();
  await handler(req({ agency_id: 'agency-1', agency_email_id: 'email-1' }), res, { createClient: wrapped, gmailDeps: fakeGmailDepsSuccess() });
  assert.equal(res._calls.status, 200);
  assert.ok(capturedInsert);
  assert.equal(capturedInsert.entity_type, 'agency_email');
  assert.equal(capturedInsert.action, 'outreach_sent');
  assert.doesNotMatch(JSON.stringify(capturedInsert), /Gövde metni/);
}));

// ── E. Failure safety ────────────────────────────────────────────────────

test('[failure] Gmail rejection before acceptance: not marked sent, agency untouched, claim released, clear Turkish error', () => withEnv(async () => {
  let agencyTouched = false;
  let releasedClaim = null;
  const createClient = fakeCreateClientFactory({
    script: { staff_users: STAFF_ADMIN_ACTIVE, agencies: AGENCY_ADAY, agency_emails: [DRAFT_ROW[0], { ...DRAFT_ROW[0], send_claimed_at: new Date().toISOString() }] },
  });
  const wrapped = () => {
    const c = createClient();
    const origFrom = c.from;
    c.from = (table) => {
      const builder = origFrom(table);
      if (table === 'agencies') {
        const origUpdate = builder.update;
        builder.update = (patch) => { agencyTouched = true; return origUpdate(patch); };
      }
      if (table === 'agency_emails') {
        const origUpdate = builder.update;
        builder.update = (patch) => { if (patch.send_claimed_at === null) releasedClaim = true; return origUpdate(patch); };
      }
      return builder;
    };
    return c;
  };
  const res = fakeRes();
  await handler(req({ agency_id: 'agency-1', agency_email_id: 'email-1' }), res, { createClient: wrapped, gmailDeps: fakeGmailDepsRejected() });
  assert.equal(res._calls.status, 502);
  assert.match(res._calls.json.error, /[a-zA-Z]/); // a real Turkish message is present
  assert.ok(!/<[a-z]/i.test(res._calls.json.error)); // never raw HTML/stack text
  assert.equal(agencyTouched, false);
  assert.equal(releasedClaim, true);
}));

test('[failure] Gmail accepted but persistence failed: distinct reconciliation_required stage, provider ids surfaced, no email body logged', () => withEnv(async () => {
  const createClient = fakeCreateClientFactory({
    script: {
      staff_users: STAFF_ADMIN_ACTIVE, agencies: AGENCY_ADAY,
      agency_emails: [DRAFT_ROW[0], { ...DRAFT_ROW[0], send_claimed_at: new Date().toISOString() }, { data: null, error: { message: 'db write failed' } }],
    },
  });
  const res = fakeRes();
  await handler(req({ agency_id: 'agency-1', agency_email_id: 'email-1' }), res, { createClient, gmailDeps: fakeGmailDepsSuccess({ gmailMessageId: 'gm-99', gmailThreadId: 'th-99' }) });
  assert.equal(res._calls.status, 500);
  assert.equal(res._calls.json.stage, 'reconciliation_required');
  assert.equal(res._calls.json.providerMessageId, 'gm-99');
  assert.equal(res._calls.json.providerThreadId, 'th-99');
}));

test('[failure] a non-critical agency-state-advance failure after a successful send is a soft warning, not an error', () => withEnv(async () => {
  const createClient = fakeCreateClientFactory({
    script: {
      staff_users: STAFF_ADMIN_ACTIVE,
      agencies: [AGENCY_ADAY[0], { data: null, error: { message: 'read failed' } }],
      agency_emails: [DRAFT_ROW[0], { ...DRAFT_ROW[0], send_claimed_at: new Date().toISOString() }],
    },
  });
  const res = fakeRes();
  await handler(req({ agency_id: 'agency-1', agency_email_id: 'email-1' }), res, { createClient, gmailDeps: fakeGmailDepsSuccess() });
  assert.equal(res._calls.status, 200);
  assert.ok(res._calls.json.warning);
}));

// ── F. requireAgencyRole reuse, unmodified ──────────────────────────────

test('[auth] this endpoint imports requireAgencyRole from the unmodified authorize module', () => {
  const src = require('fs').readFileSync(path.join(REPO_ROOT, 'api', 'agency-send-email.js'), 'utf8');
  assert.match(src, /require\(['"]\.\/_agencies\/authorize['"]\)/);
  assert.match(src, /requireAgencyRole\(req/);
});

test('[auth] api/_agencies/authorize.js ALLOWED_ROLES is unchanged by this phase — still exactly [admin, sales]', () => {
  const { ALLOWED_ROLES } = require(path.join(REPO_ROOT, 'api', '_agencies', 'authorize'));
  assert.deepEqual(ALLOWED_ROLES, ['admin', 'sales']);
});

// ── G. Agency Mailbox Phase 7 (hardened) — explicit reply (loadReplyContext) ──
// A richer, fully-chainable fake builder (adds .not/.order/.limit on top of
// the shared makeThenable above) used ONLY in this section, so none of the
// pre-existing tests above — which rely on the shared builder's graceful
// "missing chain method throws, caught as a non-fatal null fallback"
// behavior — are affected by adding these methods.
function makeFullThenable(result) {
  const obj = {
    select() { return obj; }, update() { return obj; }, insert() { return obj; },
    eq() { return obj; }, is() { return obj; }, not() { return obj; }, order() { return obj; }, limit() { return obj; },
    maybeSingle() { return obj; },
    then(resolve, reject) { return Promise.resolve(result).then(resolve, reject); },
    catch(fn) { return Promise.resolve(result).catch(fn); },
  };
  return obj;
}

test('loadReplyContext returns null (never fabricated data) when the selected row does not exist', async () => {
  const adminClient = { from: () => makeFullThenable({ data: null, error: null }) };
  const result = await handler.loadReplyContext({ adminClient, agencyId: 'agency-1', replyToAgencyEmailId: 'email-missing' });
  assert.equal(result, null);
});

test('loadReplyContext returns null when the selected row belongs to a DIFFERENT agency — never trusts a mismatched reply target', async () => {
  const adminClient = { from: () => makeFullThenable({ data: { id: 'email-1', agency_id: 'agency-OTHER', provider_thread_id: 'th-existing', internet_message_id: '<x@mail.gmail.com>', in_reply_to: null }, error: null }) };
  const result = await handler.loadReplyContext({ adminClient, agencyId: 'agency-1', replyToAgencyEmailId: 'email-1' });
  assert.equal(result, null);
});

test('loadReplyContext returns null when the selected row has no stored provider_thread_id at all — not a valid conversation context', async () => {
  const adminClient = { from: () => makeFullThenable({ data: { id: 'email-1', agency_id: 'agency-1', provider_thread_id: null, internet_message_id: '<x@mail.gmail.com>', in_reply_to: null }, error: null }) };
  const result = await handler.loadReplyContext({ adminClient, agencyId: 'agency-1', replyToAgencyEmailId: 'email-1' });
  assert.equal(result, null);
});

test('loadReplyContext derives threadId/inReplyTo/references from the SELECTED row\'s own stored fields when everything matches', async () => {
  const adminClient = { from: () => makeFullThenable({ data: { id: 'email-1', agency_id: 'agency-1', provider_thread_id: 'th-selected', internet_message_id: '<selected@mail.gmail.com>', in_reply_to: '<earlier@mail.gmail.com>' }, error: null }) };
  const result = await handler.loadReplyContext({ adminClient, agencyId: 'agency-1', replyToAgencyEmailId: 'email-1' });
  assert.equal(result.threadId, 'th-selected');
  assert.equal(result.inReplyTo, '<selected@mail.gmail.com>');
  assert.equal(result.references, '<earlier@mail.gmail.com> <selected@mail.gmail.com>');
});

test('loadReplyContext still returns a usable context (threadId only) when the selected row has no internet_message_id — same tolerance this module has always had', async () => {
  const adminClient = { from: () => makeFullThenable({ data: { id: 'email-1', agency_id: 'agency-1', provider_thread_id: 'th-selected', internet_message_id: null, in_reply_to: null }, error: null }) };
  const result = await handler.loadReplyContext({ adminClient, agencyId: 'agency-1', replyToAgencyEmailId: 'email-1' });
  assert.equal(result.threadId, 'th-selected');
  assert.equal(result.inReplyTo, null);
  assert.equal(result.references, null);
});

test('loadReplyContext looks up by the row\'s id — the SELECTED conversation, never "most recent"', async () => {
  const calls = [];
  const adminClient = {
    from(table) {
      calls.push({ table, ops: [] });
      const record = calls[calls.length - 1];
      const obj = {
        select(cols) { record.ops.push(['select', cols]); return obj; },
        eq(col, val) { record.ops.push(['eq', col, val]); return obj; },
        maybeSingle() { return Promise.resolve({ data: { id: 'email-77', agency_id: 'agency-77', provider_thread_id: 'th-77', internet_message_id: null, in_reply_to: null }, error: null }); },
      };
      return obj;
    },
  };
  await handler.loadReplyContext({ adminClient, agencyId: 'agency-77', replyToAgencyEmailId: 'email-77' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].table, 'agency_emails');
  assert.deepEqual(calls[0].ops.find(o => o[0] === 'eq'), ['eq', 'id', 'email-77']);
  // Never an .order(...).limit(1) "pick the newest" pattern — this test
  // would fail to compile that assumption in since the fake builder here
  // has no .order/.limit at all, matching loadReplyContext's own real
  // query shape (select -> eq(id) -> maybeSingle, nothing else).
});

test('loadReplyContext throws on a real query error — the caller\'s own .catch() is what makes this non-fatal, not this function swallowing it', async () => {
  const adminClient = { from: () => makeFullThenable({ data: null, error: { message: 'db unavailable' } }) };
  let caught = null;
  try { await handler.loadReplyContext({ adminClient, agencyId: 'agency-1', replyToAgencyEmailId: 'email-1' }); } catch (err) { caught = err; }
  assert.ok(caught);
  assert.equal(caught.message, 'db unavailable');
});

// ── G2. send_mode: 'new_outreach' vs 'reply' (hardened Phase 7) ─────────
// Thread continuation is now used ONLY for an EXPLICIT send_mode:'reply'
// — never inferred merely from an old thread existing. 'new_outreach'
// (the default, and the only value the single existing Send flow has
// ever sent) never even looks the thread up. 'reply' REQUIRES a
// resolvable thread context or the whole request fails closed (409),
// before Gmail is ever called — it must never silently fall back to a
// new thread just because the lookup came back empty or failed.

test('[new_outreach] an explicit send_mode:"new_outreach" never looks up or attaches to a thread — a fresh Gmail thread, exactly as before Phase 7 ever existed', () => withEnv(async () => {
  const createClient = fakeCreateClientFactory({
    script: { staff_users: STAFF_ADMIN_ACTIVE, agencies: [AGENCY_ADAY[0], { status: 'Aday' }], agency_emails: [DRAFT_ROW[0], { ...DRAFT_ROW[0], send_claimed_at: new Date().toISOString() }] },
  });
  let capturedBody = null;
  const gmailDeps = {
    fetch: async (url, opts) => {
      if (String(url).includes('oauth2.googleapis.com')) return { ok: true, json: async () => ({ access_token: 'tok', expires_in: 3600 }) };
      if (String(url).includes('/send')) { capturedBody = JSON.parse(opts.body); return { ok: true, json: async () => ({ id: 'gm-fresh', threadId: 'th-fresh' }) }; }
      return { ok: true, json: async () => ({ payload: { headers: [] } }) };
    },
  };
  const res = fakeRes();
  await handler(req({ agency_id: 'agency-1', agency_email_id: 'email-1', send_mode: 'new_outreach' }), res, { createClient, gmailDeps });
  assert.equal(res._calls.status, 200);
  assert.ok(capturedBody);
  assert.equal(capturedBody.threadId, undefined);
  const decoded = Buffer.from(capturedBody.raw.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
  assert.doesNotMatch(decoded, /In-Reply-To:/);
  assert.doesNotMatch(decoded, /References:/);
}));

test('[new_outreach] omitting send_mode entirely defaults to new_outreach — the one existing Send flow\'s behavior is unchanged', () => withEnv(async () => {
  const createClient = fakeCreateClientFactory({
    script: { staff_users: STAFF_ADMIN_ACTIVE, agencies: [AGENCY_ADAY[0], { status: 'Aday' }], agency_emails: [DRAFT_ROW[0], { ...DRAFT_ROW[0], send_claimed_at: new Date().toISOString() }] },
  });
  let capturedBody = null;
  const gmailDeps = fakeGmailDepsSuccess({ gmailMessageId: 'gm-default', gmailThreadId: 'th-default' });
  const wrapped = () => {
    const c = createClient();
    const origSend = gmailDeps.fetch;
    gmailDeps.fetch = async (url, opts) => { if (String(url).includes('/send')) capturedBody = JSON.parse(opts.body); return origSend(url, opts); };
    return c;
  };
  const res = fakeRes();
  await handler(req({ agency_id: 'agency-1', agency_email_id: 'email-1' }), res, { createClient: wrapped, gmailDeps });
  assert.equal(res._calls.status, 200);
  assert.ok(capturedBody);
  assert.equal(capturedBody.threadId, undefined, 'no send_mode given must behave exactly like new_outreach — never silently attach to a thread');
}));

test('[new_outreach] never auto-attaches to an old thread even when one genuinely exists for this agency — attaching now requires an EXPLICIT send_mode:"reply"', () => withEnv(async () => {
  // A successful new_outreach send touches agency_emails exactly 3 times:
  // 1) loadAndValidate's select, 2) claimDraftForSending's update, 3)
  // persistSentEmail's update. If findExistingThreadContext were (wrongly)
  // still being called, that would be a 4th agency_emails call — counting
  // calls, rather than relying on the shared fake builder having (or
  // lacking) a .not( method, is what actually proves the lookup itself
  // never happened, not just that one of its internal calls failed.
  let agencyEmailsCallCount = 0;
  const createClient = fakeCreateClientFactory({
    script: { staff_users: STAFF_ADMIN_ACTIVE, agencies: [AGENCY_ADAY[0], { status: 'Aday' }], agency_emails: [DRAFT_ROW[0], { ...DRAFT_ROW[0], send_claimed_at: new Date().toISOString() }] },
  });
  const wrapped = () => {
    const c = createClient();
    const origFrom = c.from;
    c.from = (table) => { if (table === 'agency_emails') agencyEmailsCallCount += 1; return origFrom(table); };
    return c;
  };
  let capturedBody = null;
  const gmailDeps = {
    fetch: async (url, opts) => {
      if (String(url).includes('oauth2.googleapis.com')) return { ok: true, json: async () => ({ access_token: 'tok', expires_in: 3600 }) };
      if (String(url).includes('/send')) { capturedBody = JSON.parse(opts.body); return { ok: true, json: async () => ({ id: 'gm-fresh2', threadId: 'th-fresh2' }) }; }
      return { ok: true, json: async () => ({ payload: { headers: [] } }) };
    },
  };
  const res = fakeRes();
  await handler(req({ agency_id: 'agency-1', agency_email_id: 'email-1', send_mode: 'new_outreach' }), res, { createClient: wrapped, gmailDeps });
  assert.equal(res._calls.status, 200);
  assert.equal(agencyEmailsCallCount, 3, 'expected exactly 3 agency_emails calls (validate, claim, persist) — a 4th would mean a thread lookup was wrongly attempted');
  assert.equal(capturedBody.threadId, undefined);
}));

test('[reply] an existing Gmail thread is continued: threadId reaches the Gmail send body, and In-Reply-To/References carry the selected message\'s own Message-Id', () => withEnv(async () => {
  const createClient = fakeCreateClientFactory({
    script: { staff_users: STAFF_ADMIN_ACTIVE, agencies: [AGENCY_ADAY[0], { status: 'Aday' }], agency_emails: [DRAFT_ROW[0], { ...DRAFT_ROW[0], send_claimed_at: new Date().toISOString() }] },
  });
  const wrapped = () => {
    const c = createClient();
    const origFrom = c.from;
    let agencyEmailsCalls = 0;
    // Call order on agency_emails for a successful reply send: 1) loadAndValidate's
    // select, 2) claimDraftForSending's update, 3) loadReplyContext's
    // select-by-id (THIS is the one to fake), 4) persistSentEmail's update.
    c.from = (table) => {
      if (table !== 'agency_emails') return origFrom(table);
      agencyEmailsCalls += 1;
      return agencyEmailsCalls === 3
        ? makeFullThenable({ data: { id: 'email-inbound-1', agency_id: 'agency-1', provider_thread_id: 'th-continuing', internet_message_id: '<prior@mail.gmail.com>', in_reply_to: null }, error: null })
        : origFrom(table);
    };
    return c;
  };
  let capturedBody = null;
  const gmailDeps = {
    fetch: async (url, opts) => {
      if (String(url).includes('oauth2.googleapis.com')) return { ok: true, json: async () => ({ access_token: 'tok', expires_in: 3600 }) };
      if (String(url).includes('/send')) { capturedBody = JSON.parse(opts.body); return { ok: true, json: async () => ({ id: 'gm-continuing', threadId: 'th-continuing' }) }; }
      return { ok: true, json: async () => ({ payload: { headers: [] } }) };
    },
  };
  const res = fakeRes();
  await handler(req({ agency_id: 'agency-1', agency_email_id: 'email-1', send_mode: 'reply', reply_to_agency_email_id: 'email-inbound-1' }), res, { createClient: wrapped, gmailDeps });
  assert.equal(res._calls.status, 200);
  assert.ok(capturedBody, 'expected the Gmail send call to have happened');
  assert.equal(capturedBody.threadId, 'th-continuing');
  const decoded = Buffer.from(capturedBody.raw.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
  assert.match(decoded, /In-Reply-To: <prior@mail\.gmail\.com>/);
  assert.match(decoded, /References: <prior@mail\.gmail\.com>/);
}));

test('[reply] an agency with TWO different Gmail threads: replying to the selected (older) one never picks the newest instead', () => withEnv(async () => {
  const createClient = fakeCreateClientFactory({
    script: { staff_users: STAFF_ADMIN_ACTIVE, agencies: [AGENCY_ADAY[0], { status: 'Aday' }], agency_emails: [DRAFT_ROW[0], { ...DRAFT_ROW[0], send_claimed_at: new Date().toISOString() }] },
  });
  const wrapped = () => {
    const c = createClient();
    const origFrom = c.from;
    let agencyEmailsCalls = 0;
    c.from = (table) => {
      if (table !== 'agency_emails') return origFrom(table);
      agencyEmailsCalls += 1;
      // The lookup is by id, not "most recent" — this row (the one the
      // test selects) is the OLDER of the agency's two threads, yet it
      // must still be the one used, proving recency is never consulted.
      return agencyEmailsCalls === 3
        ? makeFullThenable({ data: { id: 'email-older-thread', agency_id: 'agency-1', provider_thread_id: 'th-older', internet_message_id: '<older@mail.gmail.com>', in_reply_to: null }, error: null })
        : origFrom(table);
    };
    return c;
  };
  let capturedBody = null;
  const gmailDeps = {
    fetch: async (url, opts) => {
      if (String(url).includes('oauth2.googleapis.com')) return { ok: true, json: async () => ({ access_token: 'tok', expires_in: 3600 }) };
      if (String(url).includes('/send')) { capturedBody = JSON.parse(opts.body); return { ok: true, json: async () => ({ id: 'gm-older', threadId: 'th-older' }) }; }
      return { ok: true, json: async () => ({ payload: { headers: [] } }) };
    },
  };
  const res = fakeRes();
  await handler(req({ agency_id: 'agency-1', agency_email_id: 'email-1', send_mode: 'reply', reply_to_agency_email_id: 'email-older-thread' }), res, { createClient: wrapped, gmailDeps });
  assert.equal(res._calls.status, 200);
  assert.equal(capturedBody.threadId, 'th-older', 'must attach to the explicitly selected thread, never a different (e.g. newer) one for the same agency');
}));

test('[reply] a MISSING reply_to_agency_email_id fails closed with the same safe Turkish message — the lookup is never even attempted without it', () => withEnv(async () => {
  const createClient = fakeCreateClientFactory({
    script: { staff_users: STAFF_ADMIN_ACTIVE, agencies: [AGENCY_ADAY[0], { status: 'Aday' }], agency_emails: [DRAFT_ROW[0], { ...DRAFT_ROW[0], send_claimed_at: new Date().toISOString() }] },
  });
  let agencyEmailsCallsAfterClaim = 0;
  const wrapped = () => {
    const c = createClient();
    const origFrom = c.from;
    let agencyEmailsCalls = 0;
    c.from = (table) => {
      if (table !== 'agency_emails') return origFrom(table);
      agencyEmailsCalls += 1;
      if (agencyEmailsCalls > 2) agencyEmailsCallsAfterClaim += 1;
      return origFrom(table);
    };
    return c;
  };
  let gmailSendCalled = false;
  const gmailDeps = { fetch: async (url) => {
    if (String(url).includes('/send')) gmailSendCalled = true;
    return { ok: true, json: async () => ({ access_token: 'tok', expires_in: 3600 }) };
  } };
  const res = fakeRes();
  await handler(req({ agency_id: 'agency-1', agency_email_id: 'email-1', send_mode: 'reply' }), res, { createClient: wrapped, gmailDeps });
  assert.equal(res._calls.status, 409);
  assert.equal(res._calls.json.error, 'Bu e-posta konuşmasının yanıt bilgileri bulunamadı. Mesaj gönderilmedi.');
  assert.equal(res._calls.json.stage, 'reply_thread_context_unresolved');
  // The claim release IS the one extra agency_emails call after claim —
  // no reply-context SELECT is attempted when there is no id to look up.
  assert.equal(agencyEmailsCallsAfterClaim, 1);
  assert.equal(gmailSendCalled, false);
}));

test('[reply] a NOT-FOUND reply_to_agency_email_id (no such row) fails closed with the same safe Turkish message — never silently sends as a new thread', () => withEnv(async () => {
  const createClient = fakeCreateClientFactory({
    script: { staff_users: STAFF_ADMIN_ACTIVE, agencies: [AGENCY_ADAY[0], { status: 'Aday' }], agency_emails: [DRAFT_ROW[0], { ...DRAFT_ROW[0], send_claimed_at: new Date().toISOString() }] },
  });
  const wrapped = () => {
    const c = createClient();
    const origFrom = c.from;
    let agencyEmailsCalls = 0;
    c.from = (table) => {
      if (table !== 'agency_emails') return origFrom(table);
      agencyEmailsCalls += 1;
      return agencyEmailsCalls === 3
        ? makeFullThenable({ data: null, error: null })
        : origFrom(table);
    };
    return c;
  };
  let gmailSendCalled = false;
  const gmailDeps = { fetch: async (url) => {
    if (String(url).includes('/send')) gmailSendCalled = true;
    return { ok: true, json: async () => ({ access_token: 'tok', expires_in: 3600 }) };
  } };
  const res = fakeRes();
  await handler(req({ agency_id: 'agency-1', agency_email_id: 'email-1', send_mode: 'reply', reply_to_agency_email_id: 'email-does-not-exist' }), res, { createClient: wrapped, gmailDeps });
  assert.equal(res._calls.status, 409);
  assert.equal(res._calls.json.error, 'Bu e-posta konuşmasının yanıt bilgileri bulunamadı. Mesaj gönderilmedi.');
  assert.equal(res._calls.json.stage, 'reply_thread_context_unresolved');
  assert.equal(gmailSendCalled, false, 'Gmail must never be called when an explicit reply has no resolvable thread context');
}));

test('[reply][security] a reply_to_agency_email_id belonging to a DIFFERENT agency is rejected, exactly like "not found" — never cross-agency reply', () => withEnv(async () => {
  const createClient = fakeCreateClientFactory({
    script: { staff_users: STAFF_ADMIN_ACTIVE, agencies: [AGENCY_ADAY[0], { status: 'Aday' }], agency_emails: [DRAFT_ROW[0], { ...DRAFT_ROW[0], send_claimed_at: new Date().toISOString() }] },
  });
  const wrapped = () => {
    const c = createClient();
    const origFrom = c.from;
    let agencyEmailsCalls = 0;
    c.from = (table) => {
      if (table !== 'agency_emails') return origFrom(table);
      agencyEmailsCalls += 1;
      // A real row exists, with a real thread — but it belongs to a
      // DIFFERENT agency than the one this request is sending for.
      return agencyEmailsCalls === 3
        ? makeFullThenable({ data: { id: 'email-other-agency', agency_id: 'agency-SOMEONE-ELSE', provider_thread_id: 'th-not-yours', internet_message_id: '<x@mail.gmail.com>', in_reply_to: null }, error: null })
        : origFrom(table);
    };
    return c;
  };
  let gmailSendCalled = false;
  const gmailDeps = { fetch: async (url) => {
    if (String(url).includes('/send')) gmailSendCalled = true;
    return { ok: true, json: async () => ({ access_token: 'tok', expires_in: 3600 }) };
  } };
  const res = fakeRes();
  await handler(req({ agency_id: 'agency-1', agency_email_id: 'email-1', send_mode: 'reply', reply_to_agency_email_id: 'email-other-agency' }), res, { createClient: wrapped, gmailDeps });
  assert.equal(res._calls.status, 409);
  assert.equal(res._calls.json.stage, 'reply_thread_context_unresolved');
  assert.doesNotMatch(JSON.stringify(res._calls.json), /agency-SOMEONE-ELSE|th-not-yours/, 'never leak another agency\'s identifiers in the error response');
  assert.equal(gmailSendCalled, false);
}));

test('[reply] a thread-lookup failure (DB error) ALSO fails closed — never silently falls back to a new thread for an explicit reply', () => withEnv(async () => {
  const createClient = fakeCreateClientFactory({
    script: { staff_users: STAFF_ADMIN_ACTIVE, agencies: [AGENCY_ADAY[0], { status: 'Aday' }], agency_emails: [DRAFT_ROW[0], { ...DRAFT_ROW[0], send_claimed_at: new Date().toISOString() }] },
  });
  const wrapped = () => {
    const c = createClient();
    const origFrom = c.from;
    let agencyEmailsCalls = 0;
    c.from = (table) => {
      if (table !== 'agency_emails') return origFrom(table);
      agencyEmailsCalls += 1;
      return agencyEmailsCalls === 3
        ? makeFullThenable({ data: null, error: { message: 'db unavailable' } })
        : origFrom(table);
    };
    return c;
  };
  let gmailSendCalled = false;
  const gmailDeps = { fetch: async (url) => {
    if (String(url).includes('/send')) gmailSendCalled = true;
    return { ok: true, json: async () => ({ access_token: 'tok', expires_in: 3600 }) };
  } };
  const res = fakeRes();
  await handler(req({ agency_id: 'agency-1', agency_email_id: 'email-1', send_mode: 'reply', reply_to_agency_email_id: 'email-inbound-1' }), res, { createClient: wrapped, gmailDeps });
  assert.equal(res._calls.status, 409);
  assert.equal(res._calls.json.stage, 'reply_thread_context_unresolved');
  assert.doesNotMatch(JSON.stringify(res._calls.json), /db unavailable/, 'the raw database error must never reach the response body');
  assert.equal(gmailSendCalled, false);
}));

test('[reply] the claim is released on a failed-closed reply rejection, so the draft can be retried', () => withEnv(async () => {
  let releasedPatch = null;
  const createClient = fakeCreateClientFactory({
    script: { staff_users: STAFF_ADMIN_ACTIVE, agencies: [AGENCY_ADAY[0], { status: 'Aday' }], agency_emails: [DRAFT_ROW[0], { ...DRAFT_ROW[0], send_claimed_at: new Date().toISOString() }] },
  });
  const wrapped = () => {
    const c = createClient();
    const origFrom = c.from;
    let agencyEmailsCalls = 0;
    c.from = (table) => {
      if (table !== 'agency_emails') return origFrom(table);
      agencyEmailsCalls += 1;
      if (agencyEmailsCalls === 3) return makeFullThenable({ data: null, error: null });
      const builder = origFrom(table);
      const origUpdate = builder.update;
      builder.update = (patch) => { if (patch.send_claimed_at === null) releasedPatch = patch; return origUpdate(patch); };
      return builder;
    };
    return c;
  };
  const res = fakeRes();
  await handler(req({ agency_id: 'agency-1', agency_email_id: 'email-1', send_mode: 'reply', reply_to_agency_email_id: 'email-inbound-1' }), res, { createClient: wrapped, gmailDeps: {} });
  assert.equal(res._calls.status, 409);
  assert.ok(releasedPatch, 'expected the claim to be released (send_claimed_at reset to null) after the failed-closed rejection');
}));

test('[security] a browser-supplied thread/message id in the request body is never used — an explicit reply\'s thread is derived ONLY from the server-side lookup by reply_to_agency_email_id', () => withEnv(async () => {
  const createClient = fakeCreateClientFactory({
    script: { staff_users: STAFF_ADMIN_ACTIVE, agencies: [AGENCY_ADAY[0], { status: 'Aday' }], agency_emails: [DRAFT_ROW[0], { ...DRAFT_ROW[0], send_claimed_at: new Date().toISOString() }] },
  });
  const wrapped = () => {
    const c = createClient();
    const origFrom = c.from;
    let agencyEmailsCalls = 0;
    c.from = (table) => {
      if (table !== 'agency_emails') return origFrom(table);
      agencyEmailsCalls += 1;
      return agencyEmailsCalls === 3
        ? makeFullThenable({ data: { id: 'email-inbound-1', agency_id: 'agency-1', provider_thread_id: 'th-real-server-side', internet_message_id: '<real@mail.gmail.com>', in_reply_to: null }, error: null })
        : origFrom(table);
    };
    return c;
  };
  let capturedBody = null;
  const gmailDeps = {
    fetch: async (url, opts) => {
      if (String(url).includes('oauth2.googleapis.com')) return { ok: true, json: async () => ({ access_token: 'tok', expires_in: 3600 }) };
      if (String(url).includes('/send')) { capturedBody = JSON.parse(opts.body); return { ok: true, json: async () => ({ id: 'gm-x', threadId: 'th-real-server-side' }) }; }
      return { ok: true, json: async () => ({ payload: { headers: [] } }) };
    },
  };
  const res = fakeRes();
  await handler(req({
    agency_id: 'agency-1', agency_email_id: 'email-1', send_mode: 'reply', reply_to_agency_email_id: 'email-inbound-1',
    threadId: 'th-attacker-supplied', provider_thread_id: 'th-attacker-supplied', in_reply_to: '<attacker@evil.com>',
  }), res, { createClient: wrapped, gmailDeps });
  assert.equal(res._calls.status, 200);
  assert.equal(capturedBody.threadId, 'th-real-server-side');
  const decoded = Buffer.from(capturedBody.raw.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
  assert.doesNotMatch(decoded, /attacker/);
}));

test('[validate] an unrecognized send_mode value is rejected with 400 before any claim/Gmail/DB work happens', () => withEnv(async () => {
  const createClient = fakeCreateClientFactory({ script: { staff_users: STAFF_ADMIN_ACTIVE } });
  const res = fakeRes();
  await handler(req({ agency_id: 'agency-1', agency_email_id: 'email-1', send_mode: 'something-else' }), res, { createClient });
  assert.equal(res._calls.status, 400);
}));
