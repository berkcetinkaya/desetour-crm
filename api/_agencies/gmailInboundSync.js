/**
 * api/_agencies/gmailInboundSync.js
 * ─────────────────────────────────────────────────────────────────────────
 * Agency Mailbox Phase 2-5/8 — inbound reply ingestion for hello@desetour.com.
 *
 * Owns every piece of BUSINESS LOGIC this feature needs: MIME header/body
 * extraction from a Gmail message resource, the 4-tier matching hierarchy
 * that ties an inbound message to an existing Agency conversation, and the
 * orchestration that ties Gmail API calls (api/_agencies/gmailSendClient.js
 * — the only module that ever talks to Gmail directly) together with
 * Supabase reads/writes. Never imports api/agency-send-email.js or vice
 * versa; the only shared dependency is gmailSendClient.js itself.
 *
 * SECURITY / SCOPE DISCIPLINE (same as every other Agency module):
 *   - Never logs a message body, a full subject, or any raw Gmail payload —
 *     only structural diagnostics (counts, match tiers, ids already safe
 *     to log elsewhere in this codebase).
 *   - Never imports a message that doesn't confidently match an existing
 *     Agency via the matching hierarchy below — no subject matching, ever.
 *   - Never assumes OAuth scope — every caller of the sync path MUST have
 *     already called gmailSendClient.checkInboundBodyCapability() and
 *     confirmed 'full_body_ok' before this module's syncAgencyMailbox()
 *     does any body-reading work; this module does not re-check it itself
 *     (the endpoint owns that preflight gate) but never silently degrades
 *     if a later Gmail call fails — a failure here still fails this run,
 *     it never fabricates an empty-but-successful result.
 * ─────────────────────────────────────────────────────────────────────────
 */
'use strict';

const gmailClient = require('./gmailSendClient');

const SETTINGS_KEY_SYNC_CURSOR = 'agency_gmail_sync_cursor';

// Hard ceiling per invocation — bounds a single sync run's Gmail API calls
// and Supabase writes even if an unexpectedly large backlog of history
// exists, so one run can never run unbounded or risk a function timeout.
// Nothing is lost if this is hit: a run that stops early because of these
// caps always does so at a full history-page boundary and persists
// CONTINUATION state (see writeSyncCursor/syncAgencyMailbox) rather than
// advancing the stable cursor — the remainder is picked up by the next
// scheduled run from the exact page it left off at, never skipped.
const MAX_MESSAGES_PER_RUN = 200;
const MAX_HISTORY_PAGES_PER_RUN = 20;

// Postgres SQLSTATE for unique_violation — used to recognize a replayed
// (already-persisted) inbound message via the real database constraint,
// never via a separate SELECT-then-INSERT check (which would race).
const POSTGRES_UNIQUE_VIOLATION_CODE = '23505';

// Bounded stale-history-id recovery window (Agency Mailbox Phase 2
// hardening). Gmail retains History API records for roughly 7 days; this
// is deliberately a little more generous than that, while still being a
// hard, finite ceiling — never "scan the whole mailbox". The 1-hour
// overlap on top of the last known-good sync timestamp is cheap insurance
// against a message landing in the last few minutes before that sync,
// safe only because inbound persistence is idempotent.
const STALE_HISTORY_RECOVERY_MAX_WINDOW_SECONDS = 9 * 24 * 60 * 60;
const STALE_HISTORY_RECOVERY_OVERLAP_SECONDS = 60 * 60;

// Stored inbound body is normalized plain text, truncated — never the
// raw MIME payload, never the full HTML, never an unbounded quote chain.
const MAX_INBOUND_BODY_LENGTH = 5000;

// ── Pure MIME helpers — no I/O, fully unit-testable ─────────────────────

function getHeader(headers, name) {
  if (!Array.isArray(headers)) return '';
  const lower = name.toLowerCase();
  const found = headers.find(h => h && typeof h.name === 'string' && h.name.toLowerCase() === lower);
  return found ? String(found.value || '') : '';
}

/** Gmail's body.data is base64URL (RFC 4648 §5: '-'/'_', no padding) — a
 * plain base64 decoder must never be used directly on it without this
 * normalization first, or decoding silently produces garbage/truncated
 * output for any payload containing a '-' or '_' in its encoded form. */
function decodeGmailBase64Url(data) {
  if (!data || typeof data !== 'string') return '';
  try {
    const normalized = data.replace(/-/g, '+').replace(/_/g, '/');
    return Buffer.from(normalized, 'base64').toString('utf8');
  } catch (_err) {
    return '';
  }
}

