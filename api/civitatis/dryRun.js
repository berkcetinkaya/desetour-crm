/**
 * api/civitatis/dryRun.js
 * ─────────────────────────────────────────────────────────────────────────
 * Orchestrates the safe, read-only dry-run backfill/preview. Groups
 * already-parsed Civitatis messages by external booking ID, merges a
 * "New booking" + any later "Booking modified" events for the same
 * booking chronologically into one final intended state, matches that
 * state against the CRM (tour, customer, existing reservation), and
 * classifies the proposed outcome.
 *
 * NEVER writes anything. Every Supabase access happens through the
 * `repo` interface passed in by the caller (api/ingest-civitatis.js in
 * production, a fixture-backed fake in tests) — this module itself has
 * no import of any Supabase client, so it cannot accidentally write even
 * by mistake.
 * ─────────────────────────────────────────────────────────────────────────
 */
'use strict';

const { parseCivitatisEmail } = require('./parser');
const { matchTourChannel, matchCustomer, matchCustomerByName, findPossibleExistingReservation } = require('./matching');

/** Reduces a customer row to only the fields safe/useful to surface in a
 * dry-run report — mirrors exactly what findCustomersByContact/
 * findCustomersByName already select, so this is a rename for clarity
 * more than a redaction, but keeps the report shape stable even if the
 * repo layer ever selects additional columns in the future. */
function toSafeCustomerSummary(customer) {
  return {
    id: customer.id,
    fullName: customer.full_name || null,
    email: customer.email || null,
    phone: customer.phone || null,
  };
}

const OUTCOME = Object.freeze({
  WOULD_CREATE: 'WOULD_CREATE',
  WOULD_UPDATE: 'WOULD_UPDATE',
  ALREADY_MATCHES: 'ALREADY_MATCHES',
  POSSIBLE_EXISTING_MATCH: 'POSSIBLE_EXISTING_MATCH',
  NEEDS_REVIEW: 'NEEDS_REVIEW',
  IGNORED: 'IGNORED',
  PARSE_ERROR: 'PARSE_ERROR',
});

// Fields on `reservations` that a Civitatis email is allowed to propose a
// value for. Deliberately does NOT include guide_name, guide_id,
// internal_notes, notes, payment_status, assigned_to, pickup_location,
// pickup_time, or status — those are internal/CRM-managed and this list
// is the single place that decides what a modification chain is even
// capable of touching. computeReservationDiff below only ever looks at
// these keys, so an internal field can never appear in a diff by
// construction, not merely by convention.
const RESERVATION_DIFF_FIELDS = [
  { key: 'check_in', label: 'check_in (date)', fromState: s => s.date },
  // Postgres TIME columns round-trip through PostgREST as "HH:MM:SS" —
  // normalize both sides to "HH:MM" before comparing so a reservation
  // that already has the correct time is never flagged as changed merely
  // because of a trailing ":00" seconds component.
  { key: 'check_in_time', label: 'check_in_time', fromState: s => s.time, normalize: v => (v == null ? v : String(v).slice(0, 5)) },
  { key: 'pax_adult', label: 'pax_adult', fromState: s => s.adultCount },
  { key: 'pax_child', label: 'pax_child', fromState: s => s.childCount || 0 },
  { key: 'tour_language', label: 'tour_language', fromState: s => s.tourLanguage },
  { key: 'total_amount', label: 'total_amount (Civitatis net price)', fromState: s => s.netAmount },
  { key: 'currency', label: 'currency (net)', fromState: s => s.netCurrency },
  { key: 'retail_amount', label: 'retail_amount', fromState: s => s.retailAmount },
  { key: 'retail_currency', label: 'retail_currency', fromState: s => s.retailCurrency },
];

function valuesEqual(a, b) {
  if (a === null || a === undefined) return b === null || b === undefined;
  if (typeof a === 'number' || typeof b === 'number') return Number(a) === Number(b);
  return String(a) === String(b);
}

const identity = v => v;

/** Chronologically merges every successfully-parsed event for one booking
 * into a single final state: later non-null field values override
 * earlier ones, field by field. All fields here come from Civitatis
 * emails only — there is no CRM-only data in this merge, so no allow-
 * list is needed at this step (it is needed later, when comparing this
 * merged state against an EXISTING reservation row — see
 * RESERVATION_DIFF_FIELDS above). */
