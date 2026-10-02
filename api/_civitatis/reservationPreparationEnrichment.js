/**
 * api/_civitatis/reservationPreparationEnrichment.js
 * ─────────────────────────────────────────────────────────────────────────
 * Tour Preparation Intelligence — Phase C2F: automatic post-write
 * reservation-preparation materialization for future Civitatis ingestion.
 *
 * This is a SECONDARY ENRICHMENT step, run only AFTER a Civitatis domain
 * write (public.ingest_civitatis_booking via writeAdapter.js's
 * executeCivitatisIngestionPlan, or public.cancel_civitatis_booking via
 * cancellationAdapter.js's executeCivitatisCancellationPlan) has already
 * fully committed. It never decides whether a booking was created/updated/
 * cancelled/failed — it only reads that already-final outcome and, for the
 * exact outcomes that mean "this reservation's own state just changed in a
 * way that may affect its required tickets", calls the existing, unmodified
 * public.materialize_reservation_preparations(UUID) RPC (Phase C2C) once
 * per such event. ALL quantity/create/update/supersede/cancellation-
 * reconciliation logic lives inside that RPC — this module reimplements
 * none of it.
 *
 * Structurally identical in shape and failure-isolation discipline to
 * api/_civitatis/activityModalityEnrichment.js (Phase B3) — same
 * plan/executed index-aligned iteration for the booking side, same
 * per-event try/catch, same never-throws contract, same console.error
 * diagnostic convention — but calls a different RPC for a different
 * reason: that module persists an event's OWN parsed Activity/meal text;
 * this module re-evaluates a reservation's CURRENT active
 * tour_preparation_rules against its CURRENT guest count/tour, which is
 * exactly what re-running after an update (guest count or tour change) or
 * a cancellation (pending rows need reconciling) requires.
 *
 * NEVER CREATES MEAL PREPARATION ROWS: this module calls the SAME RPC
 * api/_civitatis/activityModalityEnrichment.js's own reservation already
 * had running against it, which only ever acts on rows in
 * tour_preparation_rules (entrance_ticket/transport/special_access/
 * other) — reservations.meal_status remains its own, completely separate
 * column, written only by set_reservation_activity_modality via
 * activityModalityPersistence.js. This module neither reads nor writes
 * meal_status, and introduces no new preparation_type.
 *
 * NEVER RUNS FOR:
 *   - A booking event whose RPC result is NOT 'created' or 'updated' —
 *     'stale_ignored', 'booking_already_exists', 'manual_review_required',
 *     'already_processed', 'failed', or any unrecognized value never
 *     triggers materialization (no authoritative reservation_id to
 *     materialize, or nothing about the reservation's own state actually
 *     changed).
 *   - A cancellation event whose RPC result is NOT 'cancelled' —
 *     'already_cancelled' (a duplicate/idempotent re-send, not a new
 *     transition), 'already_processed', 'manual_review_required',
 *     'failed', or any unrecognized value never triggers materialization.
 *   - A skipped/ineligible plan entry, or any call beyond the executed
 *     prefix of a booking whose chain stopped early on a failed/unknown
 *     RPC result (mirrors activityModalityEnrichment.js exactly).
 *   - An event whose RPC result carries no reservation_id — never guessed,
 *     never derived from the request payload or any other field.
 *
 * FAILURE ISOLATION:
 * Every single event's materialization attempt is wrapped in its own
 * try/catch. A failure for one event never stops materialization for any
 * other event, and never propagates out of either exported function —
 * neither function ever throws. The domain write each event represents
 * has already fully committed; this module cannot un-commit it or cause
 * it to be retried. Failures are reported via `onError` (default:
 * console.error, the same diagnostic convention every other enrichment
 * step in this codebase already uses) so they remain visible for later
 * manual repair/reconciliation — no new queue/retry architecture.
 * ─────────────────────────────────────────────────────────────────────────
 */
'use strict';

const { materializeReservationPreparations } = require('./reservationPreparationMaterialization');

// The exhaustive set of public.ingest_civitatis_booking(...) results that
// mean "this reservation's own tour/guest-count fields were just written
// by this event" — the IDENTICAL set
// api/_civitatis/activityModalityEnrichment.js's ENRICHABLE_RESULTS
// already uses, for the analogous reason: only created/updated carry a
// just-written, authoritative reservation_id whose current guest count/
// tour may change which active tour_preparation_rules now apply.
const MATERIALIZABLE_BOOKING_RESULTS = new Set(['created', 'updated']);

