/**
 * api/_civitatis/writeAdapter.js
 * ─────────────────────────────────────────────────────────────────────────
 * PREPARATION ONLY — NOT WIRED INTO ANY REACHABLE ENDPOINT OR CRON.
 *
 * This module is the future production-write counterpart to
 * api/_civitatis/dryRun.js: instead of building a read-only report, it
 * plans (and, only when explicitly given a real `rpcCaller`, executes)
 * calls to the public.ingest_civitatis_booking(...) transactional RPC
 * defined in supabase_migration_civitatis_write.sql — a migration that
 * has NOT been applied to any database yet.
 *
 * Nothing in api/ingest-civitatis.js imports this file. Nothing in
 * vercel.json schedules anything that would call it. It exists so its
 * logic can be reviewed and unit-tested (tests/civitatis/
 * writeAdapter.test.js) ahead of the day the migration above is applied
 * and a deliberate, separate change wires a real write path in.
 *
 * REUSES, NEVER RE-IMPLEMENTS, THE VALIDATED MATCHING LOGIC:
 * parseCivitatisEmail, mergeChronologicalState, matchTourChannel,
 * matchCustomer, matchCustomerByName, and findPossibleExistingReservation
 * are all imported from the already-validated parser.js/dryRun.js/
 * matching.js — this file adds zero new parsing or matching rules. Its
 * only new responsibilities are: (1) deciding, per booking, whether it
 * is safe to write at all (mirroring dryRun.js's own outcome
 * classification), and (2) building the RPC call payload for each
 * individual Gmail message in a safe booking's chronological event
 * history — the RPC processes one Gmail message per call, since real
 * Civitatis "Booking modified" emails are full snapshots (not deltas),
 * so applying each one's own fields in order is sufficient without
 * needing to pre-merge across events the way a dry-run report does.
 *
 * NEVER writes anything by itself: `executeCivitatisIngestionPlan` only
 * calls whatever `rpcCaller` function it is given — in a real deployment
 * that would be a thin wrapper around
 * supabaseAdmin.getServiceRoleClient().rpc('ingest_civitatis_booking', ...),
 * but that wrapper does not exist yet in this codebase (deliberately, per
 * "Do NOT enable production writes yet"). Every test in
 * writeAdapter.test.js passes a fake in-memory `rpcCaller` that never
 * touches Supabase.
 * ─────────────────────────────────────────────────────────────────────────
 */
'use strict';

const { parseCivitatisEmail } = require('./parser');
const { mergeChronologicalState } = require('./dryRun');
const { matchTourChannel, matchCustomer, matchCustomerByName, findPossibleExistingReservation } = require('./matching');

// The complete, exhaustive vocabulary of result values
// public.ingest_civitatis_booking(...) (V4) can return. Any value NOT in
// this set is treated as an unknown/unexpected result and fails closed —
// see executeCivitatisIngestionPlan below — rather than being assumed
// safe to continue past.
const KNOWN_RPC_RESULTS = new Set([
  'created',
  'updated',
  'stale_ignored',
  'booking_already_exists',
  'manual_review_required',
  'already_processed',
  'failed',
]);

/**
 * Builds the exact parameter object public.ingest_civitatis_booking(...)
 * expects for ONE parsed Civitatis event (one Gmail message).
 *
 * @param {{parsedEvent: object, rawBody: string|null, civitatisSourceId: string, tourId: string|null, customerId: string|null, autoProvisionTour?: boolean, civitatisInternalCode?: string|null, civitatisLanguageCode?: string|null}} args
 *   tourId is null for a booking whose tour_channels match did not
 *   resolve (fail-closed OR provisionable — see matchTourChannel's
 *   `provisionable` flag) — the RPC decides what to do next from
 *   autoProvisionTour. civitatisInternalCode/civitatisLanguageCode are
 *   the SAME mergedState.internalCode/languageCode values
 *   planCivitatisIngestion already used to make that eligibility
 *   decision (constant across every call in one booking's chain, never
 *   re-derived per individual event), passed through regardless of
 *   autoProvisionTour so a fail-closed needs_review row still records
 *   what product/language was involved, for later manual resolution.
 */
