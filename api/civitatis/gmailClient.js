/**
 * api/civitatis/gmailClient.js
 * ─────────────────────────────────────────────────────────────────────────
 * Minimal Gmail REST API client for reservation@desetour.com, used only
 * server-side (Vercel function / future scheduled job). Deliberately
 * implemented with plain fetch + a manual OAuth2 refresh-token exchange
 * rather than the full googleapis SDK — this integration only ever needs
 * "list messages matching a query" and "get one message's headers + plain
 * text body", so a small, dependency-free client is more auditable than
 * pulling in a large general-purpose SDK for two REST calls.
 *
 * Every credential is read from environment variables at call time —
 * never hard-coded, never logged, never returned in any response body.
 * If they are not configured, every exported function fails with a
 * clear ConfigurationError rather than silently doing nothing or
 * falling back to any other credential source.
 *
 * This module never invokes any AI/LLM service and never makes a network
 * call to anything other than accounts.google.com / www.googleapis.com.
 * ─────────────────────────────────────────────────────────────────────────
 */
'use strict';

const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const GMAIL_API_BASE = 'https://www.googleapis.com/gmail/v1/users/me';

class ConfigurationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConfigurationError';
  }
}

function requireEnv() {
  const clientId = process.env.GMAIL_CLIENT_ID;
  const clientSecret = process.env.GMAIL_CLIENT_SECRET;
  const refreshToken = process.env.GMAIL_REFRESH_TOKEN;
  const missing = [
    !clientId && 'GMAIL_CLIENT_ID',
    !clientSecret && 'GMAIL_CLIENT_SECRET',
    !refreshToken && 'GMAIL_REFRESH_TOKEN',
  ].filter(Boolean);
  if (missing.length > 0) {
    throw new ConfigurationError(
      `Gmail ingestion is not configured: missing environment variable(s): ${missing.join(', ')}. ` +
      'These must be set as server-side Vercel environment variables (never committed to source, never sent to browser code). ' +
      'See the setup instructions in the implementation report for exact steps to obtain them.'
    );
  }
  return { clientId, clientSecret, refreshToken };
}

let _cachedAccessToken = null;
let _cachedAccessTokenExpiresAt = 0;

/** Exchanges the long-lived refresh token for a short-lived access token.
 * Cached in-memory for the remainder of this process's lifetime (a Vercel
 * function invocation), refreshed a little before actual expiry. */
async function getAccessToken() {
  const { clientId, clientSecret, refreshToken } = requireEnv();

  if (_cachedAccessToken && Date.now() < _cachedAccessTokenExpiresAt - 60_000) {
    return _cachedAccessToken;
  }

  const response = await fetch(TOKEN_ENDPOINT, {
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
    throw new Error(`Gmail OAuth token refresh failed (${response.status}): ${bodyText.slice(0, 300)}`);
  }

  const json = await response.json();
  _cachedAccessToken = json.access_token;
  _cachedAccessTokenExpiresAt = Date.now() + (json.expires_in || 3600) * 1000;
  return _cachedAccessToken;
}

async function gmailFetch(path, { accessToken, params } = {}) {
  const url = new URL(`${GMAIL_API_BASE}${path}`);
  if (params) {
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null) url.searchParams.set(key, value);
    }
  }
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok) {
    const bodyText = await response.text().catch(() => '');
    throw new Error(`Gmail API request to ${path} failed (${response.status}): ${bodyText.slice(0, 300)}`);
  }
  return response.json();
}

/**
 * Lists Gmail message IDs matching a search query, following pagination
 * until exhausted. Returns bare {id, threadId} pairs only — callers fetch
 * full message content separately via getMessage, only for messages not
 * already recorded in email_ingestions (idempotency is enforced by the
 * caller, keyed on message id, not by this function).
 */
async function listMessageIds(query) {
  const accessToken = await getAccessToken();
  const ids = [];
  let pageToken;
  do {
    const page = await gmailFetch('/messages', {
      accessToken,
      params: { q: query, pageToken, maxResults: 100 },
    });
    for (const m of page.messages || []) ids.push({ id: m.id, threadId: m.threadId });
    pageToken = page.nextPageToken;
  } while (pageToken);
  return ids;
}

function base64UrlDecode(data) {
  if (!data) return '';
  const normalized = data.replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(normalized, 'base64').toString('utf8');
}

/** Strips a minimal set of HTML block/line elements down to plain text
 * with newlines, for the (unverified until tested against the real
 * mailbox) case where Civitatis sends only a text/html body with no
 * text/plain alternative. Intentionally simple and conservative — this
 * is not a general HTML renderer, only enough to preserve the "Label:"
 * / value line structure the parser depends on. */
