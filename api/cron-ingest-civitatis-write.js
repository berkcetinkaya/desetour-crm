/**
 * api/cron-ingest-civitatis-write.js — Vercel Serverless Function
 * ─────────────────────────────────────────────────────────────────────────
 * Dese Tour Operations Center — SCHEDULED (automatic) Civitatis email
 * ingestion. Invoked every 15 minutes by a GitHub Actions workflow (see
 * .github/workflows/civitatis-scheduled-ingestion.yml) — NOT by Vercel
 * Cron (vercel.json has no `crons` entry; Vercel Cron on this project's
 * plan cannot reliably reach a 15-minute cadence, and this repo does not
 * use it as a second scheduler). It exists so a human never has to open
 * the manual endpoint's URL for ordinary day-to-day ingestion.
 *
 * ZERO NEW BOOKING/MATCHING/WRITE LOGIC. Every actual decision — what
 * counts as an eligible booking, how events are grouped and ordered,
 * what gets written and in what order, what stays fail-closed
 * (POSSIBLE_EXISTING_MATCH / NEEDS_REVIEW / PARSE_ERROR / IGNORED / an
 * unknown or 'failed' RPC result) — is made by the exact same,
 * unmodified code api/ingest-civitatis-write.js already uses:
 *   - api/_civitatis/writeAdapter.js's planCivitatisIngestion /
 *     executeCivitatisIngestionPlan (grouping, eligibility, ordering,
 *     fail-closed stop-on-failure) — imported, not copied.
 *   - public.ingest_civitatis_booking(...) (the SAME transactional RPC,
 *     called through the SAME buildRealRpcCaller this file imports from
 *     api/ingest-civitatis-write.js).
 * This file's own job is: (1) prove the request really came from the
 * scheduler, (2) discover which Gmail messages to consider — see GMAIL
 * DISCOVERY below, the one genuinely new piece of logic in this file —
 * and (3) hand them to runCivitatisWriteOrchestration exactly as the
 * manual endpoint does.
 *
 * AUTHENTICATION: a plain, server-side shared-secret header
 * (`Authorization: Bearer <secret>`) checked against the
 * CIVITATIS_SCHEDULER_SECRET environment variable. This is intentionally
 * NOT tied to Vercel's own auto-injected cron header anymore (that
 * mechanism only applies when Vercel's own Cron feature makes the
 * request; GitHub Actions makes an ordinary HTTP request and must supply
 * the header itself, from a GitHub Actions encrypted secret holding the
 * SAME value). Fails closed: an unset CIVITATIS_SCHEDULER_SECRET means
 * no request — including a genuine scheduled one — can ever pass.
 *
 * THE WRITE GATE IS UNCHANGED AND STILL RESPECTED: passing the scheduler
 * secret check does NOT by itself cause any write. write mode is still
 * computed by isWriteModeActive({ writeEnvValue:
 * process.env.CIVITATIS_WRITE_ENABLED, requestedWrite: true }) — the
 * SAME function, the SAME environment variable, the SAME exact-string
 * "true" requirement the manual endpoint already enforces. On a
 * deployment where CIVITATIS_WRITE_ENABLED is not "true" (e.g.
 * Production, until explicitly enabled after review), a
 * correctly-authenticated scheduled run still only ever produces a
 * dry-run report. There is exactly one write gate in this whole system.
 *
 * GMAIL DISCOVERY — bounded overlap window, not "assume page 1 is
 * everything" (see the earlier design this file replaces, and the
 * dedicated architecture-review conversation this fix responds to):
 *   1. Read the most recent email_ingestions.received_at this system has
 *      ever recorded (api/_civitatis/supabaseAdmin.js's new
 *      getLatestEmailIngestionReceivedAt — a plain read, no schema
 *      change, no effect on any existing query).
 *   2. Subtract OVERLAP_WINDOW_MS (see constant below) from it — or, if
 *      no watermark exists yet (first-ever scheduled run), from "now" —
 *      to get a since-timestamp. This is a DELIBERATE, generous overlap,
 *      not the exact watermark with zero margin: scheduler delays, clock
 *      skew between Gmail's own timestamps and this system's, a run that
 *      failed entirely before updating anything, and Gmail's own
 *      indexing lag are all safely re-covered by every subsequent run,
 *      not just tolerated once.
 *   3. Search Gmail with `after:<sinceUnixSeconds>` (a documented Gmail
 *      search operator — see buildCivitatisSearchQueryWithWindow in
 *      gmailClient.js) — narrowing at the QUERY level, never by
 *      assuming which page holds the newest mail.
 *   4. Page through EVERY result Gmail returns for that bounded window
 *      (gmailClient.fetchAllMessagesWithinCeiling), up to FETCH_CEILING
 *      messages — never assuming the first page is complete.
 *   5. Hand the ENTIRE fetched set (not just "the newest N") to the
 *      unmodified planCivitatisIngestion/executeCivitatisIngestionPlan.
 * Re-encountering an already-processed message inside the overlap
 * window is expected and harmless: ingest_civitatis_booking's
 * gmail_message_id UNIQUE guard makes it a guaranteed already_processed
 * no-op — email_ingestions remains the sole authoritative duplicate
 * protection, unchanged.
 *
 * This design's correctness does NOT depend on Gmail's list ordering AT
 * ALL, in either direction: every run re-scans the FULL bounded window
 * (not "resume where the last page token left off"), so even a message
 * Gmail happens to place at the very end of one run's results — or one
 * that a truncated run never reaches at all — remains inside the window
 * and gets a fresh chance on every subsequent run (up to ~
 * OVERLAP_WINDOW_MS / 15 minutes independent opportunities before it
 * ages out of the window). Only if a message NEVER once makes it into
 * ANY run's fetched set for its entire time inside the window could it
 * be missed — see FETCH_CEILING's sizing rationale below for why that is
 * not expected at realistic volumes, and see `truncated` in the response
 * for how a run that could not be certain it saw everything reports
 * that honestly rather than silently claiming completeness.
 * ─────────────────────────────────────────────────────────────────────────
 */
