/**
 * api/agency-mailbox-sync.js — Vercel Serverless Function
 * ─────────────────────────────────────────────────────────────────────────
 * Agency Mailbox Phase 2/8 — scheduled inbound-reply sync for
 * hello@desetour.com, triggered the SAME way api/cron-ingest-civitatis-write.js
 * already is: a scheduled caller (a GitHub Actions workflow, not a native
 * Vercel Cron Job — this repo has none) sends a GET request with
 * `Authorization: Bearer <AGENCY_MAILBOX_SYNC_SECRET>`. Never reachable
 * without that exact header; never callable from browser code, which
 * never even knows this secret exists.
 *
 * Every real decision — the capability preflight, History API pagination,
 * the 4-tier matching hierarchy, persistence, Agency state updates — lives
 * in api/_agencies/gmailInboundSync.js; this file is purely the HTTP/auth/
 * Supabase-client wiring around it, same split as every other Agency
 * endpoint in this codebase.
 *
 * Default mode (`?mode` omitted or `incremental`): one bounded Gmail
 * History API pass since the last stored cursor (public.settings). Mode
 * `backfill`: the explicit, separately-triggered Phase 8 bounded catch-up
 * (never run automatically, never unbounded — see buildBackfillQuery).
 * Mode `capability`: a pre-production, STRICTLY READ-ONLY probe — calls
 * only gmailInboundSync.checkMailboxCapability and returns immediately;
 * it never reaches incremental sync or backfill, performs zero Supabase
 * writes (no agency_emails/agencies/activity_logs/settings cursor
 * writes), and never ingests a mailbox message. Intended to be run
 * against a Preview deployment before any real sync is attempted there.
 *
 * SAFETY: the capability preflight (gmailSendClient.checkInboundBodyCapability)
 * is re-checked on EVERY invocation, never cached across runs and never
 * assumed from this feature merely existing — if the OAuth grant cannot
 * read a full message body, this endpoint writes NOTHING and reports
 * `stage: 'capability_check_failed'` with a safe, non-raw classification
 * only (`insufficient_scope` | `unknown_error`), never Gmail's own error
 * text, never a token.
 * ─────────────────────────────────────────────────────────────────────────
 */
'use strict';

const realGmailInboundSync = require('./_agencies/gmailInboundSync');

class ConfigurationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConfigurationError';
  }
}

/** Same shape as cron-ingest-civitatis-write.js's own predicate — fails
 * closed: an unset secret can never authorize a request, however this is
 * called. */
function isAuthorizedSchedulerRequest({ configuredSecret, authorizationHeader }) {
  return !!configuredSecret && authorizationHeader === `Bearer ${configuredSecret}`;
}

/* ═════════════════════════════════════════════════════════════════════
 * TEMPORARY DIAGNOSTIC — added to debug a persistent 401 on the
 * scheduled Agency Mailbox sync despite a GitHub repo secret and a
 * Vercel Production env var that are confirmed to hold the same value
 * (including a redeploy after the env var was set). Computes ONLY safe
 * boolean/length metadata about the auth inputs — it never returns or
 * logs the secret, the Authorization header, any substring of either,
 * or any reversible encoding. Does NOT change isAuthorizedSchedulerRequest
 * or the accepted auth contract in any way — this function is read-only
 * diagnostic computed AFTER the real (unmodified) auth check has already
 * failed. Remove this function, its one call site below, and its test
 * coverage once the root cause is confirmed and fixed.
 * ═════════════════════════════════════════════════════════════════════ */
function _diagnoseUnauthorizedRequest({ configuredSecret, authorizationHeader }) {
  const BEARER_PREFIX = 'Bearer ';
  const hasConfigured = typeof configuredSecret === 'string' && configuredSecret.length > 0;
  const hasHeader = typeof authorizationHeader === 'string' && authorizationHeader.length > 0;
  const schemeIsBearer = hasHeader && authorizationHeader.startsWith(BEARER_PREFIX);
  const providedBearerValue = schemeIsBearer ? authorizationHeader.slice(BEARER_PREFIX.length) : null;

  const configuredTrimmed = hasConfigured ? configuredSecret.trim() : '';
  const providedTrimmed = providedBearerValue !== null ? providedBearerValue.trim() : '';

  return {
    configuredSecretPresent: hasConfigured,
    authorizationHeaderPresent: hasHeader,
    authorizationSchemeIsBearer: schemeIsBearer,
    configuredSecretLength: hasConfigured ? configuredSecret.length : 0,
    providedBearerValueLength: providedBearerValue !== null ? providedBearerValue.length : 0,
    exactMatch: hasConfigured && providedBearerValue !== null && providedBearerValue === configuredSecret,
    trimmedMatch: hasConfigured && providedBearerValue !== null && providedTrimmed === configuredTrimmed,
    configuredHasLeadingOrTrailingWhitespace: hasConfigured && configuredSecret !== configuredTrimmed,
    providedHasLeadingOrTrailingWhitespace: providedBearerValue !== null && providedBearerValue !== providedTrimmed,
  };
}

function getSupabaseEnv() {
  const url = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const missing = [
    !url && 'SUPABASE_URL',
    !serviceRoleKey && 'SUPABASE_SERVICE_ROLE_KEY',
  ].filter(Boolean);
  if (missing.length > 0) {
    throw new ConfigurationError(
      `Agency mailbox sync is not configured: missing environment variable(s): ${missing.join(', ')}. ` +
      'Set these as server-side Vercel environment variables — never in browser-reachable config.'
    );
  }
  return { url, serviceRoleKey };
}

