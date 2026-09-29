'use strict';
/**
 * tests/civitatis/cancellationDetection.test.js
 * ─────────────────────────────────────────────────────────────────────────
 * Cancellation EVENT DETECTION only — sender/subject classification
 * (api/_civitatis/eventDetector.js) and parseCivitatisEmail's defense-in-
 * depth handling of a cancellation-classified message. No RPC, no
 * database, no network — pure function tests, real production subject
 * text (A38807986) used verbatim where available.
 * ─────────────────────────────────────────────────────────────────────────
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { detectCivitatisEvent, CIVITATIS_SENDER } = require('../../api/_civitatis/eventDetector');
const { parseCivitatisEmail } = require('../../api/_civitatis/parser');
const F = require('./fixtures');

// ── Valid cancellation detection, real production subject ──────────────

test('the real A38807986 cancellation subject is classified "cancelled" with the correct external booking id', () => {
  const r = detectCivitatisEvent({ from: F.FROM_CIVITATIS, subject: 'Cancellation A38807986: Visita guiada pela Istambul imprescindível' });
  assert.equal(r.classification, 'cancelled');
  assert.equal(r.externalBookingIdFromSubject, '38807986');
  assert.equal(r.reason, null);
});

test('a differently-worded but same-format cancellation subject also classifies correctly (not hardcoded to one activity name)', () => {
  const r = detectCivitatisEvent({ from: F.FROM_CIVITATIS, subject: 'Cancellation A99999999: Some Other Tour Name' });
  assert.equal(r.classification, 'cancelled');
  assert.equal(r.externalBookingIdFromSubject, '99999999');
});

// ── Exact booking ID extraction ──────────────────────────────────────────

test('the extracted booking id is exactly the digit sequence, no leading "A", no trailing punctuation', () => {
  const r = detectCivitatisEvent({ from: F.FROM_CIVITATIS, subject: 'Cancellation A38807986: Visita guiada pela Istambul imprescindível' });
  assert.equal(r.externalBookingIdFromSubject, '38807986');
  assert.doesNotMatch(r.externalBookingIdFromSubject, /[^0-9]/);
});

// ── Non-Civitatis sender rejected — authoritative sender gate ──────────

test('a non-Civitatis sender is never classified "cancelled" even with an identical-looking subject', () => {
  const r = detectCivitatisEvent({ from: F.FROM_OTHER, subject: 'Cancellation A38807986: Visita guiada pela Istambul imprescindível' });
  assert.notEqual(r.classification, 'cancelled');
  assert.equal(r.classification, 'ignored');
  assert.match(r.reason, /is not exactly/);
});

test('a spoofed display name around the real address is still accepted (matches existing sender-extraction behavior) — but a genuinely different address is not', () => {
  const spoofed = detectCivitatisEvent({ from: 'Totally Legit <notificaciones@civitatis.com>', subject: 'Cancellation A38807986: X' });
  assert.equal(spoofed.classification, 'cancelled');

  const different = detectCivitatisEvent({ from: 'Civitatis <notificaciones@civitatis-lookalike.com>', subject: 'Cancellation A38807986: X' });
  assert.notEqual(different.classification, 'cancelled');
});

// ── No fuzzy matching: the word "cancellation" alone is not authoritative

test('an email merely containing the word "cancellation" elsewhere in the subject, from the real sender, is NOT treated as a cancellation event unless the subject matches the exact anchored pattern', () => {
  const r = detectCivitatisEvent({ from: F.FROM_CIVITATIS, subject: 'Your cancellation policy has changed' });
  assert.notEqual(r.classification, 'cancelled');
});

test('"cancellation" not anchored at the start of the subject is not matched (never a substring/fuzzy match)', () => {
  const r = detectCivitatisEvent({ from: F.FROM_CIVITATIS, subject: 'Re: Cancellation A38807986: Visita guiada pela Istambul imprescindível' });
  assert.notEqual(r.classification, 'cancelled');
});

test('a genuine new_booking or modified subject is never misclassified as cancelled', () => {
  const nb = detectCivitatisEvent({ from: F.FROM_CIVITATIS, subject: 'New booking A38807986: Visita guiada pela Istambul imprescindível' });
  assert.equal(nb.classification, 'new_booking');
  const mod = detectCivitatisEvent({ from: F.FROM_CIVITATIS, subject: 'Booking A38807986 modified: Visita guiada pela Istambul imprescindível' });
  assert.equal(mod.classification, 'modified');
});

// ── Sender constant sanity (confirms this reuses the SAME authoritative
// constant the rest of the pipeline already uses, never a second one) ──

test('CIVITATIS_SENDER is the single authoritative sender address used for cancellation detection too', () => {
  assert.equal(CIVITATIS_SENDER, 'notificaciones@civitatis.com');
});

// ── parseCivitatisEmail defense-in-depth for a cancellation message ────

test('parseCivitatisEmail never treats a cancellation-classified message as a bookable new_booking/modified event', () => {
  const r = parseCivitatisEmail(F.civitatisCancellationA38807986);
  assert.equal(r.ok, false);
  assert.equal(r.status, 'cancellation_event');
  assert.equal(r.externalBookingId, '38807986');
  assert.ok(r.reasons.some(x => /cancellation/i.test(x)), JSON.stringify(r.reasons));
});

test('parseCivitatisEmail never attempts body-field extraction for a cancellation message (no Date/People/Retail/Net reasons pushed)', () => {
  const r = parseCivitatisEmail(F.civitatisCancellationA38807986);
  const reasonText = JSON.stringify(r.reasons);
  assert.doesNotMatch(reasonText, /Date:|People:|Retail price:|Net price:|Client details/);
});
