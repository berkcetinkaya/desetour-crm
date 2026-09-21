/**
 * api/civitatis/gmailClient.js
 * ─────────────────────────────────────────────────────────────────────────
 * Minimal Gmail REST API client for reservation@desetour.com, used only
 * server-side (Vercel function / future scheduled job). Deliberately
 * implemented with plain fetch + a manual OAuth2 refresh-token exchange
 * rather than the full googleapis SDK — this integration only ever needs
 * "list messages matching a query" and "get one message's headers + body
 * text", so a small, dependency-free client is more auditable than
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
 *
 * MIME BODY EXTRACTION
 * ─────────────────────
 * Real Civitatis reservation emails are HTML, with the reservation
 * details rendered as nested <table>/<tr>/<td> structures, and may arrive
 * as any of: a bare text/plain payload, a bare text/html payload,
 * multipart/alternative (text/plain + text/html side by side), or
 * multipart/mixed wrapping a multipart/alternative (or a bare text/html
 * part) — with the useful part potentially several levels deep. All of
 * this is handled by collectBodyCandidates() below, which recursively
 * walks payload.parts to find every text/plain and text/html candidate
 * regardless of nesting depth, never assuming the useful body is a
 * first-level part.
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

// ── HTML → deterministic plain text ─────────────────────────────────────

// Common HTML named entities Civitatis's transactional templates (and
// generic mail-merge tooling in general) are known to use. Numeric
// entities (&#39; / &#x2019; etc.) are handled separately below via
// String.fromCodePoint, so this table only needs named ones.
const NAMED_HTML_ENTITIES = {
  nbsp: ' ',
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  euro: '€',
  copy: '©',
  reg: '®',
  trade: '™',
  rsquo: '’',
  lsquo: '‘',
  ldquo: '“',
  rdquo: '”',
  ndash: '–',
  mdash: '—',
  hellip: '…',
  middot: '·',
};

/** Decodes HTML entities (named, decimal, and hex) without touching any
 * other character — accented letters (Español, Goñi, ...) that arrive as
 * literal Unicode in the source are left completely untouched, since this
 * function only ever matches the literal "&...;" entity syntax. */
function decodeHtmlEntities(text) {
  return String(text || '').replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (match, entity) => {
    if (entity[0] === '#') {
      const isHex = entity[1] === 'x' || entity[1] === 'X';
      const codePoint = isHex ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
      if (!Number.isFinite(codePoint) || codePoint < 0 || codePoint > 0x10ffff) return match;
      try {
        return String.fromCodePoint(codePoint);
      } catch (_err) {
        return match;
      }
    }
    const key = entity.toLowerCase();
    return Object.prototype.hasOwnProperty.call(NAMED_HTML_ENTITIES, key) ? NAMED_HTML_ENTITIES[key] : match;
  });
}

// Elements whose boundaries carry real structural meaning in a Civitatis
// reservation email: the whole reservation is laid out as nested
// tables, with each "Label:" / value pair in its own row or cell. Both
// the opening and closing tag of each of these forces a line break so
// that label/value pairs never collapse onto the same line as an
// unrelated neighboring cell (the exact failure this fix targets — see
// the module header). Inline formatting tags (b, span, a, font, img, ...)
// are deliberately NOT in this list: they carry no row/cell boundary and
// are simply dropped later without inserting a break.
const BLOCK_BOUNDARY_TAG_NAMES = [
  'p', 'div', 'tr', 'table', 'thead', 'tbody', 'tfoot',
  'td', 'th', 'li', 'ul', 'ol', 'section', 'article',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
];
const BLOCK_TAG_ALTERNATION = BLOCK_BOUNDARY_TAG_NAMES.join('|');
// `(?=[\s>/])` anchors on the character immediately after the tag name so
// "th" never spuriously matches inside "thead"/"tfoot" (the engine only
// accepts "th" when directly followed by whitespace, '>' or a self-
// closing '/').
const BLOCK_OPEN_RE = new RegExp(`<(?:${BLOCK_TAG_ALTERNATION})(?=[\\s>/])[^>]*>`, 'gi');
const BLOCK_CLOSE_RE = new RegExp(`</(?:${BLOCK_TAG_ALTERNATION})\\s*>`, 'gi');
const BR_RE = /<br\s*\/?>/gi;

