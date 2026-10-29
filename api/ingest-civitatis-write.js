/**
 * api/ingest-civitatis-write.js — Vercel Serverless Function
 * ─────────────────────────────────────────────────────────────────────────
 * Dese Tour Operations Center — Civitatis email ingestion, CONTROLLED
 * WRITE ACTIVATION PATH.
 *
 * This is a NEW, separate endpoint from the existing /api/ingest-civitatis
 * (which remains dry-run-only, completely unchanged, and still has no
 * write code path anywhere in it or anything it calls). This file is the
 * ONLY reachable HTTP endpoint that can ever invoke
 * api/_civitatis/writeAdapter.js's executeCivitatisIngestionPlan, which is
 * in turn the ONLY place that can ever call the
 * public.ingest_civitatis_booking(...) RPC.
 *
 * DRY RUN IS THE DEFAULT BEHAVIOR, EVERY TIME, UNCONDITIONALLY, UNLESS
 * BOTH OF THE FOLLOWING ARE TRUE FOR THIS SPECIFIC REQUEST:
 *   1. The server-side environment variable CIVITATIS_WRITE_ENABLED is
 *      set to EXACTLY the string "true" (not "1", not "TRUE", not any
 *      other truthy-looking value — see isWriteModeActive below). This
 *      is the infrastructure-level gate: can this deployment EVER write,
 *      at all, regardless of what any individual request asks for.
 *   2. The request itself explicitly passes write=true (query string or
 *      JSON body). This is the per-request gate: even on a deployment
 *      where writes are enabled, a plain call with no write=true is
 *      ALWAYS a dry run — nothing is ever written just because the
 *      server happens to be write-enabled.
 * Both gates are required together. Missing or wrong on either one
 * means: build the exact same plan a write would use, report exactly
 * what WOULD be sent to the RPC and in what order, and never call it.
 *
 * WRITE MODE, WHEN BOTH GATES ARE SATISFIED, uses ONLY:
 *   - the already-existing Supabase service_role client
 *     (api/_civitatis/supabaseAdmin.js's getServiceRoleClient) — the
 *     SAME client the read-only dry-run repo already uses, never a new
 *     credential path;
 *   - the already-installed public.ingest_civitatis_booking(...) RPC
 *     (V7, already applied to production) via a single
 *     supabase.rpc('ingest_civitatis_booking', payload) call per Gmail
 *     message, exactly as api/_civitatis/writeAdapter.js's
 *     executeCivitatisIngestionPlan already expects to drive it;
 *   - the already-existing, unmodified eligibility gating in
 *     api/_civitatis/writeAdapter.js's planCivitatisIngestion. This file
 *     adds ZERO new eligibility rules, ZERO new parsing rules, and ZERO
 *     new customer-matching rules — POSSIBLE_EXISTING_MATCH,
 *     NEEDS_REVIEW, PARSE_ERROR, and IGNORED bookings are exactly as
 *     unwritable here as they already were in writeAdapter.js's own
 *     design; this file cannot loosen that even if it wanted to, since
 *     it never sees an ineligible booking's calls at all (writeAdapter
 *     never puts them in `entry.calls`).
 *
 * SINGLE-BOOKING MANUAL MODE (?externalBookingId=...): when supplied,
 * ONLY Gmail messages whose PARSED external booking id (via the
 * unmodified api/_civitatis/parser.js — called here purely as a filter,
 * never re-implemented) matches EXACTLY are ever handed to
 * planCivitatisIngestion. Every other message fetched in the same page
 * is dropped before planning even starts, so no other booking can ever
 * be written by a single-booking request, regardless of what else was
 * in the fetched page.
 *
 * NEVER writes when disabled: when isWriteModeActive(...) is false, the
 * real Supabase RPC wrapper (buildRealRpcCaller) is never even
 * constructed, let alone called — not just "constructed but unused".
 *
 * RESPONSE SHAPE never includes raw email bodies, customer PII beyond
 * what the RPC itself already needed to report (this file adds none of
 * its own), or any credential. See buildDryRunResults/buildWriteResults/
 * decorateCallResult below for the exact reported fields.
 *
 * MANUAL WRITE REQUESTS NOW REQUIRE A SHARED SECRET (see
 * isManualWriteAuthorized below): a request with write=true is rejected
 * with 401, BEFORE any Gmail/Supabase call is even attempted, unless it
 * also carries a `x-civitatis-write-secret` header matching the
 * server-side CIVITATIS_MANUAL_WRITE_SECRET environment variable. This
 * closes the gap CIVITATIS_WRITE_ENABLED + write=true alone left open:
 * on any deployment where the env flag is on, ANY caller who merely
 * discovered the URL and appended ?write=true could previously trigger a
 * real write with no authentication at all. Dry-run (no write=true, the
 * default) is completely unaffected — still open for diagnostics with no
 * secret required, exactly as before. Fails closed: an unset
 * CIVITATIS_MANUAL_WRITE_SECRET means NO write=true request can ever
 * succeed here, regardless of what header is supplied.
 *
 * AUTOMATIC SCHEDULING lives in the separate sibling file
 * api/cron-ingest-civitatis-write.js, invoked on a schedule by Vercel
 * Cron (see vercel.json's `crons` entry) and authenticated by Vercel's
 * own supported cron mechanism (the Authorization: Bearer $CRON_SECRET
 * header Vercel attaches automatically) — a completely separate secret
 * and code path from the manual one above. That file duplicates NONE of
 * this one's ingestion logic: it imports and calls
 * runCivitatisWriteOrchestration, buildRealRpcCaller, isWriteModeActive,
 * and the two message-count constants directly from this file (see the
 * exports at the bottom). This file itself still has no crons entry of
 * its own and remains manual-invocation-only.
 * ─────────────────────────────────────────────────────────────────────────
 */
'use strict';