function buildRpcPayload({ parsedEvent, rawBody, civitatisSourceId, tourId, customerId, autoProvisionTour = false, civitatisInternalCode = null, civitatisLanguageCode = null }) {
  return {
    p_gmail_message_id: parsedEvent.gmailMessageId,
    p_gmail_thread_id: parsedEvent.gmailThreadId,
    p_received_at: parsedEvent.receivedAt,
    p_raw_subject: parsedEvent.rawSubject,
    p_raw_body_snapshot: rawBody == null ? null : String(rawBody),
    p_event_type: parsedEvent.eventType,
    p_source_id: civitatisSourceId,
    p_external_booking_id: parsedEvent.externalBookingId,
    p_tour_id: tourId,
    p_tour_language: parsedEvent.tourLanguage,
    p_check_in: parsedEvent.date,
    p_check_in_time: parsedEvent.time,
    p_pax_adult: parsedEvent.adultCount,
    p_pax_child: parsedEvent.childCount || 0,
    p_total_amount: parsedEvent.netAmount,
    p_currency: parsedEvent.netCurrency,
    p_retail_amount: parsedEvent.retailAmount,
    p_retail_currency: parsedEvent.retailCurrency,
    p_customer_id: customerId,
    p_customer_full_name: parsedEvent.clientFullName,
    p_customer_email: parsedEvent.clientEmail,
    p_customer_phone: (parsedEvent.phones && parsedEvent.phones[0]) || null,
    // A native JS array/object here — NEVER a pre-stringified JSON
    // string. supabase.rpc(fn, args) hands the WHOLE args object to
    // @supabase/postgrest-js's PostgrestBuilder, which itself calls
    // JSON.stringify(this.body) exactly ONCE to build the HTTP request
    // body. Pre-serializing this field with JSON.stringify(...) here
    // would double-encode it: PostgREST would receive a JSON STRING
    // (whose text merely looks like an array) under p_passengers, cast
    // it to a JSONB SCALAR, and public.ingest_civitatis_booking's
    // jsonb_array_elements(p_passengers) calls would throw "cannot
    // extract elements from a scalar" — exactly the real production
    // failure this comment documents (gmailMessageId
    // 1a0aedc69a2ef905 / booking A41629692's first controlled write
    // attempt). See tests/civitatis/writeAdapter.test.js's REGRESSION
    // test for the reproduction.
    p_passengers: parsedEvent.passengers || [],
    // Civitatis tour auto-provisioning (see the RPC's Step 2a and
    // matching.js's `provisionable` flag) — p_auto_provision_tour is
    // only ever true for the two approved decision-table branches
    // (product entirely unmapped, or missing this exact language
    // variant); every other unmatched case reaches the RPC with this
    // false, so it records a persisted, retryable needs_review row
    // without attempting to create anything.
    p_auto_provision_tour: !!autoProvisionTour,
    p_civitatis_internal_code: civitatisInternalCode,
    p_civitatis_language_code: civitatisLanguageCode,
  };
}

