/**
 * api/_civitatis/activityModalityBackfillDryRun.js
 * ─────────────────────────────────────────────────────────────────────────
 * Tour Preparation Intelligence — Phase B2: read-only backfill dry-run
 * for existing Civitatis reservations' Activity/meal-modality.
 *
 * ZERO WRITES. Every Supabase call in this file is a `.select(...)` —
 * there is no `.insert(`/`.update(`/`.delete(`/`.rpc(` anywhere in this
 * module, and it never imports activityModalityPersistence.js. It exists
 * purely to produce a report a human reviews before any real backfill is
 * ever executed (a later, separate phase).
 *
 * AUTHORITATIVE EMAIL SELECTION (Part 4)
 * ─────────────────────────────────────────────────────────────
 * For each reservation, candidate email_ingestions rows are joined via
 * the composite (source_id, external_booking_id) — the same reliable
 * join established in the Tour Preparation Intelligence Phase 0 audit
 * (NOT the FK email_ingestions.reservation_id, which is only ever set on
 * the one terminal row that happened to complete `processed`, and stays
 * NULL on every other row for the same booking). Candidates are filtered
 * to:
 *   event_type != 'cancelled'        — a cancellation email is never
 *                                       treated as an Activity/modality
 *                                       source, regardless of what it
 *                                       might restate.
 *   processing_status = 'processed'  — a 'needs_review'/'failed'/
 *                                       'received' row never successfully
 *                                       became real reservation state, so
 *                                       its content is never trusted as
 *                                       authoritative. This also excludes
 *                                       any stale retry remnant, since a
 *                                       retry of the SAME Gmail message
 *                                       upserts onto the SAME row
 *                                       (ON CONFLICT (gmail_message_id) DO
 *                                       UPDATE) rather than creating a
 *                                       second one — there is nothing
 *                                       further to de-duplicate here.
 * ...then ordered received_at DESC, created_at DESC, id DESC and the
 * first row is selected — a fully deterministic three-level tiebreak
 * (the final `id` comparison guarantees exactly one winner even in a
 * same-timestamp edge case). This is the exact algorithm specified and
 * live-validated during the Phase B discovery turn.
 *
 * ACTIVITY/LANGUAGE EXTRACTION (Part 3.4, 3.5)
 * ─────────────────────────────────────────────────────────────
 * Re-uses api/_civitatis/parser.js's own findLabelValue/LABEL_NAMES/
 * compactLines (additively exported for this purpose — see that file's
 * module.exports comment) against the selected row's raw_body_snapshot —
 * the EXACT SAME label-matching logic normal ingestion already uses for
 * both the Activity and Language fields, not a re-implementation. The
 * full parseCivitatisEmail(message) entry point is deliberately NOT used
 * here: it requires a `from` header (for detectCivitatisEvent's
 * classification) that email_ingestions never stored historically, and
 * reconstructing one would mean guessing at classification rather than
 * reusing the row's own already-authoritative, already-stored
 * event_type. The reservation's own canonical language is re-derived
 * from the SAME selected email (via languageMap.js's mapCivitatisLanguage,
 * also already exported) rather than reverse-mapping
 * reservations.tour_language (which stores the Turkish DISPLAY NAME, e.g.
 * "Portekizce", not the 2-letter code the rule table and normalizer key
 * on) — this keeps Activity and language derivation self-consistent,
 * sourced from the one same authoritative email, exactly how normal
 * ingestion derives them together in the first place.
 * ─────────────────────────────────────────────────────────────────────────
 */
'use strict';

const { getServiceRoleClient } = require('./supabaseAdmin');
const { getActiveCivitatisModalityRules } = require('./activityModalityRules');
const { compactLines, findLabelValue, LABEL_NAMES } = require('./parser');
const { mapCivitatisLanguage } = require('./languageMap');
const { normalizeCivitatisActivityModality } = require('./activityModality');

const CIVITATIS_SOURCE_SLUG = 'civitatis';
const VALID_SCOPES = ['future_active', 'all'];

/** Istanbul "today" as an ISO date (YYYY-MM-DD) — mirrors the exact
 * Intl.DateTimeFormat('en-CA', {timeZone:'Europe/Istanbul', ...}) + parts
 * technique DeseTourDashboard.jsx's own istanbulNowParts already uses for
 * the live dashboard's "is this reservation upcoming" logic. A pure,
 * injectable function (optional `now` override) for deterministic tests —
 * production callers never pass it. */
function getIstanbulTodayISO(now) {
  const raw = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Istanbul',
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(now instanceof Date ? now : new Date()).reduce((acc, p) => { acc[p.type] = p.value; return acc; }, {});
  return `${raw.year}-${raw.month}-${raw.day}`;
}

/** Extracts { activityRaw, languageCode } from one email_ingestions row's
 * raw_body_snapshot using the exact same label-matching functions normal
 * ingestion uses. Pure — no I/O. Returns nulls (never throws) when the
 * body is missing or a field can't be found/mapped — fail-closed,
 * exactly like the normalizer itself does downstream. */