const gmailClient = require('./_civitatis/gmailClient');
const { createSupabaseCivitatisRepo, getServiceRoleClient, ConfigurationError } = require('./_civitatis/supabaseAdmin');
const { planCivitatisIngestion, executeCivitatisIngestionPlan } = require('./_civitatis/writeAdapter');
const { enrichCivitatisActivityModalityForPlan } = require('./_civitatis/activityModalityEnrichment');
const { materializeReservationPreparationsForBookingPlan, materializeReservationPreparationsForCancellations } = require('./_civitatis/reservationPreparationEnrichment');
const { parseCivitatisEmail } = require('./_civitatis/parser');
const { detectCivitatisEvent } = require('./_civitatis/eventDetector');
const { planCivitatisCancellations, executeCivitatisCancellationPlan } = require('./_civitatis/cancellationAdapter');
const { planCivitatisClientMessages, executeCivitatisClientMessagePlan } = require('./_civitatis/clientMessageAdapter');

const DEFAULT_MAX_MESSAGES = 25;
const HARD_MAX_MESSAGES = 100; // same bound as /api/ingest-civitatis, for the same reason (function time budget)

// ── Pure helpers — no I/O, fully unit-testable without Gmail/Supabase ──────

/**
 * The write-activation gate (requirement: "keep dry run as the default
 * behavior"). Both the server-side environment variable AND the
 * request's own explicit opt-in must be true — either one missing or
 * wrong means dry run, unconditionally. `writeEnvValue` is passed in
 * explicitly (rather than read from process.env here) so this function
 * stays pure and directly testable.
 */
function isWriteModeActive({ writeEnvValue, requestedWrite }) {
  return writeEnvValue === 'true' && requestedWrite === true;
}

/** True only when the request explicitly opted into write mode — a
 * missing/absent/anything-else value is never treated as an opt-in. */
function parseRequestedWrite(rawValue) {
  return rawValue === 'true' || rawValue === true;
}

/**
 * Manual write-request authorization gate — checked ONLY when
 * requestedWrite is true (dry-run requests never call this and need no
 * secret). Pure/injectable, same style as isWriteModeActive, so it is
 * directly unit-testable without setting real process.env or crafting a
 * real HTTP request. Fails closed: no configuredSecret means this can
 * never return true, however it is called.
 */
function isManualWriteAuthorized({ configuredSecret, providedSecret }) {
  return !!configuredSecret && typeof providedSecret === 'string' && providedSecret === configuredSecret;
}

/** The two supported identityDecision values — see
 * parseIdentityDecisionRequest below. Exhaustive; anything else is
 * rejected. */
const SUPPORTED_IDENTITY_DECISIONS = new Set(['existing_customer', 'new_customer']);

/**
 * Pure, injectable validator for the explicit two-way identity-decision
 * request parameters (identityDecisionFor/identityDecision/
 * confirmedCustomerId) — the replacement for the earlier, one-way
 * confirmNotSameCustomerFor override, which always forced customerId to
 * null and could silently create a duplicate customer for what might be
 * the SAME real traveler. This function performs only the PURELY
 * SYNTACTIC checks (shape of the three parameters relative to each
 * other and to externalBookingId, and the "manual write-mode only"
 * requirement) — all of which are answerable with no Gmail/Supabase
 * call. It deliberately does NOT validate that confirmedCustomerId is
 * an actual name-match candidate — that requires the read-only planning
 * stage (parsed Gmail messages + a repo lookup) and is instead checked
 * inside writeAdapter.js's planCivitatisIngestion itself, which aborts
 * with `{ok:false, stage:'identity_decision_invalid_candidate'}` for an
 * invalid id (mapped to a 400 by the HTTP handler below) — still always
 * before any write RPC is ever reached.
 *
 * Returns `{ok:true, decision:null}` when no identity-decision
 * parameter was supplied at all (the normal, default path — untouched).
 * Returns `{ok:true, decision:{externalBookingId, decision,
 * confirmedCustomerId}}` when a well-formed, write-mode-eligible
 * decision was supplied. Returns `{ok:false, error}` for every
 * malformed combination, fails closed.
 */
function parseIdentityDecisionRequest({ externalBookingId, identityDecisionFor, identityDecision, confirmedCustomerId, requestedWrite }) {
  const anySupplied = identityDecisionFor != null || identityDecision != null || confirmedCustomerId != null;
  if (!anySupplied) return { ok: true, decision: null };

  if (!identityDecisionFor || !identityDecision) {
    return { ok: false, error: 'identityDecisionFor and identityDecision must both be supplied together.' };
  }
  if (identityDecisionFor !== externalBookingId) {
    return { ok: false, error: 'identityDecisionFor must exactly equal externalBookingId — it can never apply to a different or unscoped booking.' };
  }
  if (!SUPPORTED_IDENTITY_DECISIONS.has(identityDecision)) {
    return { ok: false, error: `Unsupported identityDecision "${identityDecision}" — must be exactly "existing_customer" or "new_customer".` };
  }
  if (identityDecision === 'existing_customer' && !confirmedCustomerId) {
    return { ok: false, error: 'identityDecision=existing_customer requires confirmedCustomerId.' };
  }
  if (identityDecision === 'new_customer' && confirmedCustomerId) {
    return { ok: false, error: 'identityDecision=new_customer must not supply confirmedCustomerId.' };
  }
  if (!requestedWrite) {
    return { ok: false, error: 'Identity decisions are manual write-mode operations only — add write=true and a valid x-civitatis-write-secret header.' };
  }
  return { ok: true, decision: { externalBookingId, decision: identityDecision, confirmedCustomerId: confirmedCustomerId || null } };
}

/**
 * Single-booking manual mode filter. Calls the EXISTING, UNMODIFIED
 * parser purely to read `externalBookingId` off each message for
 * filtering — this adds no new parsing rule and changes no parser
 * behavior. A message that fails to parse (ok:false) but still carries
 * a subject-derived externalBookingId for the SAME requested booking is
 * deliberately KEPT, so writeAdapter's own "any parse failure in the
 * chain -> ineligible" rule still sees that booking's full chain and
 * correctly refuses to write it — filtering here must never accidentally
 * make an otherwise-ineligible booking look eligible by hiding its own
 * failed sibling event.
 */
function filterMessagesByExternalBookingId(messages, externalBookingId) {
  if (!externalBookingId) return messages;
  return (messages || []).filter(m => {
    const parsed = parseCivitatisEmail(m);
    return parsed.externalBookingId === externalBookingId;
  });
}

