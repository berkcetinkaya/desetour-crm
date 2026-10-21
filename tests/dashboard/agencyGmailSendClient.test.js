'use strict';
/**
 * tests/dashboard/agencyGmailSendClient.test.js
 * ─────────────────────────────────────────────────────────────────────────
 * Agency Mailbox Phase A — api/_agencies/gmailSendClient.js. Every network
 * call is injected via deps.fetch — no live network access, matching
 * every other test in this project.
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

async function withoutEnv(missingKey, fn) {
  const keys = ['AGENCY_GMAIL_CLIENT_ID', 'AGENCY_GMAIL_CLIENT_SECRET', 'AGENCY_GMAIL_REFRESH_TOKEN', 'AGENCY_GMAIL_FROM'];
  const prev = {};
  for (const k of keys) prev[k] = process.env[k];
  for (const k of keys) {
    if (k === missingKey) delete process.env[k];
    else process.env[k] = 'present';
  }
  gmailSendClient._resetAccessTokenCacheForTests();
  try { return await fn(); }
  finally {
    for (const k of keys) { if (prev[k] === undefined) delete process.env[k]; else process.env[k] = prev[k]; }
    gmailSendClient._resetAccessTokenCacheForTests();
  }
}

function fakeFetchSequence(responses) {
  let i = 0;
  return async () => {
    const r = responses[Math.min(i, responses.length - 1)];
    i += 1;
    return r;
  };
}

function okJson(body) {
  return { ok: true, json: async () => body, text: async () => JSON.stringify(body) };
}
function errResp(status, text = 'error') {
  return { ok: false, status, text: async () => text, json: async () => ({}) };
}

// ── A. Configuration fails closed ───────────────────────────────────────

test('missing any AGENCY_GMAIL_* env var fails closed with ConfigurationError, never silently proceeds', () => {
  for (const key of ['AGENCY_GMAIL_CLIENT_ID', 'AGENCY_GMAIL_CLIENT_SECRET', 'AGENCY_GMAIL_REFRESH_TOKEN', 'AGENCY_GMAIL_FROM']) {
    withoutEnv(key, () => {
      assert.throws(() => gmailSendClient.requireEnv(), gmailSendClient.ConfigurationError);
    });
  }
});

test('AGENCY_GMAIL_FROM resolves to hello@desetour.com in the documented setup', () => withEnv(() => {
  const { fromEmail } = gmailSendClient.requireEnv();
  assert.equal(fromEmail, 'hello@desetour.com');
}));

test('ConfigurationError never leaks a credential value in its message', () => {
  withoutEnv('AGENCY_GMAIL_REFRESH_TOKEN', () => {
    try { gmailSendClient.requireEnv(); assert.fail('expected throw'); }
    catch (err) {
      assert.doesNotMatch(err.message, /present/); // the dummy value used for the other three env vars in this test
    }
  });
});

// ── B. Unicode handling ──────────────────────────────────────────────────

test('encodeHeaderUtf8 round-trips Turkish, Spanish, Portuguese, Italian, and plain English text', () => {
  const samples = [
    'Türkiye\'den Selamlar ı ş ğ ç ö ü',
    'Hola, ¿cómo estás? España',
    'Olá, como você está? São Paulo',
    'Ciao, come stai? Città',
    'Hello from Dese Tour',
  ];
  for (const text of samples) {
    const encoded = gmailSendClient.encodeHeaderUtf8(text);
    assert.match(encoded, /^=\?UTF-8\?B\?.+\?=$/);
    const b64 = encoded.slice('=?UTF-8?B?'.length, -'?='.length);
    assert.equal(Buffer.from(b64, 'base64').toString('utf8'), text);
  }
});

test('base64EncodeBodyWrapped round-trips a multi-paragraph Unicode body and wraps at 76 chars', () => {
  const body = 'Merhaba,\n\nBu bir test e-postasıdır: ı ş ğ ç ö ü İ Ş Ğ Ç Ö Ü. ' + 'x'.repeat(200);
  const encoded = gmailSendClient.base64EncodeBodyWrapped(body);
  const lines = encoded.split('\r\n');
  for (const line of lines.slice(0, -1)) assert.ok(line.length <= 76);
  const decoded = Buffer.from(lines.join(''), 'base64').toString('utf8');
  assert.equal(decoded, body);
});

test('buildRawMimeMessage rejects an invalid recipient address before ever building anything', () => {
  assert.throws(() => gmailSendClient.buildRawMimeMessage({
    fromEmail: 'hello@desetour.com', fromName: 'Dese Tour', toEmail: 'not-an-email', subject: 'x', bodyText: 'y',
  }), gmailSendClient.GmailSendError);
});

test('buildRawMimeMessage uses the exact From/To/Subject/MIME headers specified, UTF-8, no attachments/CC/BCC', () => {
  const raw = gmailSendClient.buildRawMimeMessage({
    fromEmail: 'hello@desetour.com', fromName: 'Dese Tour', toEmail: 'acente@example.com',
    subject: 'Türkçe Konu ş ğ', bodyText: 'Merhaba İspanya',
  });
  const decoded = Buffer.from(raw.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
  assert.match(decoded, /^From: Dese Tour <hello@desetour\.com>\r\n/);
  assert.match(decoded, /\r\nTo: acente@example\.com\r\n/);
  assert.match(decoded, /\r\nSubject: =\?UTF-8\?B\?/);
  assert.match(decoded, /\r\nMIME-Version: 1\.0\r\n/);
  assert.match(decoded, /\r\nContent-Type: text\/plain; charset="UTF-8"\r\n/);
  assert.match(decoded, /\r\nContent-Transfer-Encoding: base64\r\n/);
  assert.doesNotMatch(decoded, /\r\nCc:/i);
  assert.doesNotMatch(decoded, /\r\nBcc:/i);
  assert.doesNotMatch(decoded, /Content-Disposition: attachment/i);
});

test('buildRawMimeMessage never sets its own Message-ID header (Gmail assigns the real one — see fetchMessageIdHeader)', () => {
  const raw = gmailSendClient.buildRawMimeMessage({
    fromEmail: 'hello@desetour.com', fromName: 'Dese Tour', toEmail: 'acente@example.com', subject: 'x', bodyText: 'y',
  });
  const decoded = Buffer.from(raw.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
  assert.doesNotMatch(decoded, /\r\nMessage-ID:/i);
});

// ── C. sendMessage / fetchMessageIdHeader ───────────────────────────────

test('sendMessage calls Gmail with the exact configured sender and the given recipient', () => withEnv(async () => {
  let capturedUrl = null, capturedBody = null;
  const fetchFn = async (url, opts) => {
    if (String(url).includes('oauth2.googleapis.com')) return okJson({ access_token: 'tok', expires_in: 3600 });
    capturedUrl = String(url);
    capturedBody = JSON.parse(opts.body);
    return okJson({ id: 'gm-1', threadId: 'th-1' });
  };
  const result = await gmailSendClient.sendMessage({ toEmail: 'acente@example.com', subject: 'Konu', bodyText: 'Gövde' }, { fetch: fetchFn });
  assert.match(capturedUrl, /\/messages\/send$/);
  assert.ok(capturedBody.raw);
  const decoded = Buffer.from(capturedBody.raw.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
  assert.match(decoded, /From: Dese Tour <hello@desetour\.com>/);
  assert.match(decoded, /To: acente@example\.com/);
  assert.equal(result.gmailMessageId, 'gm-1');
  assert.equal(result.gmailThreadId, 'th-1');
  assert.equal(result.fromEmail, 'hello@desetour.com');
}));

test('sendMessage throws GmailSendError (never resolves) when Gmail rejects the send', () => withEnv(async () => {
  const fetchFn = async (url) => {
    if (String(url).includes('oauth2.googleapis.com')) return okJson({ access_token: 'tok', expires_in: 3600 });
    return errResp(400, 'invalid request');
  };
  await assert.rejects(
    () => gmailSendClient.sendMessage({ toEmail: 'acente@example.com', subject: 'x', bodyText: 'y' }, { fetch: fetchFn }),
    gmailSendClient.GmailSendError
  );
}));

test('fetchMessageIdHeader returns the Message-Id header value when present', () => withEnv(async () => {
  const fetchFn = async (url) => {
    if (String(url).includes('oauth2.googleapis.com')) return okJson({ access_token: 'tok', expires_in: 3600 });
    return okJson({ payload: { headers: [{ name: 'Message-Id', value: '<abc123@mail.gmail.com>' }] } });
  };
  const id = await gmailSendClient.fetchMessageIdHeader('gm-1', { fetch: fetchFn });
  assert.equal(id, '<abc123@mail.gmail.com>');
}));

test('fetchMessageIdHeader requests ONLY the Message-Id metadata header, never the body', () => withEnv(async () => {
  let capturedUrl = null;
  const fetchFn = async (url) => {
    if (String(url).includes('oauth2.googleapis.com')) return okJson({ access_token: 'tok', expires_in: 3600 });
    capturedUrl = String(url);
    return okJson({ payload: { headers: [] } });
  };
  await gmailSendClient.fetchMessageIdHeader('gm-1', { fetch: fetchFn });
  assert.match(capturedUrl, /format=metadata/);
  assert.match(capturedUrl, /metadataHeaders=Message-Id/);
}));

test('fetchMessageIdHeader returns null (never fabricates a value) when the header is absent', () => withEnv(async () => {
  const fetchFn = async (url) => {
    if (String(url).includes('oauth2.googleapis.com')) return okJson({ access_token: 'tok', expires_in: 3600 });
    return okJson({ payload: { headers: [] } });
  };
  const id = await gmailSendClient.fetchMessageIdHeader('gm-1', { fetch: fetchFn });
  assert.equal(id, null);
}));

test('fetchMessageIdHeader returns null (never throws) when the fetch itself fails', () => withEnv(async () => {
  const fetchFn = async (url) => {
    if (String(url).includes('oauth2.googleapis.com')) return okJson({ access_token: 'tok', expires_in: 3600 });
    return errResp(500, 'server error');
  };
  const id = await gmailSendClient.fetchMessageIdHeader('gm-1', { fetch: fetchFn });
  assert.equal(id, null);
}));

test('getAccessToken caches the token across calls within the same process', () => withEnv(async () => {
  let tokenCalls = 0;
  const fetchFn = fakeFetchSequence([okJson({ access_token: 'tok', expires_in: 3600 })]);
  const wrapped = async (url, opts) => { if (String(url).includes('oauth2.googleapis.com')) tokenCalls += 1; return fetchFn(url, opts); };
  await gmailSendClient.getAccessToken({ fetch: wrapped });
  await gmailSendClient.getAccessToken({ fetch: wrapped });
  assert.equal(tokenCalls, 1);
}));
