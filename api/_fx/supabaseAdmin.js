/**
 * api/_fx/supabaseAdmin.js
 * ─────────────────────────────────────────────────────────────────────────
 * The ONLY module in the exchange-rate integration that talks to
 * Supabase with elevated privilege. Same shape and same boundary as
 * api/_civitatis/supabaseAdmin.js and api/_whatsapp/supabaseAdmin.js:
 * backed by the service_role key, read exclusively from
 * process.env.SUPABASE_SERVICE_ROLE_KEY at call time, never hard-coded,
 * never logged, never reachable from browser code. public.exchange_rates
 * has no authenticated-role write policy at all (see the forward
 * migration) — this service_role client is the ONLY thing that can ever
 * write a row into it.
 * ─────────────────────────────────────────────────────────────────────────
 */
'use strict';

let _cachedClient = null;

class ConfigurationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConfigurationError';
  }
}

function getServiceRoleClient() {
  if (_cachedClient) return _cachedClient;

  const url = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !serviceRoleKey) {
    const missing = [
      !url && 'SUPABASE_URL',
      !serviceRoleKey && 'SUPABASE_SERVICE_ROLE_KEY',
    ].filter(Boolean).join(', ');
    throw new ConfigurationError(
      `Exchange-rate fetching is not configured: missing environment variable(s): ${missing}. ` +
      'Set these in the Vercel project\'s server-side environment variables — never in browser-reachable config.'
    );
  }

  const { createClient } = require('@supabase/supabase-js');
  _cachedClient = createClient(url, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return _cachedClient;
}

/**
 * Upserts a batch of { rate_date, base_currency, quote_currency, rate,
 * source } rows, keyed on the table's own UNIQUE(rate_date,
 * base_currency, quote_currency) constraint — re-fetching the same day's
 * rate twice (e.g. a retried cron run) overwrites that day's row with
 * the same values rather than erroring or duplicating. Returns the
 * upserted rows.
 */
async function upsertExchangeRates(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return [];
  const sb = getServiceRoleClient();
  const { data, error } = await sb.from('exchange_rates')
    .upsert(rows, { onConflict: 'rate_date,base_currency,quote_currency' })
    .select();
  if (error) throw new Error(`Supabase error upserting exchange_rates: ${error.message}`);
  return data || [];
}

module.exports = {
  ConfigurationError,
  getServiceRoleClient,
  upsertExchangeRates,
};
