/**
 * api/_civitatis/matching.js
 * ─────────────────────────────────────────────────────────────────────────
 * Pure matching logic — tour, customer, and legacy-reservation matching —
 * operating entirely on plain data already fetched by the caller (see
 * api/_civitatis/supabaseAdmin.js for the actual Supabase reads). Nothing
 * in this file talks to Supabase, so every rule here is directly testable
 * with fixture arrays, exactly like the parser.
 *
 * Three deliberately separate, conservative matchers:
 *   - matchTourChannel: EXACT tour_channels.external_product_id match
 *     only. No fuzzy matching, no partial matching, ever.
 *   - matchCustomer: EXACT email/phone match only, mirroring the
 *     existing SupabaseCustomerRepo.findByContact OR-on-email-or-phone
 *     rule. No name-only matching, ever — real Civitatis emails do not
 *     reliably provide enough to disambiguate an agency contact from a
 *     private traveler by name alone.
 *   - findPossibleExistingReservation: requires MULTIPLE independent
 *     strong signals (tour + date + time + guest count) to agree before
 *     even proposing a candidate, and always returns a "possible" match
 *     for human confirmation — never an automatic identity decision.
 * ─────────────────────────────────────────────────────────────────────────
 */
'use strict';

/**
 * Matches a Civitatis "Internal code" to a DeseTour tour via
 * tour_channels.external_product_id, scoped to the Civitatis source_id.
 * Exact string match only — no trimming beyond what the parser already
 * did, no case-folding, no fuzzy/partial matching. Ambiguous data (more
 * than one tour_channels row claiming the same code for the same source,
 * which should never happen given tour_channels' own UNIQUE(tour_id,
 * source_id) constraint but could in principle arise from two different
 * tours both being mis-tagged with the same code) is treated as "no safe
 * match" rather than picked arbitrarily.
 *
 * @param {string|null} internalCode
 * @param {string} civitatisSourceId
 * @param {Array<{id,tour_id,source_id,external_product_id,tour:{id,name}}>} tourChannels
 */
function matchTourChannel({ internalCode, civitatisSourceId, tourChannels }) {
  if (!internalCode) {
    return { matched: false, method: 'exact_external_product_id', tour: null, tourChannelId: null, reason: 'no Internal code parsed from the email' };
  }
  const candidates = (tourChannels || []).filter(
    tc => tc.source_id === civitatisSourceId && tc.external_product_id === internalCode
  );
  if (candidates.length === 0) {
    return {
      matched: false, method: 'exact_external_product_id', tour: null, tourChannelId: null,
      reason: `no tour_channels row has external_product_id exactly "${internalCode}" for the Civitatis source — an operator must set this on the correct tour's Civitatis sales-channel row (or a new one) before this booking can be created`,
    };
  }
  if (candidates.length > 1) {
    return {
      matched: false, method: 'exact_external_product_id', tour: null, tourChannelId: null,
      reason: `${candidates.length} tour_channels rows share external_product_id "${internalCode}" for the Civitatis source — ambiguous, needs manual resolution`,
    };
  }
  return { matched: true, method: 'exact_external_product_id', tour: candidates[0].tour || null, tourChannelId: candidates[0].id };
}

/**
 * Matches the booking contact (Civitatis "Client details") to an existing
 * customer, mirroring SupabaseCustomerRepo.findByContact's exact
 * email-OR-phone rule. Returns "cannot determine" (never a guess) when
 * neither an email nor a phone was available in the parsed message —
 * which, per the real examples inspected for this integration, is the
 * common case for a "New booking" email with no Modified-information
 * phone yet. This is surfaced explicitly in the dry-run report rather
 * than silently treated as "no existing customer".
 *
 * Conflict safety: if the email matches one existing customer and the
 * phone matches a DIFFERENT existing customer, that is never silently
 * resolved by picking whichever happened to come first in the query
 * result — `conflict: true` is returned instead, with every distinct
 * customer involved, so the caller can require manual review rather
 * than guess a winner.
 *
 * @param {string|null} email
 * @param {string|null} phone
 * @param {Array<{id,full_name,email,phone}>} customers
 */
function matchCustomer({ email, phone, customers }) {
  if (!email && !phone) {
    return {
      determined: false, matched: false, conflict: false, customer: null, candidates: [],
      reason: 'no email or phone was present in the parsed email to safely match an existing customer — name-only matching is never attempted',
    };
  }
  const emailMatches = email
    ? (customers || []).filter(c => c.email && c.email.toLowerCase() === String(email).toLowerCase())
    : [];
  const phoneMatches = phone
    ? (customers || []).filter(c => c.phone && c.phone === phone)
    : [];

  const byId = new Map();
  for (const c of [...emailMatches, ...phoneMatches]) byId.set(c.id, c);
  const distinctMatches = Array.from(byId.values());

  if (distinctMatches.length === 0) {
    return {
      determined: true, matched: false, conflict: false, customer: null, candidates: [],
      reason: 'no existing customer found by email/phone — would create a new customer record',
    };
  }
  if (distinctMatches.length === 1) {
    return { determined: true, matched: true, conflict: false, customer: distinctMatches[0], candidates: distinctMatches, reason: null };
  }
  return {
    determined: true, matched: false, conflict: true, customer: null, candidates: distinctMatches,
    reason: `email and phone identify ${distinctMatches.length} different existing customers — cannot safely determine a single match automatically; requires manual confirmation`,
  };
}