/** Depth-first search for the first body part of `mimeType` — handles
 * Gmail's arbitrarily-nested multipart/alternative + multipart/mixed
 * structure (e.g. multipart/mixed > multipart/alternative > text/plain +
 * text/html, with attachment parts as later siblings). Skips any part
 * that looks like an attachment (has a filename) even if its mimeType
 * happens to match, since an attached .txt/.html file is not the message
 * body. */
function findBodyPartData(payload, mimeType) {
  if (!payload) return null;
  const isAttachment = payload.filename && payload.filename.length > 0;
  if (!isAttachment && payload.mimeType === mimeType && payload.body && payload.body.data) {
    return payload.body.data;
  }
  if (Array.isArray(payload.parts)) {
    for (const part of payload.parts) {
      const found = findBodyPartData(part, mimeType);
      if (found) return found;
    }
  }
  return null;
}

function stripHtmlToText(html) {
  return String(html || '')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/[ \t]+/g, ' ')
    .replace(/[ \t]*\n[ \t]*/g, '\n')
    .trim();
}

/** Plain-text preferred, HTML-stripped-to-text as the fallback (never
 * both, never raw HTML stored) — truncated to MAX_INBOUND_BODY_LENGTH.
 * Returns '' (never throws) for a payload with no recognizable text part
 * at all (e.g. an image-only message). */
function extractNormalizedPlainTextBody(payload) {
  const plainData = findBodyPartData(payload, 'text/plain');
  if (plainData) {
    const text = decodeGmailBase64Url(plainData).trim();
    if (text) return text.slice(0, MAX_INBOUND_BODY_LENGTH);
  }
  const htmlData = findBodyPartData(payload, 'text/html');
  if (htmlData) {
    const text = stripHtmlToText(decodeGmailBase64Url(htmlData));
    if (text) return text.slice(0, MAX_INBOUND_BODY_LENGTH);
  }
  return '';
}

/** Extracts the bare email address from a header value that may be a
 * plain address or a "Display Name <addr>" form. Always lower-cased for
 * case-insensitive comparison against agencies.email. */
function extractEmailAddress(headerValue) {
  if (!headerValue) return '';
  const angleMatch = headerValue.match(/<([^<>]+)>/);
  const raw = angleMatch ? angleMatch[1] : headerValue;
  return raw.trim().toLowerCase();
}

/** Splits an In-Reply-To or References header into its individual
 * angle-bracketed Message-IDs — References commonly carries more than
 * one, space-separated. */
function splitMessageIdList(headerValue) {
  if (!headerValue) return [];
  const matches = headerValue.match(/<[^<>]+>/g);
  return matches ? matches.map(s => s.trim()) : [];
}

/** Pulls exactly the fields the matching hierarchy and persistence step
 * need from one Gmail message resource (format=full) — never the raw
 * resource itself past this point. */
function extractMessageFields(gmailMessage) {
  const headers = (gmailMessage && gmailMessage.payload && gmailMessage.payload.headers) || [];
  return {
    gmailMessageId: gmailMessage && gmailMessage.id || null,
    gmailThreadId: gmailMessage && gmailMessage.threadId || null,
    messageId: getHeader(headers, 'Message-Id').trim() || null,
    inReplyTo: getHeader(headers, 'In-Reply-To').trim() || null,
    references: getHeader(headers, 'References').trim() || null,
    fromHeader: getHeader(headers, 'From').trim(),
    toHeader: getHeader(headers, 'To').trim(),
    subject: getHeader(headers, 'Subject').trim(),
    body: extractNormalizedPlainTextBody(gmailMessage && gmailMessage.payload),
  };
}

// ── Matching hierarchy — pure, no I/O ───────────────────────────────────

/**
 * Builds the lookup indexes the matching hierarchy needs from the
 * Agencies/agency_emails rows already in the database — every
 * historical row contributes, not just the latest per agency, so an
 * agency with multiple past threads is still correctly matched on any
 * of them.
 */
function buildMatchingIndexes({ agencies, agencyEmails }) {
  const threadIdToAgencyId = new Map();
  const messageIdToAgencyId = new Map();
  const gmailMessageIdToAgencyId = new Map();
  for (const row of (agencyEmails || [])) {
    if (!row) continue;
    if (row.provider_thread_id) threadIdToAgencyId.set(row.provider_thread_id, row.agency_id);
    if (row.internet_message_id) messageIdToAgencyId.set(row.internet_message_id, row.agency_id);
    if (row.provider_message_id) gmailMessageIdToAgencyId.set(row.provider_message_id, row.agency_id);
  }
  const agencyIdsByEmail = new Map();
  for (const a of (agencies || [])) {
    if (!a || !a.email) continue;
    const key = String(a.email).trim().toLowerCase();
    if (!key) continue;
    if (!agencyIdsByEmail.has(key)) agencyIdsByEmail.set(key, []);
    agencyIdsByEmail.get(key).push(a.id);
  }
  return { threadIdToAgencyId, messageIdToAgencyId, gmailMessageIdToAgencyId, agencyIdsByEmail };
}

