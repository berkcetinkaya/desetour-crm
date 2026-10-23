'use strict';
/**
 * tests/dashboard/agencyGmailInboundClient.test.js
 * ─────────────────────────────────────────────────────────────────────────
 * Agency Mailbox Phase 1/2/7 — the api/_agencies/gmailSendClient.js
 * additions for inbound sync: checkInboundBodyCapability, fetchMessageFull,
 * listHistory, getProfile, listMessageIdsByQuery, and sendMessage/
 * buildRawMimeMessage's new optional threadId/inReplyTo/references.
 * Every network call is injected via deps.fetch — no live network access.
 * ─────────────────────────────────────────────────────────────────────────
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const REPO_ROOT = path.join(__dirname, '..', '..');
const gmailSendClient = require(path.join(REPO_ROOT, 'api', '_agencies', 'gmailSendClient'));

async function withEnv(fn) {
  const keys = ['AGENCY_GMAIL_CLIENT_ID', 'AGENCY_GMAIL_CLIENT_SECRET', 'AGENCY_GMAIL_REFRESH_TOKEN', 'AGENCY_GMAIL_FROM'];
  const prev = {};
  for (const k of keys) prev[k] = process.env[k];
  process.env.AGENCY_GMAIL_CLIENT_ID = 'test-client-id';
  process.env.AGENCY_GMAIL_CLIENT_SECRET = 'test-client-secret';
  process.env.AGENCY_GMAIL_REFRESH_TOKEN = 'test-refresh-token';
  process.env.AGENCY_GMAIL_FROM = 'hello@desetour.com';
  gmailSendClient._resetAccessTokenCacheForTests();
  try { return await fn(); }
  finally {
    for (const k of keys) { if (prev[k] === undefined) delete process.env[k]; else process.env[k] = prev[k]; }
    gmailSendClient._resetAccessTokenCacheForTests();
  }
}

function okJson(body) {
  return { ok: true, json: async () => body, text: async () => JSON.stringify(body) };
}
function errResp(status, text = 'error') {
  return { ok: false, status, text: async () => text, json: async () => ({}) };
}
function tokenOrReal(url, real) {
  return async (u, opts) => {
    if (String(u).includes('oauth2.googleapis.com')) return okJson({ access_token: 'tok', expires_in: 3600 });
    return real(u, opts);
  };
}

// ═══════════════ Phase 1 — capability preflight ═══════════════════════════

test('checkInboundBodyCapability returns full_body_ok when format=full succeeds', () => withEnv(async () => {
  const fetchFn = tokenOrReal(null, async () => okJson({ id: 'gm-1', payload: { headers: [], mimeType: 'text/plain', body: { data: '' } } }));
  const result = await gmailSendClient.checkInboundBodyCapability({ sampleGmailMessageId: 'gm-1' }, { fetch: fetchFn });
  assert.deepEqual(result, { capability: 'full_body_ok' });
}));

test('checkInboundBodyCapability classifies Gmail\'s documented scope rejection as insufficient_scope', () => withEnv(async () => {
  const fetchFn = tokenOrReal(null, async () => errResp(400, "Metadata scope doesn't allow format FULL"));
  const result = await gmailSendClient.checkInboundBodyCapability({ sampleGmailMessageId: 'gm-1' }, { fetch: fetchFn });
  assert.equal(result.capability, 'insufficient_scope');
}));

test('checkInboundBodyCapability classifies a 403 insufficient-permission rejection as insufficient_scope too', () => withEnv(async () => {
  const fetchFn = tokenOrReal(null, async () => errResp(403, 'Request had insufficient authentication scopes.'));
  const result = await gmailSendClient.checkInboundBodyCapability({ sampleGmailMessageId: 'gm-1' }, { fetch: fetchFn });
  assert.equal(result.capability, 'insufficient_scope');
}));

test('checkInboundBodyCapability classifies an unrelated failure as unknown_error, never full_body_ok', () => withEnv(async () => {
  const fetchFn = tokenOrReal(null, async () => errResp(500, 'internal server error'));
  const result = await gmailSendClient.checkInboundBodyCapability({ sampleGmailMessageId: 'gm-1' }, { fetch: fetchFn });
  assert.equal(result.capability, 'unknown_error');
}));

test('checkInboundBodyCapability never calls Gmail at all without a sample message id — fails closed, never guesses', () => withEnv(async () => {
  let called = false;
  const fetchFn = async () => { called = true; return okJson({}); };
  const result = await gmailSendClient.checkInboundBodyCapability({ sampleGmailMessageId: null }, { fetch: fetchFn });
  assert.equal(result.capability, 'unknown_error');
  assert.equal(called, false);
}));

test('checkInboundBodyCapability never leaks Gmail\'s raw error text in its return value — only a fixed classification string', () => withEnv(async () => {
  const fetchFn = tokenOrReal(null, async () => errResp(400, "Metadata scope doesn't allow format FULL — leaked-secret-marker"));
  const result = await gmailSendClient.checkInboundBodyCapability({ sampleGmailMessageId: 'gm-1' }, { fetch: fetchFn });
  assert.deepEqual(Object.keys(result).sort(), ['capability']);
  assert.doesNotMatch(JSON.stringify(result), /leaked-secret-marker/);
}));

test('fetchMessageFull requests format=full against the given message id', () => withEnv(async () => {
  let capturedUrl = null;
  const fetchFn = tokenOrReal(null, async (url) => { capturedUrl = String(url); return okJson({ id: 'gm-1', payload: {} }); });
  await gmailSendClient.fetchMessageFull('gm-1', { fetch: fetchFn });
  assert.match(capturedUrl, /\/messages\/gm-1/);
  assert.match(capturedUrl, /format=full/);
}));

// ═══════════════ Phase 2 — History API / profile / search transport ═══════

test('listHistory requests the history endpoint with startHistoryId, messageAdded, and INBOX scoping', () => withEnv(async () => {
  let capturedUrl = null;
  const fetchFn = tokenOrReal(null, async (url) => { capturedUrl = String(url); return okJson({ history: [], historyId: '999' }); });
  const result = await gmailSendClient.listHistory({ startHistoryId: '123' }, { fetch: fetchFn });
  assert.match(capturedUrl, /\/history/);
  assert.match(capturedUrl, /startHistoryId=123/);
  assert.match(capturedUrl, /historyTypes=messageAdded/);
  assert.match(capturedUrl, /labelId=INBOX/);
  assert.equal(result.historyId, '999');
}));

test('listHistory forwards pageToken when given, for pagination', () => withEnv(async () => {
  let capturedUrl = null;
  const fetchFn = tokenOrReal(null, async (url) => { capturedUrl = String(url); return okJson({ history: [] }); });
  await gmailSendClient.listHistory({ startHistoryId: '123', pageToken: 'page-2' }, { fetch: fetchFn });
  assert.match(capturedUrl, /pageToken=page-2/);
}));

test('getProfile requests the profile endpoint and returns it unchanged', () => withEnv(async () => {
  const fetchFn = tokenOrReal(null, async () => okJson({ historyId: '555', emailAddress: 'hello@desetour.com' }));
  const result = await gmailSendClient.getProfile({ fetch: fetchFn });
  assert.equal(result.historyId, '555');
}));

test('listMessageIdsByQuery sends the exact query string given — it never builds or widens the query itself', () => withEnv(async () => {
  let capturedUrl = null;
  const fetchFn = tokenOrReal(null, async (url) => { capturedUrl = String(url); return okJson({ messages: [] }); });
  await gmailSendClient.listMessageIdsByQuery({ query: '(threadId:abc)' }, { fetch: fetchFn });
  assert.match(decodeURIComponent(capturedUrl), /q=\(threadId:abc\)/);
}));

// ═══════════════ Phase 7 — same-thread send (backward compatible) ═════════

test('sendMessage WITHOUT threadId/inReplyTo/references behaves exactly as before — no new headers, no threadId in the request body', () => withEnv(async () => {
  let capturedBody = null;
  const fetchFn = tokenOrReal(null, async (url, opts) => { capturedBody = JSON.parse(opts.body); return okJson({ id: 'gm-1', threadId: 'th-1' }); });
  await gmailSendClient.sendMessage({ toEmail: 'acente@example.com', subject: 'x', bodyText: 'y' }, { fetch: fetchFn });
  assert.deepEqual(Object.keys(capturedBody).sort(), ['raw']);
  const decoded = Buffer.from(capturedBody.raw.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
  assert.doesNotMatch(decoded, /In-Reply-To:/i);
  assert.doesNotMatch(decoded, /References:/i);
}));

test('sendMessage WITH threadId includes it in the Gmail request body', () => withEnv(async () => {
  let capturedBody = null;
  const fetchFn = tokenOrReal(null, async (url, opts) => { capturedBody = JSON.parse(opts.body); return okJson({ id: 'gm-2', threadId: 'th-existing' }); });
  await gmailSendClient.sendMessage({ toEmail: 'acente@example.com', subject: 'x', bodyText: 'y', threadId: 'th-existing' }, { fetch: fetchFn });
  assert.equal(capturedBody.threadId, 'th-existing');
}));

test('sendMessage WITH inReplyTo/references emits the matching MIME headers', () => withEnv(async () => {
  let capturedBody = null;
  const fetchFn = tokenOrReal(null, async (url, opts) => { capturedBody = JSON.parse(opts.body); return okJson({ id: 'gm-3', threadId: 'th-3' }); });
  await gmailSendClient.sendMessage({
    toEmail: 'acente@example.com', subject: 'x', bodyText: 'y',
    threadId: 'th-3', inReplyTo: '<original@mail.gmail.com>', references: '<original@mail.gmail.com>',
  }, { fetch: fetchFn });
  const decoded = Buffer.from(capturedBody.raw.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
  assert.match(decoded, /In-Reply-To: <original@mail\.gmail\.com>/);
  assert.match(decoded, /References: <original@mail\.gmail\.com>/);
}));

test('buildRawMimeMessage omits In-Reply-To/References entirely when not given — never an empty header line', () => {
  const raw = gmailSendClient.buildRawMimeMessage({
    fromEmail: 'hello@desetour.com', fromName: 'Dese Tour', toEmail: 'acente@example.com', subject: 'x', bodyText: 'y',
  });
  const decoded = Buffer.from(raw.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
  assert.doesNotMatch(decoded, /In-Reply-To:/);
  assert.doesNotMatch(decoded, /References:/);
});