'use strict';

const gmailClient = require('./_civitatis/gmailClient');
const { createSupabaseCivitatisRepo, ConfigurationError } = require('./_civitatis/supabaseAdmin');
const writeEndpoint = require('./ingest-civitatis-write');

// How far back of a safety margin to re-scan beyond the last known
// watermark, every single run. Chosen deliberately generous: this
// project's own explicit priority is "never miss a reservation" over
// "avoid repeated reads" (repeated reads are cheap and idempotent). 24
// hours means even a scheduler outage lasting the better part of a day
// is fully recovered by the very next successful run, with zero manual
// intervention — far beyond the 15-minute run interval this window
// needs to merely double-cover for ordinary scheduler jitter/clock skew.
const OVERLAP_WINDOW_MS = 24 * 60 * 60 * 1000;

// Hard ceiling on messages fetched in one run, across all pages. Sized
// generously above realistic Civitatis volume for a single tour
// operator (a handful to low tens of booking emails per day, meaning a
// 24-hour window realistically holds well under 100 messages even
// accounting for both new_booking and modified events) — 300 is
// comfortable multi-times headroom for a genuine burst, while staying
// boundable within this function's existing maxDuration (each fetched
// message costs one additional Gmail API call; see vercel.json). This
// is a SOFT ceiling (see gmailClient.fetchAllMessagesWithinCeiling) —
// stops requesting further pages once met, never discards messages
// already fetched.
const FETCH_CEILING = 300;

// ── Pure helpers — no I/O, fully unit-testable ───────────────────────────

/**
 * Vercel's supported cron authentication check has been superseded by a
 * plain shared-secret header (see file header "AUTHENTICATION"). Kept as
 * a small pure/injectable predicate, same style as
 * writeEndpoint.isWriteModeActive/isManualWriteAuthorized. Fails closed:
 * no configuredSecret means this can never return true, however it is
 * called.
 */
function isAuthorizedSchedulerRequest({ configuredSecret, authorizationHeader }) {
  return !!configuredSecret && authorizationHeader === `Bearer ${configuredSecret}`;
}