/**
 * The 4-tier matching hierarchy, in the exact required order. Returns
 * {matched:true, agencyId, matchTier} or {matched:false}. Never matches
 * on subject. Tier 4 (known contact email) only matches when exactly
 * ONE agency shares that email — zero or multiple candidates is treated
 * as unambiguous-failure, never a guess.
 */
function classifyInboundMessage(fields, indexes) {
  const { threadIdToAgencyId, messageIdToAgencyId, gmailMessageIdToAgencyId, agencyIdsByEmail } = indexes;

  if (fields.gmailThreadId && threadIdToAgencyId.has(fields.gmailThreadId)) {
    return { matched: true, agencyId: threadIdToAgencyId.get(fields.gmailThreadId), matchTier: 'thread_id' };
  }

  const referencedIds = [...splitMessageIdList(fields.inReplyTo), ...splitMessageIdList(fields.references)];

  for (const id of referencedIds) {
    if (messageIdToAgencyId.has(id)) {
      return { matched: true, agencyId: messageIdToAgencyId.get(id), matchTier: 'message_id_reference' };
    }
  }

  // Tier 3 also accepts a bare (non-angle-bracketed) Gmail API message id
  // in In-Reply-To/References — some clients/relays echo it verbatim
  // instead of an RFC 2822 Message-ID, so the raw header tokens are
  // checked here too, not just the bracketed ones.
  const rawHeaderTokens = [fields.inReplyTo, fields.references]
    .filter(Boolean)
    .flatMap((value) => value.trim().split(/\s+/))
    .filter(Boolean);
  const gmailIdCandidates = [...referencedIds, ...rawHeaderTokens];

  for (const id of gmailIdCandidates) {
    if (gmailMessageIdToAgencyId.has(id)) {
      return { matched: true, agencyId: gmailMessageIdToAgencyId.get(id), matchTier: 'provider_message_id_reference' };
    }
  }

  const fromAddress = extractEmailAddress(fields.fromHeader);
  if (fromAddress && agencyIdsByEmail.has(fromAddress)) {
    const candidates = agencyIdsByEmail.get(fromAddress);
    if (candidates.length === 1) {
      return { matched: true, agencyId: candidates[0], matchTier: 'known_contact_email' };
    }
    // 0 is impossible here (has() already true); >1 is a genuinely
    // ambiguous shared address — never guess which agency it belongs to.
  }

  return { matched: false };
}

/** Phase 8 — builds a Gmail search query bounded to known Agency threads
 * and contacts only, for the one-time historical catch-up. Never returns
 * a query that would match the whole mailbox — an empty known-set means
 * an empty/no-op query (handled by the caller, which skips the call
 * entirely rather than sending an unbounded "in:anywhere" search). */
function buildBackfillQuery({ knownThreadIds, knownContactEmails, sinceUnixSeconds }) {
  const clauses = [];
  for (const threadId of (knownThreadIds || [])) {
    if (threadId) clauses.push(`threadId:${threadId}`);
  }
  for (const email of (knownContactEmails || [])) {
    if (email) clauses.push(`from:${email}`);
  }
  if (clauses.length === 0) return null;
  const scoped = `(${clauses.join(' OR ')})`;
  return sinceUnixSeconds ? `${scoped} after:${sinceUnixSeconds}` : scoped;
}

// ── Supabase-facing orchestration ───────────────────────────────────────
// Everything below talks to Supabase (via an injected adminClient — the
// SAME service-role pattern api/agency-send-email.js already uses, never
// trusting anything browser-supplied since this only ever runs from the
// scheduled sync endpoint) and to Gmail only through gmailSendClient.js's
// already-reviewed transport functions.

/**
 * The stored cursor value's shape (all in the one existing settings.value
 * JSON blob — no migration):
 *   {
 *     historyId:    string  — the STABLE, confirmed baseline. Only ever
 *                             advanced once an entire history range has
 *                             been fully paginated AND every candidate
 *                             message in it has been successfully
 *                             persisted — never early, never partially.
 *     lastSyncedAt: string  — ISO timestamp of the last time historyId
 *                             above was advanced (used to bound stale-
 *                             history recovery's catch-up window).
 *     continuation: object|null — present only while a run was cut short
 *                             by this run's own safe per-run limits
 *                             (MAX_HISTORY_PAGES_PER_RUN/MAX_MESSAGES_PER_RUN)
 *                             before reaching the end of the current
 *                             history range:
 *       baselineHistoryId: string — the SAME startHistoryId the stable
 *                             historyId had when this multi-run range
 *                             began; passed back to Gmail on every
 *                             resumed page fetch (Gmail's pageToken is
 *                             only meaningful together with the baseline
 *                             it was issued under).
 *       pageToken:          string — where to resume pagination; always a
 *                             full-page boundary (see syncAgencyMailbox),
 *                             never mid-page.
 *       targetHistoryId:    string|null — the historyId Gmail reported
 *                             for this range (constant across every page
 *                             of one history.list "session" per the
 *                             Gmail API); this becomes the new stable
 *                             historyId once the range is fully drained.
 *     recoveredAt:  string|undefined — ISO timestamp of the last stale-
 *                             history-id recovery, if one has ever run;
 *                             diagnostic only, never required to be read.
 *   }
 */
