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

// The complete, exhaustive vocabulary public.mark_civitatis_email_
// needs_review(...) can return. Same fail-closed philosophy as
// KNOWN_RPC_RESULTS above — an unrecognized value is never assumed
// safe. 'already_needs_review' (added by the pre-production review's
// retry-noise fix) means the row was ALREADY needs_review and was left
// completely untouched — a known, successful, zero-write outcome, not
// a failure — see api/ingest-civitatis-write.js's classifyMarkerOutcome
// for how this is actually counted in the reported summary.
const KNOWN_MARK_NEEDS_REVIEW_RESULTS = new Set([
  'manual_review_required',
  'already_needs_review',
  'already_processed',
  'failed',
]);

/**
 * Builds the exact parameter object public.mark_civitatis_email_
 * needs_review(...) expects for ONE Gmail message that a pre-RPC
 * safety gate (POSSIBLE_EXISTING_MATCH in any of its three variants,
 * a booking-chain parse failure, or an unresolved external booking id)
 * has decided must never reach ingest_civitatis_booking automatically.
 * `reasonDetail` carries only safe, non-PII identifiers (a candidate
 * customer/reservation id, a count, a parser-reported reason string) —
 * never an email address, phone number, or passenger name; callers are
 * responsible for keeping it that way, exactly as every call site in
 * this file already does.
 *
 * @param {{event: object, rawBody: string|null, civitatisSourceId: string, reasonCode: string, reasonDetail: string}} args
 *   `event` is a parsed message object (parseCivitatisEmail's own
 *   result) — ok:true or ok:false alike; only gmailMessageId is
 *   strictly required for the marker RPC's own idempotency key, so this
 *   is safe to call even for an event whose externalBookingId/eventType
 *   are null.
 */
