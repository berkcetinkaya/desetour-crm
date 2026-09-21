/**
 * api/civitatis/eventDetector.js
 * ─────────────────────────────────────────────────────────────────────────
 * The gate before any body parsing happens. Decides, from sender + subject
 * alone, whether a message is:
 *   - a supported Civitatis reservation event (new_booking | modified)
 *   - clearly irrelevant (invoices, marketing, account-manager, review
 *     requests, "new activity available", etc.) -> ignored
 *   - apparently reservation-related but not in a currently supported
 *     shape (e.g. a future cancellation email) -> needs_review, never
 *     guessed into new_booking/modified
 *
 * The civitatis.com domain alone is deliberately NOT sufficient — the
 * sender must be the exact reservation-notification address.
 * ─────────────────────────────────────────────────────────────────────────
 */
'use strict';

const CIVITATIS_SENDER = 'notificaciones@civitatis.com';

const NEW_BOOKING_SUBJECT = /^New booking A(\d+):/;
const MODIFIED_SUBJECT = /^Booking A(\d+) modified:/;

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
 *   classification: 'new_booking' | 'modified' | 'ignored' | 'needs_review',
 *   externalBookingIdFromSubject: string | null,
 *   reason: string | null,
 * }}
 */
function detectCivitatisEvent({ from, subject }) {
  const senderEmail = extractEmailAddress(from);
  if (senderEmail !== CIVITATIS_SENDER) {
    return {
      classification: 'ignored',
      externalBookingIdFromSubject: null,
      reason: `sender "${senderEmail || '(none)'}" is not exactly ${CIVITATIS_SENDER}`,
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

  // Sender is genuinely Civitatis reservations, but the subject didn't
  // match either supported pattern. Distinguish "looks like a booking
  // event we don't support yet" (e.g. a future cancellation subject)
  // from "not a booking event at all" (invoice, marketing, account
  // manager, review request, "new activity available", ...).
  const shapeMatch = BOOKING_EVENT_SHAPE.exec(subjectText);
  if (shapeMatch) {
    const idToken = /A(\d+)/.exec(shapeMatch[0]);
    return {
      classification: 'needs_review',
      externalBookingIdFromSubject: idToken ? idToken[1] : null,
      reason: `subject "${subjectText}" appears reservation-related but does not match a currently supported pattern (only "New booking A########:" and "Booking A######## modified:" are supported; cancellation and other event types are not implemented yet)`,
    };
  }

  return {
    classification: 'ignored',
    externalBookingIdFromSubject: null,
    reason: `subject "${subjectText}" does not match a supported Civitatis reservation pattern and shows no reservation-related indicators`,
  };
}

module.exports = { detectCivitatisEvent, extractEmailAddress, CIVITATIS_SENDER };
