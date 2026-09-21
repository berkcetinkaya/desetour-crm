/**
 * /api/ingest-civitatis.js — Vercel Serverless Function
 * ─────────────────────────────────────────────────────────────────────────
 * Dese Tour Operations Center — Civitatis email ingestion
 *
 * THIS PHASE: DRY RUN ONLY. There is no write code path anywhere in this
 * function or anything it calls — api/civitatis/dryRun.js and
 * api/civitatis/supabaseAdmin.js only ever SELECT. No production
 * customer, reservation, reservation_guests, activity_logs, or
 * email_ingestions row is created, updated, or deleted by this endpoint
 * in this phase, regardless of what query parameters are supplied. It is
 * not wired to any cron/schedule (no vercel.json changes were made
 * alongside this file).
 *
 * SECURITY MODEL (mirrors api/send-email.js):
 *   - GMAIL_CLIENT_ID / GMAIL_CLIENT_SECRET / GMAIL_REFRESH_TOKEN and
 *     SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY live ONLY in Vercel's
 *     server-side environment variables — never in source, never sent to
 *     the browser, never logged.
 *   - If any of them are missing, the request fails with a clear 503
 *     configuration error rather than proceeding partially.
 *
 * USAGE (dry run, paginated — see report for exact real-mailbox steps):
 *   GET /api/ingest-civitatis?maxMessages=25
 *   GET /api/ingest-civitatis?maxMessages=25&pageToken=<from previous response>
 *
 * The response's `nextPageToken` (when present) must be passed back in a
 * follow-up request to continue the backfill — a single invocation
 * intentionally processes a bounded page of messages so it can complete
 * well within the function's maxDuration.
 * ─────────────────────────────────────────────────────────────────────────
 */
'use strict';

const gmailClient = require('./civitatis/gmailClient');
const { createSupabaseCivitatisRepo } = require('./civitatis/supabaseAdmin');
const { runCivitatisDryRun } = require('./civitatis/dryRun');

const DEFAULT_MAX_MESSAGES = 25;
const HARD_MAX_MESSAGES = 100; // upper bound regardless of what a caller requests, to stay inside the function's time budget

module.exports = async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed. Use GET or POST.' });
  }

  // Explicit, permanent guard: this endpoint has no write implementation
  // in this phase. If a caller ever passes mode=write (e.g. a future
  // script written against an assumed-future API shape), refuse loudly
  // rather than silently ignoring the parameter — there must never be an
  // ambiguous path into a write that doesn't exist yet.
  const requestedMode = (req.query && req.query.mode) || (req.body && req.body.mode);
  if (requestedMode && requestedMode !== 'dryRun') {
    return res.status(400).json({
      error: `mode "${requestedMode}" is not supported. This endpoint only implements dry-run mode in this phase — there is no production write code path yet.`,
    });
  }

  let maxMessages = parseInt((req.query && req.query.maxMessages) || DEFAULT_MAX_MESSAGES, 10);
  if (!Number.isFinite(maxMessages) || maxMessages < 1) maxMessages = DEFAULT_MAX_MESSAGES;
  maxMessages = Math.min(maxMessages, HARD_MAX_MESSAGES);
  const pageToken = (req.query && req.query.pageToken) || undefined;

  let messages;
  let nextPageToken;
  try {
    const page = await gmailClient.fetchMessagePage(gmailClient.buildCivitatisSearchQuery(), {
      pageToken,
      maxResults: maxMessages,
    });
    messages = page.messages;
    nextPageToken = page.nextPageToken;
  } catch (err) {
    if (err instanceof gmailClient.ConfigurationError) {
      return res.status(503).json({ error: err.message, stage: 'gmail_configuration' });
    }
    console.error('[ingest-civitatis] Gmail fetch error:', err.message);
    return res.status(502).json({ error: 'Failed to fetch messages from Gmail. See function logs for details.', stage: 'gmail_fetch' });
  }

  let report;
  try {
    const repo = createSupabaseCivitatisRepo();
    report = await runCivitatisDryRun({ messages, repo });
  } catch (err) {
    if (err.name === 'ConfigurationError') {
      return res.status(503).json({ error: err.message, stage: 'supabase_configuration' });
    }
    console.error('[ingest-civitatis] Dry-run error:', err.message);
    return res.status(500).json({ error: 'Dry run failed unexpectedly. See function logs for details.', stage: 'dry_run' });
  }

  if (!report.ok) {
    return res.status(422).json({ error: report.error, stage: 'dry_run_precondition' });
  }

  return res.status(200).json({
    mode: 'dryRun',
    ...report,
    pagination: { requestedMaxMessages: maxMessages, nextPageToken: nextPageToken || null },
  });
};
