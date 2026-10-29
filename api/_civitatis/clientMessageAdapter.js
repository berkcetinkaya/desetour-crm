/**
 * api/_civitatis/clientMessageAdapter.js
 * ─────────────────────────────────────────────────────────────────────────
 * Civitatis CLIENT-MESSAGE ingestion — a third, completely separate,
 * parallel pipeline alongside api/_civitatis/writeAdapter.js (new_booking/
 * modified) and api/_civitatis/cancellationAdapter.js (cancelled), never
 * merged into either. A "New client message about your reservation
 * <number>" email carries no booking fields to extract — it only ever
 * needs the actual customer/agency message text and which reservation it
 * belongs to, so (exactly like cancellationAdapter.js) this file's job is
 * small and structurally different: detect + resolve the reservation
 * number + extract the clean message text, then hand off to the dedicated
 * public.ingest_civitatis_reservation_message(...) RPC, which does the
 * actual matching/persistence/notification inside its own transaction —
 * the same "plan (JS, read-only) then execute (RPC call)" shape every
 * other Civitatis adapter in this directory already uses.
 *
 * CORE RULES (never violated anywhere in this file or the RPC it calls):
 *   - Never fuzzy-matched. Exact external_booking_id match only.
 *   - A subject/body reservation-number disagreement fails closed — the
 *     message is still PERSISTED (as a diagnostic 'ambiguous' row, never
 *     silently discarded), but never attached to a guessed reservation.
 *   - Never mutates any reservations column — ingest + persist + notify
 *     only (Part 9).
 * ─────────────────────────────────────────────────────────────────────────
 */
'use strict';

const { detectCivitatisEvent } = require('./eventDetector');
const { compactLines, findLabelValue, LABEL_NAMES } = require('./parser');
const { extractClientMessageText } = require('./clientMessageExtraction');

/** The complete, exhaustive vocabulary of result values
 * public.ingest_civitatis_reservation_message(...) can return. Any value
 * NOT in this set is treated as unknown/unexpected and fails closed,
 * exactly like writeAdapter.js's own KNOWN_RPC_RESULTS. */
const KNOWN_CLIENT_MESSAGE_RPC_RESULTS = new Set([
  'matched',
  'unmatched',
  'ambiguous',
  'already_processed',
  'failed',
]);

/**
 * Resolves the Civitatis reservation number for ONE client-message email:
 * the subject (eventDetector's own capture) is the primary signal, the
 * body's "Reservation number:" line (parser.js's existing, already-
 * tested label extractor — never a new regex) is a deterministic
 * fallback. If both are present and DISAGREE, never guesses which one is
 * right — returns mismatch:true instead, so the caller can fail closed
 * (Part 1).
 *
 * @returns {{externalBookingId: string|null, mismatch: boolean, subjectValue: ?string, bodyValue: ?string}}
 */
function resolveClientMessageExternalBookingId({ externalBookingIdFromSubject, body }) {
  const lines = compactLines(body);
  const bodyNumberRaw = findLabelValue(lines, LABEL_NAMES.RESERVATION_NUMBER);
  // Same digit-only normalization the real parser.js already applies
  // when cross-validating subject vs body for booking emails.
  const bodyNumber = bodyNumberRaw ? bodyNumberRaw.replace(/\D/g, '') : null;

  if (externalBookingIdFromSubject && bodyNumber) {
    if (externalBookingIdFromSubject !== bodyNumber) {
      return { externalBookingId: null, mismatch: true, subjectValue: externalBookingIdFromSubject, bodyValue: bodyNumber };
    }
    return { externalBookingId: externalBookingIdFromSubject, mismatch: false, subjectValue: externalBookingIdFromSubject, bodyValue: bodyNumber };
  }
  if (externalBookingIdFromSubject) return { externalBookingId: externalBookingIdFromSubject, mismatch: false, subjectValue: externalBookingIdFromSubject, bodyValue: null };
  if (bodyNumber) return { externalBookingId: bodyNumber, mismatch: false, subjectValue: null, bodyValue: bodyNumber };
  return { externalBookingId: null, mismatch: false, subjectValue: null, bodyValue: null };
}

/**
 * Builds the exact parameter object
 * public.ingest_civitatis_reservation_message(...) expects for ONE
 * parsed Civitatis client-message email (one Gmail message).
 * `forceAmbiguous` is set only for the subject/body mismatch case — see
 * resolveClientMessageExternalBookingId and the RPC's own
 * p_force_ambiguous doc comment.
 */
function buildClientMessageRpcPayload({ event, civitatisSourceId, forceAmbiguous = false }) {
  return {
    p_gmail_message_id: event.gmailMessageId,
    p_gmail_thread_id: event.gmailThreadId,
    p_received_at: event.receivedAt,
    p_raw_subject: event.rawSubject,
    p_source_id: civitatisSourceId,
    p_external_booking_id: event.externalBookingId,
    p_message_text: event.messageText,
    p_force_ambiguous: forceAmbiguous,
  };
}