/**
 * Plans (never writes) the full set of RPC calls a batch of already-
 * fetched Gmail messages would produce, applying the EXACT SAME safety
 * gate dryRun.js's own outcome classification already applies, PLUS the
 * approved Civitatis tour auto-provisioning decision table:
 *   - a booking whose event chain has any parse failure -> ineligible
 *     (never reaches the RPC at all — a parse failure has nothing
 *     dependable to record)
 *   - no exact tour_channels match, genuinely ambiguous/unresolvable
 *     (ambiguous mapping, unrecognized/missing language, missing
 *     internal code) -> STILL eligible (tourId:null,
 *     autoProvisionTour:false) — sent to the RPC so a permanent,
 *     retryable email_ingestions row is recorded instead of being
 *     silently skipped
 *   - no exact tour_channels match, but matchTourChannel flagged it
 *     `provisionable` (product entirely unmapped, or missing this exact
 *     language variant) -> eligible (tourId:null,
 *     autoProvisionTour:true) — the RPC resolves or creates the tour
 *     itself, inside its own transaction
 *   - an unlinked legacy reservation strong-signal match -> ineligible
 *     (POSSIBLE_EXISTING_MATCH; requires manual confirmation) — only
 *     ever checked once a tour is actually resolved (never for a
 *     provisioning booking, which cannot have a pre-existing legacy
 *     reservation for a tour that does not exist yet)
 *   - an email/phone contact conflict (two different existing
 *     customers) -> ineligible (POSSIBLE_EXISTING_MATCH)
 *   - an exact-normalized-name customer candidate with no email/phone
 *     match -> ineligible (POSSIBLE_EXISTING_MATCH; name alone is never
 *     sufficient for an automatic bind)
 *   - otherwise -> eligible; customerId is the already-matched customer
 *     (reused, never re-created) or null (the RPC will create one from
 *     the booking CONTACT's own fields — never a passenger)
 *
 * Read-only: only ever calls the `repo`'s existing read methods (the
 * same repo interface api/_civitatis/supabaseAdmin.js already implements
 * for the dry-run endpoint). Never calls anything write-shaped.
 *
 * @param {{messages: Array, repo: object}} args
 * @returns {Promise<{ok:true, civitatisSourceId:string, plans:Array} | {ok:false, error:string}>}
 */