function extractActivityAndLanguage(rawBodySnapshot) {
  if (!rawBodySnapshot || typeof rawBodySnapshot !== 'string') {
    return { activityRaw: null, languageCode: null };
  }
  const lines = compactLines(rawBodySnapshot);
  const activityRaw = findLabelValue(lines, LABEL_NAMES.ACTIVITY);
  const languageRaw = findLabelValue(lines, LABEL_NAMES.LANGUAGE);
  let languageCode = null;
  if (languageRaw) {
    const mapped = mapCivitatisLanguage(languageRaw);
    if (mapped.ok) languageCode = mapped.code;
  }
  return { activityRaw: activityRaw || null, languageCode };
}

/** Deterministically picks the latest authoritative, non-cancellation,
 * successfully-processed email_ingestions row from a candidate list —
 * see the module header for the exact algorithm. Pure — operates on an
 * already-fetched array, no I/O, independently unit-testable. */
function selectAuthoritativeIngestion(candidateRows) {
  const eligible = (candidateRows || []).filter(
    (row) => row && row.event_type !== 'cancelled' && row.processing_status === 'processed'
  );
  if (eligible.length === 0) return null;
  return eligible.slice().sort((a, b) => {
    const receivedDiff = new Date(b.received_at).getTime() - new Date(a.received_at).getTime();
    if (receivedDiff !== 0) return receivedDiff;
    const createdDiff = new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
    if (createdDiff !== 0) return createdDiff;
    return String(b.id).localeCompare(String(a.id));
  })[0];
}

/** Builds one dry-run report row for a single reservation. Pure given its
 * already-fetched inputs — no I/O of its own. */
function buildDryRunRow({ reservation, candidateIngestions, activeRules }) {
  const selected = selectAuthoritativeIngestion(candidateIngestions);
  const { activityRaw, languageCode } = selected
    ? extractActivityAndLanguage(selected.raw_body_snapshot)
    : { activityRaw: null, languageCode: null };

  const normalized = normalizeCivitatisActivityModality({
    activityName: activityRaw,
    languageCode,
    rules: activeRules,
  });

  const wouldChange =
    (reservation.purchased_activity_raw || null) !== (activityRaw || null) ||
    (reservation.meal_status || 'unknown') !== normalized.mealStatus;

  return {
    reservation_id: reservation.id,
    reservation_number: reservation.reservation_number,
    external_booking_id: reservation.external_booking_id,
    check_in: reservation.check_in,
    reservation_status: reservation.status,
    tour_language: reservation.tour_language,
    selected_ingestion_id: selected ? selected.id : null,
    selected_received_at: selected ? selected.received_at : null,
    activity_raw: activityRaw,
    current_purchased_activity_raw: reservation.purchased_activity_raw || null,
    current_meal_status: reservation.meal_status || 'unknown',
    proposed_meal_status: normalized.mealStatus,
    normalization_reason: normalized.reason,
    matched_rule_id: normalized.matchedRuleId,
    would_change: wouldChange,
  };
}

/**
 * Runs the full read-only dry run against Supabase and returns the
 * report. ZERO writes — every call below is `.select(...)`.
 *
 * @param {{ scope?: 'future_active'|'all', now?: Date }} [opts]
 * @returns {Promise<{ scope: string, rows: Array<object> }>}
 */
async function runCivitatisActivityModalityBackfillDryRun({ scope = 'future_active', now } = {}) {
  if (!VALID_SCOPES.includes(scope)) {
    throw new Error(`Unknown backfill dry-run scope "${scope}" — must be one of: ${VALID_SCOPES.join(', ')}. Scopes are never silently mixed.`);
  }

  const sb = getServiceRoleClient();

  const { data: sourceRow, error: sourceError } = await sb.from('sources')
    .select('id')
    .eq('slug', CIVITATIS_SOURCE_SLUG)
    .maybeSingle();
  if (sourceError) throw new Error(`Supabase error reading sources: ${sourceError.message}`);
  if (!sourceRow) return { scope, rows: [] };
  const sourceId = sourceRow.id;

  let reservationsQuery = sb.from('reservations')
    .select('id,reservation_number,external_booking_id,check_in,status,tour_language,purchased_activity_raw,meal_status')
    .eq('source_id', sourceId);

  if (scope === 'future_active') {
    const istanbulTodayISO = getIstanbulTodayISO(now);
    reservationsQuery = reservationsQuery.gte('check_in', istanbulTodayISO).neq('status', 'cancelled');
  }

  const { data: reservations, error: resError } = await reservationsQuery;
  if (resError) throw new Error(`Supabase error reading reservations: ${resError.message}`);

  const activeRules = await getActiveCivitatisModalityRules();

  const rows = [];
  for (const reservation of reservations || []) {
    const { data: candidateIngestions, error: ingError } = await sb.from('email_ingestions')
      .select('id,event_type,processing_status,received_at,created_at,raw_body_snapshot')
      .eq('source_id', sourceId)
      .eq('external_booking_id', reservation.external_booking_id);
    if (ingError) throw new Error(`Supabase error reading email_ingestions for ${reservation.external_booking_id}: ${ingError.message}`);

    rows.push(buildDryRunRow({ reservation, candidateIngestions, activeRules }));
  }

  return { scope, rows };
}

module.exports = {
  runCivitatisActivityModalityBackfillDryRun,
  selectAuthoritativeIngestion,
  buildDryRunRow,
  extractActivityAndLanguage,
  getIstanbulTodayISO,
  VALID_SCOPES,
};