async function handler(req, res, deps = {}) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed.' });
  }

  const authorized = isAuthorizedSchedulerRequest({
    configuredSecret: process.env.AGENCY_MAILBOX_SYNC_SECRET,
    authorizationHeader: req.headers['authorization'],
  });
  if (!authorized) {
    // TEMPORARY DIAGNOSTIC — server-log only (Vercel Function Logs), never
    // in the HTTP response, so no browser/caller ever sees it. Safe
    // metadata only — see _diagnoseUnauthorizedRequest's own header
    // comment. Remove this block once the 401 is root-caused and fixed.
    console.error('[agency-mailbox-sync][TEMP-DIAGNOSTIC-401]', _diagnoseUnauthorizedRequest({
      configuredSecret: process.env.AGENCY_MAILBOX_SYNC_SECRET,
      authorizationHeader: req.headers['authorization'],
    }));
    return res.status(401).json({ error: 'Unauthorized.' });
  }

  let adminClient;
  try {
    const { url, serviceRoleKey } = getSupabaseEnv();
    const createClient = deps.createClient || require('@supabase/supabase-js').createClient;
    adminClient = createClient(url, serviceRoleKey);
  } catch (err) {
    if (err instanceof ConfigurationError) {
      return res.status(503).json({ error: err.message, stage: 'db_configuration' });
    }
    throw err;
  }

  const query = req.query || {};
  const mode = query.mode === 'backfill' ? 'backfill' : query.mode === 'capability' ? 'capability' : 'incremental';
  const gmailDeps = deps.gmailDeps || {};
  const gmailInboundSync = deps.gmailInboundSync || realGmailInboundSync;

  // Mode 'capability' is a dead end, deliberately: it returns immediately
  // with the minimal safe shape below and NEVER falls through to the
  // incremental/backfill dispatch or the shared response-building code
  // further down (which merges in extra fields like `mode` or structural
  // run counts) — this response is exactly {ok, capability}, nothing else.
  if (mode === 'capability') {
    try {
      const capResult = await gmailInboundSync.checkMailboxCapability({ adminClient, gmailDeps });
      if (!capResult.ok) {
        console.error('[agency-mailbox-sync] Capability-only probe failed:', { capability: capResult.capability });
        return res.status(503).json({ ok: false, capability: capResult.capability });
      }
      console.info('[agency-mailbox-sync] Capability-only probe succeeded.');
      return res.status(200).json({ ok: true, capability: capResult.capability });
    } catch (err) {
      console.error('[agency-mailbox-sync] Capability-only probe failed unexpectedly:', err.message);
      return res.status(500).json({ ok: false, capability: 'unknown_error' });
    }
  }

  try {
    let result;
    if (mode === 'backfill') {
      const sinceParam = typeof query.since === 'string' ? parseInt(query.since, 10) : NaN;
      const sinceUnixSeconds = Number.isFinite(sinceParam) ? sinceParam : undefined;
      result = await gmailInboundSync.runBoundedBackfill({ adminClient, gmailDeps, sinceUnixSeconds });
    } else {
      result = await gmailInboundSync.syncAgencyMailbox({ adminClient, gmailDeps });
    }

    if (!result.ok && result.stage === 'capability_check_failed') {
      // Safe, classified-only response — never Gmail's raw error text,
      // never a token. See this file's header "SAFETY" note.
      console.error('[agency-mailbox-sync] Capability preflight failed:', { capability: result.capability, mode });
      return res.status(503).json({
        error: result.capability === 'insufficient_scope'
          ? 'Gmail OAuth re-authorization with a message-body read scope (e.g. gmail.readonly) is required before inbound sync can run.'
          : 'Gmail inbound read capability could not be confirmed. See function logs for details.',
        stage: 'capability_check_failed',
        capability: result.capability,
      });
    }

    if (!result.ok && result.stage === 'stale_history_recovery_failed') {
      // The Gmail History cursor was stale (startHistoryId outside Gmail's
      // retention window) and the bounded recovery catch-up itself could
      // not complete. The old cursor was left untouched (fail closed) —
      // this is retried automatically on the next scheduled run, never a
      // permanent failure. Safe, structural-only response — never a raw
      // Gmail error, never a token.
      console.error('[agency-mailbox-sync] Stale history-id recovery failed:', { mode });
      return res.status(503).json({
        error: 'Gmail history cursor olduğu haliyle kullanılamıyor; sınırlı bir kurtarma denendi ve başarısız oldu. Bir sonraki otomatik çalıştırmada yeniden denenecek.',
        stage: 'stale_history_recovery_failed',
      });
    }

    // Safe to log/return in full — matched/skipped/processed counts and
    // a historyId are structural diagnostics, never a body, never PII.
    console.info('[agency-mailbox-sync] run complete:', { mode, ...result });
    return res.status(200).json({ ok: true, mode, ...result });
  } catch (err) {
    console.error('[agency-mailbox-sync] Unexpected error:', err.message);
    return res.status(500).json({ error: 'Agency mailbox sync failed unexpectedly. See function logs for details.' });
  }
}

module.exports = handler;
module.exports.ConfigurationError = ConfigurationError;
module.exports.isAuthorizedSchedulerRequest = isAuthorizedSchedulerRequest;
// TEMPORARY DIAGNOSTIC export — see _diagnoseUnauthorizedRequest's own
// header comment. Remove alongside the rest of the diagnostic.
module.exports._diagnoseUnauthorizedRequest = _diagnoseUnauthorizedRequest;
