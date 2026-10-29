/**
 * api/_civitatis/eventDetector.js
 * ─────────────────────────────────────────────────────────────────────────
 * The gate before any body parsing happens. Decides, from sender + subject
 * alone, whether a message is:
 *   - a supported Civitatis reservation event (new_booking | modified)
 *   - a supported Civitatis client/reservation message (client_message)
 *   - clearly irrelevant (invoices, marketing, account-manager, review
 *     requests, "new activity available", etc.) -> ignored
 *   - apparently reservation-related but not in a currently supported
 *     shape (e.g. a future cancellation email) -> needs_review, never
 *     guessed into new_booking/modified
 *
 * The civitatis.com domain alone is deliberately NOT sufficient — the
 * sender must be one of the two EXACT, explicitly enumerated Civitatis
 * addresses below. Never a substring/domain check, never trust based on
 * the "From" header's display name alone (extractEmailAddress always
 * reads the real address out of "Display Name <address>", the display
 * name itself is never consulted), and never widened to any other
 * civitatis.com address without the same explicit, evidence-based
 * addition made here.
 * ─────────────────────────────────────────────────────────────────────────
 */
'use strict';

// The single historical sender address — unchanged, still the exact
// value booking/modification/cancellation detection has always trusted.
// Kept as its own export for backward compatibility (existing callers/
// tests reference it directly) — never replaced by the second address
// below, only ever ADDED to.
const CIVITATIS_SENDER = 'notificaciones@civitatis.com';

// Confirmed on real production evidence: a genuine "New client message
// about your reservation <number>" email arrives from this second,
// equally legitimate Civitatis address — a different automated sender
// for a different Civitatis email category, not a replacement for the
// one above. Both are trusted, exactly, nothing else: two entries, no
// substring match, no bare-domain match, no display-name trust.
const CIVITATIS_TRUSTED_SENDERS = Object.freeze([
  CIVITATIS_SENDER,
  'notifications@civitatis.com',
]);

function isTrustedCivitatisSender(email) {
  return CIVITATIS_TRUSTED_SENDERS.includes(email);
}

const NEW_BOOKING_SUBJECT = /^New booking A(\d+):/;
const MODIFIED_SUBJECT = /^Booking A(\d+) modified:/;
// Confirmed verbatim on real production evidence: "Cancellation A38807986:
// Visita guiada pela Istambul imprescindível". Anchored at the START of
// the subject, exactly like the two patterns above — never a substring/
// fuzzy match, and never triggered by an email merely mentioning the word
// "cancellation" elsewhere (e.g. a policy notice) or by a non-Civitatis
// sender, since the sender gate above always runs first.
const CANCELLATION_SUBJECT = /^Cancellation A(\d+):/;

// Confirmed verbatim on real production evidence: "New client message
// about your reservation 42414893". Anchored at the START of the
// subject, same discipline as the three patterns above — a bare-digit
// reservation number (no "A" prefix, unlike NEW_BOOKING_SUBJECT/
// MODIFIED_SUBJECT/CANCELLATION_SUBJECT above), matching the exact shape
// already stored in reservations.external_booking_id.
const CLIENT_MESSAGE_SUBJECT = /^New client message about your reservation\s+(\d+)/;

// A stricter "this looks structurally like a booking-event subject we
// just don't support yet" signal (e.g. a future "Booking A########
// cancelled:" email), used only to distinguish "needs_review" from
// "ignored" once the two fully-supported patterns above have already
// failed to match. Deliberately anchored at the START of the subject —
// real reservation-event subjects always lead with "New booking A#..."
// or "Booking A#...". This must NOT match something like "Invoice
// requested for booking A41629692:", where the booking reference is
// incidental to an otherwise unrelated email type (an invoice request,
// not a reservation state change) — that case belongs in "ignored", not
// "needs_review", even though it mentions a real booking ID. Never used
// to accept a message as new_booking/modified — only to decide which
// rejection bucket an unmatched message lands in.
const BOOKING_EVENT_SHAPE = /^(New booking|Booking) A\d+\b/;

/**
 * Extracts a bare email address from a "From" header value, which may be
 * either a bare address or "Display Name <address>" form.
 */
function extractEmailAddress(fromHeader) {
  if (typeof fromHeader !== 'string') return '';
  const angleMatch = /<([^>]+)>/.exec(fromHeader);
  const candidate = (angleMatch ? angleMatch[1] : fromHeader).trim();
  return candidate.toLowerCase();
}

/**
 * @param {{ from: string, subject: string }} message
 * @returns {{
 *   classification: 'new_booking' | 'modified' | 'cancelled' | 'client_message' | 'ignored' | 'needs_review',
 *   externalBookingIdFromSubject: string | null,
 *   reason: string | null,
 * }}
 */
function detectCivitatisEvent({ from, subject }) {
  const senderEmail = extractEmailAddress(from);
  if (!isTrustedCivitatisSender(senderEmail)) {
    return {
      classification: 'ignored',
      externalBookingIdFromSubject: null,
      reason: `sender "${senderEmail || '(none)'}" is not one of the exact trusted Civitatis addresses (${CIVITATIS_TRUSTED_SENDERS.join(', ')})`,
    };
  }

  const subjectText = typeof subject === 'string' ? subject.trim() : '';

  const newBookingMatch = NEW_BOOKING_SUBJECT.exec(subjectText);
  if (newBookingMatch) {
    return {
      classification: 'new_booking',
      externalBookingIdFromSubject: newBookingMatch[1],
      reason: null,
    };
  }

  const modifiedMatch = MODIFIED_SUBJECT.exec(subjectText);
  if (modifiedMatch) {
    return {
      classification: 'modified',
      externalBookingIdFromSubject: modifiedMatch[1],
      reason: null,
    };
  }

  const cancellationMatch = CANCELLATION_SUBJECT.exec(subjectText);
  if (cancellationMatch) {
    return {
      classification: 'cancelled',
      externalBookingIdFromSubject: cancellationMatch[1],
      reason: null,
    };
  }

  const clientMessageMatch = CLIENT_MESSAGE_SUBJECT.exec(subjectText);
  if (clientMessageMatch) {
    return {
      classification: 'client_message',
      externalBookingIdFromSubject: clientMessageMatch[1],
      reason: null,
    };
  }

  // Sender is genuinely Civitatis reservations, but the subject didn't
  // match any of the three supported patterns. Distinguish "looks like a
  // booking event we don't support yet" (some other, still-unimplemented
  // event type) from "not a booking event at all" (invoice, marketing,
  // account manager, review request, "new activity available", ...).
  const shapeMatch = BOOKING_EVENT_SHAPE.exec(subjectText);
  if (shapeMatch) {
    const idToken = /A(\d+)/.exec(shapeMatch[0]);
    return {
      classification: 'needs_review',
      externalBookingIdFromSubject: idToken ? idToken[1] : null,
      reason: `subject "${subjectText}" appears reservation-related but does not match a currently supported pattern (only "New booking A########:", "Booking A######## modified:", and "Cancellation A########:" are supported; other event types are not implemented yet)`,
    };
  }

  return {
    classification: 'ignored',
    externalBookingIdFromSubject: null,
    reason: `subject "${subjectText}" does not match a supported Civitatis reservation pattern and shows no reservation-related indicators`,
  };
}

module.exports = { detectCivitatisEvent, extractEmailAddress, isTrustedCivitatisSender, CIVITATIS_SENDER, CIVITATIS_TRUSTED_SENDERS };
