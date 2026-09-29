/**
 * api/_civitatis/cancellationAdapter.js
 * ─────────────────────────────────────────────────────────────────────────
 * Civitatis CANCELLATION ingestion — deliberately a completely separate,
 * parallel pipeline from api/_civitatis/writeAdapter.js's new_booking/
 * modified handling, never merged into it. A cancellation email carries no
 * booking fields to extract (no Date/People/Retail/Net price/passengers) —
 * it only ever needs to say WHICH existing booking to mark cancelled, so
 * this file's job is small and structurally different: detect + extract
 * the external booking id from the subject alone (never the body), then
 * hand off to the dedicated public.cancel_civitatis_booking(...) RPC,
 * which does the actual reservation lookup/status-update/notification
 * inside its own transaction — exactly the same "plan (JS, read-only) then
 * execute (RPC call)" shape writeAdapter.js already uses, kept in its own
 * file so cancellation can never accidentally share code paths, grouping,
 * or eligibility logic with new_booking/modified ingestion.
 *
 * CORE RULE (never violated anywhere in this file or the RPC it calls): a
 * Civitatis cancellation email NEVER deletes a reservation, never creates
 * one, and never triggers tour auto-provisioning. It only ever locates an
 * existing reservation by (source_id, external_booking_id) and marks it
 * cancelled.
 * ─────────────────────────────────────────────────────────────────────────
 */
'use strict';

const { detectCivitatisEvent } = require('./eventDetector');

/** The complete, exhaustive vocabulary of result values
 * public.cancel_civitatis_booking(...) can return. Any value NOT in this
 * set is treated as unknown/unexpected and fails closed, exactly like
 * writeAdapter.js's own KNOWN_RPC_RESULTS. */
const KNOWN_CANCELLATION_RPC_RESULTS = new Set([
  'cancelled',
  'already_cancelled',
  'already_processed',
  'manual_review_required',
  'failed',
]);

/**
 * Builds the exact parameter object public.cancel_civitatis_booking(...)
 * expects for ONE parsed Civitatis cancellation email (one Gmail message).
 */
function buildCancellationRpcPayload({ event, rawBody, civitatisSourceId }) {
  return {
    p_gmail_message_id: event.gmailMessageId,
    p_gmail_thread_id: event.gmailThreadId,
    p_received_at: event.receivedAt,
    p_raw_subject: event.rawSubject,
    p_raw_body_snapshot: rawBody == null ? null : String(rawBody),
    p_source_id: civitatisSourceId,
    p_external_booking_id: event.externalBookingId,
  };
}

/**
 * Plans (never writes) the cancel_civitatis_booking RPC calls a batch of
 * already-fetched Gmail messages would produce. Read-only: only ever calls
 * repo.getCivitatisSource() — the same read-only method
 * planCivitatisIngestion already uses, nothing new added to the repo
 * interface. Every message here is expected to already be filtered to
 * classification==='cancelled' by the caller (see
 * runCivitatisWriteOrchestration's cancellation/non-cancellation split) —
 * this function defensively re-checks classification itself via
 * detectCivitatisEvent anyway, rather than trusting the caller's filter,
 * so it can never accidentally plan a call for a non-cancellation message
 * even if miscalled.
 *
 * One plan entry PER cancellation email — never grouped/merged the way
 * new_booking/modified events within one booking are, since a
 * cancellation is a single independent operation with no chronological
 * state to merge. Two cancellation emails for the same booking (a genuine
 * duplicate, or Civitatis sending it twice) simply produce two
 * independent plan entries; the RPC's own idempotency (Step 0/1, same
 * gmail_message_id-scoped guard as ingest_civitatis_booking) and its
 * already_cancelled short-circuit handle that safely without any
 * special-casing here.
 *
 * @param {{messages: Array, repo: object}} args
 * @returns {Promise<{ok:true, civitatisSourceId:string, plans:Array} | {ok:false, error:string}>}
 */
async function planCivitatisCancellations({ messages, repo }) {
  const civitatisSource = await repo.getCivitatisSource();
  if (!civitatisSource) {
    return { ok: false, error: 'No Civitatis source found — cannot plan any cancellation writes.' };
  }

  const seenGmailIds = new Set();
  const plans = [];
  for (const message of messages || []) {
    if (!message || !message.gmailMessageId) continue;
    if (seenGmailIds.has(message.gmailMessageId)) continue; // same Gmail-level dedup writeAdapter.js applies
    seenGmailIds.add(message.gmailMessageId);

    const detection = detectCivitatisEvent({ from: message.from, subject: message.subject });
    if (detection.classification !== 'cancelled') continue; // defensive re-check — see header comment

    const event = {
      gmailMessageId: message.gmailMessageId,
      gmailThreadId: message.gmailThreadId || null,
      receivedAt: message.receivedAt || null,
      rawSubject: typeof message.subject === 'string' ? message.subject : '',
      externalBookingId: detection.externalBookingIdFromSubject,
    };

    plans.push({
      gmailMessageId: event.gmailMessageId,
      externalBookingId: event.externalBookingId,
      payload: buildCancellationRpcPayload({ event, rawBody: message.body || null, civitatisSourceId: civitatisSource.id }),
    });
  }

  return { ok: true, civitatisSourceId: civitatisSource.id, plans };
}

/**
 * Executes an already-built cancellation plan, one RPC call per entry, via
 * the injected rpcCaller (never constructed here — see
 * api/ingest-civitatis-write.js's buildRealCancellationRpcCaller, the ONLY
 * place a real Supabase call is ever made). No fail-closed "stop on first
 * failure" behavior is needed here (unlike executeCivitatisIngestionPlan)
 * — each cancellation email is already fully independent, so one call's
 * outcome never affects another's.
 */
async function executeCivitatisCancellationPlan(plan, rpcCaller) {
  const results = [];
  for (const entry of plan) {
    const rpcResult = await rpcCaller(entry.payload);
    const resultValue = rpcResult && rpcResult.result;
    results.push({
      gmailMessageId: entry.gmailMessageId,
      externalBookingId: entry.externalBookingId,
      unknownResult: !KNOWN_CANCELLATION_RPC_RESULTS.has(resultValue),
      rpcResult,
    });
  }
  return results;
}

module.exports = {
  planCivitatisCancellations,
  executeCivitatisCancellationPlan,
  buildCancellationRpcPayload,
  KNOWN_CANCELLATION_RPC_RESULTS,
};