async function readSyncCursor({ adminClient }) {
  const { data, error } = await adminClient
    .from('settings').select('value').eq('key', SETTINGS_KEY_SYNC_CURSOR).maybeSingle();
  if (error) throw error;
  if (!data || !data.value) return null;
  try {
    const parsed = JSON.parse(data.value);
    if (!parsed || !parsed.historyId) return null;
    return {
      historyId: parsed.historyId,
      lastSyncedAt: parsed.lastSyncedAt || null,
      continuation: (parsed.continuation && parsed.continuation.pageToken) ? parsed.continuation : null,
      recoveredAt: parsed.recoveredAt || null,
    };
  } catch (_err) {
    return null;
  }
}

async function writeSyncCursor({ adminClient, historyId, continuation = null, recoveredAt }) {
  const value = JSON.stringify({
    historyId: String(historyId),
    lastSyncedAt: new Date().toISOString(),
    continuation: continuation ? {
      baselineHistoryId: String(continuation.baselineHistoryId),
      pageToken: continuation.pageToken,
      targetHistoryId: continuation.targetHistoryId != null ? String(continuation.targetHistoryId) : null,
    } : null,
    ...(recoveredAt ? { recoveredAt } : {}),
  });
  const { error } = await adminClient
    .from('settings')
    .upsert({ key: SETTINGS_KEY_SYNC_CURSOR, value, value_type: 'json', label: 'Agency Gmail sync cursor', is_public: false }, { onConflict: 'key' });
  if (error) throw error;
}

/** Postgres's unique_violation (23505) is the ONLY signal trusted to mean
 * "this exact Gmail message was already persisted" — detected from the
 * real INSERT's own error, never from a separate SELECT-then-INSERT probe
 * (which would race under concurrent/overlapping sync runs). Scoped to
 * specifically the provider_message_id constraint so an unrelated unique
 * violation (should one ever be added to this table later) is never
 * silently swallowed as if it were a harmless replay. */
function isProviderMessageIdUniqueViolation(error) {
  if (!error || error.code !== POSTGRES_UNIQUE_VIOLATION_CODE) return false;
  const haystack = `${error.message || ''} ${error.details || ''}`.toLowerCase();
  return haystack.includes('provider_message_id');
}

/** Gmail's History API responds with a 404 when startHistoryId is too old
 * (Gmail only retains history for about a week) or otherwise no longer
 * valid. Classified structurally via the HTTP status GmailSendError now
 * carries (see gmailSendClient.js), never by pattern-matching Gmail's own
 * free-text error body. */
function isStaleHistoryIdError(err) {
  return !!(err && err.name === 'GmailSendError' && err.status === 404);
}

/** Bounds the Phase 8-style recovery catch-up to the actual gap since the
 * last confirmed-good sync, with a hard ceiling so it is NEVER unbounded —
 * "sufficient to cover the likely gap", never "scan the whole mailbox".
 * Falls back to the hard ceiling alone when there is no (or an
 * unparseable) lastSyncedAt to anchor to. */
function computeStaleHistoryRecoveryWindowStart({ lastSyncedAt, nowMs = Date.now() }) {
  const ceilingSeconds = Math.floor((nowMs - STALE_HISTORY_RECOVERY_MAX_WINDOW_SECONDS * 1000) / 1000);
  if (!lastSyncedAt) return ceilingSeconds;
  const lastSyncedMs = new Date(lastSyncedAt).getTime();
  if (!Number.isFinite(lastSyncedMs)) return ceilingSeconds;
  const sinceLastSync = Math.floor((lastSyncedMs - STALE_HISTORY_RECOVERY_OVERLAP_SECONDS * 1000) / 1000);
  // Never older than the hard ceiling, no matter how stale lastSyncedAt is.
  return Math.max(sinceLastSync, ceilingSeconds);
}

/** The most recent outbound message's own Gmail id — used ONLY as the
 * sample for checkInboundBodyCapability (never fetched for its body
 * otherwise). Returns null if no agency has ever had an email sent yet,
 * in which case there is nothing to probe capability against and
 * nothing to sync against either. */
