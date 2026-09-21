/**
 * api/civitatis/writeAdapter.js
 * ─────────────────────────────────────────────────────────────────────────
 * PREPARATION ONLY — NOT WIRED INTO ANY REACHABLE ENDPOINT OR CRON.
 *
 * This module is the future production-write counterpart to
 * api/civitatis/dryRun.js: instead of building a read-only report, it
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

/**
 * Builds the exact parameter object public.ingest_civitatis_booking(...)
 * expects for ONE parsed Civitatis event (one Gmail message).
 *
 * @param {{parsedEvent: object, rawBody: string|null, civitatisSourceId: string, tourId: string, customerId: string|null}} args
 */
function buildRpcPayload({ parsedEvent, rawBody, civitatisSourceId, tourId, customerId }) {
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
    p_passengers: JSON.stringify(parsedEvent.passengers || []),
  };
}

/**
 * Plans (never writes) the full set of RPC calls a batch of already-
 * fetched Gmail messages would produce, applying the EXACT SAME safety
 * gate dryRun.js's own outcome classification already applies:
 *   - a booking whose event chain has any parse failure -> ineligible
 *   - no exact tour_channels match -> ineligible (never fuzzy)
 *   - an unlinked legacy reservation strong-signal match -> ineligible
 *     (POSSIBLE_EXISTING_MATCH; requires manual confirmation)
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
 * same repo interface api/civitatis/supabaseAdmin.js already implements
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
    items.sort((a, b) => new Date(a.parsed.receivedAt) - new Date(b.parsed.receivedAt));

    const failed = items.filter(it => !it.parsed.ok);
    if (failed.length > 0) {
      plans.push({ externalBookingId, eligible: false, reason: 'one or more events in this booking\'s chain failed to parse (NEEDS_REVIEW/PARSE_ERROR) — never written' });
      continue;
    }

    const events = items.map(it => it.parsed);
    const mergedState = mergeChronologicalState(events);

    const tourMatch = matchTourChannel({ internalCode: mergedState.internalCode, civitatisSourceId: civitatisSource.id, tourChannels });
    if (!tourMatch.matched) {
      plans.push({ externalBookingId, eligible: false, reason: tourMatch.reason });
      continue;
    }

    const existingLinked = await repo.findReservationByExternalBooking({ sourceId: civitatisSource.id, externalBookingId });

    if (!existingLinked) {
      const candidateReservations = await repo.findCandidateLegacyReservations({ tourId: tourMatch.tour.id });
      const legacyMatch = findPossibleExistingReservation(
        { tourId: tourMatch.tour.id, checkIn: mergedState.date, checkInTime: mergedState.time, totalGuestCount: mergedState.totalGuestCount },
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
      tourId: tourMatch.tour.id,
      customerId, // null means "the RPC should create one"
      calls: items.map(it => buildRpcPayload({
        parsedEvent: it.parsed,
        rawBody: it.rawBody,
        civitatisSourceId: civitatisSource.id,
        tourId: tourMatch.tour.id,
        customerId,
      })),
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
 * next booking) the first time a call returns result:'failed' — a
 * failed event's transaction already rolled back cleanly inside the RPC
 * (see the migration's EXCEPTION handler), so nothing partial was left
 * behind, but applying a LATER event for the same booking on top of a
 * failed earlier one risks skipping real intermediate state.
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
    for (const payload of entry.calls) {
      const rpcResult = await rpcCaller(payload);
      callResults.push({ gmailMessageId: payload.p_gmail_message_id, rpcResult });
      if (rpcResult && rpcResult.result === 'failed') break;
    }
    results.push({ externalBookingId: entry.externalBookingId, skipped: false, calls: callResults });
  }
  return results;
}

module.exports = {
  buildRpcPayload,
  planCivitatisIngestion,
  executeCivitatisIngestionPlan,
};
