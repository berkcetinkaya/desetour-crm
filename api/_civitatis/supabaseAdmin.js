/**
 * api/_civitatis/supabaseAdmin.js
 * ─────────────────────────────────────────────────────────────────────────
 * The ONLY module in this integration that talks to Supabase with
 * elevated privilege. Implements the read-only `repo` interface
 * api/_civitatis/dryRun.js expects, backed by the Supabase service_role
 * key — which bypasses RLS by design (see "SERVICE ROLE BYPASS" in
 * supabase_rls_policies.sql) and therefore must NEVER be reachable from
 * browser code. It is read only in this module by construction: every
 * exported function below issues a `select`, never an `insert`/`update`/
 * `delete` — there is no write path in this file at all yet, matching
 * this phase's explicit "do not implement production writes yet".
 *
 * The service_role key is read exclusively from
 * process.env.SUPABASE_SERVICE_ROLE_KEY at call time — never hard-coded,
 * never logged, never returned in any response body. If it (or the
 * project URL) is not configured, every function here fails safely with
 * a clear, actionable error rather than falling back to any other
 * credential or silently no-op'ing.
 * ─────────────────────────────────────────────────────────────────────────
 */
'use strict';

const { normalizeFullNameForComparison } = require('./matching');

const CIVITATIS_SOURCE_SLUG = 'civitatis';

let _cachedClient = null;

/**
 * Lazily creates (and caches) a Supabase client authenticated with the
 * service_role key. Throws a clear, non-sensitive configuration error —
 * never a stack trace pointing at a missing env var value — if the
 * required environment variables are absent, so a misconfigured
 * deployment fails loudly instead of silently reading/writing nothing.
 */
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
      `Civitatis ingestion is not configured: missing environment variable(s): ${missing}. ` +
      'Set these in the Vercel project\'s server-side environment variables — never in browser-reachable config. ' +
      'See the setup instructions in the implementation report for exact steps.'
    );
  }

  // Uses the same @supabase/supabase-js package already a runtime
  // dependency of this app (browser-side, via CDN, for the anon-key
  // client) — require()'d here only in the Node/Vercel function runtime,
  // never bundled into the browser build.
  const { createClient } = require('@supabase/supabase-js');
  _cachedClient = createClient(url, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return _cachedClient;
}

class ConfigurationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConfigurationError';
  }
}

/** The real Civitatis source row — never created here, never duplicated.
 * Looked up by slug first (the stable machine key), falling back to a
 * case-insensitive name match only if no slug match exists, since the
 * exact slug used in production was not dictated by this implementation
 * phase. Returns null (never a guess) if no matching source is found or
 * if it isn't flagged as a sales channel. */
async function getCivitatisSource() {
  const sb = getServiceRoleClient();
  const bySlug = await sb.from('sources')
    .select('id,name,slug,is_sales_channel,is_review_source')
    .eq('slug', CIVITATIS_SOURCE_SLUG)
    .maybeSingle();
  if (bySlug.error) throw new Error(`Supabase error reading sources by slug: ${bySlug.error.message}`);
  if (bySlug.data) return bySlug.data;

  const byName = await sb.from('sources')
    .select('id,name,slug,is_sales_channel,is_review_source')
    .ilike('name', CIVITATIS_SOURCE_SLUG)
    .maybeSingle();
  if (byName.error) throw new Error(`Supabase error reading sources by name: ${byName.error.message}`);
  return byName.data || null;
}

/** All tour_channels rows for the given source, joined to their tour. */
async function getTourChannelsForSource(sourceId) {
  const sb = getServiceRoleClient();
  const { data, error } = await sb.from('tour_channels')
    .select('id,tour_id,source_id,external_product_id,is_active,tour:tours(id,name)')
    .eq('source_id', sourceId);
  if (error) throw new Error(`Supabase error reading tour_channels: ${error.message}`);
  return data || [];
}

/** The business-identity lookup: is this exact Civitatis booking already
 * linked to a reservation? */
async function findReservationByExternalBooking({ sourceId, externalBookingId }) {
  const sb = getServiceRoleClient();
  const { data, error } = await sb.from('reservations')
    .select('id,source_id,external_booking_id,tour_id,customer_id,check_in,check_in_time,pax_adult,pax_child,tour_language,total_amount,currency,retail_amount,retail_currency,status,guide_name,notes,internal_notes')
    .eq('source_id', sourceId)
    .eq('external_booking_id', externalBookingId)
    .maybeSingle();
  if (error) throw new Error(`Supabase error reading reservations by external booking id: ${error.message}`);
  return data || null;
}