/** Maps gmailMessageId -> p_event_type from an already-built plan's
 * eligible entries, so write-mode result decoration can report eventType
 * without executeCivitatisIngestionPlan needing to carry it itself
 * (writeAdapter.js is not modified by this file). */
function buildEventTypeMap(plan) {
  const map = new Map();
  for (const entry of (plan && plan.plans) || []) {
    if (!entry.eligible) continue;
    for (const call of entry.calls) map.set(call.p_gmail_message_id, call.p_event_type);
  }
  return map;
}

/** Shapes one executed call's result into the exact reporting contract
 * this endpoint promises: externalBookingId (added by the caller),
 * gmailMessageId, eventType, decision, rpcResult, reservationId,
 * ingestionId, processingStatus, stoppedEarly (added by the caller),
 * error, stage, diagnostics — never the raw request payload, never a
 * passenger name, never a customer contact field. stage/diagnostics
 * (V9) are SQL error metadata only (a processing-stage label, a
 * SQLSTATE code, constraint/table/column identifiers, a bounded
 * PL/pgSQL call-stack excerpt) — never application data — and are only
 * ever present on a 'failed' RPC result from a V9-or-later database;
 * they are simply absent (null) against V8 or any non-'failed' result,
 * since older/other RPC responses never carry these keys. */
function decorateCallResult(call, eventType) {
  const rpcResult = (call && call.rpcResult) || {};
  const resultValue = rpcResult.result;
  return {
    gmailMessageId: call.gmailMessageId,
    eventType: eventType || null,
    decision: call.unknownResult ? 'UNKNOWN_RPC_RESULT (failed closed)' : (resultValue || 'UNKNOWN'),
    rpcResult: resultValue || null,
    reservationId: rpcResult.reservation_id || null,
    ingestionId: rpcResult.ingestion_id || null,
    processingStatus: rpcResult.processing_status || null,
    error: rpcResult.error || null,
    stage: rpcResult.stage || null,
    diagnostics: rpcResult.diagnostics || null,
  };
}

/** Dry-run reporting: exactly what WOULD be sent to the RPC, in the
 * exact order writeAdapter would send it, without ever calling it.
 * Surfaces tourId/autoProvisionTour at the booking level (unchanged
 * across every call in one booking's chain) so an operator using this
 * endpoint's dry-run mode to verify a specific booking — e.g. per-
 * booking recovery via ?externalBookingId=... before flipping to
 * write=true — can see, without guessing, whether it will resolve
 * against an already-existing tour mapping, auto-provision a new one,
 * or (tourId:null, autoProvisionTour:false) still require a human to
 * resolve an ambiguous/unrecognized-language mapping first. */
function buildDryRunResults(plan) {
  return plan.plans.map(entry => {
    if (!entry.eligible) {
      // wouldMarkNeedsReview: what WOULD be persisted via
      // mark_civitatis_email_needs_review if this same request ran with
      // write=true — reported here WITHOUT ever calling that RPC. A
      // plain dry run (this function) never executes any marker call;
      // only write-mode orchestration does (see buildWriteResults /
      // executeCivitatisIngestionPlan's markNeedsReviewRpcCaller).
      const wouldMarkNeedsReview = (entry.needsReviewMarkers || []).map(m => ({
        gmailMessageId: m.p_gmail_message_id,
        reasonCode: m.p_reason_code,
      }));
      return { externalBookingId: entry.externalBookingId, skipped: true, reason: entry.reason, stoppedEarly: false, calls: [], wouldMarkNeedsReview };
    }
    return {
      externalBookingId: entry.externalBookingId,
      skipped: false,
      stoppedEarly: false,
      tourId: entry.tourId,
      autoProvisionTour: !!entry.autoProvisionTour,
      tourMatchReason: entry.tourMatchReason || null,
      calls: entry.calls.map(c => ({
        gmailMessageId: c.p_gmail_message_id,
        eventType: c.p_event_type,
        decision: 'WOULD_WRITE (dry run — write mode not active for this request)',
        rpcResult: null,
        reservationId: null,
        ingestionId: null,
        processingStatus: null,
        error: null,
      })),
    };
  });
}

/** Shapes one executed needs_review-marker call's result — same never-
 * leak-PII/never-leak-payload discipline as decorateCallResult, but for
 * mark_civitatis_email_needs_review's much smaller result vocabulary.
 * `processingStatus` (added for buildIngestionSummary's
 * classifyMarkerOutcome below) mirrors decorateCallResult's own field
 * of the same name — needed specifically to tell an `already_processed`
 * marker result (the row genuinely is 'processed', a benign duplicate)
 * apart from any other, unexpected processing_status value on that same
 * result (fails closed — see classifyMarkerOutcome). */
function decorateMarkerResult(marker) {
  const rpcResult = (marker && marker.rpcResult) || {};
  const resultValue = rpcResult.result;
  return {
    gmailMessageId: marker.gmailMessageId,
    reasonCode: marker.reasonCode,
    decision: marker.unknownResult ? 'UNKNOWN_RPC_RESULT (failed closed)' : (resultValue || 'UNKNOWN'),
    ingestionId: rpcResult.ingestion_id || null,
    processingStatus: rpcResult.processing_status || null,
    error: rpcResult.error || null,
  };
}

/** Write-mode reporting: decorates executeCivitatisIngestionPlan's own
 * (unmodified) results with eventType and the flattened field set this
 * endpoint promises. */
function buildWriteResults(executedResults, eventTypeByGmailId) {
  return executedResults.map(entry => {
    const markerResults = (entry.markerResults || []).map(decorateMarkerResult);
    if (entry.skipped) {
      return { externalBookingId: entry.externalBookingId, skipped: true, reason: entry.reason, stoppedEarly: false, calls: [], markerResults };
    }
    return {
      externalBookingId: entry.externalBookingId,
      skipped: false,
      stoppedEarly: entry.stoppedEarly,
      calls: entry.calls.map(c => decorateCallResult(c, eventTypeByGmailId.get(c.gmailMessageId))),
      markerResults,
    };
  });
}

