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
  constructor(message, { stage, status } = {}) {
    super(message);
    this.name = 'GmailSendError';
    this.stage = stage || 'unknown';
    // The HTTP status Gmail actually returned, when known — lets callers
    // classify failures structurally (e.g. a 404 on the History API means
    // an expired/invalid startHistoryId) instead of pattern-matching
    // Gmail's own free-text error body, which is never guaranteed stable.
    this.status = typeof status === 'number' ? status : null;
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
 * `inReplyTo`/`references` (Agency Mailbox Phase 2/7 — same-thread CRM
 * replies) are OPTIONAL and additive: when omitted (the default, and the
 * only case that existed before this phase), neither header is emitted
 * and every byte of the message is identical to before — the existing
 * new-thread outreach send behavior is completely unaffected. When
 * provided, they are the RFC Message-ID(s) of the message being replied
 * to (never fabricated — always a value this module or the caller
 * already received from a real Gmail response).
 *
 * No attachments, no CC/BCC — both explicitly out of scope for V1.
 */
function buildRawMimeMessage({ fromEmail, fromName, toEmail, subject, bodyText, inReplyTo, references }) {
  if (!isValidEmailAddress(toEmail)) {
    throw new GmailSendError(`Invalid recipient email address: "${toEmail}"`, { stage: 'validation' });
  }
  const fromHeader = fromName ? `${fromName} <${fromEmail}>` : fromEmail;
  const lines = [
    `From: ${fromHeader}`,
    `To: ${toEmail}`,
    `Subject: ${encodeHeaderUtf8(subject)}`,
    `Date: ${new Date().toUTCString()}`,
    ...(inReplyTo ? [`In-Reply-To: ${inReplyTo}`] : []),
    ...(references ? [`References: ${references}`] : []),
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
    throw new GmailSendError(`Gmail API request to ${path} failed (${response.status}): ${bodyText.slice(0, 300)}`, { stage: 'api_request', status: response.status });
  }
  return response.json();
}

/**
 * Sends one outbound email via Gmail API's users.messages.send. Returns
 * ONLY the two identifiers Gmail's send response actually contains
 * (id, threadId) — it never contains message headers, so the RFC
 * Message-ID is never available here; see fetchMessageIdHeader.
 *
 * `threadId`/`inReplyTo`/`references` (Agency Mailbox Phase 2/7) are
 * OPTIONAL. Omitted (the default): behaves exactly as before this phase
 * — Gmail starts a new thread, no reply headers. Provided: the request
 * body additionally carries `threadId` so Gmail groups the sent message
 * into that existing conversation, and the MIME message itself carries
 * the matching In-Reply-To/References headers (via buildRawMimeMessage)
 * so every other RFC-compliant mail client threads it correctly too —
 * Gmail's own `threadId` field alone is not sufficient for that, proper
 * headers are. The caller (api/agency-send-email.js) is responsible for
 * sourcing these from data it already trusts (a previously stored
 * provider_thread_id/internet_message_id) — this function never
 * fabricates or looks them up itself.
 *
 * Any error thrown by this function means Gmail did NOT accept the send
 * (the HTTP call itself failed or returned a non-2xx status) — the
 * caller may safely treat a thrown error here as "not sent". Once this
 * function RESOLVES successfully, the email has been accepted by Gmail
 * and must never be re-sent, no matter what happens afterward.
 */
async function sendMessage({ toEmail, subject, bodyText, threadId, inReplyTo, references }, deps = {}) {
  const { fromEmail } = requireEnv();
  const accessToken = await getAccessToken(deps);
  const raw = buildRawMimeMessage({ fromEmail, fromName: 'Dese Tour', toEmail, subject, bodyText, inReplyTo, references });
  const result = await gmailApiFetch('/messages/send', {
    accessToken,
    method: 'POST',
    body: { raw, ...(threadId ? { threadId } : {}) },
    fetchImpl: deps.fetch,
  });
  return { gmailMessageId: result.id, gmailThreadId: result.threadId, fromEmail };
}

/**
 * Fetches a message in FULL format (headers + complete MIME body) —
 * never called during ordinary outbound sending; used only by the
 * inbound sync (api/_agencies/gmailInboundSync.js) once
 * checkInboundBodyCapability (below) has confirmed this is actually
 * possible under the current OAuth grant. Returns the raw Gmail message
 * resource — MIME/body parsing is deliberately NOT this module's job
 * (kept in gmailInboundSync.js), matching this file's existing
 * separation of concerns (this module only ever talks to the Gmail API
 * directly; no other file does).
 */
async function fetchMessageFull(gmailMessageId, deps = {}) {
  const accessToken = await getAccessToken(deps);
  return gmailApiFetch(`/messages/${gmailMessageId}`, {
    accessToken,
    params: { format: 'full' },
    fetchImpl: deps.fetch,
  });
}

/**
 * Agency Mailbox Phase 1 — the capability PREFLIGHT this whole inbound
 * feature is gated behind. gmail.metadata (already proven live in
 * production — see fetchMessageIdHeader, which has been successfully
 * reading two real sent messages' headers) covers headers and the
 * History API, but Gmail explicitly REJECTS format=full under a
 * metadata-only grant with a distinct, recognizable error — it does
 * NOT imply full-body read access. This function never assumes either
 * way: it makes the real call against a real, already-known message id
 * (never searches the mailbox itself) and classifies the REAL result.
 *
 * `sampleGmailMessageId` must be an id this caller already trusts (e.g.
 * a recent outbound send's own provider_message_id) — this function
 * never discovers one itself.
 *
 * Returns one of:
 *   { capability: 'full_body_ok' }        — format=full succeeded;
 *     inbound body sync may proceed.
 *   { capability: 'insufficient_scope' }  — Gmail's own rejection of
 *     format=full under the current (metadata-only) scope, recognized
 *     from its documented error text. The caller must stop and report
 *     that OAuth re-authorization with gmail.readonly (or broader) is
 *     required — never proceed with inbound sync.
 *   { capability: 'unknown_error' }       — any other failure (network,
 *     a missing/invalid sample id, an unrelated API error). Treated
 *     identically to insufficient_scope by every caller — fail closed,
 *     never assume capability from an inconclusive result.
 * Never leaks the raw Gmail error text to anything beyond this return
 * value's classification — callers must never forward Gmail's own
 * error body to the browser.
 */
async function checkInboundBodyCapability({ sampleGmailMessageId }, deps = {}) {
  requireEnv();
  if (!sampleGmailMessageId) {
    return { capability: 'unknown_error', reason: 'no_sample_message_id' };
  }
  try {
    await fetchMessageFull(sampleGmailMessageId, deps);
    return { capability: 'full_body_ok' };
  } catch (err) {
    if (err instanceof GmailSendError && /scope|permission/i.test(err.message)) {
      return { capability: 'insufficient_scope' };
    }
    return { capability: 'unknown_error' };
  }
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

/**
 * Gmail History API — the incremental-sync primitive for Agency Mailbox
 * Phase 2. Given a previously stored startHistoryId, Gmail returns only
 * what changed since then (filtered here to new messages landing in
 * INBOX) — never a full mailbox scan. Pure transport: returns Gmail's
 * raw response ({history, historyId, nextPageToken}) unchanged; looping
 * over nextPageToken and interpreting the result is the caller's job
 * (gmailInboundSync.js), not this function's.
 */
async function listHistory({ startHistoryId, pageToken }, deps = {}) {
  const accessToken = await getAccessToken(deps);
  return gmailApiFetch('/history', {
    accessToken,
    params: { startHistoryId, pageToken, historyTypes: 'messageAdded', labelId: 'INBOX' },
    fetchImpl: deps.fetch,
  });
}

/**
 * Gmail users.getProfile — the cheapest possible call, used only once:
 * to discover the mailbox's CURRENT historyId so the very first Phase 2
 * run (before any cursor has ever been stored) can seed its baseline
 * from "now" rather than either scanning the whole mailbox or having no
 * starting point at all.
 */
async function getProfile(deps = {}) {
  const accessToken = await getAccessToken(deps);
  return gmailApiFetch('/profile', { accessToken, fetchImpl: deps.fetch });
}

/**
 * Bounded search — Agency Mailbox Phase 8 (historical catch-up) only;
 * never called by the ordinary Phase 2 incremental sync. This function
 * has no awareness of "Agency" at all — it is a thin Gmail API
 * passthrough, same as every other function in this file. The caller
 * (gmailInboundSync.js's buildBackfillQuery) is responsible for scoping
 * `query` to known agency threads/contacts so this can never return
 * unrelated hello@desetour.com mail.
 */
async function listMessageIdsByQuery({ query, pageToken, maxResults }, deps = {}) {
  const accessToken = await getAccessToken(deps);
  return gmailApiFetch('/messages', {
    accessToken,
    params: { q: query, pageToken, maxResults: maxResults || 50 },
    fetchImpl: deps.fetch,
  });
}

module.exports = {
  ConfigurationError,
  GmailSendError,
  requireEnv,
  getAccessToken,
  sendMessage,
  fetchMessageIdHeader,
  fetchMessageFull,
  checkInboundBodyCapability,
  listHistory,
  getProfile,
  listMessageIdsByQuery,
  buildRawMimeMessage,
  encodeHeaderUtf8,
  base64EncodeBodyWrapped,
  base64UrlEncode,
  isValidEmailAddress,
  _resetAccessTokenCacheForTests,
};