/**
 * Deterministic comparison key for a customer/contact full name: trims
 * leading/trailing whitespace, collapses any run of whitespace (spaces,
 * tabs, non-breaking/Unicode spaces — \s already covers these in a JS
 * regex) to a single space, and lowercases for case-insensitive
 * comparison. Used ONLY to build a comparison key — the actual
 * stored/display name is never altered anywhere by this function.
 *
 * Deliberately does NOT: strip accents, transliterate, reorder tokens,
 * or do substring/prefix/fuzzy matching — "Jose Garcia" and
 * "José García" are intentionally NOT equal under this key, and
 * "Juan Armas" is intentionally NOT equal to "Juan Armas Puente".
 *
 * @param {string|null|undefined} name
 * @returns {string} '' if name is not a non-empty string
 */
function normalizeFullNameForComparison(name) {
  if (typeof name !== 'string') return '';
  return name.replace(/\s+/g, ' ').trim().toLowerCase();
}

/**
 * Conservative NAME-ONLY candidate search for the booking CONTACT
 * (Civitatis "Client details" — never a passenger; callers must only
 * ever pass mergedState.clientFullName here, not a passenger name).
 * Only ever intended to be called when email/phone did NOT already
 * produce a confirmed match (see dryRun.js) — a name match is NEVER by
 * itself an automatic bind, so this never returns `matched: true`
 * meaning "use this customer"; it only surfaces candidates for a human
 * to confirm. Exact normalized-name equality only — no fuzzy/substring
 * matching, ever.
 *
 * @param {string|null} fullName - the booking contact's clientFullName
 * @param {Array<{id,full_name,email,phone}>} customers - candidate pool
 *   (the caller is expected to have already narrowed this, e.g. via a
 *   database-side prefilter — this function re-verifies exact equality
 *   itself regardless, so it is correct even given an unfiltered pool)
 */
function matchCustomerByName({ fullName, customers }) {
  const key = normalizeFullNameForComparison(fullName);
  if (!key) {
    return { matched: false, candidates: [], reason: 'no booking contact full name was available to search for a possible existing customer' };
  }
  const candidates = (customers || []).filter(c => normalizeFullNameForComparison(c.full_name) === key);
  if (candidates.length === 0) {
    return { matched: false, candidates: [], reason: null };
  }
  if (candidates.length === 1) {
    return {
      matched: true, candidates,
      reason: 'an existing customer with the exact same normalized full name was found — name alone is never sufficient for an automatic match; requires manual confirmation before any write',
    };
  }
  return {
    matched: true, candidates,
    reason: `${candidates.length} existing customers share the exact same normalized full name — cannot safely select one automatically; requires manual confirmation before any write`,
  };
}

/**
 * Conservative "might this already be a manually-entered CRM reservation"
 * check for the historical backfill. Deliberately requires ALL of tour,
 * date, and time to match, AND the total guest count to match, before
 * returning any candidate at all — a single matching field (e.g. "same
 * date") is never enough on its own. Even when all of those agree, the
 * result is always POSSIBLE, never a proposed automatic merge: the
 * caller must always require human confirmation before treating it as
 * the same reservation.
 *
 * Only considers reservations with NO source_id/external_booking_id
 * already set — a reservation already linked to a Civitatis (or other)
 * booking is handled by the business-identity lookup
 * (findReservationByExternalBooking), not this heuristic.
 *
 * @param {{ tourId:string|null, checkIn:string|null, checkInTime:string|null, totalGuestCount:number|null }} parsed
 * @param {Array<{id,tour_id,check_in,check_in_time,pax_adult,pax_child,source_id,external_booking_id,customer_id}>} candidateReservations
 *   Pre-filtered by the caller to unlinked reservations (source_id IS NULL)
 *   for the matched tour_id — see supabaseAdmin.js.
 */
function findPossibleExistingReservation({ tourId, checkIn, checkInTime, totalGuestCount }, candidateReservations) {
  if (!tourId || !checkIn || !checkInTime || totalGuestCount === null || totalGuestCount === undefined) {
    return { possible: false, candidates: [], reason: 'insufficient parsed data (tour/date/time/guest count) to evaluate a legacy match' };
  }
  const matches = (candidateReservations || []).filter(r => {
    if (r.source_id || r.external_booking_id) return false; // already linked — not this heuristic's concern
    if (r.tour_id !== tourId) return false;
    if (r.check_in !== checkIn) return false;
    if ((r.check_in_time || '').slice(0, 5) !== checkInTime) return false;
    const resGuestCount = (r.pax_adult || 0) + (r.pax_child || 0);
    if (resGuestCount !== totalGuestCount) return false;
    return true;
  });
  if (matches.length === 0) {
    return { possible: false, candidates: [], reason: null };
  }
  return {
    possible: true,
    candidates: matches,
    reason: `${matches.length} existing unlinked reservation(s) match on tour + date + time + guest count — strong but not proven identity; requires manual confirmation before any write`,
  };
}

module.exports = {
  matchTourChannel,
  matchCustomer,
  matchCustomerByName,
  normalizeFullNameForComparison,
  findPossibleExistingReservation,
};
