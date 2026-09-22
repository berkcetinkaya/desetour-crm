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
 * NOT wired to cron: no vercel.json crons entry exists for this or any
 * other function. Manual invocation only, in this phase.
 * ─────────────────────────────────────────────────────────────────────────
 */
'use strict';

const gmailClient = require('./_civitatis/gmailClient');
const { createSupabaseCivitatisRepo, getServiceRoleClient, ConfigurationError } = require('./_civitatis/supabaseAdmin');
const { planCivitatisIngestion, executeCivitatisIngestionPlan } = require('./_civitatis/writeAdapter');
const { parseCivitatisEmail } = require('./_civitatis/parser');

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
 * exact order writeAdapter would send it, without ever calling it. */
function buildDryRunResults(plan) {
  return plan.plans.map(entry => {
    if (!entry.eligible) {
      return { externalBookingId: entry.externalBookingId, skipped: true, reason: entry.reason, stoppedEarly: false, calls: [] };
    }
    return {
      externalBookingId: entry.externalBookingId,
      skipped: false,
      stoppedEarly: false,
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

/** Write-mode reporting: decorates executeCivitatisIngestionPlan's own
 * (unmodified) results with eventType and the flattened field set this
 * endpoint promises. */
function buildWriteResults(executedResults, eventTypeByGmailId) {
  return executedResults.map(entry => {
    if (entry.skipped) {
      return { externalBookingId: entry.externalBookingId, skipped: true, reason: entry.reason, stoppedEarly: false, calls: [] };
    }
    return {
      externalBookingId: entry.externalBookingId,
      skipped: false,
      stoppedEarly: entry.stoppedEarly,
      calls: entry.calls.map(c => decorateCallResult(c, eventTypeByGmailId.get(c.gmailMessageId))),
    };
  });
}

/**
 * The full orchestration, with `repo` and `rpcCaller` (write mode only)
 * INJECTED — no Gmail/Supabase I/O of its own beyond what those
 * injected dependencies do. This is what the HTTP handler below calls,
 * and it is also exactly what tests/civitatis/writeEndpoint.test.js
 * exercises directly with a fake repo and a fake/spy rpcCaller, so the
 * real request-handling code path is what gets proven, not a
 * reimplementation of it.
 *
 * When writeModeActive is false, `rpcCaller` is never invoked — the
 * caller (the HTTP handler below) does not even construct a real one in
 * that case, so there is no real RPC wrapper in existence at all for a
 * disabled request, not merely an unused one.
 */
async function runCivitatisWriteOrchestration({ messages, repo, externalBookingId, writeModeActive, rpcCaller }) {
  const filteredMessages = externalBookingId
    ? filterMessagesByExternalBookingId(messages, externalBookingId)
    : (messages || []);

  const plan = await planCivitatisIngestion({ messages: filteredMessages, repo });
  if (!plan.ok) return { ok: false, error: plan.error };

  if (!writeModeActive) {
    return { ok: true, results: buildDryRunResults(plan) };
  }

  const eventTypeByGmailId = buildEventTypeMap(plan);
  const executed = await executeCivitatisIngestionPlan(plan, rpcCaller);
  return { ok: true, results: buildWriteResults(executed, eventTypeByGmailId) };
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
  if (writeModeActive) {
    try {
      rpcCaller = buildRealRpcCaller();
    } catch (err) {
      if (err instanceof ConfigurationError) {
        return res.status(503).json({ error: err.message, stage: 'supabase_configuration' });
      }
      throw err;
    }
  }

  let outcome;
  try {
    outcome = await runCivitatisWriteOrchestration({ messages, repo, externalBookingId, writeModeActive, rpcCaller });
  } catch (err) {
    console.error('[ingest-civitatis-write] Orchestration error:', err.message);
    return res.status(500).json({ error: 'Ingestion failed unexpectedly. See function logs for details.', stage: 'orchestration' });
  }

  if (!outcome.ok) {
    return res.status(422).json({ error: outcome.error, stage: 'planning_precondition' });
  }

  if (externalBookingId && outcome.results.length === 0) {
    return res.status(200).json({
      mode: writeModeActive ? 'write' : 'dryRun',
      writeEnabled: writeEnvValue === 'true',
      requestedWrite,
      externalBookingId,
      results: [],
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
handler.filterMessagesByExternalBookingId = filterMessagesByExternalBookingId;
handler.buildEventTypeMap = buildEventTypeMap;
handler.decorateCallResult = decorateCallResult;
handler.buildDryRunResults = buildDryRunResults;
handler.buildWriteResults = buildWriteResults;
handler.runCivitatisWriteOrchestration = runCivitatisWriteOrchestration;

module.exports = handler;
