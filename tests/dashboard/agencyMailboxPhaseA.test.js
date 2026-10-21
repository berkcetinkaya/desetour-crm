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