/**
 * Deterministically converts a Civitatis HTML email body into plain text
 * that preserves label/value line structure, for the case where no
 * usable text/plain alternative exists. Never uses AI/an LLM — this is a
 * fixed set of regex/string transformations, always producing the same
 * output for the same input.
 *
 * Steps, in order:
 *   1. Drop <script>/<style> content and HTML comments entirely.
 *   2. Turn every <br> and every block-boundary tag (table/tr/td/p/div/
 *      li/...) into a newline, BEFORE any tag is stripped — this is what
 *      keeps "Reservation number:" and its value as two distinct lines
 *      (or a "Label: value" same-line pair, when the source places both
 *      in one cell) instead of one run-on line.
 *   3. Strip every remaining tag (inline formatting, images, anchors)
 *      without inserting a break — they carry no structural meaning here.
 *   4. Decode HTML entities.
 *   5. Normalize whitespace: non-breaking spaces become regular spaces,
 *      horizontal whitespace runs collapse, and consecutive blank lines
 *      collapse — without ever merging two distinct label/value lines
 *      into one.
 */
function htmlToPlainTextFallback(html) {
  let text = String(html || '');
  text = text.replace(/<script[\s\S]*?<\/script>/gi, '');
  text = text.replace(/<style[\s\S]*?<\/style>/gi, '');
  text = text.replace(/<!--[\s\S]*?-->/g, '');
  text = text.replace(BR_RE, '\n');
  text = text.replace(BLOCK_OPEN_RE, '\n');
  text = text.replace(BLOCK_CLOSE_RE, '\n');
  text = text.replace(/<[^>]+>/g, '');
  text = decodeHtmlEntities(text);
  text = text.replace(/ /g, ' ');
  text = text
    .split('\n')
    .map(line => line.replace(/[ \t]+/g, ' ').trim())
    .join('\n');
  text = text.replace(/\n{2,}/g, '\n');
  return text.trim();
}

/** Final normalization applied to whichever body text was selected
 * (text/plain as-is, or the HTML-fallback output) — handles CRLF vs LF,
 * stray non-breaking spaces a text/plain part can still contain, and
 * collapses accidental multiple blank lines, without altering any
 * meaningful character (accents, currency symbols, punctuation). */