function mergeChronologicalState(events) {
  const FIELDS = [
    'activityName', 'internalCode', 'city', 'languageRaw', 'tourLanguage', 'languageCode',
    'date', 'time', 'durationRaw', 'adultCount', 'childCount', 'totalGuestCount',
    'passengers', 'retailAmount', 'retailCurrency', 'netAmount', 'netCurrency',
    'clientName', 'clientSurname', 'clientFullName', 'clientEmail', 'phones',
  ];
  const ARRAY_FIELDS = new Set(['passengers', 'phones']);
  const state = {};
  for (const field of FIELDS) state[field] = ARRAY_FIELDS.has(field) ? [] : null;
  for (const event of events) {
    for (const field of FIELDS) {
      const value = event[field];
      const isEmpty = value === null || value === undefined || (Array.isArray(value) && value.length === 0);
      if (!isEmpty) state[field] = value;
    }
  }
  return state;
}

function computeReservationDiff(existingReservation, mergedState) {
  const diff = [];
  for (const field of RESERVATION_DIFF_FIELDS) {
    const normalize = field.normalize || identity;
    const proposedRaw = field.fromState(mergedState);
    if (proposedRaw === null || proposedRaw === undefined) continue; // never propose clearing a field we have no value for
    const proposed = normalize(proposedRaw);
    const current = normalize(existingReservation[field.key]);
    if (!valuesEqual(current, proposed)) {
      diff.push({ field: field.key, label: field.label, current: current ?? null, proposed });
    }
  }
  return diff;
}

function computePassengerDiff(existingGuestNames, mergedPassengers) {
  const proposedNames = (mergedPassengers || []).map(p => p.fullName);
  const currentNames = existingGuestNames || [];
  const sameLength = proposedNames.length === currentNames.length;
  const sameSet = sameLength && proposedNames.every((n, i) => n === currentNames[i]);
  return {
    changed: !sameSet,
    current: currentNames,
    proposed: proposedNames,
  };
}

function todayIsoDate(now) {
  const d = now instanceof Date ? now : new Date();
  return d.toISOString().slice(0, 10);
}

/**
 * Builds the report entry for one external booking ID (one or more
 * chronologically-ordered events).
 */