/** Splits an already-filtered message batch into cancellation messages
 * and everything else, via the SAME detectCivitatisEvent classification
 * eventDetector.js already performs — never a second/different rule.
 * This split happens BEFORE planCivitatisIngestion ever sees the
 * messages: a cancellation email carries none of the fields
 * parseCivitatisEmail requires (Date/People/Retail/Net price/...), and
 * grouping it alongside a new_booking/modified email for the SAME
 * external_booking_id would incorrectly mark that booking's whole chain
 * "failed to parse" — see cancellationAdapter.js's header for the full
 * argument. This is the ONLY change made to how messages reach
 * planCivitatisIngestion; the non-cancellation array is passed through
 * completely unfiltered otherwise, so existing new_booking/modified
 * behavior is unaffected byte-for-byte when no cancellation email is
 * present in the batch. */
function splitCancellationMessages(messages) {
  const cancellations = [];
  const other = [];
  for (const m of messages || []) {
    const detection = detectCivitatisEvent({ from: m && m.from, subject: m && m.subject });
    if (detection.classification === 'cancelled') cancellations.push(m);
    else other.push(m);
  }
  return { cancellations, other };
}

/** Dry-run reporting for cancellations — mirrors buildDryRunResults'
 * shape/spirit for the booking pipeline, but flat (one entry per email,
 * never grouped) since a cancellation has no booking-chain concept. */
function buildCancellationDryRunResults(plan) {
  return plan.plans.map(entry => ({
    gmailMessageId: entry.gmailMessageId,
    externalBookingId: entry.externalBookingId,
    decision: 'WOULD_CANCEL (dry run — write mode not active for this request)',
    rpcResult: null,
  }));
}

/** Write-mode reporting for cancellations — same never-leak-PII/never-
 * leak-payload discipline as decorateCallResult. */
function decorateCancellationResult(entry) {
  const rpcResult = entry.rpcResult || {};
  const resultValue = rpcResult.result;
  return {
    gmailMessageId: entry.gmailMessageId,
    externalBookingId: entry.externalBookingId,
    decision: entry.unknownResult ? 'UNKNOWN_RPC_RESULT (failed closed)' : (resultValue || 'UNKNOWN'),
    rpcResult: resultValue || null,
    reservationId: rpcResult.reservation_id || null,
    ingestionId: rpcResult.ingestion_id || null,
    reason: rpcResult.reason || null,
    error: rpcResult.error || null,
    stage: rpcResult.stage || null,
    diagnostics: rpcResult.diagnostics || null,
  };
}

/** Splits classification==='client_message' messages out of a batch —
 * same shape as splitCancellationMessages, applied to the remainder
 * AFTER cancellations have already been split out (see
 * runCivitatisWriteOrchestration). */
function splitClientMessages(messages) {
  const clientMessages = [];
  const other = [];
  for (const m of messages || []) {
    const detection = detectCivitatisEvent({ from: m && m.from, subject: m && m.subject });
    if (detection.classification === 'client_message') clientMessages.push(m);
    else other.push(m);
  }
  return { clientMessages, other };
}

/** Dry-run reporting for client messages — mirrors
 * buildCancellationDryRunResults' shape/spirit, flat (one entry per
 * email). A mismatch entry (forceAmbiguous:true) is reported distinctly
 * so a dry run makes the fail-closed diagnostic outcome visible too,
 * never indistinguishable from an ordinary match attempt. */
function buildClientMessageDryRunResults(plan) {
  return plan.plans.map(entry => ({
    gmailMessageId: entry.gmailMessageId,
    externalBookingId: entry.externalBookingId,
    decision: entry.forceAmbiguous
      ? `WOULD_RECORD_AMBIGUOUS (${entry.mismatchReason})`
      : 'WOULD_INGEST (dry run — write mode not active for this request)',
    rpcResult: null,
  }));
}

/** Write-mode reporting for client messages — same never-leak-PII/never-
 * leak-message-body discipline as decorateCancellationResult. The
 * message text itself is NEVER included here. */
function decorateClientMessageResult(entry) {
  const rpcResult = entry.rpcResult || {};
  const resultValue = rpcResult.result;
  return {
    gmailMessageId: entry.gmailMessageId,
    externalBookingId: entry.externalBookingId,
    decision: entry.unknownResult ? 'UNKNOWN_RPC_RESULT (failed closed)' : (resultValue || 'UNKNOWN'),
    rpcResult: resultValue || null,
    reservationMessageId: rpcResult.reservation_message_id || null,
    reservationId: rpcResult.reservation_id || null,
    reason: rpcResult.reason || null,
  };
}

/**
 * The full orchestration, with `repo`, `rpcCaller` (write mode only), and
 * `cancellationRpcCaller` (write mode only) INJECTED — no Gmail/Supabase
 * I/O of its own beyond what those injected dependencies do. This is what
 * the HTTP handler below calls, and it is also exactly what
 * tests/civitatis/writeEndpoint.test.js exercises directly with a fake
 * repo and a fake/spy rpcCaller, so the real request-handling code path is
 * what gets proven, not a reimplementation of it.
 *
 * When writeModeActive is false, NEITHER rpcCaller NOR
 * cancellationRpcCaller is ever invoked — the caller (the HTTP handler
 * below) does not even construct real ones in that case, so there is no
 * real RPC wrapper in existence at all for a disabled request, not merely
 * an unused one.
 *
 * `markNeedsReviewRpcCaller` (write mode only, exactly like rpcCaller/
 * cancellationRpcCaller) is passed straight through to
 * executeCivitatisIngestionPlan as its optional third argument — see
 * that function's own doc comment. A dry run never receives one and
 * never needs to: buildDryRunResults reports what WOULD be marked
 * purely from `plan.plans[].needsReviewMarkers`, with zero RPC calls.
 *
 * `identityDecision` (write mode only) is forwarded to
 * planCivitatisIngestion unchanged — see api/ingest-civitatis-write.js's
 * own handler for the full identityDecisionFor/identityDecision/
 * confirmedCustomerId validation this value must already have passed
 * before reaching here. A `{ok:false, stage:'identity_decision_invalid_candidate'}`
 * result from planCivitatisIngestion (an invalid confirmedCustomerId)
 * is passed straight through so the HTTP handler can map it to a 400.
 */
