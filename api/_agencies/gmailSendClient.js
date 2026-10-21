/**
 * api/_agencies/gmailSendClient.js
 * ─────────────────────────────────────────────────────────────────────────
 * Agency Mailbox Phase A — minimal Gmail REST API client for SENDING
 * outbound outreach from hello@desetour.com. Server-side only (Vercel
 * function), never reachable from browser code.
 *
 * COMPLETELY SEPARATE from api/_civitatis/gmailClient.js: that module is
 * read-only and dedicated to reservation@desetour.com (Civitatis booking
 * ingestion). This module is write-only (send + the one minimal read
 * needed to recover a sent message's Message-ID — see fetchMessageIdHeader
 * below) and dedicated to hello@desetour.com. The two mailboxes are
 * different Google accounts, so they use entirely separate OAuth
 * credentials (separate environment variables — see requireEnv) and
 * separate in-memory token caches. Neither module imports the other;
 * nothing here ever modifies api/_civitatis/gmailClient.js's behavior.
 *
 * Every credential is read from environment variables at call time —
 * never hard-coded, never logged, never returned in any response body.
 * Fails closed with a clear ConfigurationError if any are missing.
 *
 * SCOPES: sending (users.messages.send) needs gmail.send. Fetching a
 * message's headers after send (fetchMessageIdHeader) needs gmail.send's
 * own scope does NOT cover read access — that is a Gmail API scope you
 * can look up for yourself, Google's own documented restriction. This
 * module's fetchMessageIdHeader call therefore additionally requires
 * gmail.readonly (or broader) to have been granted during OAuth consent —
 * see the implementation report for the exact recommendation on when to
 * authorize it.
 * ─────────────────────────────────────────────────────────────────────────
 */
'use strict';

const crypto = require('crypto');

const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const GMAIL_API_BASE = 'https://www.googleapis.com/gmail/v1/users/me';

class ConfigurationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConfigurationError';
  }
}

class GmailSendError extends Error {
  constructor(message, { stage } = {}) {
    super(message);
    this.name = 'GmailSendError';
    this.stage = stage || 'unknown';
  }
}

function requireEnv() {
  const clientId = process.env.AGENCY_GMAIL_CLIENT_ID;
  const clientSecret = process.env.AGENCY_GMAIL_CLIENT_SECRET;
  const refreshToken = process.env.AGENCY_GMAIL_REFRESH_TOKEN;
  const fromEmail = process.env.AGENCY_GMAIL_FROM;
  const missing = [
    !clientId && 'AGENCY_GMAIL_CLIENT_ID',
    !clientSecret && 'AGENCY_GMAIL_CLIENT_SECRET',
    !refreshToken && 'AGENCY_GMAIL_REFRESH_TOKEN',
    !fromEmail && 'AGENCY_GMAIL_FROM',
  ].filter(Boolean);
  if (missing.length > 0) {
    throw new ConfigurationError(
      `Agency mailbox sending is not configured: missing environment variable(s): ${missing.join(', ')}. ` +
      'These must be set as server-side Vercel environment variables (never committed to source, never sent to browser code).'
    );
  }
  return { clientId, clientSecret, refreshToken, fromEmail };
}

let _cachedAccessToken = null;
let _cachedAccessTokenExpiresAt = 0;

/** Exchanges the long-lived Agency refresh token for a short-lived access
 * token. Cached in-memory for this process's lifetime only — entirely
 * separate from api/_civitatis/gmailClient.js's own cache. */
async function getAccessToken(deps = {}) {
  const fetchFn = deps.fetch || fetch;
  const { clientId, clientSecret, refreshToken } = requireEnv();

  if (_cachedAccessToken && Date.now() < _cachedAccessTokenExpiresAt - 60_000) {
    return _cachedAccessToken;
  }

  const response = await fetchFn(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }),
  });

  if (!response.ok) {
    const bodyText = await response.text().catch(() => '');
    throw new GmailSendError(`Agency Gmail OAuth token refresh failed (${response.status}): ${bodyText.slice(0, 300)}`, { stage: 'token_refresh' });
  }

  const json = await response.json();
  _cachedAccessToken = json.access_token;
  _cachedAccessTokenExpiresAt = Date.now() + (json.expires_in || 3600) * 1000;
  return _cachedAccessToken;
}

/** Test-only: clears the module-level token cache so each test starts
 * from a clean slate. Never called from production code paths. */
function _resetAccessTokenCacheForTests() {
  _cachedAccessToken = null;
  _cachedAccessTokenExpiresAt = 0;
}