async function buildBookingReport({ externalBookingId, events, civitatisSourceId, tourChannels, repo, now }) {
  const eventHistory = events.map(e => ({
    gmailMessageId: e.gmailMessageId,
    eventType: e.eventType || null,
    status: e.status,
    receivedAt: e.receivedAt,
    rawSubject: e.rawSubject,
    reasons: e.reasons || [],
  }));

  const failedEvents = events.filter(e => !e.ok);
  if (failedEvents.length > 0) {
    const hasParseError = failedEvents.some(e => e.status === 'parse_error');
    return {
      externalBookingId,
      outcome: hasParseError ? OUTCOME.PARSE_ERROR : OUTCOME.NEEDS_REVIEW,
      reasons: failedEvents.flatMap(e => e.reasons || []),
      eventHistory,
      mergedState: null,
      pastOrFuture: null,
      tourMatch: null,
      customerMatch: null,
      possibleExistingMatch: null,
      possibleExistingCustomerMatch: null,
      reservationDiff: null,
      passengerDiff: null,
    };
  }

  const mergedState = mergeChronologicalState(events);
  const pastOrFuture = mergedState.date ? (mergedState.date < todayIsoDate(now) ? 'past' : 'future') : null;

  const tourMatch = matchTourChannel({
    internalCode: mergedState.internalCode,
    civitatisSourceId,
    tourChannels,
  });

  if (!tourMatch.matched) {
    return {
      externalBookingId,
      outcome: OUTCOME.NEEDS_REVIEW,
      reasons: [tourMatch.reason],
      eventHistory,
      mergedState,
      pastOrFuture,
      tourMatch,
      customerMatch: null,
      possibleExistingMatch: null,
      possibleExistingCustomerMatch: null,
      reservationDiff: null,
      passengerDiff: null,
    };
  }

  // Business-identity lookup: has THIS Civitatis booking already been
  // ingested (by this dry run in an earlier logical pass, or by a prior
  // live-ingestion run) as a linked reservation?
  const existingLinked = await repo.findReservationByExternalBooking({
    sourceId: civitatisSourceId,
    externalBookingId,
  });

  if (existingLinked) {
    const existingGuestNames = await repo.getReservationGuestNames(existingLinked.id);
    const reservationDiff = computeReservationDiff(existingLinked, mergedState);
    const passengerDiff = computePassengerDiff(existingGuestNames, mergedState.passengers);
    const outcome = (reservationDiff.length === 0 && !passengerDiff.changed) ? OUTCOME.ALREADY_MATCHES : OUTCOME.WOULD_UPDATE;
    return {
      externalBookingId,
      outcome,
      reasons: [],
      eventHistory,
      mergedState,
      pastOrFuture,
      tourMatch,
      customerMatch: null,
      possibleExistingMatch: null,
      possibleExistingCustomerMatch: null,
      existingReservationId: existingLinked.id,
      reservationDiff,
      passengerDiff,
    };
  }

  // Not yet linked by business identity — before proposing a brand new
  // reservation, conservatively check whether this looks like a booking
  // that was already entered manually into the CRM (the historical-
  // backfill duplicate-protection requirement).
  const candidateReservations = await repo.findCandidateLegacyReservations({ tourId: tourMatch.tour.id });
  const legacyMatch = findPossibleExistingReservation(
    { tourId: tourMatch.tour.id, checkIn: mergedState.date, checkInTime: mergedState.time, totalGuestCount: mergedState.totalGuestCount },
    candidateReservations
  );

  if (legacyMatch.possible) {
    return {
      externalBookingId,
      outcome: OUTCOME.POSSIBLE_EXISTING_MATCH,
      reasons: [legacyMatch.reason],
      eventHistory,
      mergedState,
      pastOrFuture,
      tourMatch,
      customerMatch: null,
      possibleExistingMatch: legacyMatch.candidates,
      possibleExistingCustomerMatch: null,
      reservationDiff: null,
      passengerDiff: null,
    };
  }

  const customerCandidates = await repo.findCustomersByContact({
    email: mergedState.clientEmail,
    phone: (mergedState.phones && mergedState.phones[0]) || null,
  });
  const customerMatch = matchCustomer({
    email: mergedState.clientEmail,
    phone: (mergedState.phones && mergedState.phones[0]) || null,
    customers: customerCandidates,
  });

  // A confirmed email/phone match is authoritative and is never
  // second-guessed by a name comparison (Task 7). Only when email/phone
  // did NOT produce a confirmed match — nothing was parsed, nothing
  // matched, or email/phone pointed to two different existing customers
  // (customerMatch.conflict) — do we fall back to a conservative,
  // NAME-ONLY signal on the booking CONTACT (mergedState.clientFullName,
  // never a passenger — matchCustomerByName is only ever called with
  // that field here). A name-only result is NEVER an automatic bind:
  // it only ever produces a POSSIBLE_EXISTING_MATCH for human review,
  // surfaced separately from the existing reservation-level
  // possibleExistingMatch (a bare array, unchanged) as
  // possibleExistingCustomerMatch, to avoid breaking that existing
  // shape while still reusing the same POSSIBLE_EXISTING_MATCH outcome.
  let possibleExistingCustomerMatch = null;
  if (!customerMatch.matched) {
    if (customerMatch.conflict) {
      possibleExistingCustomerMatch = {
        matchType: 'contact_conflict',
        reason: customerMatch.reason,
        candidates: customerMatch.candidates.map(toSafeCustomerSummary),
      };
    } else if (mergedState.clientFullName) {
      const nameCandidates = await repo.findCustomersByName({ fullName: mergedState.clientFullName });
      const nameMatch = matchCustomerByName({ fullName: mergedState.clientFullName, customers: nameCandidates });
      if (nameMatch.matched) {
        possibleExistingCustomerMatch = {
          matchType: 'exact_normalized_name',
          reason: nameMatch.reason,
          candidates: nameMatch.candidates.map(toSafeCustomerSummary),
        };
      }
    }
  }

  if (possibleExistingCustomerMatch) {
    return {
      externalBookingId,
      outcome: OUTCOME.POSSIBLE_EXISTING_MATCH,
      reasons: [possibleExistingCustomerMatch.reason],
      eventHistory,
      mergedState,
      pastOrFuture,
      tourMatch,
      customerMatch,
      possibleExistingMatch: null,
      possibleExistingCustomerMatch,
      reservationDiff: null,
      passengerDiff: null,
    };
  }

  return {
    externalBookingId,
    outcome: OUTCOME.WOULD_CREATE,
    reasons: customerMatch.determined ? [] : [customerMatch.reason],
    eventHistory,
    mergedState,
    pastOrFuture,
    tourMatch,
    customerMatch,
    possibleExistingMatch: null,
    possibleExistingCustomerMatch: null,
    reservationDiff: null,
    passengerDiff: null,
    // Reported for visibility even though dry-run performs no write —
    // this is exactly the status normal reservation creation would use
    // (SupabaseReservationRepo.create always writes status:
    // 'pending_confirmation' regardless of date), never a fabricated
    // "completed" merely because the tour date is in the past.
    proposedReservationStatus: 'pending_confirmation',
  };
}