async function runCivitatisWriteOrchestration({ messages, repo, externalBookingId, writeModeActive, rpcCaller, cancellationRpcCaller, clientMessageRpcCaller, markNeedsReviewRpcCaller, identityDecision = null }) {
  const filteredMessages = externalBookingId
    ? filterMessagesByExternalBookingId(messages, externalBookingId)
    : (messages || []);

  const { cancellations: cancellationMessages, other: afterCancellationSplit } = splitCancellationMessages(filteredMessages);
  // A third, independent split (same shape as cancellations) — client
  // messages never reach planCivitatisIngestion/the booking RPC either,
  // for exactly the same reason cancellations don't: they carry no
  // booking fields to extract.
  const { clientMessages, other: bookingMessages } = splitClientMessages(afterCancellationSplit);

  const plan = await planCivitatisIngestion({ messages: bookingMessages, repo, identityDecision });
  if (!plan.ok) return { ok: false, error: plan.error, stage: plan.stage };

  const cancellationPlan = await planCivitatisCancellations({ messages: cancellationMessages, repo });
  if (!cancellationPlan.ok) return { ok: false, error: cancellationPlan.error };

  const clientMessagePlan = await planCivitatisClientMessages({ messages: clientMessages, repo });
  if (!clientMessagePlan.ok) return { ok: false, error: clientMessagePlan.error };

  if (!writeModeActive) {
    return {
      ok: true,
      results: buildDryRunResults(plan),
      cancellations: buildCancellationDryRunResults(cancellationPlan),
      clientMessages: buildClientMessageDryRunResults(clientMessagePlan),
    };
  }

  const eventTypeByGmailId = buildEventTypeMap(plan);
  const executed = await executeCivitatisIngestionPlan(plan, rpcCaller, markNeedsReviewRpcCaller);

  // Tour Preparation Intelligence Phase B3: automatic Activity/meal-modality
  // enrichment, run ONLY here — after the booking domain write has already
  // fully committed, and never for cancellations (executedCancellations,
  // below, is a structurally separate variable/path this call never
  // touches). This is a SECONDARY ENRICHMENT: wrapped so that nothing it
  // does can alter `executed` or this function's return value, and so any
  // failure here (rule-repository read error, persistence RPC error, or
  // anything else) can never cause the booking write above to be treated
  // as failed or retried. enrichCivitatisActivityModalityForPlan already
  // isolates failures per individual event internally; this try/catch is
  // an extra outer guard against a totally unexpected error in the
  // enrichment step itself.
  try {
    await enrichCivitatisActivityModalityForPlan({ plan, executed });
  } catch (err) {
    console.error('[ingest-civitatis-write] Activity modality enrichment error:', err.message);
  }

  // Tour Preparation Intelligence Phase C2F: automatic reservation-
  // preparation materialization, run ONLY here — after the booking domain
  // write above has already fully committed. Same isolation philosophy as
  // the activity-modality enrichment immediately above: wrapped so that
  // nothing it does can alter `executed` or this function's return value,
  // and so any failure here can never cause the booking write to be
  // treated as failed or retried.
  // materializeReservationPreparationsForBookingPlan already isolates
  // failures per individual event internally; this try/catch is an extra
  // outer guard against a totally unexpected error in the step itself.
  try {
    await materializeReservationPreparationsForBookingPlan({ plan, executed });
  } catch (err) {
    console.error('[ingest-civitatis-write] Reservation preparation materialization error (booking):', err.message);
  }

  const executedCancellations = await executeCivitatisCancellationPlan(cancellationPlan.plans, cancellationRpcCaller);

  // Same Phase C2F enrichment, for the cancellation pipeline — run ONLY
  // after the cancellation domain write above has already fully
  // committed, and never able to affect `executedCancellations` or this
  // function's return value.
  try {
    await materializeReservationPreparationsForCancellations({ executedCancellations });
  } catch (err) {
    console.error('[ingest-civitatis-write] Reservation preparation materialization error (cancellation):', err.message);
  }

  // Client messages: a third, fully independent write step — never
  // enrichment of the booking/cancellation writes above, so no isolating
  // try/catch is needed here (same reasoning as cancellations: each
  // email is already fully independent, and a client-message write
  // failure must be visible in the real response, not swallowed).
  const executedClientMessages = await executeCivitatisClientMessagePlan(clientMessagePlan.plans, clientMessageRpcCaller);

  return {
    ok: true,
    results: buildWriteResults(executed, eventTypeByGmailId),
    cancellations: executedCancellations.map(decorateCancellationResult),
    clientMessages: executedClientMessages.map(decorateClientMessageResult),
  };
}

/** The ONLY place a real RPC call is ever constructed. A call-level
 * Supabase error (permission/network/argument-shape issue — distinct
 * from the RPC's OWN internal EXCEPTION handling, which already returns
 * a normal {result:'failed', ...} response) is translated into the SAME
 * {result:'failed', error} shape rather than thrown, so it is handled by
 * executeCivitatisIngestionPlan's existing, UNMODIFIED fail-closed logic
 * exactly like any other 'failed' result — stopping further processing
 * for that booking's chain, with no change needed to writeAdapter.js. */
function buildRealRpcCaller() {
  const sb = getServiceRoleClient();
  return async function rpcCaller(payload) {
    const { data, error } = await sb.rpc('ingest_civitatis_booking', payload);
    if (error) {
      return { result: 'failed', error: `RPC call error: ${error.message}` };
    }
    return data;
  };
}

/** The ONLY place a real cancellation RPC call is ever constructed —
 * deliberately a SEPARATE function calling a SEPARATE RPC
 * (cancel_civitatis_booking), never routed through buildRealRpcCaller/
 * ingest_civitatis_booking. Same call-level-error-to-{result:'failed'}
 * translation as buildRealRpcCaller, for the same reason. */
function buildRealCancellationRpcCaller() {
  const sb = getServiceRoleClient();
  return async function cancellationRpcCaller(payload) {
    const { data, error } = await sb.rpc('cancel_civitatis_booking', payload);
    if (error) {
      return { result: 'failed', error: `RPC call error: ${error.message}` };
    }
    return data;
  };
}

