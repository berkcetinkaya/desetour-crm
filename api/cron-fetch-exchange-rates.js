/**
 * api/cron-fetch-exchange-rates.js — Vercel Serverless Function
 * ─────────────────────────────────────────────────────────────────────────
 * Dese Tour Operations Center — Civitatis Settlement Engine, Phase 1.
 * Scheduled (daily) fetch of the ECB reference-rate feed, computing the
 * EUR->TRY/USD->TRY/GBP->TRY cross rates this project needs and caching
 * them in public.exchange_rates. Invoked by a GitHub Actions workflow
 * (see .github/workflows/exchange-rates-scheduled-fetch.yml) on the
 * exact same shared-secret-header pattern
 * api/cron-ingest-civitatis-write.js already established — this file
 * introduces no new authentication mechanism.
 *
 * AUTHENTICATION: `Authorization: Bearer <secret>` checked against the
 * FX_SCHEDULER_SECRET environment variable. Fails closed: an unset
 * FX_SCHEDULER_SECRET means no request can ever pass.
 *
 * WRITE PATH: api/_fx/supabaseAdmin.js's upsertExchangeRates, using the
 * service_role key — the ONLY thing that can ever write to
 * exchange_rates (no authenticated-role write policy exists on that
 * table at all; see the forward migration). No secret of any kind is
 * needed to call the ECB feed itself — it is a free, public, no-key
 * endpoint — so this function's only secret is its own inbound
 * scheduler auth.
 * ─────────────────────────────────────────────────────────────────────────
 */
'use strict';

const ecbClient = require('./_fx/ecbClient');
const fxAdmin = require('./_fx/supabaseAdmin');

/** Same shape as cron-ingest-civitatis-write.js's identical predicate —
 * pure/injectable, fails closed with no configured secret. */
function isAuthorizedSchedulerRequest({ configuredSecret, authorizationHeader }) {
  return !!configuredSecret && authorizationHeader === `Bearer ${configuredSecret}`;
}

async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed.' });
  }

  const authorized = isAuthorizedSchedulerRequest({
    configuredSecret: process.env.FX_SCHEDULER_SECRET,
    authorizationHeader: req.headers['authorization'],
  });
  if (!authorized) {
    return res.status(401).json({ error: 'Unauthorized.' });
  }

  let rows;
  try {
    rows = await ecbClient.fetchEcbDailyRates();
  } catch (err) {
    if (err instanceof ecbClient.EcbFetchError) {
      console.error('[cron-fetch-exchange-rates] ECB fetch/parse error:', err.message);
      return res.status(502).json({ error: err.message, stage: 'ecb_fetch' });
    }
    throw err;
  }

  if (rows.length === 0) {
    // Not an error (section 11's own fallback philosophy applies here
    // too) — the ECB feed responded but did not include a TRY rate this
    // run. No row is written; the next scheduled run tries again.
    return res.status(200).json({ ok: true, written: 0, note: 'ECB feed did not include a TRY rate this run; nothing written.' });
  }

  let written;
  try {
    written = await fxAdmin.upsertExchangeRates(rows);
  } catch (err) {
    if (err instanceof fxAdmin.ConfigurationError) {
      return res.status(503).json({ error: err.message, stage: 'supabase_configuration' });
    }
    console.error('[cron-fetch-exchange-rates] Upsert error:', err.message);
    return res.status(502).json({ error: 'Failed to write exchange rates. See function logs for details.', stage: 'upsert' });
  }

  return res.status(200).json({ ok: true, written: written.length, rows: written });
}

handler.isAuthorizedSchedulerRequest = isAuthorizedSchedulerRequest;

module.exports = handler;
