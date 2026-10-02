/**
 * api/_civitatis/reservationPreparationMaterialization.js
 * ─────────────────────────────────────────────────────────────────────────
 * Tour Preparation Intelligence — Phase C2F: narrow server-side wrapper
 * around the already-deployed public.materialize_reservation_preparations
 * (UUID) RPC (Phase C2C) — never a direct `.from('reservation_preparations')
 * .insert/update(...)`, and never a reimplementation of that RPC's own
 * per_guest/per_adult/fixed quantity rules, create/update/supersede
 * decisions, or cancellation-reconciliation semantics in JavaScript.
 *
 * Exactly as narrow as api/_civitatis/activityModalityPersistence.js is for
 * its own RPC: this file's only job is "call the one RPC, with the one
 * argument it takes, and surface its JSONB result or a translated error."
 * It does not decide WHETHER materialization is applicable for a given
 * Civitatis event — that decision lives in
 * api/_civitatis/reservationPreparationEnrichment.js, exactly as
 * activityModality.js/activityModalityRules.js (not
 * activityModalityPersistence.js) own the "should we persist, and what"
 * decision for that enrichment.
 * ─────────────────────────────────────────────────────────────────────────
 */
'use strict';

const { getServiceRoleClient } = require('./supabaseAdmin');

/**
 * Calls public.materialize_reservation_preparations(p_reservation_id) for
 * exactly one reservation. Fails closed (returns a non-write result,
 * never throws) when reservationId itself is missing — only a genuine
 * Supabase transport/query error throws, mirroring
 * persistReservationActivityModality's own contract.
 *
 * @param {{reservationId: string}} args
 * @returns {Promise<object>} the RPC's own JSONB result, verbatim.
 */
async function materializeReservationPreparations({ reservationId } = {}) {
  if (!reservationId) {
    return { result: 'invalid_input', reservation_id: reservationId || null };
  }

  const sb = getServiceRoleClient();
  const { data, error } = await sb.rpc('materialize_reservation_preparations', {
    p_reservation_id: reservationId,
  });

  if (error) {
    throw new Error(`Supabase error calling materialize_reservation_preparations: ${error.message}`);
  }

  return data;
}

module.exports = {
  materializeReservationPreparations,
};