async function findSampleOutboundGmailMessageId({ adminClient }) {
  const { data, error } = await adminClient
    .from('agency_emails')
    .select('provider_message_id')
    .not('provider_message_id', 'is', null)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return (data && data.provider_message_id) || null;
}

async function loadMatchingContext({ adminClient }) {
  const [{ data: agencies, error: agenciesError }, { data: agencyEmails, error: emailsError }] = await Promise.all([
    adminClient.from('agencies').select('id, email'),
    adminClient.from('agency_emails').select('agency_id, provider_thread_id, internet_message_id, provider_message_id'),
  ]);
  if (agenciesError) throw agenciesError;
  if (emailsError) throw emailsError;
  return buildMatchingIndexes({ agencies, agencyEmails });
}

/**
 * Persists one confidently-matched inbound message via a plain INSERT.
 * Idempotency is enforced by the EXISTING partial unique index on
 * agency_emails.provider_message_id (WHERE provider_message_id IS NOT
 * NULL) — the database constraint itself is the sole authority, never a
 * SELECT-then-INSERT existence check (which would race under overlapping
 * sync runs). A real duplicate-key violation on that specific column
 * (Postgres 23505) is recognized from the INSERT's own error and reported
 * back as a safe, non-fatal replay — never a fatal sync error, never a
 * duplicate row. Every OTHER database error (a different constraint, a
 * connectivity failure, a permissions error, ...) is propagated unchanged
 * so it is never mistaken for a harmless replay.
 *
 * NOTE: a plain `.upsert(payload, {onConflict:'provider_message_id'})` is
 * deliberately NOT used here — PostgREST's upsert generates a bare
 * `ON CONFLICT (provider_message_id) DO NOTHING/UPDATE` with no WHERE
 * predicate, which Postgres can only use against a FULL (non-partial)
 * unique index/constraint. The only unique index on this column is the
 * partial one above, so that statement shape fails its own conflict-
 * target inference on every call, not just on genuine duplicates — a
 * plain INSERT, with the partial index enforcing uniqueness and a 23505
 * catch here, is the only thing that actually works against a partial
 * unique index.
 *
 * Returns { persisted: true, duplicate: false } on a genuine new insert,
 * or { persisted: false, duplicate: true } when this exact
 * provider_message_id was already recorded.
 */
async function persistInboundMessage({ adminClient, agencyId, fields }) {
  const { error } = await adminClient
    .from('agency_emails')
    .insert({
      agency_id: agencyId,
      direction: 'inbound',
      status: 'received',
      subject: fields.subject || null,
      body: fields.body || null,
      received_at: new Date().toISOString(),
      provider: 'gmail',
      provider_message_id: fields.gmailMessageId,
      provider_thread_id: fields.gmailThreadId,
      internet_message_id: fields.messageId,
      in_reply_to: fields.inReplyTo,
      from_email: extractEmailAddress(fields.fromHeader) || null,
      to_email: extractEmailAddress(fields.toHeader) || null,
    });
  if (error) {
    if (isProviderMessageIdUniqueViolation(error)) {
      return { persisted: false, duplicate: true };
    }
    throw error;
  }
  return { persisted: true, duplicate: false };
}

/** Mirrors api/agency-send-email.js's advanceAgencyContactState — a
 * reply is contact too, so last_contact_at advances. Deliberately never
 * changes agencies.status: replying doesn't itself promote an agency to
 * Partner, a human still decides that (Phase 5 requirement). Failure
 * here is a soft warning only, same as the outbound path — the
 * authoritative "this reply exists" fact is already persisted in
 * agency_emails regardless of whether this follow-up update succeeds. */
