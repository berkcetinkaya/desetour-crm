'use strict';
/**
 * tests/dashboard/agencyInboundSync.test.js
 * ─────────────────────────────────────────────────────────────────────────
 * Agency Mailbox Phase 2-5/8 — api/_agencies/gmailInboundSync.js. Covers
 * MIME header/body extraction, the 4-tier matching hierarchy, the Gmail
 * History API sync cursor, idempotent persistence, the full
 * syncAgencyMailbox orchestration (capability gate, pagination, bounds),
 * and the bounded Phase 8 backfill. Every Gmail/Supabase call is injected
 * — no live network access, matching every other test in this project.
 * ─────────────────────────────────────────────────────────────────────────
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const REPO_ROOT = path.join(__dirname, '..', '..');
const sync = require(path.join(REPO_ROOT, 'api', '_agencies', 'gmailInboundSync'));
const gmailSendClient = require(path.join(REPO_ROOT, 'api', '_agencies', 'gmailSendClient'));

// ── Minimal fake Supabase query builder — chainable AND thenable at any
// point, so `await adminClient.from(t).select(...).eq(...).maybeSingle()`
// and `await adminClient.from(t).update(...).eq(...)` both resolve
// correctly regardless of how long the chain is. Each table's configured
// results are consumed in call order (FIFO), same style as this
// project's existing fakeFetchSequence helper.
//
// `statefulTables` (opt-in, default none) makes a table's `.upsert()`
// actually persist into an in-memory map keyed by whatever column
// `.eq()` was last called with (the only shape the real cursor read/write
// path needs — `.select('value').eq('key', K).maybeSingle()` /
// `.upsert({key:K, ...}, {onConflict:'key'})`), so a test can run the
// real syncAgencyMailbox TWICE in a row and have the second call
// actually observe what the first call wrote — needed for the
// continuation-resumes-on-the-next-run tests below. Every pre-existing
// test keeps using the plain FIFO queue (statefulTables omitted), so
// none of them are affected by this addition. ──────────────────────────
function makeFakeAdminClient(resultsByTable = {}, { statefulTables = [] } = {}) {
  const queues = {};
  for (const [table, results] of Object.entries(resultsByTable)) queues[table] = results.slice();
  const calls = [];
  const state = {};

  function resolveNext(table) {
    const queue = queues[table] || (queues[table] = []);
    const next = queue.length ? queue.shift() : { data: null, error: null };
    return Promise.resolve(next);
  }

  function builder(table) {
    const b = {};
    const filters = {};
    for (const method of ['select', 'not', 'order', 'limit']) {
      b[method] = (...args) => { calls.push({ table, method, args }); return b; };
    }
    b.eq = (col, val) => { filters[col] = val; calls.push({ table, method: 'eq', args: [col, val] }); return b; };
    b.maybeSingle = () => {
      calls.push({ table, method: 'maybeSingle' });
      if (statefulTables.includes(table) && state[table] && state[table].has(filters.key)) {
        return Promise.resolve({ data: state[table].get(filters.key), error: null });
      }
      return resolveNext(table);
    };
    b.upsert = (payload, opts) => {
      calls.push({ table, method: 'upsert', payload, opts });
      if (statefulTables.includes(table)) {
        const keyField = (opts && opts.onConflict) || 'key';
        if (!state[table]) state[table] = new Map();
        state[table].set(payload[keyField], payload);
      }
      return resolveNext(table);
    };
    b.update = (payload) => { calls.push({ table, method: 'update', payload }); return b; };
    // Chainable (not immediately resolved) so `.insert(x).select('id').single()`
    // works — persistInboundMessage needs the inserted row's own id back.
    // A bare `await adminClient.from(t).insert(x)` with no further chain
    // still resolves correctly via `.then` below, same as before.
    b.insert = (payload) => { calls.push({ table, method: 'insert', payload }); return b; };
    b.single = () => resolveNext(table);
    b.then = (resolve, reject) => resolveNext(table).then(resolve, reject);
    return b;
  }

  return { from: builder, _calls: calls, _state: state };
}

function gmailMessage({ id = 'gm-1', threadId = 'th-1', headers = [], mimeType = 'text/plain', bodyText = '' }) {
  return {
    id, threadId,
    payload: {
      headers,
      mimeType,
      body: { data: Buffer.from(bodyText, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '') },
    },
  };
}

/** A canned Gmail transport, routed by URL — covers token exchange,
 * /history (paginated, with an optional 404-on-a-specific-startHistoryId
 * to simulate an expired/invalid cursor), /profile, and /messages/{id}.
 * `historyPages` is consumed strictly in call order, mirroring exactly
 * what a real sequence of listHistory calls would receive. */
function makeGmailFetch({ historyPages = [], messagesById = {}, profile = { historyId: '9999' }, staleOnStartHistoryId = null, staleStatus = 404 } = {}) {
  let historyCallIndex = 0;
  const calls = [];
  const fetchFn = async (url) => {
    const u = String(url);
    calls.push(u);
    if (u.includes('oauth2.googleapis.com')) {
      return { ok: true, json: async () => ({ access_token: 'tok', expires_in: 3600 }) };
    }
    const parsed = new URL(u);
    if (parsed.pathname.endsWith('/history')) {
      const startHistoryId = parsed.searchParams.get('startHistoryId');
      if (staleOnStartHistoryId && startHistoryId === staleOnStartHistoryId) {
        return { ok: false, status: staleStatus, text: async () => 'Requested entity was not found.' };
      }
      const page = historyPages[historyCallIndex];
      historyCallIndex += 1;
      if (!page) throw new Error('makeGmailFetch: no more canned history pages (call #' + historyCallIndex + ')');
      return { ok: true, json: async () => page };
    }
    if (parsed.pathname.endsWith('/profile')) {
      return { ok: true, json: async () => profile };
    }
    const messageMatch = parsed.pathname.match(/\/messages\/([^/]+)$/);
    if (messageMatch) {
      const msg = messagesById[messageMatch[1]];
      if (!msg) throw new Error('makeGmailFetch: no canned message for id ' + messageMatch[1]);
      return { ok: true, json: async () => msg };
    }
    if (parsed.pathname.endsWith('/messages')) {
      // listMessageIdsByQuery (Phase 8 / stale-history recovery backfill)
      return { ok: true, json: async () => ({ messages: Object.keys(messagesById).map(id => ({ id })) }) };
    }
    throw new Error('makeGmailFetch: unexpected URL ' + u);
  };
  fetchFn.calls = calls;
  return fetchFn;
}

function withGmailEnv(fn) {
  const keys = ['AGENCY_GMAIL_CLIENT_ID', 'AGENCY_GMAIL_CLIENT_SECRET', 'AGENCY_GMAIL_REFRESH_TOKEN', 'AGENCY_GMAIL_FROM'];
  const prev = {};
  for (const k of keys) prev[k] = process.env[k];
  process.env.AGENCY_GMAIL_CLIENT_ID = 'x'; process.env.AGENCY_GMAIL_CLIENT_SECRET = 'x';
  process.env.AGENCY_GMAIL_REFRESH_TOKEN = 'x'; process.env.AGENCY_GMAIL_FROM = 'hello@desetour.com';
  return Promise.resolve().then(fn).finally(() => {
    for (const k of keys) { if (prev[k] === undefined) delete process.env[k]; else process.env[k] = prev[k]; }
  });
}

/** A unique_violation exactly as Postgres/PostgREST actually shapes it for
 * the partial index on agency_emails.provider_message_id — used to drive
 * the fake adminClient's agency_emails queue for duplicate-replay tests. */
function uniqueViolationError(providerMessageId) {
  return {
    data: null,
    error: {
      code: '23505',
      message: 'duplicate key value violates unique constraint "idx_agency_emails_provider_message_id"',
      details: `Key (provider_message_id)=(${providerMessageId}) already exists.`,
    },
  };
}

// ═══════════════ A. MIME helpers ═══════════════════════════════════════