async function planCivitatisIngestion({ messages, repo }) {
  const civitatisSource = await repo.getCivitatisSource();
  if (!civitatisSource) {
    return { ok: false, error: 'No Civitatis source found — cannot plan any writes.' };
  }
  const tourChannels = await repo.getTourChannelsForSource(civitatisSource.id);

  const seenGmailIds = new Set();
  const parsedEvents = [];
  for (const message of messages || []) {
    if (!message || !message.gmailMessageId) continue;
    if (seenGmailIds.has(message.gmailMessageId)) continue; // same Gmail-level dedup dryRun.js applies
    seenGmailIds.add(message.gmailMessageId);
    parsedEvents.push({ parsed: parseCivitatisEmail(message), rawBody: message.body || null });
  }

  const groups = new Map();
  for (const item of parsedEvents) {
    const bookingId = item.parsed.externalBookingId;
    if (!bookingId) continue; // standalone ignored/needs_review/parse_error — never plannable
    if (!groups.has(bookingId)) groups.set(bookingId, []);
    groups.get(bookingId).push(item);
  }

  const plans = [];
  for (const [externalBookingId, items] of groups) {
    // Gmail's own listing order is NOT guaranteed chronological (in
    // practice it is typically newest-first) — every event within a
    // booking's chain is re-sorted here by receivedAt ASCENDING
    // regardless of the order `messages` arrived in, so a New booking
    // email is always sent to the RPC before its later Booking modified
    // email, however the caller fetched/batched them. Ties (identical
    // receivedAt) fall back to gmailMessageId — a stable, always-present
    // string — purely so repeated runs over the same input produce the
    // exact same order; it carries no chronological meaning of its own.
    items.sort((a, b) => {
      const byTime = new Date(a.parsed.receivedAt) - new Date(b.parsed.receivedAt);
      if (byTime !== 0) return byTime;
      const idA = String(a.parsed.gmailMessageId || '');
      const idB = String(b.parsed.gmailMessageId || '');
      return idA < idB ? -1 : idA > idB ? 1 : 0;
    });

    const failed = items.filter(it => !it.parsed.ok);
    if (failed.length > 0) {
      plans.push({ externalBookingId, eligible: false, reason: 'one or more events in this booking\'s chain failed to parse (NEEDS_REVIEW/PARSE_ERROR) — never written' });
      continue;
    }

    const events = items.map(it => it.parsed);
    const mergedState = mergeChronologicalState(events);

    const tourMatch = matchTourChannel({
      internalCode: mergedState.internalCode,
      civitatisSourceId: civitatisSource.id,
      // Same canonical language name dryRun.js passes — see matching.js
      // for the full product+language precedence rule.
      bookingLanguage: mergedState.tourLanguage,
      tourChannels,
    });

    if (!tourMatch.matched && !tourMatch.provisionable) {
      // Genuinely fail-closed tour-matching (ambiguous mapping,
      // unrecognized/missing language, or the defensive missing-
      // internal-code case) — this booking is NO LONGER silently
      // skipped. It is still sent to the RPC (tourId:null,
      // auto-provisioning NOT requested), so a permanent, retryable
      // email_ingestions row is recorded (the RPC's own field
      // validation routes it to needs_review) instead of this booking
      // depending indefinitely on Gmail rediscovery with zero persisted
      // trace. See public.ingest_civitatis_booking's Step 2b.
      plans.push({
        externalBookingId, eligible: true, tourId: null, autoProvisionTour: false, customerId: null,
        tourMatchReason: tourMatch.reason,
        calls: items.map(it => buildRpcPayload({
          parsedEvent: it.parsed, rawBody: it.rawBody, civitatisSourceId: civitatisSource.id,
          tourId: null, customerId: null, autoProvisionTour: false,
          civitatisInternalCode: mergedState.internalCode, civitatisLanguageCode: mergedState.languageCode,
        })),
        // Tour Preparation Intelligence Phase B3: a purely additive,
        // parallel-to-`calls` array (same order/length) carrying each
        // individual event's own already-parsed Activity/language, so a
        // post-write enrichment step can read them by index without a
        // second parse. Deliberately NOT merged into `calls`' own payload
        // objects — api/ingest-civitatis-write.js's buildEventTypeMap/
        // buildDryRunResults/buildWriteResults/decorateCallResult all read
        // specific keys directly off each `calls` element today, and this
        // field must never change that existing shape.
        callMeta: items.map(it => ({ activityName: it.parsed.activityName, languageCode: it.parsed.languageCode })),
      });
      continue;
    }

    // Resolved (an exact existing mapping) or null (provisionable — the
    // RPC will resolve/create the tour itself, inside its own
    // transaction, under a lock keyed on the exact (source,
    // external_product_id, booking_language) identity — see Step 2a).
    // Never both: tourMatch.matched and tourMatch.provisionable are
    // mutually exclusive by construction in matchTourChannel.
    const resolvedTourId = tourMatch.matched ? tourMatch.tour.id : null;
    const autoProvisionTour = !tourMatch.matched; // i.e. tourMatch.provisionable === true here

    const existingLinked = await repo.findReservationByExternalBooking({ sourceId: civitatisSource.id, externalBookingId });

    if (!existingLinked && resolvedTourId) {
      // Legacy-reservation matching is inherently tour-scoped — a
      // provisioning booking (resolvedTourId still null; its tour does
      // not exist yet) cannot possibly have a pre-existing unlinked
      // reservation to match against, so this step is skipped rather
      // than attempted against a null tour id.
      const candidateReservations = await repo.findCandidateLegacyReservations({ tourId: resolvedTourId });
      const legacyMatch = findPossibleExistingReservation(
        { tourId: resolvedTourId, checkIn: mergedState.date, checkInTime: mergedState.time, totalGuestCount: mergedState.totalGuestCount },
        candidateReservations
      );
      if (legacyMatch.possible) {
        plans.push({ externalBookingId, eligible: false, reason: `POSSIBLE_EXISTING_MATCH (unlinked legacy reservation): ${legacyMatch.reason}` });
        continue;
      }
    }

    let customerId = null;
    if (!existingLinked) {
      const customerCandidates = await repo.findCustomersByContact({
        email: mergedState.clientEmail,
        phone: (mergedState.phones && mergedState.phones[0]) || null,
      });
      const customerMatch = matchCustomer({
        email: mergedState.clientEmail,
        phone: (mergedState.phones && mergedState.phones[0]) || null,
        customers: customerCandidates,
      });

      if (customerMatch.matched) {
        customerId = customerMatch.customer.id;
      } else if (customerMatch.conflict) {
        plans.push({ externalBookingId, eligible: false, reason: `POSSIBLE_EXISTING_MATCH (contact conflict): ${customerMatch.reason}` });
        continue;
      } else if (mergedState.clientFullName) {
        const nameCandidates = await repo.findCustomersByName({ fullName: mergedState.clientFullName });
        const nameMatch = matchCustomerByName({ fullName: mergedState.clientFullName, customers: nameCandidates });
        if (nameMatch.matched) {
          plans.push({ externalBookingId, eligible: false, reason: `POSSIBLE_EXISTING_MATCH (exact normalized name): ${nameMatch.reason}` });
          continue;
        }
      }
      // else: customerId stays null — the RPC creates a new customer from
      // this booking's own contact fields (never a passenger name).
    }

    plans.push({
      externalBookingId,
      eligible: true,
      tourId: resolvedTourId,
      autoProvisionTour,
      customerId, // null means "the RPC should create one"
      calls: items.map(it => buildRpcPayload({
        parsedEvent: it.parsed,
        rawBody: it.rawBody,
        civitatisSourceId: civitatisSource.id,
        tourId: resolvedTourId,
        customerId,
        autoProvisionTour,
        civitatisInternalCode: mergedState.internalCode,
        civitatisLanguageCode: mergedState.languageCode,
      })),
      // Tour Preparation Intelligence Phase B3 — see the other plans.push
      // call site above for why this parallel field exists.
      callMeta: items.map(it => ({ activityName: it.parsed.activityName, languageCode: it.parsed.languageCode })),
    });
  }

  return { ok: true, civitatisSourceId: civitatisSource.id, plans };
}