async function advanceAgencyOnReply({ adminClient, agencyId }) {
  try {
    const { error } = await adminClient.from('agencies').update({ last_contact_at: new Date().toISOString() }).eq('id', agencyId);
    if (error) return { ok: false, error: error.message };
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

async function logInboundReply({ adminClient, agencyId, agencyEmailId }) {
  try {
    await adminClient.from('activity_logs').insert({
      entity_type: 'agency_email',
      entity_id: agencyEmailId,
      action: 'reply_received',
      description: 'Acenteden yanıt alındı.',
      metadata: { agency_id: agencyId, provider: 'gmail' },
      performed_by: null,
    });
  } catch (_err) {
    // Soft warning only — same rule as every other activity log in this feature.
  }
}

/**
 * Fetches, classifies, and (if matched) persists one candidate Gmail
 * message id — shared by syncAgencyMailbox's page loop, runBoundedBackfill,
 * and stale-history recovery, so the convergence rule below can never
 * drift between call sites.
 *
 * CONVERGENCE RULE: a candidate is NOT considered fully processed until
 * BOTH the inbound row is persisted (possibly as a safe duplicate replay)
 * AND the required agencies.last_contact_at follow-up update succeeds.
 * If that follow-up update fails, this function THROWS — exactly like a
 * Gmail fetch failure — so every caller stops advancing any cursor/
 * continuation state at this exact point, never past it. A temporarily
 * failing agencies table therefore holds the Gmail history cursor open
 * rather than silently leaving the CRM's conversation correct but its
 * follow-up state permanently wrong; the scheduler retries. On that
 * retry, the insert becomes a harmless 23505 duplicate (never a second
 * row) and the follow-up update is attempted again — a duplicate replay
 * is explicitly NOT "nothing left to do".
 *
 * Activity logging happens exactly once, at the moment of the FIRST
 * successful insert — deliberately NOT gated on the follow-up update
 * below, so a transient agencies-table failure (which legitimately holds
 * the cursor open for retry) can never cause the reply's own activity log
 * to be silently lost: by the time any retry sees this message again, it
 * is already a duplicate and is correctly never logged a second time.
 *
 * Returns 'matched' (a genuinely new row, now fully converged), 'duplicate'
 * (already recorded on a prior attempt, now fully converged), or
 * 'skipped' (no confident agency match — nothing is persisted or logged
 * for it, by design). Any thrown error (a Gmail fetch failure, a non-
 * duplicate database error, or a failed follow-up update) propagates to
 * the caller unchanged.
 */
async function processCandidateMessage({ adminClient, gmailDeps, gmailMessageId, indexes }) {
  const gmailMessage = await gmailClient.fetchMessageFull(gmailMessageId, gmailDeps);
  const fields = extractMessageFields(gmailMessage);
  const classification = classifyInboundMessage(fields, indexes);
  if (!classification.matched) return 'skipped';

  const persistResult = await persistInboundMessage({ adminClient, agencyId: classification.agencyId, fields });
  if (!persistResult.duplicate) {
    await logInboundReply({ adminClient, agencyId: classification.agencyId, agencyEmailId: fields.gmailMessageId });
  }

  const advanceResult = await advanceAgencyOnReply({ adminClient, agencyId: classification.agencyId });
  if (!advanceResult.ok) {
    throw new Error(`Agency follow-up state update failed for agency ${classification.agencyId}: ${advanceResult.error}`);
  }

  return persistResult.duplicate ? 'duplicate' : 'matched';
}

/**
 * Agency Mailbox Phase 2 hardening — stale/invalid startHistoryId
 * recovery. Gmail's History API 404s once startHistoryId falls outside
 * its retention window; reseeding straight to "now" in that case would
 * silently lose any reply that arrived during the untracked gap, so
 * instead this runs a BOUNDED catch-up (reusing runBoundedBackfill
 * verbatim — same known-threads/known-contacts scoping, same "never an
 * unrestricted mailbox scan" guarantee) over a window sized to the actual
 * gap (computeStaleHistoryRecoveryWindowStart), and only reseeds the
 * stable cursor if that catch-up completes without error. A failed
 * catch-up leaves the old (stale) cursor completely untouched and fails
 * closed — the next scheduled run will detect the same staleness and
 * retry, safely, since the catch-up's own persistence is idempotent.
 */
async function recoverFromStaleHistoryId({ adminClient, gmailDeps, lastSyncedAt }) {
  const sinceUnixSeconds = computeStaleHistoryRecoveryWindowStart({ lastSyncedAt });
  let backfillResult;
  try {
    backfillResult = await runBoundedBackfill({ adminClient, gmailDeps, sinceUnixSeconds });
  } catch (_err) {
    return { ok: false, stage: 'stale_history_recovery_failed' };
  }

  let profile;
  try {
    profile = await gmailClient.getProfile(gmailDeps);
  } catch (_err) {
    // The catch-up itself succeeded (and is safely idempotent if retried),
    // but we could not confirm a fresh baseline to reseed to — leave the
    // old cursor in place rather than guessing one. Next run retries both
    // steps; re-running the catch-up again is a safe no-op on anything
    // it already persisted.
    return { ok: false, stage: 'stale_history_recovery_failed' };
  }

  await writeSyncCursor({ adminClient, historyId: profile.historyId, continuation: null, recoveredAt: new Date().toISOString() });
  return {
    ok: true,
    stage: 'recovered_from_stale_history',
    matched: backfillResult.matched,
    duplicates: backfillResult.duplicates,
    skipped: backfillResult.skipped,
    processed: backfillResult.processed,
    historyId: profile.historyId,
  };
}

/**
 * The full Phase 2 incremental sync, one invocation. Always re-checks
 * the capability preflight live (never assumes a prior success still
 * holds).
 *
 * Processes Gmail History API pages ATOMICALLY: a page's candidate
 * messages are always either fully processed or not attempted at all —
 * never partially. The STABLE cursor (the historyId used as the
 * baseline for the next run with no continuation in progress) only ever
 * advances once the entire history range is drained (no nextPageToken
 * left) AND every one of its candidate messages has been successfully
 * processed. If this run's own safe per-run limits
 * (MAX_HISTORY_PAGES_PER_RUN/MAX_MESSAGES_PER_RUN) are hit first, the run
 * stops at the next full page boundary and persists CONTINUATION state
 * (the exact pageToken to resume from, under the SAME baseline) instead
 * of advancing the stable cursor — so a run that is cut short can never
 * silently skip whatever is left in that range; the next scheduled
 * invocation resumes exactly where this one stopped.
 *
 * If fetching a page, or fetching/classifying/persisting any one message
 * within it, throws, the error propagates immediately and NOTHING is
 * written — the stored cursor/continuation stays exactly as it was
 * before this run started, so the next run retries this same range from
 * the same point. Re-processing already-successfully-persisted messages
 * on such a retry is always safe: persistInboundMessage's duplicate
 * detection is backed by the database's own unique index, never a
 * separate (racy) existence check.
 *
 * Returns a plain diagnostics object — never a raw Gmail error, never a
 * message body, never a credential — safe for the endpoint to log and
 * to include in its own response.
 */
async function syncAgencyMailbox(deps = {}) {
  const { adminClient, gmailDeps = {} } = deps;

  const sampleGmailMessageId = await findSampleOutboundGmailMessageId({ adminClient });
  if (sampleGmailMessageId) {
    const capability = await gmailClient.checkInboundBodyCapability({ sampleGmailMessageId }, gmailDeps);
    if (capability.capability !== 'full_body_ok') {
      return { ok: false, stage: 'capability_check_failed', capability: capability.capability };
    }
  }

  const stored = await readSyncCursor({ adminClient });
  if (!stored) {
    // First-ever run: seed the baseline from the mailbox's CURRENT
    // historyId. Deliberately does NOT backfill anything on this run —
    // establishing a baseline and backfilling are separate, explicit
    // actions (see runBoundedBackfill), never silently combined.
    const profile = await gmailClient.getProfile(gmailDeps);
    await writeSyncCursor({ adminClient, historyId: profile.historyId });
    return { ok: true, stage: 'cursor_seeded', historyId: profile.historyId, matched: 0, duplicates: 0, skipped: 0 };
  }

  // Everything below operates on ONE history range: either a fresh one
  // starting at the stable cursor, or a resumed one continuing from
  // exactly where a previous, capped-out run left off. `stableHistoryId`
  // is the cursor value as it was before this run — it is written back
  // UNCHANGED whenever this run has to stop early (continuation saved),
  // and only ever replaced once the whole range is drained.
  const stableHistoryId = stored.historyId;
  const baselineHistoryId = stored.continuation ? stored.continuation.baselineHistoryId : stableHistoryId;
  let pageToken = stored.continuation ? stored.continuation.pageToken : undefined;
  let targetHistoryId = stored.continuation ? stored.continuation.targetHistoryId : null;

  const indexes = await loadMatchingContext({ adminClient });

  let matchedCount = 0;
  let duplicateCount = 0;
  let skippedCount = 0;
  let processedCount = 0;
  let pagesFetchedThisRun = 0;

  while (true) {
    let page;
    try {
      page = await gmailClient.listHistory({ startHistoryId: baselineHistoryId, pageToken }, gmailDeps);
    } catch (err) {
      if (isStaleHistoryIdError(err)) {
        return await recoverFromStaleHistoryId({ adminClient, gmailDeps, lastSyncedAt: stored.lastSyncedAt });
      }
      throw err;
    }
    if (targetHistoryId == null && page.historyId) targetHistoryId = page.historyId;

    const candidateIds = Array.from(new Set(
      (page.history || []).flatMap(entry => (entry.messagesAdded || [])
        .map(added => added && added.message && added.message.id)
        .filter(Boolean))
    ));

    // Atomic per page: every candidate in this page is processed before
    // moving on — a thrown error here aborts the WHOLE run without
    // writing anything, so this page is retried in full next time.
    for (const gmailMessageId of candidateIds) {
      const outcome = await processCandidateMessage({ adminClient, gmailDeps, gmailMessageId, indexes });
      if (outcome === 'matched') matchedCount += 1;
      else if (outcome === 'duplicate') duplicateCount += 1;
      else skippedCount += 1;
      processedCount += 1;
    }
    pagesFetchedThisRun += 1;

    const hasMore = !!page.nextPageToken;
    if (!hasMore) {
      // The whole range is drained and every candidate in it succeeded —
      // only now is it safe to advance the stable cursor.
      await writeSyncCursor({ adminClient, historyId: targetHistoryId || baselineHistoryId, continuation: null });
      return { ok: true, stage: 'synced', matched: matchedCount, duplicates: duplicateCount, skipped: skippedCount, processed: processedCount, pagesFetched: pagesFetchedThisRun };
    }

    if (pagesFetchedThisRun >= MAX_HISTORY_PAGES_PER_RUN || processedCount >= MAX_MESSAGES_PER_RUN) {
      // Incomplete — checkpoint continuation at this (just-finished, full)
      // page boundary. The stable cursor is written back UNCHANGED.
      await writeSyncCursor({
        adminClient,
        historyId: stableHistoryId,
        continuation: { baselineHistoryId, pageToken: page.nextPageToken, targetHistoryId },
      });
      return { ok: true, stage: 'continuation_saved', matched: matchedCount, duplicates: duplicateCount, skipped: skippedCount, processed: processedCount, pagesFetched: pagesFetchedThisRun };
    }

    pageToken = page.nextPageToken;
  }
}

/**
 * Phase 8 — bounded, explicit, one-time (or occasionally re-run)
 * historical catch-up. Never called by syncAgencyMailbox itself; a
 * distinct code path the sync endpoint exposes only via an explicit
 * `mode: 'backfill'` request, never the default scheduled behavior.
 * Scoped strictly to known agency threads/contacts via
 * buildBackfillQuery — an empty known-set makes this a safe no-op
 * rather than an unbounded mailbox scan.
 */
async function runBoundedBackfill({ adminClient, gmailDeps = {}, sinceUnixSeconds }) {
  const indexes = await loadMatchingContext({ adminClient });
  const knownThreadIds = Array.from(indexes.threadIdToAgencyId.keys());
  const knownContactEmails = Array.from(indexes.agencyIdsByEmail.keys());
  const query = buildBackfillQuery({ knownThreadIds, knownContactEmails, sinceUnixSeconds });
  if (!query) {
    return { ok: true, stage: 'no_known_agencies', matched: 0, duplicates: 0, skipped: 0, processed: 0 };
  }

  const candidateGmailMessageIds = [];
  let pageToken;
  let pagesFetched = 0;
  do {
    const page = await gmailClient.listMessageIdsByQuery({ query, pageToken, maxResults: 50 }, gmailDeps);
    for (const m of (page.messages || [])) {
      if (m && m.id) candidateGmailMessageIds.push(m.id);
    }
    pageToken = page.nextPageToken;
    pagesFetched += 1;
  } while (pageToken && pagesFetched < MAX_HISTORY_PAGES_PER_RUN && candidateGmailMessageIds.length < MAX_MESSAGES_PER_RUN);

  const boundedIds = Array.from(new Set(candidateGmailMessageIds)).slice(0, MAX_MESSAGES_PER_RUN);
  let matchedCount = 0;
  let duplicateCount = 0;
  let skippedCount = 0;
  for (const gmailMessageId of boundedIds) {
    const outcome = await processCandidateMessage({ adminClient, gmailDeps, gmailMessageId, indexes });
    if (outcome === 'matched') matchedCount += 1;
    else if (outcome === 'duplicate') duplicateCount += 1;
    else skippedCount += 1;
  }

  return { ok: true, stage: 'backfill_complete', matched: matchedCount, duplicates: duplicateCount, skipped: skippedCount, processed: boundedIds.length };
}

module.exports = {
  SETTINGS_KEY_SYNC_CURSOR,
  MAX_MESSAGES_PER_RUN,
  MAX_HISTORY_PAGES_PER_RUN,
  MAX_INBOUND_BODY_LENGTH,
  POSTGRES_UNIQUE_VIOLATION_CODE,
  STALE_HISTORY_RECOVERY_MAX_WINDOW_SECONDS,
  STALE_HISTORY_RECOVERY_OVERLAP_SECONDS,
  getHeader,
  decodeGmailBase64Url,
  findBodyPartData,
  stripHtmlToText,
  extractNormalizedPlainTextBody,
  extractEmailAddress,
  splitMessageIdList,
  extractMessageFields,
  buildMatchingIndexes,
  classifyInboundMessage,
  buildBackfillQuery,
  isProviderMessageIdUniqueViolation,
  isStaleHistoryIdError,
  computeStaleHistoryRecoveryWindowStart,
  readSyncCursor,
  writeSyncCursor,
  findSampleOutboundGmailMessageId,
  loadMatchingContext,
  persistInboundMessage,
  advanceAgencyOnReply,
  logInboundReply,
  processCandidateMessage,
  recoverFromStaleHistoryId,
  syncAgencyMailbox,
  runBoundedBackfill,
};