/** The ONLY place a real client-message RPC call is ever constructed —
 * deliberately a separate function calling a separate RPC
 * (ingest_civitatis_reservation_message — see
 * supabase_migration_civitatis_client_messages.sql), never routed
 * through buildRealRpcCaller/ingest_civitatis_booking or
 * buildRealCancellationRpcCaller/cancel_civitatis_booking. Same call-
 * level-error-to-{result:'failed'} translation as the two builders
 * above, for the same reason: executeCivitatisClientMessagePlan's
 * existing fail-closed unknownResult handling already treats any value
 * outside KNOWN_CLIENT_MESSAGE_RPC_RESULTS correctly without needing
 * special-case logic here. */
function buildRealClientMessageRpcCaller() {
  const sb = getServiceRoleClient();
  return async function clientMessageRpcCaller(payload) {
    const { data, error } = await sb.rpc('ingest_civitatis_reservation_message', payload);
    if (error) {
      return { result: 'failed', error: `RPC call error: ${error.message}` };
    }
    return data;
  };
}

/** The ONLY place a real needs_review-marker RPC call is ever
 * constructed — deliberately a THIRD, separate function calling a
 * THIRD, separate, structurally-write-incapable RPC
 * (mark_civitatis_email_needs_review — see
 * supabase_migration_civitatis_write_v14_mark_needs_review.sql), never
 * routed through either of the other two real-RPC builders above. Same
 * call-level-error-to-{result:'failed'} translation, for the same
 * reason: executeCivitatisIngestionPlan's existing fail-closed
 * unknownResult handling already treats any value outside
 * KNOWN_MARK_NEEDS_REVIEW_RESULTS (writeAdapter.js) correctly without
 * needing special-case logic here. Only ever constructed when write
 * mode is active — see the HTTP handler below. */
function buildRealMarkNeedsReviewRpcCaller() {
  const sb = getServiceRoleClient();
  return async function markNeedsReviewRpcCaller(payload) {
    const { data, error } = await sb.rpc('mark_civitatis_email_needs_review', payload);
    if (error) {
      return { result: 'failed', error: `RPC call error: ${error.message}` };
    }
    return data;
  };
}

/**
 * Classifies ONE already-executed, already-decorated needs_review-
 * marker result (decorateMarkerResult's own output shape) into exactly
 * one of 'needsReview' | 'duplicate' | 'failed' — never inferred merely
 * from "a marker call happened at all". This is the pre-production
 * review's FIX 1: `markerResults.length > 0` is NOT sufficient evidence
 * of a successful needs_review mark — the marker RPC call itself can
 * return `result:'failed'` (a genuine SQL/runtime error inside
 * mark_civitatis_email_needs_review), an unrecognized value, or fail at
 * the Supabase-call level (translated to `{result:'failed', error}` by
 * buildRealMarkNeedsReviewRpcCaller, exactly like the real booking
 * RPC's own call-level error handling) — every one of those must count
 * as a genuine failure, never a silent "needs review" success.
 *   - 'manual_review_required' / 'already_needs_review' -> needsReview
 *     (both are successful, correctly-recorded review states — the
 *     second just means THIS call found it already there and wrote
 *     nothing new; see the V14 migration's own retry-noise fix).
 *   - 'already_processed' -> 'duplicate' ONLY when the row's own
 *     reported processing_status is genuinely 'processed' (the
 *     ambiguity was actually resolved through the normal flow in the
 *     meantime — a benign, successful outcome, not invented success);
 *     any other/missing processing_status on an already_processed
 *     result is unexpected and fails closed.
 *   - 'failed', 'UNKNOWN_RPC_RESULT (failed closed)', or anything else
 *     unrecognized -> 'failed'.
 */
function classifyMarkerOutcome(marker) {
  const decision = marker && marker.decision;
  if (decision === 'manual_review_required' || decision === 'already_needs_review') return 'needsReview';
  if (decision === 'already_processed') {
    return (marker && marker.processingStatus) === 'processed' ? 'duplicate' : 'failed';
  }
  return 'failed'; // 'failed', 'UNKNOWN_RPC_RESULT (failed closed)', or any other/missing value
}

/**
 * Safe, PII-free counts summarizing one orchestration outcome — added
 * so the cron's GitHub Actions workflow (and any human reading a
 * manual response) can see partial-failure/needs-review signals
 * without parsing every individual call result. Works identically
 * against a dry-run outcome (reporting what WOULD happen — no real
 * marker RPC result exists yet, so classifyMarkerOutcome is never
 * consulted for those; `wouldMarkNeedsReview`'s mere presence IS the
 * correct signal there, since nothing has actually been attempted) and
 * a write-mode outcome (reporting what DID happen, via
 * classifyMarkerOutcome for every real marker result).
 *
 * `needsReview`/`needsReviewBookingIds` (FIX 2): a booking-level count
 * of DISTINCT external_booking_ids needing review — a chain with
 * several Gmail messages (e.g. a PARSE_FAILURE_CHAIN or
 * POSSIBLE_EXISTING_MATCH_CONTACT_CONFLICT booking, which mark EVERY
 * message in the chain) must contribute exactly ONE entry, never one
 * per message/marker. A booking that fails closed is reported under
 * `failed`/`failedBookingIds` instead, never both (failure takes
 * precedence over needsReview for the SAME booking — "a booking must
 * appear in failedBookingIds if any required marker call for that
 * booking fails"). A marker/call with NO resolvable externalBookingId
 * (the EXTERNAL_BOOKING_ID_UNRESOLVED case) is NEVER invented a
 * booking id — it is counted separately in
 * `needsReviewUnresolvedMessages`, which is message-level by
 * necessity (there is no booking to dedupe by).
 *
 * Only booking/cancellation ids and reason codes are ever included —
 * never an email address, phone number, passenger name, or raw email
 * body/subject.
 */
