/**
 * api/cron-ingest-civitatis-write.js — Vercel Serverless Function
 * ─────────────────────────────────────────────────────────────────────────
 * Dese Tour Operations Center — SCHEDULED (automatic) Civitatis email
 * ingestion. This is the ONLY code in this repository invoked by Vercel
 * Cron (see vercel.json's `crons` entry, which points here). It exists
 * so a human never has to open api/ingest-civitatis-write.js's URL by
 * hand for ordinary day-to-day ingestion.
 *
 * ZERO NEW INGESTION LOGIC. Every actual decision — what counts as an
 * eligible booking, how events are grouped and ordered, what gets
 * written and in what order, what stays fail-closed
 * (POSSIBLE_EXISTING_MATCH / NEEDS_REVIEW / PARSE_ERROR /
 * IGNORED / an unknown or 'failed' RPC result) — is made by the exact
 * same, unmodified code api/ingest-civitatis-write.js already uses and
 * tests/civitatis/writeEndpoint.test.js already exercises directly:
 *   - api/_civitatis/gmailClient.js (Gmail retrieval)
 *   - api/_civitatis/writeAdapter.js's planCivitatisIngestion /
 *     executeCivitatisIngestionPlan (grouping, eligibility, ordering,
 *     fail-closed stop-on-failure)
 *   - api/_civitatis/parser.js / matching.js (via the above — not
 *     called directly here at all)
 *   - public.ingest_civitatis_booking(...) (the SAME transactional RPC,
 *     called through the SAME buildRealRpcCaller this file imports
 *     from api/ingest-civitatis-write.js rather than reimplementing)
 * This file's own job is exactly three things: (1) prove the request
 * really came from Vercel Cron, (2) fetch one fresh, unfiltered page of
 * the newest Civitatis messages, and (3) hand them to
 * runCivitatisWriteOrchestration — imported, not copied — with write
 * mode computed by the SAME isWriteModeActive gate the manual endpoint
 * already uses.
 *
 * AUTHENTICATION — Vercel's own supported cron mechanism: when a
 * `CRON_SECRET` environment variable is set on the project, Vercel
 * automatically attaches `Authorization: Bearer <CRON_SECRET>` to every
 * request it sends when invoking a scheduled function
 * (https://vercel.com/docs/cron-jobs/manage-cron-jobs#securing-cron-jobs).
 * isAuthorizedCronRequest below checks that header against the SAME
 * environment variable. Fails closed: if CRON_SECRET is not set at all,
 * every request — including a genuine Vercel Cron invocation — is
 * rejected with 401, never silently allowed through. There is no
 * fallback path that skips this check. A caller who merely discovers
 * this URL, with no knowledge of CRON_SECRET, can never pass it.
 *
 * THE WRITE GATE IS UNCHANGED AND STILL RESPECTED: reaching this
 * function on a schedule (i.e. passing the CRON_SECRET check) does NOT
 * by itself cause any write. write mode is still computed by
 * isWriteModeActive({ writeEnvValue: process.env.CIVITATIS_WRITE_ENABLED,
 * requestedWrite: true }) — the SAME function, the SAME environment
 * variable, the SAME exact-string "true" requirement the manual
 * endpoint already enforces. On a deployment where
 * CIVITATIS_WRITE_ENABLED is not "true" (e.g. Production, until
 * explicitly enabled after review), a correctly-authenticated scheduled
 * run still only ever produces a dry-run report — the exact same
 * "build the plan, report what WOULD be sent, never call the RPC"
 * behavior as an unauthenticated dry-run request to the manual
 * endpoint. No separate "is this cron run allowed to write" flag exists
 * anywhere in this file — there is exactly one write gate in this whole
 * system, and this file does not get its own copy of it.
 *
 * GMAIL PAGINATION: deliberately NEVER passes a pageToken — every
 * invocation starts fresh from Gmail's own first page for
 * buildCivitatisSearchQuery(), which the Gmail API always returns
 * newest-first (there is no orderBy param; this is Gmail's own default,
 * unchanged, unconfigurable ordering). This means every scheduled run
 * independently sees whatever is newest AT THAT MOMENT, never a stale
 * pinned position — the exact opposite of "accidentally limited forever
 * to an old fixed first page". Already-processed messages coming back
 * on a later run's "newest N" page is expected and harmless: writeAdapter's
 * own already_processed idempotency (driven by ingest_civitatis_booking's
 * gmail_message_id UNIQUE guard) makes reprocessing the same message a
 * guaranteed no-op. maxMessages is set to the SAME HARD_MAX_MESSAGES
 * ceiling (100) the manual endpoint already enforces — imported, not
 * duplicated — a generous per-run window for realistic Civitatis booking
 * volume between scheduled runs. If real volume ever regularly
 * approached that ceiling between runs, the fix is a shorter cron
 * interval or a genuine multi-page loop — deliberately out of scope
 * here, since neither is needed today and this file's whole purpose is
 * the smallest safe scheduling layer on top of already-proven logic.
 * ─────────────────────────────────────────────────────────────────────────
 */