function base64UrlEncode(buffer) {
  return buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

/** RFC 2047 "encoded word" for a header value that may contain non-ASCII
 * characters (Turkish, Spanish, Portuguese, Italian, or plain English —
 * English ASCII text round-trips through this unchanged in meaning, just
 * base64-wrapped like everything else). Applied to Subject only — From/
 * To are always plain ASCII email addresses in this V1 (no display-name
 * Unicode requirement was asked for). */
function encodeHeaderUtf8(text) {
  const b64 = Buffer.from(String(text || ''), 'utf8').toString('base64');
  return `=?UTF-8?B?${b64}?=`;
}

/** Base64-encodes a UTF-8 body, line-wrapped at 76 characters per RFC
 * 2045 — the standard, safe transfer encoding for a text/plain part that
 * may contain any Unicode character (Turkish ı/ş/ğ, Spanish ñ,
 * Portuguese ã/ç, Italian à/è, or plain ASCII) without any risk of an
 * intermediate system mangling raw 8-bit bytes in transit. */
function base64EncodeBodyWrapped(text) {
  const b64 = Buffer.from(String(text || ''), 'utf8').toString('base64');
  const lines = [];
  for (let i = 0; i < b64.length; i += 76) lines.push(b64.slice(i, i + 76));
  return lines.join('\r\n');
}

function isValidEmailAddress(email) {
  return typeof email === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
}

/**
 * Builds one RFC 2822 message (CRLF line endings, as the RFC requires)
 * and returns it base64url-encoded, ready for Gmail API's
 * users.messages.send `raw` field.
 *
 * Deliberately does NOT set a Message-ID header itself: Gmail assigns
 * its own canonical one on send regardless, and self-generating one here
 * would either be silently overwritten (wasted effort) or risk a
 * malformed/duplicate value — see fetchMessageIdHeader for how the real,
 * Gmail-assigned Message-ID is retrieved afterward instead of being
 * guessed or fabricated here.
 *
 * No attachments, no CC/BCC — both explicitly out of scope for V1.
 */
function buildRawMimeMessage({ fromEmail, fromName, toEmail, subject, bodyText }) {
  if (!isValidEmailAddress(toEmail)) {
    throw new GmailSendError(`Invalid recipient email address: "${toEmail}"`, { stage: 'validation' });
  }
  const fromHeader = fromName ? `${fromName} <${fromEmail}>` : fromEmail;
  const lines = [
    `From: ${fromHeader}`,
    `To: ${toEmail}`,
    `Subject: ${encodeHeaderUtf8(subject)}`,
    `Date: ${new Date().toUTCString()}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: base64',
    '',
    base64EncodeBodyWrapped(bodyText),
  ];
  const raw = lines.join('\r\n');
  return base64UrlEncode(Buffer.from(raw, 'utf8'));
}

async function gmailApiFetch(path, { accessToken, method = 'GET', params, body, fetchImpl } = {}) {
  const fetchFn = fetchImpl || fetch;
  const url = new URL(`${GMAIL_API_BASE}${path}`);
  if (params) {
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null) url.searchParams.set(key, value);
    }
  }
  const response = await fetchFn(url, {
    method,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!response.ok) {
    const bodyText = await response.text().catch(() => '');
    throw new GmailSendError(`Gmail API request to ${path} failed (${response.status}): ${bodyText.slice(0, 300)}`, { stage: 'api_request' });
  }
  return response.json();
}

/**
 * Sends one outbound email via Gmail API's users.messages.send. Returns
 * ONLY the two identifiers Gmail's send response actually contains
 * (id, threadId) — it never contains message headers, so the RFC
 * Message-ID is never available here; see fetchMessageIdHeader.
 *
 * Any error thrown by this function means Gmail did NOT accept the send
 * (the HTTP call itself failed or returned a non-2xx status) — the
 * caller may safely treat a thrown error here as "not sent". Once this
 * function RESOLVES successfully, the email has been accepted by Gmail
 * and must never be re-sent, no matter what happens afterward.
 */
async function sendMessage({ toEmail, subject, bodyText }, deps = {}) {
  const { fromEmail } = requireEnv();
  const accessToken = await getAccessToken(deps);
  const raw = buildRawMimeMessage({ fromEmail, fromName: 'Dese Tour', toEmail, subject, bodyText });
  const result = await gmailApiFetch('/messages/send', {
    accessToken,
    method: 'POST',
    body: { raw },
    fetchImpl: deps.fetch,
  });
  return { gmailMessageId: result.id, gmailThreadId: result.threadId, fromEmail };
}

/**
 * Fetches ONLY the Message-ID header of an already-sent message — the
 * minimum possible request (format=metadata, metadataHeaders scoped to
 * exactly one header) to recover the RFC Message-ID Gmail assigned,
 * without ever reading the message body. Requires gmail.readonly (or
 * broader) on top of gmail.send — see this module's header comment.
 *
 * Returns null (never a fabricated value) if the header is absent or
 * this call itself fails — the caller already has gmailMessageId/
 * gmailThreadId from sendMessage and must proceed with internet_message_id
 * left null rather than invent one.
 */
async function fetchMessageIdHeader(gmailMessageId, deps = {}) {
  try {
    const accessToken = await getAccessToken(deps);
    const result = await gmailApiFetch(`/messages/${gmailMessageId}`, {
      accessToken,
      params: { format: 'metadata', metadataHeaders: 'Message-Id' },
      fetchImpl: deps.fetch,
    });
    const headers = (result.payload && result.payload.headers) || [];
    const header = headers.find(h => h.name.toLowerCase() === 'message-id');
    return header ? header.value : null;
  } catch (_err) {
    return null;
  }
}

module.exports = {
  ConfigurationError,
  GmailSendError,
  requireEnv,
  getAccessToken,
  sendMessage,
  fetchMessageIdHeader,
  buildRawMimeMessage,
  encodeHeaderUtf8,
  base64EncodeBodyWrapped,
  base64UrlEncode,
  isValidEmailAddress,
  _resetAccessTokenCacheForTests,
};
