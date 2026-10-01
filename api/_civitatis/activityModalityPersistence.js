/**
 * api/_civitatis/activityModalityPersistence.js
 * ─────────────────────────────────────────────────────────────────────────
 * Tour Preparation Intelligence — Phase B2: narrow server-side persistence
 * helper for reservations.purchased_activity_raw / reservations.meal_status.
 *
 * Calls ONLY public.set_reservation_activity_modality (Phase B2's new,
 * narrow RPC) via the existing service_role client — never a direct
 * `.from('reservations').update(...)`. This file does NOT normalize the
 * Activity text itself: it takes an already-computed meal_status (the
 * caller is expected to have already run
 * api/_civitatis/activityModality.js's normalizeCivitatisActivityModality)
 * and persists exactly that result, plus the raw Activity string,
 * verbatim. There is no architectural reason for this helper to
 * re-normalize — doing so would duplicate the normalizer's own
 * responsibility and risk the two diverging.
 *
 * NOT wired into api/_civitatis/writeAdapter.js or the ingestion RPC
 * call path by this phase — that wiring is a later, separate step. This
 * file is usable in isolation today only via the backfill dry-run tool
 * (which, in dry-run mode, never calls it — see
 * activityModalityBackfillDryRun.js) and by future code that chooses to.
 * ─────────────────────────────────────────────────────────────────────────
 */
'use strict';

const { getServiceRoleClient } = require('./supabaseAdmin');

const VALID_MEAL_STATUSES = new Set(['included', 'not_included', 'unknown']);

/**
 * Persists an already-normalized meal-modality result for one reservation.
 * Fails closed (returns a non-write result, never throws for a caller
 * mistake) when the input itself is insufficient to safely identify the
 * target row or carries an invalid meal_status — only a genuine Supabase
 * transport/query error throws.
 *
 * @param {{
 *   reservationId: string,
 *   sourceId: string,
 *   externalBookingId: string,
 *   purchasedActivityRaw: string|null,
 *   mealStatus: 'included'|'not_included'|'unknown'
 * }} args
 * @returns {Promise<{result: string, reservation_id?: string, meal_status?: string}>}
 */
async function persistReservationActivityModality({
  reservationId,
  sourceId,
  externalBookingId,
  purchasedActivityRaw,
  mealStatus,
} = {}) {
  if (!reservationId || !sourceId || !externalBookingId) {
    return { result: 'invalid_input', reservation_id: reservationId || null };
  }
  if (!VALID_MEAL_STATUSES.has(mealStatus)) {
    return { result: 'invalid_meal_status', reservation_id: reservationId };
  }

  const sb = getServiceRoleClient();
  const { data, error } = await sb.rpc('set_reservation_activity_modality', {
    p_reservation_id: reservationId,
    p_source_id: sourceId,
    p_external_booking_id: externalBookingId,
    p_purchased_activity_raw: purchasedActivityRaw == null ? null : String(purchasedActivityRaw),
    p_meal_status: mealStatus,
  });

  if (error) {
    throw new Error(`Supabase error calling set_reservation_activity_modality: ${error.message}`);
  }

  return data;
}

module.exports = {
  persistReservationActivityModality,
  VALID_MEAL_STATUSES,
};