'use strict';

const gmailClient = require('./_civitatis/gmailClient');
const { createSupabaseCivitatisRepo, ConfigurationError } = require('./_civitatis/supabaseAdmin');
const writeEndpoint = require('./ingest-civitatis-write');

// ── Pure helper — no I/O, fully unit-testable ───────────────────────────

/**
 * Vercel's supported cron authentication check. Pure/injectable, same
 * style as writeEndpoint.isWriteModeActive/isManualWriteAuthorized, so
 * it is directly testable without a real HTTP request or real
 * process.env. Fails closed: no configuredSecret means this can never
 * return true, however it is called.
 */
function isAuthorizedCronRequest({ configuredSecret, authorizationHeader }) {
  return !!configuredSecret && authorizationHeader === `Bearer ${configuredSecret}`;
}

/**
 * The exact options handed to gmailClient.fetchMessagePage for every
 * scheduled run — a tiny pure function purely so the "never a pageToken"
 * pagination safety property (see file header) is directly assertable in
 * a test without mocking Gmail at all, the same way isAuthorizedCronRequest
 * is directly assertable without a real request.
 */
function buildCronFetchOptions() {
  return { maxResults: writeEndpoint.HARD_MAX_MESSAGES };
}

// ── HTTP handler ─────────────────────────────────────────────────────────

async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed. Vercel Cron only sends GET.' });
  }

  const authorized = isAuthorizedCronRequest({
    configuredSecret: process.env.CRON_SECRET,
    authorizationHeader: req.headers['authorization'],
  });
  if (!authorized) {
    return res.status(401).json({ error: 'Unauthorized.' });
  }

  const fetchOptions = buildCronFetchOptions();
  const maxMessages = fetchOptions.maxResults;

  let messages;
  let nextPageToken;
  try {
    const page = await gmailClient.fetchMessagePage(gmailClient.buildCivitatisSearchQuery(), fetchOptions);
    messages = page.messages;
    nextPageToken = page.nextPageToken;
  } catch (err) {
    if (err instanceof gmailClient.ConfigurationError) {
      return res.status(503).json({ error: err.message, stage: 'gmail_configuration' });
    }
    console.error('[cron-ingest-civitatis-write] Gmail fetch error:', err.message);
    return res.status(502).json({ error: 'Failed to fetch messages from Gmail. See function logs for details.', stage: 'gmail_fetch' });
  }

  let repo;
  try {
    repo = createSupabaseCivitatisRepo();
  } catch (err) {
    if (err instanceof ConfigurationError) {
      return res.status(503).json({ error: err.message, stage: 'supabase_configuration' });
    }
    throw err;
  }

  const writeEnvValue = process.env.CIVITATIS_WRITE_ENABLED;
  const writeModeActive = writeEndpoint.isWriteModeActive({ writeEnvValue, requestedWrite: true });

  let rpcCaller = null;
  if (writeModeActive) {
    try {
      rpcCaller = writeEndpoint.buildRealRpcCaller();
    } catch (err) {
      if (err instanceof ConfigurationError) {
        return res.status(503).json({ error: err.message, stage: 'supabase_configuration' });
      }
      throw err;
    }
  }

  let outcome;
  try {
    // externalBookingId: null — a scheduled run is never scoped to one
    // booking, unlike the manual endpoint's diagnostic single-booking mode.
    outcome = await writeEndpoint.runCivitatisWriteOrchestration({
      messages, repo, externalBookingId: null, writeModeActive, rpcCaller,
    });
  } catch (err) {
    console.error('[cron-ingest-civitatis-write] Orchestration error:', err.message);
    return res.status(500).json({ error: 'Ingestion failed unexpectedly. See function logs for details.', stage: 'orchestration' });
  }

  if (!outcome.ok) {
    return res.status(422).json({ error: outcome.error, stage: 'planning_precondition' });
  }

  return res.status(200).json({
    trigger: 'cron',
    mode: writeModeActive ? 'write' : 'dryRun',
    writeEnabled: writeEnvValue === 'true',
    results: outcome.results,
    pagination: { requestedMaxMessages: maxMessages, nextPageToken: nextPageToken || null },
  });
}

handler.isAuthorizedCronRequest = isAuthorizedCronRequest;
handler.buildCronFetchOptions = buildCronFetchOptions;

module.exports = handler;