function normalizeExtractedText(text) {
  return String(text || '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/ /g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** A text/plain candidate is only usable if it actually carries content —
 * multipart/alternative messages sometimes ship a trivial text/plain
 * stub ("This email requires an HTML-capable client to view.") alongside
 * the real HTML body. A short/near-empty candidate is treated as absent
 * rather than fed to the parser as if it were the real body. */
function isMeaningfulPlainTextBody(text) {
  return typeof text === 'string' && text.trim().length >= 40;
}

/**
 * Recursively walks a Gmail message payload (arbitrarily nested
 * multipart/alternative, multipart/mixed, multipart/related, ...) and
 * collects every text/plain and text/html body found, in document order,
 * regardless of nesting depth. Never assumes the useful part is at the
 * top level or a first-level child.
 */
function collectBodyCandidates(payload) {
  const plainTextCandidates = [];
  const htmlCandidates = [];

  function walk(node) {
    if (!node) return;
    const mimeType = typeof node.mimeType === 'string' ? node.mimeType : '';
    const hasInlineData = !!(node.body && node.body.data);

    if (mimeType === 'text/plain' && hasInlineData) {
      plainTextCandidates.push(base64UrlDecode(node.body.data));
      return;
    }
    if (mimeType === 'text/html' && hasInlineData) {
      htmlCandidates.push(base64UrlDecode(node.body.data));
      return;
    }
    if (Array.isArray(node.parts) && node.parts.length > 0) {
      for (const child of node.parts) walk(child);
      return;
    }
    // A leaf part with no recognized mimeType but inline data (a
    // malformed/unusual payload) — surfaced as a plain-text candidate
    // rather than silently dropped, so the parser still gets a chance at
    // whatever text is actually there.
    if (hasInlineData && !mimeType.startsWith('multipart/')) {
      plainTextCandidates.push(base64UrlDecode(node.body.data));
    }
  }

  walk(payload);
  return { plainTextCandidates, htmlCandidates };
}

/**
 * Selects and normalizes the single best body text for a message:
 *   1. The first "meaningful" text/plain candidate, if any.
 *   2. Otherwise the first text/html candidate, converted deterministically.
 *   3. Otherwise, any text/plain candidate at all (even a short one) —
 *      better to hand the parser something and let it report specific
 *      missing fields than to silently return an empty body.
 *   4. Otherwise an empty string (parser.js reports this as parse_error).
 */
function selectMessageBody(payload) {
  const { plainTextCandidates, htmlCandidates } = collectBodyCandidates(payload);

  const meaningfulPlain = plainTextCandidates.find(isMeaningfulPlainTextBody);
  if (meaningfulPlain !== undefined) {
    return {
      text: normalizeExtractedText(meaningfulPlain),
      selectedBodyMimeType: 'text/plain',
      plainTextCandidateCount: plainTextCandidates.length,
      htmlCandidateCount: htmlCandidates.length,
    };
  }

  if (htmlCandidates.length > 0) {
    return {
      text: normalizeExtractedText(htmlToPlainTextFallback(htmlCandidates[0])),
      selectedBodyMimeType: 'text/html',
      plainTextCandidateCount: plainTextCandidates.length,
      htmlCandidateCount: htmlCandidates.length,
    };
  }

  if (plainTextCandidates.length > 0) {
    return {
      text: normalizeExtractedText(plainTextCandidates[0]),
      selectedBodyMimeType: 'text/plain',
      plainTextCandidateCount: plainTextCandidates.length,
      htmlCandidateCount: htmlCandidates.length,
    };
  }

  return { text: '', selectedBodyMimeType: null, plainTextCandidateCount: 0, htmlCandidateCount: 0 };
}

/** Backward-compatible wrapper returning just the extracted text. */
function extractPlainTextBody(payload) {
  return selectMessageBody(payload).text;
}

function findHeader(headers, name) {
  const header = (headers || []).find(h => h.name.toLowerCase() === name.toLowerCase());
  return header ? header.value : '';
}

/**
 * Builds a structural-only diagnostic tree for one MIME node: mimeType,
 * filename (if any), whether inline body data is present, and (for
 * text/plain and text/html leaves only) the decoded character length —
 * never the decoded text itself. Used solely by the safe ?debugMime=1
 * diagnostic mode; never included in the normal dry-run response.
 */
function buildMimeStructureDiagnostics(node) {
  if (!node) return null;
  const mimeType = typeof node.mimeType === 'string' ? node.mimeType : null;
  const hasBodyData = !!(node.body && node.body.data);
  let decodedTextLength = null;
  if (hasBodyData && (mimeType === 'text/plain' || mimeType === 'text/html')) {
    decodedTextLength = base64UrlDecode(node.body.data).length;
  }
  return {
    mimeType,
    filename: node.filename || null,
    hasBodyData,
    decodedTextLength,
    parts: Array.isArray(node.parts) ? node.parts.map(buildMimeStructureDiagnostics) : [],
  };
}

/**
 * Fetches one full message and normalizes it into the plain object shape
 * api/civitatis/parser.js expects — this is the sole place Gmail-specific
 * structure (headers array, multipart payload, base64url body) is
 * translated into that shape, keeping the parser itself Gmail-agnostic.
 *
 * With { includeDiagnostics: true }, additionally returns a structural-
 * only `diagnostics` object (no body text, no PII) describing the MIME
 * shape actually encountered and which candidate was selected — used by
 * the ?debugMime=1 endpoint mode to troubleshoot extraction without the
 * dry-run pipeline or any Supabase access.
 */
async function getMessage(messageId, { includeDiagnostics = false } = {}) {
  const accessToken = await getAccessToken();
  const raw = await gmailFetch(`/messages/${messageId}`, { accessToken, params: { format: 'full' } });
  const headers = raw.payload ? raw.payload.headers : [];
  const selection = selectMessageBody(raw.payload);

  const message = {
    from: findHeader(headers, 'From'),
    subject: findHeader(headers, 'Subject'),
    body: selection.text,
    gmailMessageId: raw.id,
    gmailThreadId: raw.threadId,
    receivedAt: raw.internalDate ? new Date(Number(raw.internalDate)).toISOString() : null,
  };

  if (!includeDiagnostics) return message;

  return {
    message,
    diagnostics: {
      gmailMessageId: raw.id,
      topLevelMimeType: raw.payload ? raw.payload.mimeType : null,
      partTree: buildMimeStructureDiagnostics(raw.payload),
      selectedBodyMimeType: selection.selectedBodyMimeType,
      selectedBodyLength: selection.text.length,
      plainTextCandidateCount: selection.plainTextCandidateCount,
      htmlCandidateCount: selection.htmlCandidateCount,
    },
  };
}

/**
 * Fetches ONE page of full messages matching a query — bounded by
 * maxResults and resumable via pageToken. A real mailbox's full
 * Civitatis history can easily exceed what fits inside a single
 * serverless function invocation's time limit (see vercel.json), so the
 * backfill is deliberately chunked rather than attempting to list and
 * fetch an unbounded number of messages in one call. The caller
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
 * Same pagination contract as fetchMessagePage, but returns structural
 * MIME diagnostics for each message instead of the normalized message
 * object — used only by the ?debugMime=1 endpoint mode. Never returns
 * body text, customer data, or financial values.
 */
async function fetchMessagePageDiagnostics(query, { pageToken, maxResults = 25 } = {}) {
  const accessToken = await getAccessToken();
  const listing = await gmailFetch('/messages', {
    accessToken,
    params: { q: query, pageToken, maxResults },
  });
  const diagnostics = [];
  for (const m of listing.messages || []) {
    const { diagnostics: d } = await getMessage(m.id, { includeDiagnostics: true });
    diagnostics.push(d);
  }
  return { diagnostics, nextPageToken: listing.nextPageToken || null };
}

/**
 * Same pagination contract as fetchMessagePage, but returns BOTH the
 * normalized message (including its selected body text) and its
 * selection diagnostics for each message — used only by the
 * ?debugParser=1 endpoint mode, which reduces `message.body` to a
 * sanitized line list (api/civitatis/parserDiagnostics.js) before it
 * ever leaves the server; this function itself does not redact
 * anything, so callers must never return `message.body` verbatim.
 */
async function fetchMessagePageFull(query, { pageToken, maxResults = 25 } = {}) {
  const accessToken = await getAccessToken();
  const listing = await gmailFetch('/messages', {
    accessToken,
    params: { q: query, pageToken, maxResults },
  });
  const items = [];
  for (const m of listing.messages || []) {
    items.push(await getMessage(m.id, { includeDiagnostics: true }));
  }
  return { items, nextPageToken: listing.nextPageToken || null };
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
  fetchMessagePageDiagnostics,
  fetchMessagePageFull,
  fetchAllMatchingMessages,
  buildCivitatisSearchQuery,
  extractPlainTextBody,
  selectMessageBody,
  collectBodyCandidates,
  htmlToPlainTextFallback,
  decodeHtmlEntities,
  normalizeExtractedText,
  base64UrlDecode,
  buildMimeStructureDiagnostics,
  ConfigurationError,
};