/** Passenger names (in stored order) for an existing reservation, used
 * only to compute the passenger diff — never written here. */
async function getReservationGuestNames(reservationId) {
  const sb = getServiceRoleClient();
  const { data, error } = await sb.from('reservation_guests')
    .select('full_name,sort_order')
    .eq('reservation_id', reservationId)
    .order('sort_order', { ascending: true });
  if (error) throw new Error(`Supabase error reading reservation_guests: ${error.message}`);
  return (data || []).map(g => g.full_name);
}

/** Conservative candidate pool for the legacy-match heuristic: unlinked
 * reservations (no source_id, no external_booking_id) for the matched
 * tour only. The actual multi-field agreement check happens in
 * matching.js — this only narrows the read. */
async function findCandidateLegacyReservations({ tourId }) {
  const sb = getServiceRoleClient();
  const { data, error } = await sb.from('reservations')
    .select('id,tour_id,check_in,check_in_time,pax_adult,pax_child,source_id,external_booking_id,customer_id')
    .eq('tour_id', tourId)
    .is('source_id', null)
    .is('external_booking_id', null);
  if (error) throw new Error(`Supabase error reading candidate legacy reservations: ${error.message}`);
  return data || [];
}

/** Mirrors SupabaseCustomerRepo.findByContact's exact email-OR-phone
 * rule, narrowed server-side rather than fetching every customer. */
async function findCustomersByContact({ email, phone }) {
  if (!email && !phone) return [];
  const sb = getServiceRoleClient();
  let query = sb.from('customers').select('id,full_name,email,phone');
  if (email && phone) query = query.or(`email.eq.${email},phone.eq.${phone}`);
  else if (email) query = query.eq('email', email);
  else query = query.eq('phone', phone);
  const { data, error } = await query.limit(5);
  if (error) throw new Error(`Supabase error reading customers by contact: ${error.message}`);
  return data || [];
}

/** Conservative name-only candidate lookup for the booking CONTACT (never
 * a passenger — see api/_civitatis/dryRun.js, which only ever calls this
 * with mergedState.clientFullName). Narrowed server-side with a
 * case-insensitive exact-string `ilike` (no `%`/`_` wildcards, so this is
 * NOT database-side fuzzy matching — it is a plain case-insensitive
 * equality check on the already whitespace-normalized query string)
 * rather than downloading the entire customers table. This is a
 * prefilter only: the actual match decision is always made by
 * matching.js's matchCustomerByName, which independently re-applies
 * normalizeFullNameForComparison to every candidate returned here, so
 * correctness never depends on this query alone. */
async function findCustomersByName({ fullName }) {
  const normalized = normalizeFullNameForComparison(fullName);
  if (!normalized) return [];
  const sb = getServiceRoleClient();
  const { data, error } = await sb.from('customers')
    .select('id,full_name,email,phone')
    .ilike('full_name', normalized)
    .limit(10);
  if (error) throw new Error(`Supabase error reading customers by name: ${error.message}`);
  return data || [];
}

/**
 * The most recent Gmail-message timestamp (email_ingestions.received_at)
 * this system has ever recorded, across every processing_status — used
 * ONLY by api/cron-ingest-civitatis-write.js to compute a bounded
 * search-window watermark; never used by planCivitatisIngestion/
 * dryRun.js's own eligibility, matching, or write decisions. Any row's
 * existence means that exact Gmail message was already fetched and
 * recorded (Step 1 of ingest_civitatis_booking always claims a row on
 * first sight, regardless of eventual outcome), so this intentionally
 * carries no processing_status filter. Returns null when the table is
 * empty (first-ever scheduled run) — never a fabricated default; the
 * caller is responsible for falling back to a bounded default window in
 * that case, not this function.
 */
async function getLatestEmailIngestionReceivedAt() {
  const sb = getServiceRoleClient();
  const { data, error } = await sb.from('email_ingestions')
    .select('received_at')
    .order('received_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`Supabase error reading latest email_ingestions.received_at: ${error.message}`);
  return data ? data.received_at : null;
}

/** The full read-only repo object shape api/_civitatis/dryRun.js expects. */
function createSupabaseCivitatisRepo() {
  return {
    getCivitatisSource,
    getTourChannelsForSource,
    findReservationByExternalBooking,
    getReservationGuestNames,
    findCandidateLegacyReservations,
    findCustomersByContact,
    findCustomersByName,
    getLatestEmailIngestionReceivedAt,
  };
}

module.exports = {
  createSupabaseCivitatisRepo,
  getServiceRoleClient,
  getLatestEmailIngestionReceivedAt,
  ConfigurationError,
  CIVITATIS_SOURCE_SLUG,
};
