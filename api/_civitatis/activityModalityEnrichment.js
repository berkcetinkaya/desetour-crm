/**
 * api/_civitatis/activityModalityEnrichment.js
 * ─────────────────────────────────────────────────────────────────────────
 * Tour Preparation Intelligence — Phase B3: automatic post-write Civitatis
 * Activity → meal-modality persistence.
 *
 * This is a SECONDARY ENRICHMENT step, run only after a Civitatis booking
 * domain write (public.ingest_civitatis_booking, via writeAdapter.js's
 * executeCivitatisIngestionPlan) has already completed. It never decides
 * whether a booking was created/updated/failed — it only reads that
 * already-final outcome and, for the two outcomes that mean "a reservation
 * now reflects this event" (created, updated), persists the event's own
 * parsed Activity text and normalized meal status onto that reservation.
 *
 * REUSES, NEVER DUPLICATES:
 *   - api/_civitatis/activityModality.js's normalizeCivitatisActivityModality
 *     for all classification logic (deterministic, no AI/fuzzy matching).
 *   - api/_civitatis/activityModalityRules.js for loading active rules.
 *   - api/_civitatis/activityModalityPersistence.js's
 *     persistReservationActivityModality, which itself calls ONLY the
 *     narrow public.set_reservation_activity_modality RPC — never a direct
 *     UPDATE.
 *   - The Activity/language already parsed by parser.js during the normal
 *     ingestion pass, threaded through via writeAdapter.js's `callMeta`
 *     array (same order/length as each plan entry's `calls`) — this module
 *     never re-parses an email body itself.
 *
 * MISSING ACTIVITY — ONE RULE COVERS BOTH REQUIRED BEHAVIORS:
 * When an event's own parsed activityName is null/blank, this module
 * skips the persistence call entirely for that event. For a NEW booking
 * this means "never fabricate a value" (the reservation keeps Phase A's
 * own column defaults: purchased_activity_raw NULL, meal_status
 * 'unknown'). For a MODIFICATION this means "leave the reservation's
 * existing modality fields untouched" (no RPC call is made at all, so
 * nothing already stored can be overwritten). Both required behaviors
 * fall out of the same single skip — there is no new/modification
 * branch anywhere in this file.
 *
 * NEVER RUNS FOR:
 *   - Cancellations — structurally unreachable from here; this module is
 *     only ever called with the booking-ingestion plan/results, never the
 *     separate cancellationAdapter.js plan.
 *   - 'stale_ignored' — a stale modification that did not actually update
 *     the reservation's live fields; persisting its Activity would let an
 *     older email overwrite a newer one's data. Only 'created' and
 *     'updated' are ever enriched.
 *   - Skipped (ineligible) plan entries, or any call beyond the executed
 *     prefix of a booking whose chain stopped early on a failed/unknown
 *     RPC result.
 *
 * FAILURE ISOLATION:
 * Every single event's enrichment attempt (rule load + normalize +
 * persist) is wrapped in its own try/catch. A failure for one event never
 * stops enrichment for any other event, and never propagates out of
 * enrichCivitatisActivityModalityForPlan itself — this function never
 * throws. The booking domain write it runs after has already fully
 * committed; this module cannot un-commit it or cause it to be retried.
 * Failures are reported via `onError` (default: console.error, the same
 * diagnostic convention api/ingest-civitatis-write.js already uses for
 * its own Gmail-fetch/orchestration errors) so they remain visible for
 * later manual repair/reconciliation, per the explicit requirement not to
 * invent any new queue/retry architecture in this phase.
 * ─────────────────────────────────────────────────────────────────────────
 */
'use strict';

const { normalizeCivitatisActivityModality } = require('./activityModality');
const { getActiveCivitatisModalityRules } = require('./activityModalityRules');
const { persistReservationActivityModality } = require('./activityModalityPersistence');

// The only two public.ingest_civitatis_booking(...) results that mean "a
// reservation now reflects this specific event's own fields". Deliberately
// excludes 'stale_ignored' (a superseded modification — see header),
// 'booking_already_exists' / 'already_processed' / 'manual_review_required'
// / 'failed' (none of these mean a reservation was just created/updated
// from this event's own parsed data).
const ENRICHABLE_RESULTS = new Set(['created', 'updated']);

function defaultOnError(err, context) {
  const message = err && err.message ? err.message : String(err);
  console.error('[activityModalityEnrichment] enrichment failed, reservation left for later repair:', context, message);
}

/**
 * Runs automatic Activity/meal-modality enrichment for every eligible,
 * enrichable call in an already-executed Civitatis booking-ingestion plan.
 * Never writes anything itself beyond calling the injected `persist`
 * (default: the real RPC-backed persistReservationActivityModality) —
 * never a direct table update. Never throws.
 *
 * @param {{
 *   plan: {ok:true, civitatisSourceId:string, plans:Array},
 *   executed: Array,
 *   getRules?: Function,
 *   persist?: Function,
 *   onError?: (err:Error, context:object) => void,
 * }} args
 *   `plan` is planCivitatisIngestion's return value (the SAME object
 *   passed to executeCivitatisIngestionPlan). `executed` is that call's
 *   own return value — results[j] aligns 1:1 by index with plan.plans[j].
 * @returns {Promise<void>}
 */
async function enrichCivitatisActivityModalityForPlan({
  plan,
  executed,
  getRules = getActiveCivitatisModalityRules,
  persist = persistReservationActivityModality,
  onError = defaultOnError,
} = {}) {
  if (!plan || !Array.isArray(plan.plans) || !Array.isArray(executed)) return;
  const sourceId = plan.civitatisSourceId;

  for (let j = 0; j < plan.plans.length; j++) {
    const entry = plan.plans[j];
    const resultEntry = executed[j];
    if (!entry || !entry.eligible || !resultEntry || resultEntry.skipped) continue;

    const callMeta = Array.isArray(entry.callMeta) ? entry.callMeta : [];
    const callResults = Array.isArray(resultEntry.calls) ? resultEntry.calls : [];

    // callResults is always a PREFIX of entry.calls/entry.callMeta (see
    // executeCivitatisIngestionPlan — it stops early on a failed/unknown
    // result), so iterating callResults.length alone never reads past
    // what was actually executed.
    for (let i = 0; i < callResults.length; i++) {
      const context = { externalBookingId: entry.externalBookingId, gmailMessageId: callResults[i] && callResults[i].gmailMessageId };
      try {
        const rpcResult = callResults[i] && callResults[i].rpcResult;
        const resultValue = rpcResult && rpcResult.result;
        if (!ENRICHABLE_RESULTS.has(resultValue)) continue;

        const reservationId = rpcResult && rpcResult.reservation_id;
        if (!reservationId) continue; // defensive — created/updated always carries one, but never assumed

        const meta = callMeta[i];
        const activityName = meta && meta.activityName;
        if (typeof activityName !== 'string' || activityName.trim() === '') {
          // Missing Activity on this event — see header comment: this one
          // skip correctly covers both "never fabricate" (new booking)
          // and "leave existing state untouched" (modification).
          continue;
        }

        const languageCode = meta.languageCode;
        const rules = await getRules({ languageCode });
        const normalized = normalizeCivitatisActivityModality({ activityName, languageCode, rules });

        await persist({
          reservationId,
          sourceId,
          externalBookingId: entry.externalBookingId,
          purchasedActivityRaw: activityName,
          mealStatus: normalized.mealStatus,
        });
      } catch (err) {
        onError(err, context);
      }
    }
  }
}

module.exports = {
  enrichCivitatisActivityModalityForPlan,
  ENRICHABLE_RESULTS,
};