// The exhaustive set of public.cancel_civitatis_booking(...) results that
// mean "this reservation was JUST transitioned to cancelled by this
// event". Deliberately excludes 'already_cancelled' — a duplicate/
// idempotent re-send of an already-cancelled reservation's email, not a
// new transition — and every other non-cancelling result.
const MATERIALIZABLE_CANCELLATION_RESULTS = new Set(['cancelled']);

function defaultOnError(err, context) {
  const message = err && err.message ? err.message : String(err);
  console.error('[reservationPreparationEnrichment] materialization failed, reservation left for later repair:', context, message);
}

/**
 * Runs automatic reservation-preparation materialization for every
 * eligible, materializable call in an already-executed Civitatis
 * booking-ingestion plan (new_booking/modified). Never writes anything
 * itself beyond calling the injected `materialize` (default: the real
 * RPC-backed materializeReservationPreparations) — never a direct
 * reservation_preparations write. Never throws.
 *
 * @param {{
 *   plan: {ok:true, plans:Array},
 *   executed: Array,
 *   materialize?: Function,
 *   onError?: (err:Error, context:object) => void,
 * }} args
 *   `plan` is planCivitatisIngestion's return value (the SAME object
 *   passed to executeCivitatisIngestionPlan). `executed` is that call's
 *   own return value — results[j] aligns 1:1 by index with plan.plans[j],
 *   exactly as activityModalityEnrichment.js already relies on.
 * @returns {Promise<void>}
 */
async function materializeReservationPreparationsForBookingPlan({
  plan,
  executed,
  materialize = materializeReservationPreparations,
  onError = defaultOnError,
} = {}) {
  if (!plan || !Array.isArray(plan.plans) || !Array.isArray(executed)) return;

  for (let j = 0; j < plan.plans.length; j++) {
    const entry = plan.plans[j];
    const resultEntry = executed[j];
    if (!entry || !entry.eligible || !resultEntry || resultEntry.skipped) continue;

    const callResults = Array.isArray(resultEntry.calls) ? resultEntry.calls : [];

    // callResults is always a PREFIX of entry.calls (executeCivitatisIngestionPlan
    // stops early on a failed/unknown result), so iterating callResults.length
    // alone never reads past what was actually executed.
    for (let i = 0; i < callResults.length; i++) {
      const context = { externalBookingId: entry.externalBookingId, gmailMessageId: callResults[i] && callResults[i].gmailMessageId };
      try {
        const rpcResult = callResults[i] && callResults[i].rpcResult;
        const resultValue = rpcResult && rpcResult.result;
        if (!MATERIALIZABLE_BOOKING_RESULTS.has(resultValue)) continue;

        const reservationId = rpcResult && rpcResult.reservation_id;
        if (!reservationId) continue; // defensive — created/updated always carries one, but never assumed/guessed

        await materialize({ reservationId });
      } catch (err) {
        onError(err, context);
      }
    }
  }
}

/**
 * Runs automatic reservation-preparation materialization for every
 * cancellation RPC result that just transitioned a reservation to
 * cancelled, so its existing pending preparation rows are reconciled
 * (cancelled) via the SAME RPC's own existing cancellation semantics —
 * never a manual UPDATE of reservation_preparations here. Never throws.
 *
 * @param {{
 *   executedCancellations: Array,
 *   materialize?: Function,
 *   onError?: (err:Error, context:object) => void,
 * }} args
 *   `executedCancellations` is executeCivitatisCancellationPlan's own
 *   (unmodified) return value — one entry per cancellation email, each
 *   carrying { gmailMessageId, externalBookingId, unknownResult, rpcResult }.
 * @returns {Promise<void>}
 */
async function materializeReservationPreparationsForCancellations({
  executedCancellations,
  materialize = materializeReservationPreparations,
  onError = defaultOnError,
} = {}) {
  if (!Array.isArray(executedCancellations)) return;

  for (const entry of executedCancellations) {
    const context = { externalBookingId: entry && entry.externalBookingId, gmailMessageId: entry && entry.gmailMessageId };
    try {
      const rpcResult = entry && entry.rpcResult;
      const resultValue = rpcResult && rpcResult.result;
      if (!MATERIALIZABLE_CANCELLATION_RESULTS.has(resultValue)) continue;

      const reservationId = rpcResult && rpcResult.reservation_id;
      if (!reservationId) continue; // defensive — never assumed/guessed

      await materialize({ reservationId });
    } catch (err) {
      onError(err, context);
    }
  }
}

module.exports = {
  materializeReservationPreparationsForBookingPlan,
  materializeReservationPreparationsForCancellations,
  MATERIALIZABLE_BOOKING_RESULTS,
  MATERIALIZABLE_CANCELLATION_RESULTS,
};
