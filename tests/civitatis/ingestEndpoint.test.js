'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

// No network access, no Gmail mailbox, no Supabase connection anywhere in
// this file — it only verifies that the actual Vercel handler fails safely
// (a clear 503 configuration error) when Gmail/Supabase env vars are
// absent, which is the real, guaranteed state of this sandbox and of any
// deployment before setup is completed.

function makeRes() {
  const res = {
    statusCode: null,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
  };
  return res;
}

test('GET with no Gmail credentials configured responds 503 with a clear configuration error, never a stack trace or a silent success', async () => {
  delete process.env.GMAIL_CLIENT_ID;
  delete process.env.GMAIL_CLIENT_SECRET;
  delete process.env.GMAIL_REFRESH_TOKEN;
  delete process.env.SUPABASE_URL;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;

  const handler = require('../../api/ingest-civitatis');
  const req = { method: 'GET', query: {} };
  const res = makeRes();
  await handler(req, res);

  assert.equal(res.statusCode, 503);
  assert.equal(res.body.stage, 'gmail_configuration');
  assert.ok(res.body.error.includes('GMAIL_CLIENT_ID'));
});

test('rejects an unsupported mode parameter (e.g. mode=write) with a 400, never silently ignoring it', async () => {
  const handler = require('../../api/ingest-civitatis');
  const req = { method: 'GET', query: { mode: 'write' } };
  const res = makeRes();
  await handler(req, res);

  assert.equal(res.statusCode, 400);
  assert.ok(res.body.error.includes('not supported'));
});

test('rejects non-GET/POST methods', async () => {
  const handler = require('../../api/ingest-civitatis');
  const req = { method: 'DELETE', query: {} };
  const res = makeRes();
  await handler(req, res);
  assert.equal(res.statusCode, 405);
});

test('debugMime=1 with no Gmail credentials configured responds 503 with a clear configuration error, and never touches Supabase', async () => {
  delete process.env.GMAIL_CLIENT_ID;
  delete process.env.GMAIL_CLIENT_SECRET;
  delete process.env.GMAIL_REFRESH_TOKEN;
  delete process.env.SUPABASE_URL;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;

  const handler = require('../../api/ingest-civitatis');
  const req = { method: 'GET', query: { debugMime: '1' } };
  const res = makeRes();
  await handler(req, res);

  assert.equal(res.statusCode, 503);
  assert.equal(res.body.stage, 'gmail_configuration');
});

test('mode=write is still rejected with 400 even when debugMime=1 is also passed', async () => {
  const handler = require('../../api/ingest-civitatis');
  const req = { method: 'GET', query: { mode: 'write', debugMime: '1' } };
  const res = makeRes();
  await handler(req, res);

  assert.equal(res.statusCode, 400);
  assert.ok(res.body.error.includes('not supported'));
});

test('debugParser=1 with no Gmail credentials configured responds 503 with a clear configuration error, and never touches Supabase', async () => {
  delete process.env.GMAIL_CLIENT_ID;
  delete process.env.GMAIL_CLIENT_SECRET;
  delete process.env.GMAIL_REFRESH_TOKEN;
  delete process.env.SUPABASE_URL;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;

  const handler = require('../../api/ingest-civitatis');
  const req = { method: 'GET', query: { debugParser: '1' } };
  const res = makeRes();
  await handler(req, res);

  assert.equal(res.statusCode, 503);
  assert.equal(res.body.stage, 'gmail_configuration');
});

test('mode=write is still rejected with 400 even when debugParser=1 is also passed', async () => {
  const handler = require('../../api/ingest-civitatis');
  const req = { method: 'GET', query: { mode: 'write', debugParser: '1' } };
  const res = makeRes();
  await handler(req, res);

  assert.equal(res.statusCode, 400);
  assert.ok(res.body.error.includes('not supported'));
});