function buildIngestionSummary({ results, cancellations, discoveredCount }) {
  let created = 0, updated = 0, duplicates = 0, failed = 0, skipped = 0;
  let needsReviewUnresolvedMessages = 0;
  const needsReviewBookingIds = new Set();
  const failedBookingIds = new Set();

  for (const entry of results || []) {
    if (entry.skipped) {
      skipped += 1;

      // Dry run: nothing was actually executed — report purely from
      // the plan's own wouldMarkNeedsReview list (never
      // classifyMarkerOutcome, which requires a real executed result).
      if (entry.wouldMarkNeedsReview && entry.wouldMarkNeedsReview.length > 0) {
        if (entry.externalBookingId) needsReviewBookingIds.add(entry.externalBookingId);
        else needsReviewUnresolvedMessages += entry.wouldMarkNeedsReview.length;
        continue;
      }

      // Write mode: classify EVERY actual marker result explicitly.
      // Failure anywhere in this booking's markers wins over needsReview
      // for this booking (never both for the same booking).
      let bookingFailed = false;
      let bookingNeedsReview = false;
      for (const marker of (entry.markerResults || [])) {
        const outcome = classifyMarkerOutcome(marker);
        if (outcome === 'failed') bookingFailed = true;
        else if (outcome === 'needsReview') bookingNeedsReview = true;
        else if (outcome === 'duplicate') duplicates += 1;
      }
      if (bookingFailed) {
        failed += 1;
        if (entry.externalBookingId) failedBookingIds.add(entry.externalBookingId);
      } else if (bookingNeedsReview) {
        if (entry.externalBookingId) needsReviewBookingIds.add(entry.externalBookingId);
        else needsReviewUnresolvedMessages += 1;
      }
      continue;
    }
    for (const call of entry.calls || []) {
      const decision = call.decision || call.rpcResult;
      if (decision === 'created') created += 1;
      else if (decision === 'updated') updated += 1;
      else if (decision === 'already_processed') duplicates += 1;
      else if (decision === 'manual_review_required') {
        if (entry.externalBookingId) needsReviewBookingIds.add(entry.externalBookingId);
        else needsReviewUnresolvedMessages += 1;
      } else if (decision === 'failed' || call.decision === 'UNKNOWN_RPC_RESULT (failed closed)') {
        failed += 1;
        if (entry.externalBookingId) failedBookingIds.add(entry.externalBookingId);
      }
    }
  }

  for (const entry of cancellations || []) {
    const decision = entry.decision || entry.rpcResult;
    if (decision === 'failed' || decision === 'UNKNOWN_RPC_RESULT (failed closed)') {
      failed += 1;
      if (entry.externalBookingId) failedBookingIds.add(entry.externalBookingId);
    } else if (decision === 'manual_review_required') {
      if (entry.externalBookingId) needsReviewBookingIds.add(entry.externalBookingId);
      else needsReviewUnresolvedMessages += 1;
    }
  }

  const needsReviewBookingIdsArray = [...needsReviewBookingIds];
  const failedBookingIdsArray = [...failedBookingIds];

  return {
    discovered: discoveredCount,
    created, updated, duplicates,
    needsReview: needsReviewBookingIdsArray.length, // distinct booking ids, never message/call count
    needsReviewUnresolvedMessages, // messages with no resolvable externalBookingId — tracked separately, never folded into needsReview
    failed, skipped,
    needsReviewBookingIds: needsReviewBookingIdsArray,
    failedBookingIds: failedBookingIdsArray,
  };
}

// ── HTTP handler ─────────────────────────────────────────────────────────