/**
 * Executes an already-built plan's eligible entries, in order, via the
 * given `rpcCaller` — the ONLY place in this module that would ever
 * touch a real database if wired up for real. `rpcCaller` must be an
 * async function `(payload) => Promise<object>` — in production this
 * would call supabase.rpc('ingest_civitatis_booking', payload); no such
 * wrapper exists anywhere reachable in this codebase yet.
 *
 * Stops processing a booking's remaining calls (but continues to the
 * next booking) the first time a call returns result:'failed', or a
 * result value outside KNOWN_RPC_RESULTS. A failed event's transaction
 * already rolled back cleanly inside the RPC (see the migration's
 * EXCEPTION handler), so nothing partial was left behind, but applying a
 * LATER event for the same booking on top of a failed OR unrecognized
 * earlier result risks skipping real intermediate state — an unknown
 * result is never assumed safe to continue past (fail closed).
 *
 * @param {{ok:true, plans:Array}} plan - from planCivitatisIngestion
 * @param {(payload:object) => Promise<object>} rpcCaller
 */
async function executeCivitatisIngestionPlan(plan, rpcCaller) {
  if (!plan || plan.ok !== true) {
    throw new Error('executeCivitatisIngestionPlan requires a successful plan from planCivitatisIngestion');
  }
  if (typeof rpcCaller !== 'function') {
    throw new Error('executeCivitatisIngestionPlan requires an rpcCaller function');
  }

  const results = [];
  for (const entry of plan.plans) {
    if (!entry.eligible) {
      results.push({ externalBookingId: entry.externalBookingId, skipped: true, reason: entry.reason });
      continue;
    }
    const callResults = [];
    let stoppedEarly = false;
    for (const payload of entry.calls) {
      const rpcResult = await rpcCaller(payload);
      const resultValue = rpcResult && rpcResult.result;
      const isKnown = KNOWN_RPC_RESULTS.has(resultValue);
      callResults.push({ gmailMessageId: payload.p_gmail_message_id, rpcResult, unknownResult: !isKnown });
      if (!isKnown || resultValue === 'failed') {
        stoppedEarly = true;
        break;
      }
    }
    results.push({ externalBookingId: entry.externalBookingId, skipped: false, calls: callResults, stoppedEarly });
  }
  return results;
}

module.exports = {
  buildRpcPayload,
  planCivitatisIngestion,
  executeCivitatisIngestionPlan,
};