function buildStandaloneReport(parsedEvent) {
  const outcome = parsedEvent.status === 'ignored' ? OUTCOME.IGNORED
    : parsedEvent.status === 'parse_error' ? OUTCOME.PARSE_ERROR
    : OUTCOME.NEEDS_REVIEW;
  return {
    externalBookingId: parsedEvent.externalBookingId || null,
    outcome,
    reasons: parsedEvent.reasons || [],
    eventHistory: [{
      gmailMessageId: parsedEvent.gmailMessageId,
      eventType: parsedEvent.eventType || null,
      status: parsedEvent.status,
      receivedAt: parsedEvent.receivedAt,
      rawSubject: parsedEvent.rawSubject,
      reasons: parsedEvent.reasons || [],
    }],
  };
}

/**
 * Runs the full dry run over a batch of already-fetched Gmail messages.
 * Read-only: `repo` must only ever be given read methods by the caller.
 *
 * @param {Array<{from,subject,body,gmailMessageId,gmailThreadId,receivedAt}>} messages
 * @param {{
 *   getCivitatisSource: () => Promise<{id:string}|null>,
 *   getTourChannelsForSource: (sourceId:string) => Promise<Array>,
 *   findReservationByExternalBooking: (args:{sourceId,externalBookingId}) => Promise<Object|null>,
 *   getReservationGuestNames: (reservationId:string) => Promise<string[]>,
 *   findCandidateLegacyReservations: (args:{tourId:string}) => Promise<Array>,
 *   findCustomersByContact: (args:{email,phone}) => Promise<Array>,
 *   findCustomersByName: (args:{fullName:string}) => Promise<Array>,
 * }} repo
 * @param {Date} [now]
 */
async function runCivitatisDryRun({ messages, repo, now }) {
  const civitatisSource = await repo.getCivitatisSource();
  if (!civitatisSource) {
    return {
      ok: false,
      error: 'No Civitatis source found (a sources row with is_sales_channel = true and the expected slug/name). Cannot proceed — see the migration report for how this should already be configured in production.',
    };
  }

  const tourChannels = await repo.getTourChannelsForSource(civitatisSource.id);

  const seenGmailIds = new Set();
  const gmailDuplicatesSkipped = [];
  const parsedResults = [];
  for (const message of messages || []) {
    if (!message || !message.gmailMessageId) continue;
    if (seenGmailIds.has(message.gmailMessageId)) {
      gmailDuplicatesSkipped.push(message.gmailMessageId);
      continue; // idempotency: the same Gmail message is never processed twice, even within one dry-run batch
    }
    seenGmailIds.add(message.gmailMessageId);
    parsedResults.push(parseCivitatisEmail(message));
  }

  const groupable = parsedResults.filter(r => r.externalBookingId);
  const standalone = parsedResults.filter(r => !r.externalBookingId);

  const groups = new Map();
  for (const r of groupable) {
    if (!groups.has(r.externalBookingId)) groups.set(r.externalBookingId, []);
    groups.get(r.externalBookingId).push(r);
  }

  const bookings = [];
  for (const [externalBookingId, events] of groups) {
    events.sort((a, b) => new Date(a.receivedAt) - new Date(b.receivedAt));
    bookings.push(await buildBookingReport({
      externalBookingId, events, civitatisSourceId: civitatisSource.id, tourChannels, repo, now,
    }));
  }
  bookings.sort((a, b) => String(a.externalBookingId).localeCompare(String(b.externalBookingId)));

  const standaloneReports = standalone.map(buildStandaloneReport);

  const summary = { WOULD_CREATE: 0, WOULD_UPDATE: 0, ALREADY_MATCHES: 0, POSSIBLE_EXISTING_MATCH: 0, NEEDS_REVIEW: 0, IGNORED: 0, PARSE_ERROR: 0 };
  for (const b of bookings) summary[b.outcome] = (summary[b.outcome] || 0) + 1;
  for (const s of standaloneReports) summary[s.outcome] = (summary[s.outcome] || 0) + 1;

  return {
    ok: true,
    generatedAt: new Date().toISOString(),
    civitatisSourceId: civitatisSource.id,
    totalMessagesReceived: (messages || []).length,
    gmailDuplicatesSkipped,
    summary,
    bookings,
    standalone: standaloneReports,
  };
}

module.exports = {
  runCivitatisDryRun,
  mergeChronologicalState,
  computeReservationDiff,
  computePassengerDiff,
  toSafeCustomerSummary,
  OUTCOME,
  RESERVATION_DIFF_FIELDS,
};