async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed. Use GET or POST.' });
  }

  const q = { ...(req.query || {}), ...(req.body || {}) };

  let maxMessages = parseInt(q.maxMessages || DEFAULT_MAX_MESSAGES, 10);
  if (!Number.isFinite(maxMessages) || maxMessages < 1) maxMessages = DEFAULT_MAX_MESSAGES;
  maxMessages = Math.min(maxMessages, HARD_MAX_MESSAGES);
  const pageToken = q.pageToken || undefined;

  const externalBookingId = q.externalBookingId ? String(q.externalBookingId).trim() : null;

  const writeEnvValue = process.env.CIVITATIS_WRITE_ENABLED;
  const requestedWrite = parseRequestedWrite(q.write);

  // Explicit two-way identity decision (identityDecisionFor/
  // identityDecision/confirmedCustomerId) — replaces the earlier,
  // removed confirmNotSameCustomerFor one-way override, which always
  // forced a new customer and could silently create a duplicate for
  // what might be the SAME real traveler. Pure-syntax validation only
  // here, BEFORE any Gmail/Supabase call — a malformed combination (or
  // a request missing write=true) is rejected with 400 immediately.
  // confirmedCustomerId-matches-an-actual-candidate validation happens
  // later, inside planCivitatisIngestion, which requires the read-only
  // planning stage — see runCivitatisWriteOrchestration below.
  const identityDecisionValidation = parseIdentityDecisionRequest({
    externalBookingId,
    identityDecisionFor: q.identityDecisionFor ? String(q.identityDecisionFor).trim() : null,
    identityDecision: q.identityDecision ? String(q.identityDecision).trim() : null,
    confirmedCustomerId: q.confirmedCustomerId ? String(q.confirmedCustomerId).trim() : null,
    requestedWrite,
  });
  if (!identityDecisionValidation.ok) {
    return res.status(400).json({
      error: identityDecisionValidation.error,
      stage: 'identity_decision_validation',
    });
  }
  const identityDecision = identityDecisionValidation.decision; // null, or {externalBookingId, decision, confirmedCustomerId}

  // Fail fast, before any Gmail/Supabase call: a write=true request with
  // no valid secret is rejected outright, not silently downgraded to a
  // dry run (which could mask a caller's own mistaken assumption that a
  // real write happened). Dry-run requests (requestedWrite === false)
  // never reach this check at all — no behavior change for diagnostics.
  if (requestedWrite) {
    const authorized = isManualWriteAuthorized({
      configuredSecret: process.env.CIVITATIS_MANUAL_WRITE_SECRET,
      providedSecret: req.headers['x-civitatis-write-secret'],
    });
    if (!authorized) {
      return res.status(401).json({
        error: 'Unauthorized: a write=true request requires a valid x-civitatis-write-secret header.',
        stage: 'manual_write_auth',
      });
    }
  }

  const writeModeActive = isWriteModeActive({ writeEnvValue, requestedWrite });

  let messages;
  let nextPageToken;
  try {
    const page = await gmailClient.fetchMessagePage(gmailClient.buildCivitatisSearchQuery(), {
      pageToken,
      maxResults: maxMessages,
    });
    messages = page.messages;
    nextPageToken = page.nextPageToken;
  } catch (err) {
    if (err instanceof gmailClient.ConfigurationError) {
      return res.status(503).json({ error: err.message, stage: 'gmail_configuration' });
    }
    console.error('[ingest-civitatis-write] Gmail fetch error:', err.message);
    return res.status(502).json({ error: 'Failed to fetch messages from Gmail. See function logs for details.', stage: 'gmail_fetch' });
  }

  let repo;
  try {
    repo = createSupabaseCivitatisRepo();
  } catch (err) {
    if (err instanceof ConfigurationError) {
      return res.status(503).json({ error: err.message, stage: 'supabase_configuration' });
    }
    throw err;
  }

  let rpcCaller = null;
  let cancellationRpcCaller = null;
  let clientMessageRpcCaller = null;
  let markNeedsReviewRpcCaller = null;
  if (writeModeActive) {
    try {
      rpcCaller = buildRealRpcCaller();
      cancellationRpcCaller = buildRealCancellationRpcCaller();
      clientMessageRpcCaller = buildRealClientMessageRpcCaller();
      markNeedsReviewRpcCaller = buildRealMarkNeedsReviewRpcCaller();
    } catch (err) {
      if (err instanceof ConfigurationError) {
        return res.status(503).json({ error: err.message, stage: 'supabase_configuration' });
      }
      throw err;
    }
  }

  let outcome;
  try {
    outcome = await runCivitatisWriteOrchestration({
      messages, repo, externalBookingId, writeModeActive, rpcCaller, cancellationRpcCaller,
      clientMessageRpcCaller, markNeedsReviewRpcCaller, identityDecision,
    });
  } catch (err) {
    console.error('[ingest-civitatis-write] Orchestration error:', err.message);
    return res.status(500).json({ error: 'Ingestion failed unexpectedly. See function logs for details.', stage: 'orchestration' });
  }

  if (!outcome.ok) {
    // An invalid confirmedCustomerId (planCivitatisIngestion's own
    // candidate-list check, which requires the read-only planning
    // stage and so can never happen before this point) is a genuine
    // 400-level request error, never a 422 "something about the
    // deployment's own configuration is missing" precondition —
    // distinguished by the stage planCivitatisIngestion itself reports.
    const status = outcome.stage === 'identity_decision_invalid_candidate' ? 400 : 422;
    return res.status(status).json({ error: outcome.error, stage: outcome.stage || 'planning_precondition' });
  }

  const summary = buildIngestionSummary({ results: outcome.results, cancellations: outcome.cancellations, discoveredCount: messages.length });

  if (externalBookingId && outcome.results.length === 0 && outcome.cancellations.length === 0 && outcome.clientMessages.length === 0) {
    return res.status(200).json({
      mode: writeModeActive ? 'write' : 'dryRun',
      writeEnabled: writeEnvValue === 'true',
      requestedWrite,
      externalBookingId,
      results: [],
      cancellations: [],
      clientMessages: [],
      summary,
      message: `No Gmail messages matching external booking id "${externalBookingId}" were found in this fetched page (maxMessages=${maxMessages}${pageToken ? ', pageToken supplied' : ''}). Try a larger maxMessages or supply pageToken to look further back.`,
      pagination: { requestedMaxMessages: maxMessages, nextPageToken: nextPageToken || null },
    });
  }

  return res.status(200).json({
    mode: writeModeActive ? 'write' : 'dryRun',
    writeEnabled: writeEnvValue === 'true',
    requestedWrite,
    externalBookingId: externalBookingId || null,
    results: outcome.results,
    cancellations: outcome.cancellations,
    clientMessages: outcome.clientMessages,
    summary,
    pagination: { requestedMaxMessages: maxMessages, nextPageToken: nextPageToken || null },
  });
}

// Named helpers attached to the exported handler function (Vercel only
// requires the default export to be callable as (req,res) — attaching
// extra properties does not affect that) so tests can exercise the real
// orchestration/gating/reporting logic directly, without mocking Gmail
// or Supabase network calls.
handler.isWriteModeActive = isWriteModeActive;
handler.parseRequestedWrite = parseRequestedWrite;
handler.isManualWriteAuthorized = isManualWriteAuthorized;
handler.parseIdentityDecisionRequest = parseIdentityDecisionRequest;
handler.filterMessagesByExternalBookingId = filterMessagesByExternalBookingId;
handler.buildEventTypeMap = buildEventTypeMap;
handler.decorateCallResult = decorateCallResult;
handler.buildDryRunResults = buildDryRunResults;
handler.buildWriteResults = buildWriteResults;
handler.decorateMarkerResult = decorateMarkerResult;
handler.classifyMarkerOutcome = classifyMarkerOutcome;
handler.buildIngestionSummary = buildIngestionSummary;
handler.runCivitatisWriteOrchestration = runCivitatisWriteOrchestration;
handler.splitCancellationMessages = splitCancellationMessages;
handler.buildCancellationDryRunResults = buildCancellationDryRunResults;
handler.decorateCancellationResult = decorateCancellationResult;
handler.splitClientMessages = splitClientMessages;
handler.buildClientMessageDryRunResults = buildClientMessageDryRunResults;
handler.decorateClientMessageResult = decorateClientMessageResult;
// Reused as-is by api/cron-ingest-civitatis-write.js so the scheduled
// entry point duplicates none of this ingestion/RPC logic.
handler.buildRealRpcCaller = buildRealRpcCaller;
handler.buildRealCancellationRpcCaller = buildRealCancellationRpcCaller;
handler.buildRealClientMessageRpcCaller = buildRealClientMessageRpcCaller;
handler.buildRealMarkNeedsReviewRpcCaller = buildRealMarkNeedsReviewRpcCaller;
handler.DEFAULT_MAX_MESSAGES = DEFAULT_MAX_MESSAGES;
handler.HARD_MAX_MESSAGES = HARD_MAX_MESSAGES;

module.exports = handler;
