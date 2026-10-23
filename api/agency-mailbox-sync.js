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
  const mode = query.mode === 'backfill' ? 'backfill' : 'incremental';
  const gmailDeps = deps.gmailDeps || {};
  const gmailInboundSync = deps.gmailInboundSync || realGmailInboundSync;

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