test('decodeGmailBase64Url round-trips text containing base64url-only characters (- and _)', () => {
  const original = 'a'.repeat(100); // long enough to plausibly contain - or _ once encoded; exact round-trip is what matters
  const encoded = Buffer.from(original, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_');
  assert.equal(sync.decodeGmailBase64Url(encoded), original);
});

test('decodeGmailBase64Url returns "" (never throws) for empty/invalid input', () => {
  assert.equal(sync.decodeGmailBase64Url(''), '');
  assert.equal(sync.decodeGmailBase64Url(null), '');
  assert.doesNotThrow(() => sync.decodeGmailBase64Url(undefined));
});

test('findBodyPartData finds a direct text/plain body with no parts', () => {
  const payload = { mimeType: 'text/plain', body: { data: 'aGVsbG8' } };
  assert.equal(sync.findBodyPartData(payload, 'text/plain'), 'aGVsbG8');
});

test('findBodyPartData searches nested multipart/alternative inside multipart/mixed', () => {
  const payload = {
    mimeType: 'multipart/mixed',
    parts: [
      { mimeType: 'multipart/alternative', parts: [
        { mimeType: 'text/plain', body: { data: 'cGxhaW4' } },
        { mimeType: 'text/html', body: { data: 'aHRtbA' } },
      ] },
    ],
  };
  assert.equal(sync.findBodyPartData(payload, 'text/plain'), 'cGxhaW4');
  assert.equal(sync.findBodyPartData(payload, 'text/html'), 'aHRtbA');
});

test('findBodyPartData skips a part with a filename (an attachment), even if its mimeType matches', () => {
  const payload = {
    mimeType: 'multipart/mixed',
    parts: [
      { mimeType: 'text/plain', filename: 'notes.txt', body: { data: 'YXR0YWNobWVudA' } },
      { mimeType: 'text/plain', body: { data: 'cmVhbEJvZHk' } },
    ],
  };
  assert.equal(sync.findBodyPartData(payload, 'text/plain'), 'cmVhbEJvZHk');
});

test('stripHtmlToText converts <br>/<p> to newlines and decodes common entities', () => {
  const html = '<p>Merhaba &amp; iyi g&uuml;nler</p><br>Sonraki sat&#305;r';
  const text = sync.stripHtmlToText(html);
  assert.doesNotMatch(text, /<[^>]+>/);
  assert.match(text, /Merhaba & iyi/);
});

test('extractNormalizedPlainTextBody prefers text/plain over text/html when both exist', () => {
  const plainData = Buffer.from('Plain version').toString('base64');
  const htmlData = Buffer.from('<b>HTML version</b>').toString('base64');
  const payload = { mimeType: 'multipart/alternative', parts: [
    { mimeType: 'text/plain', body: { data: plainData } },
    { mimeType: 'text/html', body: { data: htmlData } },
  ] };
  assert.equal(sync.extractNormalizedPlainTextBody(payload), 'Plain version');
});

test('extractNormalizedPlainTextBody falls back to HTML-stripped-to-text when no text/plain part exists', () => {
  const htmlData = Buffer.from('<p>Only HTML here</p>').toString('base64');
  const payload = { mimeType: 'text/html', body: { data: htmlData } };
  assert.match(sync.extractNormalizedPlainTextBody(payload), /Only HTML here/);
});

test('extractNormalizedPlainTextBody truncates to MAX_INBOUND_BODY_LENGTH — never stores an unbounded body', () => {
  const longText = 'x'.repeat(sync.MAX_INBOUND_BODY_LENGTH + 500);
  const payload = { mimeType: 'text/plain', body: { data: Buffer.from(longText).toString('base64') } };
  const result = sync.extractNormalizedPlainTextBody(payload);
  assert.equal(result.length, sync.MAX_INBOUND_BODY_LENGTH);
});

test('extractNormalizedPlainTextBody returns "" for a payload with no recognizable text part (e.g. image-only)', () => {
  const payload = { mimeType: 'image/png', body: {} };
  assert.equal(sync.extractNormalizedPlainTextBody(payload), '');
});

test('extractEmailAddress pulls the bare address out of a "Display Name <addr>" header', () => {
  assert.equal(sync.extractEmailAddress('Acme Travel <Contact@Acme.com>'), 'contact@acme.com');
  assert.equal(sync.extractEmailAddress('plain@acme.com'), 'plain@acme.com');
  assert.equal(sync.extractEmailAddress(''), '');
});

test('splitMessageIdList splits a multi-value References header into individual angle-bracketed ids', () => {
  const result = sync.splitMessageIdList('<a@x.com> <b@x.com>  <c@x.com>');
  assert.deepEqual(result, ['<a@x.com>', '<b@x.com>', '<c@x.com>']);
});

test('extractMessageFields pulls id/threadId/headers/body into one flat object', () => {
  const msg = gmailMessage({
    id: 'gm-9', threadId: 'th-9',
    headers: [
      { name: 'Message-Id', value: '<m9@acme.com>' },
      { name: 'In-Reply-To', value: '<orig@desetour.com>' },
      { name: 'From', value: 'Acme <contact@acme.com>' },
      { name: 'Subject', value: 'Re: Merhaba' },
    ],
    bodyText: 'Teşekkürler',
  });
  const fields = sync.extractMessageFields(msg);
  assert.equal(fields.gmailMessageId, 'gm-9');
  assert.equal(fields.gmailThreadId, 'th-9');
  assert.equal(fields.messageId, '<m9@acme.com>');
  assert.equal(fields.inReplyTo, '<orig@desetour.com>');
  assert.equal(fields.fromHeader, 'Acme <contact@acme.com>');
  assert.equal(fields.subject, 'Re: Merhaba');
  assert.equal(fields.body, 'Teşekkürler');
});

// ═══════════════ B. Matching hierarchy ═════════════════════════════════

const AGENCIES = [
  { id: 'AGN-1', email: 'contact@acme.com', name: 'Acme Turizm' },
  { id: 'AGN-2', email: 'info@globetour.com' },
  { id: 'AGN-shared-a', email: 'shared@dup.com' },
  { id: 'AGN-shared-b', email: 'shared@dup.com' },
];

const AGENCY_EMAILS = [
  { agency_id: 'AGN-1', provider_thread_id: 'th-acme', internet_message_id: '<out-1@desetour.com>', provider_message_id: 'gm-out-1' },
  { agency_id: 'AGN-2', provider_thread_id: 'th-globe', internet_message_id: '<out-2@desetour.com>', provider_message_id: 'gm-out-2' },
];

test('tier 1: matches by Gmail threadId', () => {
  const indexes = sync.buildMatchingIndexes({ agencies: AGENCIES, agencyEmails: AGENCY_EMAILS });
  const fields = { gmailThreadId: 'th-acme', inReplyTo: null, references: null, fromHeader: 'someone@unrelated.com' };
  const result = sync.classifyInboundMessage(fields, indexes);
  assert.deepEqual(result, { matched: true, agencyId: 'AGN-1', matchTier: 'thread_id' });
});

test('tier 2: matches by In-Reply-To against a stored internet_message_id when threadId does not match', () => {
  const indexes = sync.buildMatchingIndexes({ agencies: AGENCIES, agencyEmails: AGENCY_EMAILS });
  const fields = { gmailThreadId: 'th-unrelated', inReplyTo: '<out-2@desetour.com>', references: null, fromHeader: 'someone@unrelated.com' };
  const result = sync.classifyInboundMessage(fields, indexes);
  assert.deepEqual(result, { matched: true, agencyId: 'AGN-2', matchTier: 'message_id_reference' });
});

test('tier 2: matches by References (not just In-Reply-To) against a stored internet_message_id', () => {
  const indexes = sync.buildMatchingIndexes({ agencies: AGENCIES, agencyEmails: AGENCY_EMAILS });
  const fields = { gmailThreadId: null, inReplyTo: null, references: '<something-else@x.com> <out-1@desetour.com>', fromHeader: 'someone@unrelated.com' };
  const result = sync.classifyInboundMessage(fields, indexes);
  assert.deepEqual(result, { matched: true, agencyId: 'AGN-1', matchTier: 'message_id_reference' });
});

test('tier 3: matches a referenced id against a stored provider_message_id when no internet_message_id matches', () => {
  const indexes = sync.buildMatchingIndexes({ agencies: AGENCIES, agencyEmails: AGENCY_EMAILS });
  const fields = { gmailThreadId: null, inReplyTo: 'gm-out-2', references: null, fromHeader: 'someone@unrelated.com' };
  const result = sync.classifyInboundMessage(fields, indexes);
  assert.deepEqual(result, { matched: true, agencyId: 'AGN-2', matchTier: 'provider_message_id_reference' });
});

test('tier 4: falls back to the known contact email ONLY when exactly one agency has it', () => {
  const indexes = sync.buildMatchingIndexes({ agencies: AGENCIES, agencyEmails: [] });
  const fields = { gmailThreadId: null, inReplyTo: null, references: null, fromHeader: 'Acme <contact@acme.com>' };
  const result = sync.classifyInboundMessage(fields, indexes);
  assert.deepEqual(result, { matched: true, agencyId: 'AGN-1', matchTier: 'known_contact_email' });
});

test('tier 4: an ambiguous shared contact email (two agencies) is never guessed — no match', () => {
  const indexes = sync.buildMatchingIndexes({ agencies: AGENCIES, agencyEmails: [] });
  const fields = { gmailThreadId: null, inReplyTo: null, references: null, fromHeader: 'shared@dup.com' };
  const result = sync.classifyInboundMessage(fields, indexes);
  assert.deepEqual(result, { matched: false });
});

test('an unrelated message (no thread/reference/contact match at all) is rejected, never imported', () => {
  const indexes = sync.buildMatchingIndexes({ agencies: AGENCIES, agencyEmails: AGENCY_EMAILS });
  const fields = { gmailThreadId: 'th-completely-unrelated', inReplyTo: '<nothing@random.com>', references: null, fromHeader: 'random-person@gmail.com' };
  const result = sync.classifyInboundMessage(fields, indexes);
  assert.deepEqual(result, { matched: false });
});

test('subject is never part of the matching hierarchy — classifyInboundMessage\'s own fields never even include it as a signal', () => {
  const srcPath = path.join(REPO_ROOT, 'api', '_agencies', 'gmailInboundSync.js');
  const src = require('fs').readFileSync(srcPath, 'utf8');
  const fnIdx = src.indexOf('function classifyInboundMessage(');
  const fnEnd = src.indexOf('\nfunction ', fnIdx + 20);
  const fnBody = src.slice(fnIdx, fnEnd);
  assert.doesNotMatch(fnBody, /subject/i);
});

// ═══════════════ C. Backfill query scoping ═════════════════════════════

test('buildBackfillQuery returns null (a safe no-op) when there are no known threads or contacts at all', () => {
  assert.equal(sync.buildBackfillQuery({ knownThreadIds: [], knownContactEmails: [], sinceUnixSeconds: undefined }), null);
});

test('buildBackfillQuery scopes strictly to known thread ids and contact emails, OR-combined', () => {
  const query = sync.buildBackfillQuery({ knownThreadIds: ['th-1'], knownContactEmails: ['acme@x.com'], sinceUnixSeconds: undefined });
  assert.match(query, /threadId:th-1/);
  assert.match(query, /from:acme@x\.com/);
  assert.match(query, / OR /);
});

test('buildBackfillQuery appends a bounded time window when given', () => {
  const query = sync.buildBackfillQuery({ knownThreadIds: ['th-1'], knownContactEmails: [], sinceUnixSeconds: 1700000000 });
  assert.match(query, /after:1700000000/);
});

// ═══════════════ D. History cursor ═════════════════════════════════════

test('readSyncCursor returns null when no cursor row exists yet', async () => {
  const adminClient = makeFakeAdminClient({ settings: [{ data: null, error: null }] });
  const cursor = await sync.readSyncCursor({ adminClient });
  assert.equal(cursor, null);
});

test('readSyncCursor parses a valid stored JSON cursor', async () => {
  const adminClient = makeFakeAdminClient({ settings: [{ data: { value: JSON.stringify({ historyId: '42' }) }, error: null }] });
  const cursor = await sync.readSyncCursor({ adminClient });
  assert.equal(cursor.historyId, '42');
});

test('readSyncCursor returns null (never throws) for a malformed stored value', async () => {
  const adminClient = makeFakeAdminClient({ settings: [{ data: { value: 'not-json' }, error: null }] });
  const cursor = await sync.readSyncCursor({ adminClient });
  assert.equal(cursor, null);
});

test('writeSyncCursor upserts the settings row keyed by key, never duplicating it on repeated calls', async () => {
  const adminClient = makeFakeAdminClient({ settings: [{ error: null }] });
  await sync.writeSyncCursor({ adminClient, historyId: '100' });
  const upsertCall = adminClient._calls.find(c => c.table === 'settings' && c.method === 'upsert');
  assert.ok(upsertCall);
  assert.equal(upsertCall.payload.key, sync.SETTINGS_KEY_SYNC_CURSOR);
  assert.equal(JSON.parse(upsertCall.payload.value).historyId, '100');
  assert.equal(upsertCall.opts.onConflict, 'key');
});

// ═══════════════ E/F/G. Sample id, persistence, agency state ══════════

test('findSampleOutboundGmailMessageId returns the most recent provider_message_id, or null if none exists', async () => {
  const adminClient = makeFakeAdminClient({ agency_emails: [{ data: { provider_message_id: 'gm-latest' }, error: null }] });
  const id = await sync.findSampleOutboundGmailMessageId({ adminClient });
  assert.equal(id, 'gm-latest');

  const adminClientEmpty = makeFakeAdminClient({ agency_emails: [{ data: null, error: null }] });
  assert.equal(await sync.findSampleOutboundGmailMessageId({ adminClient: adminClientEmpty }), null);
});

// persistInboundMessage — rewritten to a plain INSERT with a 23505
// unique-violation catch, since PostgREST's upsert(onConflict:) can never
// match the partial unique index on provider_message_id (no non-partial
// unique index/constraint exists on that column, and PostgREST's
// on_conflict has no way to repeat the index's own WHERE predicate) — a
// bare `ON CONFLICT (provider_message_id) DO NOTHING` fails Postgres's
// own conflict-target inference on EVERY call, not just real duplicates.
// The partial unique index itself remains the sole idempotency authority
// — never a SELECT-then-INSERT existence check, which would race.

test('persistInboundMessage performs a plain INSERT (never upsert/onConflict) against agency_emails, and returns the inserted row\'s own id', async () => {
  const adminClient = makeFakeAdminClient({ agency_emails: [{ data: { id: 'AEM-new-uuid' }, error: null }] });
  const fields = sync.extractMessageFields(gmailMessage({
    id: 'gm-new', threadId: 'th-1',
    headers: [{ name: 'From', value: 'contact@acme.com' }, { name: 'To', value: 'hello@desetour.com' }, { name: 'Subject', value: 'Re: x' }],
    bodyText: 'merhaba',
  }));
  const result = await sync.persistInboundMessage({ adminClient, agencyId: 'AGN-1', fields });
  assert.deepEqual(result, { persisted: true, duplicate: false, insertedId: 'AEM-new-uuid' });
  const insertCall = adminClient._calls.find(c => c.table === 'agency_emails' && c.method === 'insert');
  assert.ok(insertCall, 'expected a plain insert() call');
  assert.equal(insertCall.payload.direction, 'inbound');
  assert.equal(insertCall.payload.status, 'received');
  assert.equal(insertCall.payload.provider_message_id, 'gm-new');
  assert.ok(!adminClient._calls.some(c => c.table === 'agency_emails' && c.method === 'upsert'), 'must never upsert against agency_emails');
});

test('persistInboundMessage treats a Postgres 23505 unique violation on provider_message_id as a safe, non-fatal duplicate replay', async () => {
  const adminClient = makeFakeAdminClient({ agency_emails: [uniqueViolationError('gm-dup')] });
  const fields = sync.extractMessageFields(gmailMessage({ id: 'gm-dup', bodyText: 'merhaba tekrar' }));
  const result = await sync.persistInboundMessage({ adminClient, agencyId: 'AGN-1', fields });
  assert.deepEqual(result, { persisted: false, duplicate: true, insertedId: null });
});

test('persistInboundMessage propagates any OTHER database error unchanged — a replay guard must never swallow a real failure', async () => {
  const adminClient = makeFakeAdminClient({ agency_emails: [{ data: null, error: { code: '42501', message: 'permission denied for table agency_emails' } }] });
  const fields = sync.extractMessageFields(gmailMessage({ id: 'gm-1', bodyText: 'x' }));
  let caught = null;
  try { await sync.persistInboundMessage({ adminClient, agencyId: 'AGN-1', fields }); } catch (err) { caught = err; }
  assert.ok(caught);
  assert.equal(caught.message, 'permission denied for table agency_emails');
});

test('persistInboundMessage propagates a 23505 on an UNRELATED constraint rather than misreading it as a provider_message_id replay', async () => {
  const adminClient = makeFakeAdminClient({ agency_emails: [{ data: null, error: { code: '23505', message: 'duplicate key value violates unique constraint "agency_emails_pkey"', details: 'Key (id)=(...) already exists.' } }] });
  const fields = sync.extractMessageFields(gmailMessage({ id: 'gm-1', bodyText: 'x' }));
  await assert.rejects(() => sync.persistInboundMessage({ adminClient, agencyId: 'AGN-1', fields }));
});

test('persistInboundMessage never stores the raw Gmail payload — only the already-normalized fields', async () => {
  const adminClient = makeFakeAdminClient({ agency_emails: [{ data: { id: 'AEM-1' }, error: null }] });
  const fields = sync.extractMessageFields(gmailMessage({ id: 'gm-1', bodyText: 'hello' }));
  await sync.persistInboundMessage({ adminClient, agencyId: 'AGN-1', fields });
  const insertCall = adminClient._calls.find(c => c.table === 'agency_emails' && c.method === 'insert');
  assert.doesNotMatch(JSON.stringify(insertCall.payload), /payload.*headers/);
});

test('isProviderMessageIdUniqueViolation: true only for a 23505 that actually references provider_message_id', () => {
  assert.equal(sync.isProviderMessageIdUniqueViolation({ code: '23505', message: 'x', details: 'Key (provider_message_id)=(gm-1) already exists.' }), true);
  assert.equal(sync.isProviderMessageIdUniqueViolation({ code: '23505', message: 'x', details: 'Key (id)=(...) already exists.' }), false);
  assert.equal(sync.isProviderMessageIdUniqueViolation({ code: '42501', message: 'provider_message_id permission denied' }), false);
  assert.equal(sync.isProviderMessageIdUniqueViolation(null), false);
});

test('persistInboundMessage\'s own function body uses a plain .insert( — never .upsert(/onConflict against the partial index', () => {
  const srcPath = path.join(REPO_ROOT, 'api', '_agencies', 'gmailInboundSync.js');
  const src = require('fs').readFileSync(srcPath, 'utf8');
  const fnIdx = src.indexOf('async function persistInboundMessage(');
  const fnEnd = src.indexOf('\nasync function ', fnIdx + 20);
  const fnBody = src.slice(fnIdx, fnEnd);
  assert.doesNotMatch(fnBody, /onConflict/);
  assert.doesNotMatch(fnBody, /\.upsert\(/);
  assert.match(fnBody, /\.insert\(/);
});

test('the only real .upsert( call left in the module (writeSyncCursor) targets the settings cursor row, keyed by the plain (non-partial) unique `key` column', () => {
  const srcPath = path.join(REPO_ROOT, 'api', '_agencies', 'gmailInboundSync.js');
  const src = require('fs').readFileSync(srcPath, 'utf8');
  const fnIdx = src.indexOf('async function writeSyncCursor(');
  const fnEnd = src.indexOf('\n/**', fnIdx + 20);
  const fnBody = src.slice(fnIdx, fnEnd);
  const upsertCalls = fnBody.match(/\.upsert\(/g) || [];
  assert.equal(upsertCalls.length, 1, 'expected exactly one .upsert( call inside writeSyncCursor');
  assert.match(fnBody, /\.upsert\(\{ key: SETTINGS_KEY_SYNC_CURSOR/);
  assert.match(fnBody, /onConflict:\s*['"]key['"]/);
});

test('advanceAgencyOnReply updates last_contact_at and never touches agencies.status', async () => {
  const adminClient = makeFakeAdminClient({ agencies: [{ error: null }] });
  const result = await sync.advanceAgencyOnReply({ adminClient, agencyId: 'AGN-1' });
  assert.equal(result.ok, true);
  const updateCall = adminClient._calls.find(c => c.table === 'agencies' && c.method === 'update');
  assert.ok(updateCall.payload.last_contact_at);
  assert.ok(!('status' in updateCall.payload));
});

test('advanceAgencyOnReply fails soft (never throws) on an update error', async () => {
  const adminClient = makeFakeAdminClient({ agencies: [{ error: { message: 'boom' } }] });
  const result = await sync.advanceAgencyOnReply({ adminClient, agencyId: 'AGN-1' });
  assert.equal(result.ok, false);
});

// ═══════════════ G2. processCandidateMessage — replay convergence ═════
// Shared by syncAgencyMailbox/runBoundedBackfill/stale recovery: a
// duplicate replay (the row already exists, per the database's own
// unique index) must still retry the agencies.last_contact_at follow-up
// — a prior run may have persisted the email and then failed BEFORE that
// update landed — but must never write a second activity_logs row for
// the same reply.

test('processCandidateMessage: a genuinely new match persists the email, advances the agency, and logs exactly once', () => withGmailEnv(async () => {
  const adminClient = makeFakeAdminClient({
    agency_emails: [{ data: { id: 'AEM-new' }, error: null }],
    agencies: [{ error: null }],
    activity_logs: [{ error: null }],
  });
  const msg = gmailMessage({ id: 'gm-new', threadId: 'th-acme', headers: [{ name: 'From', value: 'contact@acme.com' }] });
  const indexes = sync.buildMatchingIndexes({ agencies: AGENCIES, agencyEmails: [] });
  const outcome = await sync.processCandidateMessage({
    adminClient, gmailDeps: { fetch: makeGmailFetch({ messagesById: { 'gm-new': msg } }) }, gmailMessageId: 'gm-new', indexes,
  });
  assert.equal(outcome, 'matched');
  assert.equal(adminClient._calls.filter(c => c.table === 'agency_emails' && c.method === 'insert').length, 1);
  assert.equal(adminClient._calls.filter(c => c.table === 'agencies' && c.method === 'update').length, 1);
  assert.equal(adminClient._calls.filter(c => c.table === 'activity_logs' && c.method === 'insert').length, 1);
}));

test('processCandidateMessage: a duplicate replay still retries the agency follow-up update, but logs nothing new', () => withGmailEnv(async () => {
  const adminClient = makeFakeAdminClient({
    agency_emails: [uniqueViolationError('gm-dup')],
    agencies: [{ error: null }],
    activity_logs: [{ error: null }],
  });
  const msg = gmailMessage({ id: 'gm-dup', threadId: 'th-acme', headers: [{ name: 'From', value: 'contact@acme.com' }] });
  const indexes = sync.buildMatchingIndexes({ agencies: AGENCIES, agencyEmails: [] });
  const outcome = await sync.processCandidateMessage({
    adminClient, gmailDeps: { fetch: makeGmailFetch({ messagesById: { 'gm-dup': msg } }) }, gmailMessageId: 'gm-dup', indexes,
  });
  assert.equal(outcome, 'duplicate');
  assert.equal(adminClient._calls.filter(c => c.table === 'agencies' && c.method === 'update').length, 1, 'the agency follow-up update must still be retried on a duplicate replay');
  assert.equal(adminClient._calls.filter(c => c.table === 'activity_logs' && c.method === 'insert').length, 0, 'a replay must never create a second activity log row');
}));

test('processCandidateMessage: an unmatched message is skipped without ever touching agency_emails/agencies/activity_logs', () => withGmailEnv(async () => {
  const adminClient = makeFakeAdminClient({});
  const msg = gmailMessage({ id: 'gm-unrelated', threadId: 'th-unrelated', headers: [{ name: 'From', value: 'random@gmail.com' }] });
  const indexes = sync.buildMatchingIndexes({ agencies: AGENCIES, agencyEmails: [] });
  const outcome = await sync.processCandidateMessage({
    adminClient, gmailDeps: { fetch: makeGmailFetch({ messagesById: { 'gm-unrelated': msg } }) }, gmailMessageId: 'gm-unrelated', indexes,
  });
  assert.equal(outcome, 'skipped');
  assert.equal(adminClient._calls.length, 0);
}));

// ═══════════════ H. syncAgencyMailbox orchestration ════════════════════

test('syncAgencyMailbox stops and writes nothing when the capability preflight reports insufficient_scope', async () => {
  const adminClient = makeFakeAdminClient({ agency_emails: [{ data: { provider_message_id: 'gm-sample' }, error: null }] });
  const gmailDeps = { __test_fetchMessageFull_error: 'insufficient_scope' };
  // Stub the real Gmail client call through a fake gmailSendClient module is
  // avoided here by injecting a fetch that always 400s on format=full,
  // matching checkInboundBodyCapability's own real classification path.
  const fetchFn = async (url) => {
    if (String(url).includes('oauth2.googleapis.com')) return { ok: true, json: async () => ({ access_token: 'tok', expires_in: 3600 }) };
    return { ok: false, status: 400, text: async () => "Metadata scope doesn't allow format FULL", json: async () => ({}) };
  };
  const prevEnv = {
    AGENCY_GMAIL_CLIENT_ID: process.env.AGENCY_GMAIL_CLIENT_ID,
    AGENCY_GMAIL_CLIENT_SECRET: process.env.AGENCY_GMAIL_CLIENT_SECRET,
    AGENCY_GMAIL_REFRESH_TOKEN: process.env.AGENCY_GMAIL_REFRESH_TOKEN,
    AGENCY_GMAIL_FROM: process.env.AGENCY_GMAIL_FROM,
  };
  process.env.AGENCY_GMAIL_CLIENT_ID = 'x'; process.env.AGENCY_GMAIL_CLIENT_SECRET = 'x';
  process.env.AGENCY_GMAIL_REFRESH_TOKEN = 'x'; process.env.AGENCY_GMAIL_FROM = 'hello@desetour.com';
  try {
    const result = await sync.syncAgencyMailbox({ adminClient, gmailDeps: { fetch: fetchFn } });
    assert.equal(result.ok, false);
    assert.equal(result.stage, 'capability_check_failed');
    assert.equal(result.capability, 'insufficient_scope');
    // No settings/agency_emails write of any kind was attempted.
    assert.ok(!adminClient._calls.some(c => c.method === 'upsert' || c.method === 'update' || c.method === 'insert'));
  } finally {
    for (const [k, v] of Object.entries(prevEnv)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
});

test('syncAgencyMailbox seeds the cursor on the first-ever run (no stored cursor) and does NOT backfill anything', async () => {
  // No prior outbound sends at all -> capability preflight is skipped
  // (nothing to sample against) per the orchestration's own design.
  const adminClient = makeFakeAdminClient({
    agency_emails: [{ data: null, error: null }],
    settings: [{ data: null, error: null }, { error: null }],
  });
  const fetchFn = async (url) => {
    if (String(url).includes('oauth2.googleapis.com')) return { ok: true, json: async () => ({ access_token: 'tok', expires_in: 3600 }) };
    if (String(url).includes('/profile')) return { ok: true, json: async () => ({ historyId: '1000' }) };
    throw new Error('unexpected call: ' + url);
  };
  const prevEnv = {
    AGENCY_GMAIL_CLIENT_ID: process.env.AGENCY_GMAIL_CLIENT_ID,
    AGENCY_GMAIL_CLIENT_SECRET: process.env.AGENCY_GMAIL_CLIENT_SECRET,
    AGENCY_GMAIL_REFRESH_TOKEN: process.env.AGENCY_GMAIL_REFRESH_TOKEN,
    AGENCY_GMAIL_FROM: process.env.AGENCY_GMAIL_FROM,
  };
  process.env.AGENCY_GMAIL_CLIENT_ID = 'x'; process.env.AGENCY_GMAIL_CLIENT_SECRET = 'x';
  process.env.AGENCY_GMAIL_REFRESH_TOKEN = 'x'; process.env.AGENCY_GMAIL_FROM = 'hello@desetour.com';
  try {
    const result = await sync.syncAgencyMailbox({ adminClient, gmailDeps: { fetch: fetchFn } });
    assert.equal(result.stage, 'cursor_seeded');
    assert.equal(result.historyId, '1000');
    assert.equal(result.matched, 0);
  } finally {
    for (const [k, v] of Object.entries(prevEnv)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
});

// ═══════════════ H2. History pagination + cursor advancement ══════════
// A run processes a history PAGE atomically (every one of its candidates
// succeeds, or none of this page's progress is recorded at all). The
// STABLE cursor only ever advances once the whole range is drained AND
// every candidate in it was handled — never early, never partially.

test('syncAgencyMailbox: a single, fully-drained history page advances the stable cursor to the reported historyId and leaves no continuation', () => withGmailEnv(async () => {
  const adminClient = makeFakeAdminClient({
    agency_emails: [{ data: null, error: null }, { data: [], error: null }],
    agencies: [{ data: [], error: null }],
    settings: [{ data: { value: JSON.stringify({ historyId: '100' }) }, error: null }],
  });
  const gmailDeps = { fetch: makeGmailFetch({ historyPages: [{ history: [], historyId: '150', nextPageToken: null }] }) };
  const result = await sync.syncAgencyMailbox({ adminClient, gmailDeps });
  assert.equal(result.stage, 'synced');
  assert.equal(result.processed, 0);
  const upsertCall = adminClient._calls.find(c => c.table === 'settings' && c.method === 'upsert');
  const stored = JSON.parse(upsertCall.payload.value);
  assert.equal(stored.historyId, '150');
  assert.equal(stored.continuation, null);
}));

test('syncAgencyMailbox: multi-page history — both pages are fetched and every candidate across them is processed in one run when under the caps', () => withGmailEnv(async () => {
  const adminClient = makeFakeAdminClient({
    agency_emails: [{ data: null, error: null }, { data: [], error: null }],
    agencies: [{ data: [], error: null }],
    settings: [{ data: { value: JSON.stringify({ historyId: '100' }) }, error: null }],
  });
  const msgA = gmailMessage({ id: 'gm-a', headers: [{ name: 'From', value: 'random-a@gmail.com' }] });
  const msgB = gmailMessage({ id: 'gm-b', headers: [{ name: 'From', value: 'random-b@gmail.com' }] });
  const gmailDeps = { fetch: makeGmailFetch({
    historyPages: [
      { history: [{ messagesAdded: [{ message: { id: 'gm-a' } }] }], historyId: '200', nextPageToken: 'p2' },
      { history: [{ messagesAdded: [{ message: { id: 'gm-b' } }] }], historyId: '200', nextPageToken: null },
    ],
    messagesById: { 'gm-a': msgA, 'gm-b': msgB },
  }) };
  const result = await sync.syncAgencyMailbox({ adminClient, gmailDeps });
  assert.equal(result.stage, 'synced');
  assert.equal(result.processed, 2);
  assert.equal(result.skipped, 2);
  assert.equal(result.pagesFetched, 2);
  const upsertCall = adminClient._calls.find(c => c.table === 'settings' && c.method === 'upsert');
  assert.equal(JSON.parse(upsertCall.payload.value).historyId, '200');
}));

test('syncAgencyMailbox: the page-count cap is reached before the final page — persists continuation and does NOT advance the stable cursor early', () => withGmailEnv(async () => {
  const N = sync.MAX_HISTORY_PAGES_PER_RUN;
  const pages = [];
  for (let i = 0; i < N; i++) pages.push({ history: [], historyId: '500', nextPageToken: `page-${i + 1}` });
  const adminClient = makeFakeAdminClient({
    agency_emails: [{ data: null, error: null }, { data: [], error: null }],
    agencies: [{ data: [], error: null }],
    settings: [{ data: { value: JSON.stringify({ historyId: '100' }) }, error: null }],
  });
  const gmailDeps = { fetch: makeGmailFetch({ historyPages: pages }) };
  const result = await sync.syncAgencyMailbox({ adminClient, gmailDeps });
  assert.equal(result.stage, 'continuation_saved');
  assert.equal(result.pagesFetched, N);
  const upsertCall = adminClient._calls.find(c => c.table === 'settings' && c.method === 'upsert');
  const stored = JSON.parse(upsertCall.payload.value);
  assert.equal(stored.historyId, '100', 'the STABLE cursor must stay at its old value — it must never advance early');
  assert.ok(stored.continuation);
  assert.equal(stored.continuation.baselineHistoryId, '100');
  assert.equal(stored.continuation.pageToken, `page-${N}`);
  assert.equal(stored.continuation.targetHistoryId, '500');
}));

test('syncAgencyMailbox: continuation resumes on the next run from the exact stored pageToken and baseline, and only then advances the stable cursor', () => withGmailEnv(async () => {
  const N = sync.MAX_HISTORY_PAGES_PER_RUN;
  const adminClient = makeFakeAdminClient({
    agency_emails: [{ data: null, error: null }, { data: [], error: null }, { data: null, error: null }, { data: [], error: null }],
    agencies: [{ data: [], error: null }, { data: [], error: null }],
    settings: [{ data: { value: JSON.stringify({ historyId: '100' }) }, error: null }],
  }, { statefulTables: ['settings'] });

  const firstRunPages = [];
  for (let i = 0; i < N; i++) firstRunPages.push({ history: [], historyId: '500', nextPageToken: `page-${i + 1}` });
  const firstRunFetch = makeGmailFetch({ historyPages: firstRunPages });
  const firstResult = await sync.syncAgencyMailbox({ adminClient, gmailDeps: { fetch: firstRunFetch } });
  assert.equal(firstResult.stage, 'continuation_saved');

  const secondRunFetch = makeGmailFetch({ historyPages: [{ history: [], historyId: '500', nextPageToken: null }] });
  const secondResult = await sync.syncAgencyMailbox({ adminClient, gmailDeps: { fetch: secondRunFetch } });
  assert.equal(secondResult.stage, 'synced');

  const resumedUrl = secondRunFetch.calls.find(u => u.includes('/history'));
  assert.match(resumedUrl, /startHistoryId=100/);
  assert.match(resumedUrl, new RegExp(`pageToken=page-${N}\\b`));

  const finalUpsert = adminClient._calls.filter(c => c.table === 'settings' && c.method === 'upsert').pop();
  const finalStored = JSON.parse(finalUpsert.payload.value);
  assert.equal(finalStored.historyId, '500');
  assert.equal(finalStored.continuation, null);
}));

test('syncAgencyMailbox: a later message\'s fetch failure aborts the whole run without writing any cursor/continuation state — nothing is lost, the whole page is safely retried next time', () => withGmailEnv(async () => {
  const adminClient = makeFakeAdminClient({
    agency_emails: [{ data: null, error: null }, { data: [], error: null }, { data: null, error: null }],
    agencies: [{ data: AGENCIES, error: null }, { error: null }],
    activity_logs: [{ error: null }],
    settings: [{ data: { value: JSON.stringify({ historyId: '100' }) }, error: null }],
  });
  const msgOk = gmailMessage({ id: 'gm-ok', headers: [{ name: 'From', value: 'contact@acme.com' }] });
  const gmailDeps = { fetch: makeGmailFetch({
    historyPages: [{ history: [{ messagesAdded: [{ message: { id: 'gm-ok' } }, { message: { id: 'gm-fails' } }] }], historyId: '200', nextPageToken: null }],
    messagesById: { 'gm-ok': msgOk }, // 'gm-fails' deliberately missing -> the fake transport throws on it
  }) };
  await assert.rejects(() => sync.syncAgencyMailbox({ adminClient, gmailDeps }));
  // The first message's own persistence DID happen — safe/idempotent to repeat, never corrupted.
  assert.equal(adminClient._calls.filter(c => c.table === 'agency_emails' && c.method === 'insert').length, 1);
  // But NOTHING was written to the cursor — the next run retries this
  // exact page (both gm-ok, safely as a replay, and gm-fails) rather than
  // silently skipping past either of them.
  assert.ok(!adminClient._calls.some(c => c.table === 'settings' && c.method === 'upsert'));
}));

// ═══════════════ H3. Stale/invalid startHistoryId recovery ════════════

test('isStaleHistoryIdError recognizes a 404 GmailSendError and nothing else', () => {
  const err404 = new gmailSendClient.GmailSendError('not found', { status: 404 });
  const err400 = new gmailSendClient.GmailSendError('bad request', { status: 400 });
  assert.equal(sync.isStaleHistoryIdError(err404), true);
  assert.equal(sync.isStaleHistoryIdError(err400), false);
  assert.equal(sync.isStaleHistoryIdError(new Error('not a GmailSendError, status irrelevant')), false);
  assert.equal(sync.isStaleHistoryIdError(null), false);
});

test('computeStaleHistoryRecoveryWindowStart falls back to the hard ceiling alone when there is no lastSyncedAt', () => {
  const nowMs = Date.UTC(2026, 0, 10, 0, 0, 0);
  const result = sync.computeStaleHistoryRecoveryWindowStart({ lastSyncedAt: null, nowMs });
  assert.equal(result, Math.floor((nowMs - sync.STALE_HISTORY_RECOVERY_MAX_WINDOW_SECONDS * 1000) / 1000));
});

test('computeStaleHistoryRecoveryWindowStart anchors to lastSyncedAt minus the overlap when that window is tighter than the hard ceiling', () => {
  const nowMs = Date.UTC(2026, 0, 10, 0, 0, 0);
  const lastSyncedAt = new Date(nowMs - 2 * 60 * 60 * 1000).toISOString();
  const result = sync.computeStaleHistoryRecoveryWindowStart({ lastSyncedAt, nowMs });
  const expected = Math.floor((new Date(lastSyncedAt).getTime() - sync.STALE_HISTORY_RECOVERY_OVERLAP_SECONDS * 1000) / 1000);
  assert.equal(result, expected);
});

test('computeStaleHistoryRecoveryWindowStart never returns an earlier time than the hard ceiling even with an ancient lastSyncedAt', () => {
  const nowMs = Date.UTC(2026, 0, 10, 0, 0, 0);
  const lastSyncedAt = new Date(nowMs - 365 * 24 * 60 * 60 * 1000).toISOString();
  const result = sync.computeStaleHistoryRecoveryWindowStart({ lastSyncedAt, nowMs });
  assert.equal(result, Math.floor((nowMs - sync.STALE_HISTORY_RECOVERY_MAX_WINDOW_SECONDS * 1000) / 1000));
});

test('syncAgencyMailbox detects a 404 on listHistory and runs bounded recovery instead of throwing or looping forever', () => withGmailEnv(async () => {
  const adminClient = makeFakeAdminClient({
    agency_emails: [{ data: null, error: null }, { data: [], error: null }, { data: [], error: null }],
    agencies: [{ data: [], error: null }, { data: [], error: null }],
    settings: [{ data: { value: JSON.stringify({ historyId: '100', lastSyncedAt: new Date().toISOString() }) }, error: null }],
  });
  const gmailDeps = { fetch: makeGmailFetch({ staleOnStartHistoryId: '100', profile: { historyId: '999' } }) };
  const result = await sync.syncAgencyMailbox({ adminClient, gmailDeps });
  assert.equal(result.ok, true);
  assert.equal(result.stage, 'recovered_from_stale_history');
  assert.equal(result.historyId, '999');
  const upsertCall = adminClient._calls.find(c => c.table === 'settings' && c.method === 'upsert');
  const stored = JSON.parse(upsertCall.payload.value);
  assert.equal(stored.historyId, '999');
  assert.equal(stored.continuation, null);
  assert.ok(stored.recoveredAt);
}));

test('stale-history recovery never performs an unrestricted mailbox scan — the bounded backfill query stays strictly scoped to known threads/contacts', () => withGmailEnv(async () => {
  const adminClient = makeFakeAdminClient({
    agency_emails: [
      { data: null, error: null },
      { data: [], error: null },
      { data: [{ agency_id: 'AGN-1', provider_thread_id: 'th-acme', internet_message_id: null, provider_message_id: null }], error: null },
    ],
    agencies: [{ data: [], error: null }, { data: AGENCIES, error: null }],
    settings: [{ data: { value: JSON.stringify({ historyId: '100', lastSyncedAt: new Date().toISOString() }) }, error: null }],
  });
  let capturedQuery = null;
  const innerFetch = makeGmailFetch({ staleOnStartHistoryId: '100', profile: { historyId: '999' } });
  const gmailDeps = { fetch: async (url, opts) => {
    const u = String(url);
    if (u.includes('/messages') && !u.includes('/messages/')) capturedQuery = decodeURIComponent(new URL(u).searchParams.get('q') || '');
    return innerFetch(url, opts);
  } };
  const result = await sync.syncAgencyMailbox({ adminClient, gmailDeps });
  assert.equal(result.stage, 'recovered_from_stale_history');
  assert.ok(capturedQuery, 'expected the bounded backfill to query Gmail, scoped');
  assert.match(capturedQuery, /threadId:th-acme/);
  assert.match(capturedQuery, /after:\d+/);
  assert.doesNotMatch(capturedQuery, /in:anywhere/);
}));

test('a failed stale-history recovery (the bounded backfill itself throws) leaves the old cursor completely untouched and reports stale_history_recovery_failed', () => withGmailEnv(async () => {
  const adminClient = makeFakeAdminClient({
    agency_emails: [
      { data: null, error: null },
      { data: [], error: null },
      { data: [{ agency_id: 'AGN-1', provider_thread_id: 'th-x', internet_message_id: null, provider_message_id: null }], error: null },
    ],
    agencies: [{ data: [], error: null }, { data: [], error: null }],
    settings: [{ data: { value: JSON.stringify({ historyId: '100', lastSyncedAt: new Date().toISOString() }) }, error: null }],
  });
  const gmailDeps = { fetch: async (url) => {
    const u = String(url);
    if (u.includes('oauth2.googleapis.com')) return { ok: true, json: async () => ({ access_token: 'tok', expires_in: 3600 }) };
    if (u.includes('/history')) return { ok: false, status: 404, text: async () => 'not found' };
    if (u.includes('/messages') && !u.includes('/messages/')) return { ok: false, status: 500, text: async () => 'boom' };
    throw new Error('unexpected: ' + u);
  } };
  const result = await sync.syncAgencyMailbox({ adminClient, gmailDeps });
  assert.equal(result.ok, false);
  assert.equal(result.stage, 'stale_history_recovery_failed');
  assert.ok(!adminClient._calls.some(c => c.table === 'settings' && c.method === 'upsert'), 'the old cursor must be left completely untouched on a failed recovery');
}));

test('a stale-history recovery whose bounded backfill succeeds but whose profile re-fetch fails also leaves the old cursor untouched', () => withGmailEnv(async () => {
  const adminClient = makeFakeAdminClient({
    agency_emails: [{ data: null, error: null }, { data: [], error: null }, { data: [], error: null }],
    agencies: [{ data: [], error: null }, { data: [], error: null }],
    settings: [{ data: { value: JSON.stringify({ historyId: '100', lastSyncedAt: new Date().toISOString() }) }, error: null }],
  });
  const gmailDeps = { fetch: async (url) => {
    const u = String(url);
    if (u.includes('oauth2.googleapis.com')) return { ok: true, json: async () => ({ access_token: 'tok', expires_in: 3600 }) };
    if (u.includes('/history')) return { ok: false, status: 404, text: async () => 'not found' };
    if (u.includes('/profile')) return { ok: false, status: 500, text: async () => 'boom' };
    throw new Error('unexpected: ' + u);
  } };
  const result = await sync.syncAgencyMailbox({ adminClient, gmailDeps });
  assert.equal(result.ok, false);
  assert.equal(result.stage, 'stale_history_recovery_failed');
  assert.ok(!adminClient._calls.some(c => c.table === 'settings' && c.method === 'upsert'));
}));

test('repeating the bounded recovery catch-up does not duplicate inbound rows — a second pass safely reports the message as a duplicate', () => withGmailEnv(async () => {
  const msg = gmailMessage({ id: 'gm-recovered', threadId: 'th-acme', headers: [{ name: 'From', value: 'contact@acme.com' }] });
  const knownRow = [{ agency_id: 'AGN-1', provider_thread_id: 'th-acme', internet_message_id: null, provider_message_id: null }];

  const adminClient1 = makeFakeAdminClient({
    agency_emails: [{ data: knownRow, error: null }, { data: { id: 'AEM-recovered' }, error: null }],
    agencies: [{ data: [], error: null }, { error: null }],
    activity_logs: [{ error: null }],
  });
  const result1 = await sync.runBoundedBackfill({ adminClient: adminClient1, gmailDeps: { fetch: makeGmailFetch({ messagesById: { 'gm-recovered': msg } }) } });
  assert.equal(result1.matched, 1);
  assert.equal(result1.duplicates, 0);

  const adminClient2 = makeFakeAdminClient({
    agency_emails: [{ data: knownRow, error: null }, uniqueViolationError('gm-recovered')],
    agencies: [{ data: [], error: null }, { error: null }],
  });
  const result2 = await sync.runBoundedBackfill({ adminClient: adminClient2, gmailDeps: { fetch: makeGmailFetch({ messagesById: { 'gm-recovered': msg } }) } });
  assert.equal(result2.matched, 0);
  assert.equal(result2.duplicates, 1);
}));

// ═══════════════ H4. Derived-state convergence (hardened) ═════════════
// An inbound row persisting successfully while the agencies.last_contact_at
// follow-up fails must NOT be treated as "fully processed": the candidate
// throws, no cursor/continuation is written, and the next run's replay
// (now a harmless 23505 duplicate) retries ONLY the follow-up update —
// never a second insert, never a second activity log.

test('processCandidateMessage: the agency follow-up update failing on a genuinely NEW insert throws — the row is persisted but the candidate is not "done"', () => withGmailEnv(async () => {
  const adminClient = makeFakeAdminClient({
    agency_emails: [{ data: { id: 'AEM-new' }, error: null }],
    agencies: [{ error: { message: 'agencies table unavailable' } }],
    activity_logs: [{ error: null }],
  });
  const msg = gmailMessage({ id: 'gm-new', threadId: 'th-acme', headers: [{ name: 'From', value: 'contact@acme.com' }] });
  const indexes = sync.buildMatchingIndexes({ agencies: AGENCIES, agencyEmails: [] });
  let caught = null;
  try {
    await sync.processCandidateMessage({ adminClient, gmailDeps: { fetch: makeGmailFetch({ messagesById: { 'gm-new': msg } }) }, gmailMessageId: 'gm-new', indexes });
  } catch (err) { caught = err; }
  assert.ok(caught, 'expected processCandidateMessage to throw when the follow-up update fails');
  assert.match(caught.message, /agencies table unavailable/);
  // The insert itself DID happen — it is safe/idempotent to repeat.
  assert.equal(adminClient._calls.filter(c => c.table === 'agency_emails' && c.method === 'insert').length, 1);
  // The activity log for this reply WAS recorded — it must never be lost
  // just because the follow-up update failed afterward.
  assert.equal(adminClient._calls.filter(c => c.table === 'activity_logs' && c.method === 'insert').length, 1);
}));

test('syncAgencyMailbox: a follow-up-update failure aborts the run and does NOT advance the stable cursor — a temporary agencies-table failure holds the cursor open rather than silently diverging CRM state', () => withGmailEnv(async () => {
  const adminClient = makeFakeAdminClient({
    agency_emails: [{ data: null, error: null }, { data: [], error: null }, { data: { id: 'AEM-new' }, error: null }],
    agencies: [{ data: AGENCIES, error: null }, { error: { message: 'agencies table unavailable' } }],
    activity_logs: [{ error: null }],
    settings: [{ data: { value: JSON.stringify({ historyId: '100' }) }, error: null }],
  });
  const msg = gmailMessage({ id: 'gm-new', headers: [{ name: 'From', value: 'contact@acme.com' }] });
  const gmailDeps = { fetch: makeGmailFetch({
    historyPages: [{ history: [{ messagesAdded: [{ message: { id: 'gm-new' } }] }], historyId: '200', nextPageToken: null }],
    messagesById: { 'gm-new': msg },
  }) };
  await assert.rejects(() => sync.syncAgencyMailbox({ adminClient, gmailDeps }));
  assert.ok(!adminClient._calls.some(c => c.table === 'settings' && c.method === 'upsert'), 'the stable cursor must not advance when the agency follow-up state failed to converge');
}));

test('a replayed duplicate (the insert already succeeded on a prior, now-aborted run) retries ONLY the follow-up update — never a second insert, never a second activity log — and converges once it finally succeeds', () => withGmailEnv(async () => {
  const msg = gmailMessage({ id: 'gm-retry', threadId: 'th-acme', headers: [{ name: 'From', value: 'contact@acme.com' }] });
  const indexes = sync.buildMatchingIndexes({ agencies: AGENCIES, agencyEmails: [] });

  // Attempt 1: insert succeeds, follow-up update fails -> throws.
  const adminClient1 = makeFakeAdminClient({
    agency_emails: [{ data: { id: 'AEM-retry' }, error: null }],
    agencies: [{ error: { message: 'agencies table unavailable' } }],
    activity_logs: [{ error: null }],
  });
  await assert.rejects(() => sync.processCandidateMessage({
    adminClient: adminClient1, gmailDeps: { fetch: makeGmailFetch({ messagesById: { 'gm-retry': msg } }) }, gmailMessageId: 'gm-retry', indexes,
  }));

  // Attempt 2 (the retry — a fresh adminClient standing in for the next
  // scheduled run against the real, by-then-already-inserted row):
  // insert now hits the unique constraint (a safe duplicate replay);
  // the follow-up update succeeds this time -> fully converged.
  const adminClient2 = makeFakeAdminClient({
    agency_emails: [uniqueViolationError('gm-retry')],
    agencies: [{ error: null }],
    activity_logs: [{ error: null }],
  });
  const outcome = await sync.processCandidateMessage({
    adminClient: adminClient2, gmailDeps: { fetch: makeGmailFetch({ messagesById: { 'gm-retry': msg } }) }, gmailMessageId: 'gm-retry', indexes,
  });
  assert.equal(outcome, 'duplicate');
  assert.equal(adminClient2._calls.filter(c => c.table === 'agencies' && c.method === 'update').length, 1, 'the follow-up update must be retried on the replay');
  assert.equal(adminClient2._calls.filter(c => c.table === 'activity_logs' && c.method === 'insert').length, 0, 'a replay must never create a second activity log row');
}));

test('syncAgencyMailbox: the cursor DOES advance on the run where the follow-up update finally succeeds, even though the insert is now a duplicate replay', () => withGmailEnv(async () => {
  const adminClient = makeFakeAdminClient({
    agency_emails: [{ data: null, error: null }, { data: [], error: null }, uniqueViolationError('gm-retry')],
    agencies: [{ data: AGENCIES, error: null }, { error: null }],
    settings: [{ data: { value: JSON.stringify({ historyId: '100' }) }, error: null }],
  });
  const msg = gmailMessage({ id: 'gm-retry', headers: [{ name: 'From', value: 'contact@acme.com' }] });
  const gmailDeps = { fetch: makeGmailFetch({
    historyPages: [{ history: [{ messagesAdded: [{ message: { id: 'gm-retry' } }] }], historyId: '200', nextPageToken: null }],
    messagesById: { 'gm-retry': msg },
  }) };
  const result = await sync.syncAgencyMailbox({ adminClient, gmailDeps });
  assert.equal(result.stage, 'synced');
  assert.equal(result.duplicates, 1);
  const upsertCall = adminClient._calls.find(c => c.table === 'settings' && c.method === 'upsert');
  assert.ok(upsertCall, 'the stable cursor must advance once the repaired run fully converges');
  assert.equal(JSON.parse(upsertCall.payload.value).historyId, '200');
}));

// ═══════════════ H5. checkMailboxCapability — read-only pre-prod probe ═
// Must never touch any table beyond the one sample-id SELECT, never
// fetch/classify/persist a mailbox message, and never run History API
// pagination or the bounded backfill.

test('checkMailboxCapability returns {ok:true, capability:"full_body_ok"} when a sample exists and format=full succeeds', () => withGmailEnv(async () => {
  const adminClient = makeFakeAdminClient({ agency_emails: [{ data: { provider_message_id: 'gm-sample' }, error: null }] });
  const gmailDeps = { fetch: makeGmailFetch({ messagesById: { 'gm-sample': gmailMessage({ id: 'gm-sample' }) } }) };
  const result = await sync.checkMailboxCapability({ adminClient, gmailDeps });
  assert.deepEqual(result, { ok: true, capability: 'full_body_ok' });
}));

test('checkMailboxCapability returns {ok:false, capability:"insufficient_scope"} on Gmail\'s documented scope rejection', () => withGmailEnv(async () => {
  const adminClient = makeFakeAdminClient({ agency_emails: [{ data: { provider_message_id: 'gm-sample' }, error: null }] });
  const gmailDeps = { fetch: async (url) => {
    if (String(url).includes('oauth2.googleapis.com')) return { ok: true, json: async () => ({ access_token: 'tok', expires_in: 3600 }) };
    return { ok: false, status: 400, text: async () => "Metadata scope doesn't allow format FULL" };
  } };
  const result = await sync.checkMailboxCapability({ adminClient, gmailDeps });
  assert.deepEqual(result, { ok: false, capability: 'insufficient_scope' });
}));

test('checkMailboxCapability returns {ok:false, capability:"unknown_error"} when there is no prior outbound send to sample against', () => withGmailEnv(async () => {
  const adminClient = makeFakeAdminClient({ agency_emails: [{ data: null, error: null }] });
  const result = await sync.checkMailboxCapability({ adminClient, gmailDeps: {} });
  assert.deepEqual(result, { ok: false, capability: 'unknown_error' });
}));

test('checkMailboxCapability never calls fetchMessageFull/classifyInboundMessage/persistInboundMessage — it only probes capability, never reads a real mailbox message', () => withGmailEnv(async () => {
  const adminClient = makeFakeAdminClient({ agency_emails: [{ data: { provider_message_id: 'gm-sample' }, error: null }] });
  let messagesFetched = 0;
  const gmailDeps = { fetch: async (url) => {
    if (String(url).includes('oauth2.googleapis.com')) return { ok: true, json: async () => ({ access_token: 'tok', expires_in: 3600 }) };
    messagesFetched += 1;
    return { ok: true, json: async () => gmailMessage({ id: 'gm-sample' }) };
  } };
  await sync.checkMailboxCapability({ adminClient, gmailDeps });
  // Exactly the ONE capability probe fetch (format=full on the sample id)
  // — never a second fetch, never History API pagination, never backfill.
  assert.equal(messagesFetched, 1);
  assert.ok(!adminClient._calls.some(c => c.method !== 'select' && c.method !== 'eq' && c.method !== 'not' && c.method !== 'order' && c.method !== 'limit' && c.method !== 'maybeSingle'), 'no write of any kind');
}));

test('checkMailboxCapability performs exactly one Supabase call (the sample-id read) and nothing else', () => withGmailEnv(async () => {
  const adminClient = makeFakeAdminClient({ agency_emails: [{ data: { provider_message_id: 'gm-sample' }, error: null }] });
  const gmailDeps = { fetch: makeGmailFetch({ messagesById: { 'gm-sample': gmailMessage({ id: 'gm-sample' }) } }) };
  await sync.checkMailboxCapability({ adminClient, gmailDeps });
  const tablesTouched = new Set(adminClient._calls.map(c => c.table));
  assert.deepEqual([...tablesTouched], ['agency_emails']);
  assert.ok(!adminClient._calls.some(c => ['insert', 'update', 'upsert'].includes(c.method)), 'never a write of any kind');
}));

// ═══════════════ H6. logInboundReply — operational notification event ═
// A real, previously undetected bug: entity_id is a UUID column, but
// this function used to pass the Gmail message id (a plain string) —
// every single call failed its own CHECK/type constraint, silently
// swallowed by this function's own soft-fail. Also, 'reply_received'
// was never an allowed activity_logs.action value at all. Both are
// fixed here using only values the schema already allows — no migration.

test('truncateForNotificationPreview collapses whitespace and truncates to MAX_NOTIFICATION_PREVIEW_LENGTH with an ellipsis only when actually cut', () => {
  assert.equal(sync.truncateForNotificationPreview('  hello   world  '), 'hello world');
  assert.equal(sync.truncateForNotificationPreview(''), '');
  assert.equal(sync.truncateForNotificationPreview(null), '');
  const long = 'x'.repeat(sync.MAX_NOTIFICATION_PREVIEW_LENGTH + 50);
  const result = sync.truncateForNotificationPreview(long);
  assert.equal(result.length, sync.MAX_NOTIFICATION_PREVIEW_LENGTH + 1); // +1 for the ellipsis char
  assert.ok(result.endsWith('…'));
  const short = 'x'.repeat(sync.MAX_NOTIFICATION_PREVIEW_LENGTH);
  assert.equal(sync.truncateForNotificationPreview(short), short);
});

test('logInboundReply inserts action:"reply" (an already-allowed activity_logs.action value) — never the unsupported "reply_received"', async () => {
  const adminClient = makeFakeAdminClient({ activity_logs: [{ error: null }] });
  await sync.logInboundReply({ adminClient, agencyId: 'AGN-1', agencyEmailId: 'AEM-real-uuid', agencyName: 'Deniz Tur', subject: 'Re: Teklif', bodyPreview: 'Teşekkürler, uygun.' });
  const insertCall = adminClient._calls.find(c => c.table === 'activity_logs' && c.method === 'insert');
  assert.ok(insertCall);
  assert.equal(insertCall.payload.action, 'reply');
  assert.notEqual(insertCall.payload.action, 'reply_received');
});

test('logInboundReply writes entity_id as the REAL agency_emails row id it was given — never a Gmail message id', async () => {
  const adminClient = makeFakeAdminClient({ activity_logs: [{ error: null }] });
  await sync.logInboundReply({ adminClient, agencyId: 'AGN-1', agencyEmailId: 'AEM-real-uuid', agencyName: 'Deniz Tur' });
  const insertCall = adminClient._calls.find(c => c.table === 'activity_logs' && c.method === 'insert');
  assert.equal(insertCall.payload.entity_id, 'AEM-real-uuid');
});

test('logInboundReply sets metadata.auto_ingested="true" — the exact convention the Civitatis reservation notification already uses — making the row eligible for the shared operational notification feed', async () => {
  const adminClient = makeFakeAdminClient({ activity_logs: [{ error: null }] });
  await sync.logInboundReply({ adminClient, agencyId: 'AGN-1', agencyEmailId: 'AEM-1', agencyName: 'Deniz Tur' });
  const insertCall = adminClient._calls.find(c => c.table === 'activity_logs' && c.method === 'insert');
  assert.equal(insertCall.payload.metadata.auto_ingested, 'true');
});

test('logInboundReply denormalizes agency_name/subject/body_preview into metadata, safely short — never the full body', async () => {
  const adminClient = makeFakeAdminClient({ activity_logs: [{ error: null }] });
  await sync.logInboundReply({ adminClient, agencyId: 'AGN-1', agencyEmailId: 'AEM-1', agencyName: 'Deniz Tur', subject: 'Re: Teklif', bodyPreview: 'Kısa önizleme.' });
  const insertCall = adminClient._calls.find(c => c.table === 'activity_logs' && c.method === 'insert');
  assert.equal(insertCall.payload.metadata.agency_name, 'Deniz Tur');
  assert.equal(insertCall.payload.metadata.subject, 'Re: Teklif');
  assert.equal(insertCall.payload.metadata.body_preview, 'Kısa önizleme.');
  assert.equal(insertCall.payload.metadata.agency_id, 'AGN-1');
});

test('processCandidateMessage: a genuinely new match logs an activity row with the real inserted UUID as entity_id, the agency\'s own name, and a short body preview', () => withGmailEnv(async () => {
  const adminClient = makeFakeAdminClient({
    agency_emails: [{ data: { id: 'AEM-real-id' }, error: null }],
    agencies: [{ error: null }],
    activity_logs: [{ error: null }],
  });
  const msg = gmailMessage({
    id: 'gm-new', threadId: 'th-acme',
    headers: [{ name: 'From', value: 'contact@acme.com' }, { name: 'Subject', value: 'Re: Teklif' }],
    bodyText: 'Çok teşekkürler, uygun görünüyor.',
  });
  const indexes = sync.buildMatchingIndexes({ agencies: AGENCIES, agencyEmails: [] });
  const outcome = await sync.processCandidateMessage({
    adminClient, gmailDeps: { fetch: makeGmailFetch({ messagesById: { 'gm-new': msg } }) }, gmailMessageId: 'gm-new', indexes,
  });
  assert.equal(outcome, 'matched');
  const logCall = adminClient._calls.find(c => c.table === 'activity_logs' && c.method === 'insert');
  assert.ok(logCall);
  assert.equal(logCall.payload.entity_id, 'AEM-real-id');
  assert.equal(logCall.payload.action, 'reply');
  assert.equal(logCall.payload.metadata.auto_ingested, 'true');
  assert.equal(logCall.payload.metadata.agency_name, AGENCIES.find(a => a.id === 'AGN-1').name);
  assert.equal(logCall.payload.metadata.subject, 'Re: Teklif');
  assert.match(logCall.payload.metadata.body_preview, /teşekkürler/i);
}));