function buildMarkNeedsReviewPayload({ event, rawBody, civitatisSourceId, reasonCode, reasonDetail }) {
  return {
    p_gmail_message_id: event.gmailMessageId,
    p_gmail_thread_id: event.gmailThreadId,
    p_received_at: event.receivedAt,
    p_raw_subject: event.rawSubject,
    p_raw_body_snapshot: rawBody == null ? null : String(rawBody),
    p_source_id: civitatisSourceId,
    p_external_booking_id: event.externalBookingId || null,
    p_event_type: event.eventType || null,
    p_reason_code: reasonCode,
    p_reason_detail: reasonDetail,
  };
}

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
 * @param {{messages: Array, repo: object, identityDecision?: {externalBookingId:string, decision:'existing_customer'|'new_customer', confirmedCustomerId:string|null}|null}} args
 *   `identityDecision`: a narrowly-scoped, EXPLICIT two-way operator
 *   decision, set ONLY by api/ingest-civitatis-write.js's
 *   identityDecisionFor/identityDecision/confirmedCustomerId request
 *   parameters (themselves gated on write=true + the manual write
 *   secret + identityDecisionFor exactly equaling the request's own
 *   externalBookingId — see that file's own doc comment). Applies
 *   ONLY to the exact-normalized-name customer match gate
 *   (POSSIBLE_EXISTING_MATCH_EXACT_NAME) for the ONE booking named by
 *   `identityDecision.externalBookingId` — never for a contact
 *   conflict, a legacy-reservation match, a parse failure, or a tour-
 *   mapping problem, all of which remain fully enforced regardless of
 *   this value, and structurally unreachable from here (each of those
 *   gates `continue`s before this gate is ever evaluated). Two
 *   supported decisions:
 *     - `'existing_customer'`: `confirmedCustomerId` MUST exactly equal
 *       one of the ids `matchCustomerByName` actually returned as a
 *       candidate for THIS booking — never an arbitrary operator-
 *       supplied id. An invalid candidate id aborts planning entirely
 *       with `{ok:false, stage:'identity_decision_invalid_candidate'}`
 *       (the HTTP layer maps this to a 400, before any write RPC).
 *       When valid, `customerId` is set to exactly that confirmed id —
 *       the existing customer is reused, never auto-merged or modified.
 *     - `'new_customer'`: `customerId` stays null, so the RPC creates a
 *       genuinely new customer from the booking's own contact fields —
 *       identical to the pre-existing "no match at all" path.
 *   Omit/null (the default, every existing caller of this function is
 *   unaffected) for every normal call: the exact-name gate then takes
 *   its original, unmodified path — ineligible, with a persisted
 *   needs_review marker (see buildMarkNeedsReviewPayload) — exactly as
 *   the V14 silent-loss fix established, with no identity assumption
 *   made either way.
 * @returns {Promise<{ok:true, civitatisSourceId:string, plans:Array} | {ok:false, error:string, stage?:string}>}
 */
async function planCivitatisIngestion({ messages, repo, identityDecision = null }) {
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

  const plans = [];
  const groups = new Map();
  for (const item of parsedEvents) {
    const bookingId = item.parsed.externalBookingId;
    if (!bookingId) {
      // A genuinely non-Civitatis-booking message (ignored, or a
      // cancellation event that slipped through) carries no eventType
      // at all — parseCivitatisEmail only ever sets eventType once a
      // message has already passed eventDetector's new_booking/
      // modified classification (see parser.js). Such a message was
      // never a booking to begin with, so it correctly leaves zero
      // trace here, exactly as before.
      //
      // A message that WAS classified new_booking/modified but still
      // has no resolvable externalBookingId (the EXTERNAL_BOOKING_ID_
      // UNRESOLVED case — e.g. the body's own stated "Reservation
      // number:" disagreeing with the subject's) cannot be grouped
      // into any booking chain (there is no booking id to group by),
      // but its gmailMessageId is always known regardless — Gmail
      // itself supplies it, independent of parsing. So this is the one
      // case persisted directly as its own single-message plan entry,
      // rather than inside a booking group.
      const isBookingShaped = item.parsed.eventType === 'new_booking' || item.parsed.eventType === 'modified';
      if (isBookingShaped) {
        const reasonDetail = (item.parsed.reasons || []).join('; ') || 'external booking id could not be resolved';
        plans.push({
          externalBookingId: null,
          eligible: false,
          reason: `EXTERNAL_BOOKING_ID_UNRESOLVED: ${reasonDetail}`,
          needsReviewMarkers: [buildMarkNeedsReviewPayload({
            event: item.parsed, rawBody: item.rawBody, civitatisSourceId: civitatisSource.id,
            reasonCode: 'EXTERNAL_BOOKING_ID_UNRESOLVED', reasonDetail,
          })],
        });
      }
      continue;
    }
    if (!groups.has(bookingId)) groups.set(bookingId, []);
    groups.get(bookingId).push(item);
  }

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
      // Every message in this chain — including one that itself parsed
      // fine — is claimed and marked needs_review, one marker call per
      // gmailMessageId. This preserves the existing, deliberate rule
      // that a chain with any parse failure is never partially written
      // through the real booking RPC (order/completeness genuinely
      // matters for a chronological sequence of events on one
      // reservation), while still ensuring every one of its Gmail
      // messages leaves a persisted, queryable trace rather than
      // silently relying on indefinite Gmail rediscovery.
      const chainReasonDetail = `booking chain contains ${failed.length} of ${items.length} unparseable event(s)`;
      plans.push({
        externalBookingId, eligible: false,
        reason: `PARSE_FAILURE_CHAIN: one or more events in this booking's chain failed to parse (NEEDS_REVIEW/PARSE_ERROR) — never written`,
        needsReviewMarkers: items.map(it => buildMarkNeedsReviewPayload({
          event: it.parsed, rawBody: it.rawBody, civitatisSourceId: civitatisSource.id,
          reasonCode: 'PARSE_FAILURE_CHAIN',
          reasonDetail: it.parsed.ok ? chainReasonDetail : `${chainReasonDetail}; this event's own parse reasons: ${(it.parsed.reasons || []).join('; ')}`,
        })),
      });
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
        const candidateIds = legacyMatch.candidates.map(r => r.id).join(', ');
        const reasonDetail = `${legacyMatch.reason} (candidate reservation id(s): ${candidateIds})`;
        plans.push({
          externalBookingId, eligible: false,
          reason: `POSSIBLE_EXISTING_MATCH (unlinked legacy reservation): ${legacyMatch.reason}`,
          needsReviewMarkers: items.map(it => buildMarkNeedsReviewPayload({
            event: it.parsed, rawBody: it.rawBody, civitatisSourceId: civitatisSource.id,
            reasonCode: 'POSSIBLE_EXISTING_MATCH_LEGACY_RESERVATION', reasonDetail,
          })),
        });
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
        const candidateIds = customerMatch.candidates.map(c => c.id).join(', ');
        const reasonDetail = `${customerMatch.reason} (candidate customer id(s): ${candidateIds})`;
        plans.push({
          externalBookingId, eligible: false,
          reason: `POSSIBLE_EXISTING_MATCH (contact conflict): ${customerMatch.reason}`,
          needsReviewMarkers: items.map(it => buildMarkNeedsReviewPayload({
            event: it.parsed, rawBody: it.rawBody, civitatisSourceId: civitatisSource.id,
            reasonCode: 'POSSIBLE_EXISTING_MATCH_CONTACT_CONFLICT', reasonDetail,
          })),
        });
        continue;
      } else if (mergedState.clientFullName) {
        const nameCandidates = await repo.findCustomersByName({ fullName: mergedState.clientFullName });
        const nameMatch = matchCustomerByName({ fullName: mergedState.clientFullName, customers: nameCandidates });
        if (nameMatch.matched) {
          const hasExplicitDecisionForThisBooking = identityDecision && identityDecision.externalBookingId === externalBookingId;

          if (!hasExplicitDecisionForThisBooking) {
            // Default, production behavior (the V14 silent-loss fix):
            // no identity assumption is ever made either way — persist
            // a retryable needs_review marker for every message in this
            // booking's chain, never auto-bind, never discard.
            const candidateIds = nameMatch.candidates.map(c => c.id).join(', ');
            const reasonDetail = `${nameMatch.reason} (candidate customer id(s): ${candidateIds})`;
            plans.push({
              externalBookingId, eligible: false,
              reason: `POSSIBLE_EXISTING_MATCH (exact normalized name): ${nameMatch.reason}`,
              needsReviewMarkers: items.map(it => buildMarkNeedsReviewPayload({
                event: it.parsed, rawBody: it.rawBody, civitatisSourceId: civitatisSource.id,
                reasonCode: 'POSSIBLE_EXISTING_MATCH_EXACT_NAME', reasonDetail,
              })),
            });
            continue;
          }

          if (identityDecision.decision === 'existing_customer') {
            // confirmedCustomerId MUST be exactly one of the candidates
            // matchCustomerByName itself just returned for THIS
            // booking's own contact name — never an arbitrary operator-
            // supplied id. An invalid candidate aborts planning
            // entirely (never a silent fallback to needs_review or an
            // unchecked bind) — the HTTP layer maps this to a 400,
            // before any write RPC is ever reached.
            const candidateIds = nameMatch.candidates.map(c => c.id);
            if (!candidateIds.includes(identityDecision.confirmedCustomerId)) {
              return {
                ok: false,
                stage: 'identity_decision_invalid_candidate',
                error: `confirmedCustomerId "${identityDecision.confirmedCustomerId}" is not among the exact-normalized-name match candidates for booking ${externalBookingId} (candidate id(s): ${candidateIds.join(', ')}).`,
              };
            }
            customerId = identityDecision.confirmedCustomerId; // reuse the operator-confirmed existing customer — never modified, never merged
          }
          // else identityDecision.decision === 'new_customer':
          // customerId stays null (unchanged) — the RPC creates a
          // genuinely new customer, identical to the pre-existing
          // "no match at all" path. Either way, fall through to the
          // normal eligible plan below — never push an ineligible
          // entry, never continue.
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
      customerId, // null means "the RPC should create one"; for an
                  // identityDecision.decision==='existing_customer'
                  // booking this is exactly the operator-confirmed
                  // candidate id set two blocks above — never any other
                  // candidate, never an arbitrary id.
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
 * `markNeedsReviewRpcCaller`, when provided, is called once per entry in
 * `entry.needsReviewMarkers` (an eligible entry never has any — see
 * planCivitatisIngestion) — in production this would call
 * supabase.rpc('mark_civitatis_email_needs_review', payload). This is
 * the ONLY place that function is ever called. When omitted (the
 * default), markers are simply not executed and `entry.markerResults`
 * is reported as an empty array for every entry — this is deliberate:
 * a read-only dry run (see api/ingest-civitatis-write.js's
 * buildDryRunResults/buildCancellationDryRunResults, which never call
 * this function at all) never reaches this code path in the first
 * place, and every existing caller of this function that does not care
 * about markers continues to work completely unchanged by simply never
 * passing one.
 *
 * @param {{ok:true, plans:Array}} plan - from planCivitatisIngestion
 * @param {(payload:object) => Promise<object>} rpcCaller
 * @param {((payload:object) => Promise<object>)|undefined} [markNeedsReviewRpcCaller]
 */
async function executeCivitatisIngestionPlan(plan, rpcCaller, markNeedsReviewRpcCaller) {
  if (!plan || plan.ok !== true) {
    throw new Error('executeCivitatisIngestionPlan requires a successful plan from planCivitatisIngestion');
  }
  if (typeof rpcCaller !== 'function') {
    throw new Error('executeCivitatisIngestionPlan requires an rpcCaller function');
  }

  const results = [];
  for (const entry of plan.plans) {
    const markerResults = [];
    if (typeof markNeedsReviewRpcCaller === 'function') {
      for (const markerPayload of (entry.needsReviewMarkers || [])) {
        const rpcResult = await markNeedsReviewRpcCaller(markerPayload);
        const resultValue = rpcResult && rpcResult.result;
        markerResults.push({
          gmailMessageId: markerPayload.p_gmail_message_id,
          reasonCode: markerPayload.p_reason_code,
          rpcResult,
          unknownResult: !KNOWN_MARK_NEEDS_REVIEW_RESULTS.has(resultValue),
        });
      }
    }
    if (!entry.eligible) {
      results.push({ externalBookingId: entry.externalBookingId, skipped: true, reason: entry.reason, markerResults });
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
    results.push({ externalBookingId: entry.externalBookingId, skipped: false, calls: callResults, stoppedEarly, markerResults });
  }
  return results;
}

module.exports = {
  buildRpcPayload,
  buildMarkNeedsReviewPayload,
  planCivitatisIngestion,
  executeCivitatisIngestionPlan,
  KNOWN_MARK_NEEDS_REVIEW_RESULTS,
};