/**
 * The since-timestamp (Unix seconds) every scheduled run searches Gmail
 * from — see file header "GMAIL DISCOVERY" steps 1-2. Pure/injectable:
 * takes the watermark and "now" as plain values rather than reading
 * process/Date itself, so the exact arithmetic is directly testable.
 */
function computeSinceUnixSeconds({ lastReceivedAtIso, nowMs }) {
  const anchorMs = lastReceivedAtIso ? new Date(lastReceivedAtIso).getTime() : nowMs;
  return Math.floor((anchorMs - OVERLAP_WINDOW_MS) / 1000);
}

// ── HTTP handler ─────────────────────────────────────────────────────────

async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed.' });
  }

  const authorized = isAuthorizedSchedulerRequest({
    configuredSecret: process.env.CIVITATIS_SCHEDULER_SECRET,
    authorizationHeader: req.headers['authorization'],
  });
  if (!authorized) {
    return res.status(401).json({ error: 'Unauthorized.' });
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

  let sinceUnixSeconds;
  try {
    const lastReceivedAtIso = await repo.getLatestEmailIngestionReceivedAt();
    sinceUnixSeconds = computeSinceUnixSeconds({ lastReceivedAtIso, nowMs: Date.now() });
  } catch (err) {
    // createSupabaseCivitatisRepo() itself never throws (it only returns
    // function references) — a missing SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY
    // surfaces here, on the first actual call, as a ConfigurationError.
    // Classified the same way every other configuration failure in this
    // file already is (503, not a generic 502), consistent with
    // api/ingest-civitatis-write.js's own established pattern.
    if (err instanceof ConfigurationError) {
      return res.status(503).json({ error: err.message, stage: 'supabase_configuration' });
    }
    console.error('[cron-ingest-civitatis-write] Watermark read error:', err.message);
    return res.status(502).json({ error: 'Failed to read the ingestion watermark. See function logs for details.', stage: 'watermark_read' });
  }

  const query = gmailClient.buildCivitatisSearchQueryWithWindow(sinceUnixSeconds);

  let messages;
  let pagesFetched;
  let truncated;
  try {
    const fetched = await gmailClient.fetchAllMessagesWithinCeiling(query, { maxTotal: FETCH_CEILING });
    messages = fetched.messages;
    pagesFetched = fetched.pagesFetched;
    truncated = fetched.truncated;
    if (truncated) {
      // Not a failure — see file header for why a truncated run is
      // self-healing across subsequent runs — but must never be silent.
      console.warn(
        `[cron-ingest-civitatis-write] FETCH_CEILING (${FETCH_CEILING}) reached with more Gmail results ` +
        `still available beyond what was fetched this run (pagesFetched=${pagesFetched}). ` +
        'Not treated as a failure — the next scheduled run\'s overlap window will re-cover this period.'
      );
    }
  } catch (err) {
    if (err instanceof gmailClient.ConfigurationError) {
      return res.status(503).json({ error: err.message, stage: 'gmail_configuration' });
    }
    console.error('[cron-ingest-civitatis-write] Gmail fetch error:', err.message);
    return res.status(502).json({ error: 'Failed to fetch messages from Gmail. See function logs for details.', stage: 'gmail_fetch' });
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
    trigger: 'scheduler',
    mode: writeModeActive ? 'write' : 'dryRun',
    writeEnabled: writeEnvValue === 'true',
    results: outcome.results,
    discovery: {
      sinceUnixSeconds,
      overlapWindowMs: OVERLAP_WINDOW_MS,
      fetchCeiling: FETCH_CEILING,
      messagesFetched: messages.length,
      pagesFetched,
      truncated,
    },
  });
}

handler.isAuthorizedSchedulerRequest = isAuthorizedSchedulerRequest;
handler.computeSinceUnixSeconds = computeSinceUnixSeconds;
handler.OVERLAP_WINDOW_MS = OVERLAP_WINDOW_MS;
handler.FETCH_CEILING = FETCH_CEILING;

module.exports = handler;
