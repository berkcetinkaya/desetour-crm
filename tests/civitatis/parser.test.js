'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

const { parseCivitatisEmail } = require('../../api/civitatis/parser');
const F = require('./fixtures');

// 1. Italian new booking
test('parses a real-shaped Italian new-booking email completely', () => {
  const r = parseCivitatisEmail(F.italianNewBooking);
  assert.equal(r.ok, true);
  assert.equal(r.status, 'parsed');
  assert.equal(r.eventType, 'new_booking');
  assert.equal(r.externalBookingId, '41629692');
  assert.equal(r.activityName, 'Tour del Grande Bazar - Tour in italiano');
  assert.equal(r.internalCode, 'Grand Bazaar Experience');
  assert.equal(r.city, 'Istanbul');
  assert.equal(r.languageRaw, 'Italiano');
  assert.equal(r.tourLanguage, 'İtalyanca');
  assert.equal(r.date, '2026-11-02');
  assert.equal(r.time, '09:00');
  assert.equal(r.adultCount, 2);
  assert.equal(r.childCount, null);
  assert.equal(r.totalGuestCount, 2);
  assert.deepEqual(r.passengers, [
    { fullName: 'ROMANO JUS', sortOrder: 0 },
    { fullName: 'GRAZIELLA MINETTO', sortOrder: 1 },
  ]);
  // Passenger names must be stored exactly as received — never re-cased.
  assert.equal(r.passengers[0].fullName, 'ROMANO JUS');
  assert.equal(r.retailAmount, 4800);
  assert.equal(r.retailCurrency, 'TL');
  assert.equal(r.netAmount, 3600);
  assert.equal(r.netCurrency, 'TL');
  assert.equal(r.clientName, 'No Stop Viaggi Di Fam Srl');
  assert.equal(r.clientSurname, 'Neri Francesca');
  assert.equal(r.clientFullName, 'No Stop Viaggi Di Fam Srl Neri Francesca');
  assert.equal(r.gmailMessageId, 'msg-it-new-001');
  assert.equal(r.gmailThreadId, 'thread-41629692');
  assert.equal(r.rawSubject, 'New booking A41629692: Tour del Grande Bazar');
});

// 2. Italian modification
test('parses a real-shaped Italian modification email, including Duration and phones', () => {
  const r = parseCivitatisEmail(F.italianModification);
  assert.equal(r.ok, true);
  assert.equal(r.eventType, 'modified');
  assert.equal(r.externalBookingId, '41629692');
  assert.equal(r.durationRaw, '4 hours');
  assert.deepEqual(r.phones, ['3714261643', '3405557310']);
  // Modification carries the same reservation identity as the original.
  assert.equal(r.internalCode, 'Grand Bazaar Experience');
});

// 3. Spanish new booking
test('parses a real-shaped Spanish new-booking email with the Spanish language/people wording', () => {
  const r = parseCivitatisEmail(F.spanishNewBooking);
  assert.equal(r.ok, true);
  assert.equal(r.externalBookingId, '41576789');
  assert.equal(r.languageRaw, 'Español');
  assert.equal(r.tourLanguage, 'İspanyolca');
  assert.equal(r.adultCount, 2);
  assert.equal(r.date, '2026-09-26');
  assert.equal(r.time, '09:00'); // bare "Hour: 9:00", no am/pm parenthetical
  assert.deepEqual(r.passengers.map(p => p.fullName), ['David Galbarra Goñi', 'Itsaso Zalba Marcos']);
  assert.equal(r.clientFullName, 'David Galbarra Goñi');
});

// 4. Irrelevant Civitatis invoice email
test('classifies an invoice-request email as ignored, never as needs_review or parsed', () => {
  const r = parseCivitatisEmail(F.invoiceEmail);
  assert.equal(r.ok, false);
  assert.equal(r.status, 'ignored');
  assert.equal(r.externalBookingId, undefined);
});

// 5. Irrelevant marketing / account-manager email
test('classifies a marketing/"new activity available" email as ignored', () => {
  const r = parseCivitatisEmail(F.marketingEmail);
  assert.equal(r.ok, false);
  assert.equal(r.status, 'ignored');
});

// 6. Malformed / unsupported booking subject
test('classifies an unsupported-but-booking-shaped subject (e.g. a cancellation) as needs_review, not ignored and not guessed as new_booking/modified', () => {
  const r = parseCivitatisEmail(F.malformedBookingSubject);
  assert.equal(r.ok, false);
  assert.equal(r.status, 'needs_review');
  assert.equal(r.externalBookingId, '41629692');
  assert.ok(r.reasons[0].includes('does not match a currently supported pattern'));
});

// 7. Missing Internal code
test('flags a new-booking email with no Internal code as needs_review with an explicit reason', () => {
  const r = parseCivitatisEmail(F.missingInternalCode);
  assert.equal(r.ok, false);
  assert.equal(r.status, 'needs_review');
  assert.equal(r.internalCode, null);
  assert.ok(r.reasons.some(m => m.includes('Internal code')));
});

// 8. Unknown language
test('flags an unrecognized Civitatis language as needs_review rather than inventing a mapping', () => {
  const r = parseCivitatisEmail(F.unknownLanguage);
  assert.equal(r.ok, false);
  assert.equal(r.status, 'needs_review');
  assert.equal(r.tourLanguage, null);
  assert.ok(r.reasons.some(m => m.includes('unrecognized Civitatis language value "Deutsch"')));
});

// Sender validation
test('rejects a message that is not from notificaciones@civitatis.com even with a matching subject shape', () => {
  const spoofed = { ...F.italianNewBooking, from: 'Not Civitatis <notificaciones@civitatis.com.evil.example>' };
  const r = parseCivitatisEmail(spoofed);
  assert.equal(r.ok, false);
  assert.equal(r.status, 'ignored');
});

// Reservation-number cross-validation
test('flags a subject/body reservation-number mismatch as needs_review instead of trusting either value', () => {
  const tampered = {
    ...F.italianNewBooking,
    body: F.italianNewBooking.body.replace('41629692', '99999999'),
  };
  const r = parseCivitatisEmail(tampered);
  assert.equal(r.ok, false);
  assert.equal(r.status, 'needs_review');
  assert.ok(r.reasons.some(m => m.includes('mismatch')));
});

// Date/time determinism and rejection of impossible dates
test('rejects a date whose stated weekday does not match the actual weekday', () => {
  const badWeekday = { ...F.italianNewBooking, body: F.italianNewBooking.body.replace('Monday, november 2, 2026', 'Tuesday, november 2, 2026') };
  const r = parseCivitatisEmail(badWeekday);
  assert.equal(r.ok, false);
  assert.ok(r.reasons.some(m => m.includes('weekday')));
});

test('empty message body on an otherwise-valid subject is a parse_error, not needs_review', () => {
  const r = parseCivitatisEmail({ ...F.italianNewBooking, body: '   ' });
  assert.equal(r.ok, false);
  assert.equal(r.status, 'parse_error');
});