/**
 * Plans (never writes) the ingest_civitatis_reservation_message RPC
 * calls a batch of already-fetched Gmail messages would produce.
 * Read-only: only ever calls repo.getCivitatisSource(), the same
 * read-only method every other Civitatis plan function already uses.
 * Every message here is expected to already be filtered to
 * classification==='client_message' by the caller (see
 * runCivitatisWriteOrchestration's split) — this function defensively
 * re-checks classification itself anyway, exactly like
 * planCivitatisCancellations does, so it can never accidentally plan a
 * call for a non-client-message email even if miscalled.
 *
 * A message that cannot be planned (subject/body mismatch, no usable
 * reservation number anywhere, or no extractable message text) is NEVER
 * silently dropped: it is still represented, in `skipped`, with a clear
 * reason — Part 2's "do not discard the message silently" rule. The
 * mismatch case is the one exception that still gets a real plan entry
 * (with forceAmbiguous:true), since Part 1 explicitly requires it to be
 * PERSISTED as a diagnostic ambiguous row, not merely logged.
 *
 * @param {{messages: Array, repo: object}} args
 * @returns {Promise<{ok:true, civitatisSourceId:string, plans:Array, skipped:Array} | {ok:false, error:string}>}
 */
async function planCivitatisClientMessages({ messages, repo }) {
  const civitatisSource = await repo.getCivitatisSource();
  if (!civitatisSource) {
    return { ok: false, error: 'No Civitatis source found — cannot plan any client-message writes.' };
  }

  const seenGmailIds = new Set();
  const plans = [];
  const skipped = [];

  for (const message of messages || []) {
    if (!message || !message.gmailMessageId) continue;
    if (seenGmailIds.has(message.gmailMessageId)) continue; // same Gmail-level dedup every other adapter applies
    seenGmailIds.add(message.gmailMessageId);

    const detection = detectCivitatisEvent({ from: message.from, subject: message.subject });
    if (detection.classification !== 'client_message') continue; // defensive re-check — see header comment

    const resolved = resolveClientMessageExternalBookingId({
      externalBookingIdFromSubject: detection.externalBookingIdFromSubject,
      body: message.body,
    });

    const rawSubject = typeof message.subject === 'string' ? message.subject : '';

    if (resolved.mismatch) {
      // Part 1: fails closed, but still PERSISTED as a diagnostic
      // 'ambiguous' row (via forceAmbiguous) — never silently discarded,
      // never attached to a guessed reservation. Uses the subject's
      // number only as a trace value (subject is the primary signal);
      // the RPC itself never attempts a lookup with it.
      const messageText = extractClientMessageText(message.body) || rawSubject || '(no extractable message text)';
      plans.push({
        gmailMessageId: message.gmailMessageId,
        externalBookingId: resolved.subjectValue,
        forceAmbiguous: true,
        mismatchReason: `subject/body reservation number mismatch (subject=${resolved.subjectValue}, body=${resolved.bodyValue})`,
        payload: buildClientMessageRpcPayload({
          event: {
            gmailMessageId: message.gmailMessageId,
            gmailThreadId: message.gmailThreadId || null,
            receivedAt: message.receivedAt || null,
            rawSubject,
            externalBookingId: resolved.subjectValue,
            messageText,
          },
          civitatisSourceId: civitatisSource.id,
          forceAmbiguous: true,
        }),
      });
      continue;
    }

    if (!resolved.externalBookingId) {
      skipped.push({ gmailMessageId: message.gmailMessageId, reason: 'no reservation number found in subject or body — cannot plan' });
      continue;
    }

    const messageText = extractClientMessageText(message.body);
    if (!messageText) {
      skipped.push({ gmailMessageId: message.gmailMessageId, reason: 'no extractable message text found in body' });
      continue;
    }

    const event = {
      gmailMessageId: message.gmailMessageId,
      gmailThreadId: message.gmailThreadId || null,
      receivedAt: message.receivedAt || null,
      rawSubject,
      externalBookingId: resolved.externalBookingId,
      messageText,
    };

    plans.push({
      gmailMessageId: event.gmailMessageId,
      externalBookingId: event.externalBookingId,
      forceAmbiguous: false,
      payload: buildClientMessageRpcPayload({ event, civitatisSourceId: civitatisSource.id, forceAmbiguous: false }),
    });
  }

  return { ok: true, civitatisSourceId: civitatisSource.id, plans, skipped };
}

/**
 * Executes an already-built client-message plan, one RPC call per entry,
 * via the injected rpcCaller (never constructed here — see
 * api/ingest-civitatis-write.js's buildRealClientMessageRpcCaller, the
 * ONLY place a real Supabase call for this RPC is ever made). Exactly
 * like executeCivitatisCancellationPlan, no fail-closed "stop on first
 * failure" behavior is needed — each client-message email is already
 * fully independent.
 */
async function executeCivitatisClientMessagePlan(plan, rpcCaller) {
  const results = [];
  for (const entry of plan) {
    const rpcResult = await rpcCaller(entry.payload);
    const resultValue = rpcResult && rpcResult.result;
    results.push({
      gmailMessageId: entry.gmailMessageId,
      externalBookingId: entry.externalBookingId,
      unknownResult: !KNOWN_CLIENT_MESSAGE_RPC_RESULTS.has(resultValue),
      rpcResult,
    });
  }
  return results;
}

module.exports = {
  planCivitatisClientMessages,
  executeCivitatisClientMessagePlan,
  buildClientMessageRpcPayload,
  resolveClientMessageExternalBookingId,
  KNOWN_CLIENT_MESSAGE_RPC_RESULTS,
};