function htmlToPlainTextFallback(html) {
  return String(html)
    .replace(/<(br|\/p|\/div|\/tr|\/li)\s*\/?>(\s*)/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#39;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/[ \t]+\n/g, '\n')
    .trim();
}

/** Recursively finds the first text/plain part in a Gmail message
 * payload; falls back to text/html (converted) if no plain-text part
 * exists; falls back to the top-level body if the payload isn't
 * multipart at all. */
function extractPlainTextBody(payload) {
  if (!payload) return '';

  function findPart(node, mimeType) {
    if (!node) return null;
    if (node.mimeType === mimeType && node.body && node.body.data) return node;
    for (const child of node.parts || []) {
      const found = findPart(child, mimeType);
      if (found) return found;
    }
    return null;
  }

  const plainPart = findPart(payload, 'text/plain');
  if (plainPart) return base64UrlDecode(plainPart.body.data);

  const htmlPart = findPart(payload, 'text/html');
  if (htmlPart) return htmlToPlainTextFallback(base64UrlDecode(htmlPart.body.data));

  if (payload.body && payload.body.data) return base64UrlDecode(payload.body.data);

  return '';
}

function findHeader(headers, name) {
  const header = (headers || []).find(h => h.name.toLowerCase() === name.toLowerCase());
  return header ? header.value : '';
}

/**
 * Fetches one full message and normalizes it into the plain object shape
 * api/civitatis/parser.js expects — this is the sole place Gmail-specific
 * structure (headers array, multipart payload, base64url body) is
 * translated into that shape, keeping the parser itself Gmail-agnostic.
 */
async function getMessage(messageId) {
  const accessToken = await getAccessToken();
  const raw = await gmailFetch(`/messages/${messageId}`, { accessToken, params: { format: 'full' } });
  const headers = raw.payload ? raw.payload.headers : [];
  return {
    from: findHeader(headers, 'From'),
    subject: findHeader(headers, 'Subject'),
    body: extractPlainTextBody(raw.payload),
    gmailMessageId: raw.id,
    gmailThreadId: raw.threadId,
    receivedAt: raw.internalDate ? new Date(Number(raw.internalDate)).toISOString() : null,
  };
}

/**
 * Fetches ONE page of full messages matching a query — bounded by
 * maxResults and resumable via pageToken. A real mailbox's full
 * Civitatis history can easily exceed what fits inside a single
 * serverless function invocation's time limit (Vercel functions in this
 * project are configured with maxDuration: 30s, see api/send-email.js),
 * so the backfill is deliberately chunked rather than attempting to list
 * and fetch an unbounded number of messages in one call. The caller
 * (api/ingest-civitatis.js) loops across pages by re-invoking with the
 * returned nextPageToken until it is undefined.
 */
async function fetchMessagePage(query, { pageToken, maxResults = 25 } = {}) {
  const accessToken = await getAccessToken();
  const listing = await gmailFetch('/messages', {
    accessToken,
    params: { q: query, pageToken, maxResults },
  });
  const messages = [];
  for (const m of listing.messages || []) {
    messages.push(await getMessage(m.id));
  }
  return { messages, nextPageToken: listing.nextPageToken || null };
}

/**
 * Convenience: lists and fully fetches EVERY message matching a query in
 * one call, paging internally until exhausted. Left available for small
 * queries / tests, but api/ingest-civitatis.js uses fetchMessagePage
 * directly for the real mailbox so a large backfill can be driven across
 * multiple bounded requests instead of risking a function timeout.
 */
async function fetchAllMatchingMessages(query) {
  const idList = await listMessageIds(query);
  const messages = [];
  for (const { id } of idList) {
    messages.push(await getMessage(id));
  }
  return messages;
}

/**
 * The Gmail search query used for both backfill and (later) live
 * ingestion: scoped to the sender only. Subject-pattern / event-type
 * validation happens afterward in api/civitatis/eventDetector.js on
 * every fetched message — this query is an efficiency narrowing (avoid
 * fetching mail from unrelated senders at all), never the security
 * boundary itself, per "do not treat the civitatis.com domain generally
 * as sufficient".
 */
function buildCivitatisSearchQuery() {
  return 'from:(notificaciones@civitatis.com)';
}

module.exports = {
  getAccessToken,
  listMessageIds,
  getMessage,
  fetchMessagePage,
  fetchAllMatchingMessages,
  buildCivitatisSearchQuery,
  extractPlainTextBody,
  htmlToPlainTextFallback,
  ConfigurationError,
};
