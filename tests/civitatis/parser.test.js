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

// People/guest-count without a price suffix on the same line
test('parses a bare "People: N Adulti" value with no price text attached', () => {
  const { extractGuestCounts } = require('../../api/civitatis/parser');
  assert.deepEqual(extractGuestCounts('2 Adulti'), { adultCount: 2, childCount: null });
  assert.deepEqual(extractGuestCounts('3 Adultos'), { adultCount: 3, childCount: null });
  assert.deepEqual(extractGuestCounts('2 Adulti, 1 Bambini'), { adultCount: 2, childCount: 1 });
});

// Retail / Net price parsing
test('parses Retail price and Net price money lines, comma as thousands separator', () => {
  const { parseMoneyLine } = require('../../api/civitatis/parser');
  assert.deepEqual(parseMoneyLine('4,800 TL'), { amount: 4800, currency: 'TL' });
  assert.deepEqual(parseMoneyLine('3,600 TL'), { amount: 3600, currency: 'TL' });
});

// People field vs. passenger-section count discrepancy
test('flags a People/passenger-count mismatch for review instead of silently trusting either signal', () => {
  const mismatched = {
    ...F.italianNewBooking,
    body: F.italianNewBooking.body.replace('2 Adulti x € 43.02', '3 Adulti'),
  };
  const r = parseCivitatisEmail(mismatched);
  assert.equal(r.ok, false);
  assert.equal(r.status, 'needs_review');
  assert.ok(r.reasons.some(m => m.includes('does not match the "People:" field guest count')));
});

// ── Real-formatting tolerance: indented labels, tabs, NBSP, repeated spaces ──

test('parses correctly when every label is indented (not at column zero)', () => {
  const indented = {
    ...F.italianNewBooking,
    body: F.italianNewBooking.body.split('\n').map(l => (l.trim() ? '    ' + l : l)).join('\n'),
  };
  const r = parseCivitatisEmail(indented);
  assert.equal(r.ok, true, JSON.stringify(r.reasons));
  assert.equal(r.externalBookingId, '41629692');
  assert.equal(r.city, 'Istanbul');
});

test('parses correctly when labels and values are tab-separated on the same line', () => {
  const body = `
Reservation number:\t41629692

Internal code:\t\tGrand Bazaar Experience

Language:\tItaliano

City:\tIstanbul

Date:\tMonday, november 2, 2026

Hour:\t9:00 (9:00 am)

People:\t2 Adulti

Retail price:\t4,800 TL

Net price:\t3,600 TL

Client details:
Name: Someone
Surname: Example
`;
  const r = parseCivitatisEmail({
    from: 'Civitatis <notificaciones@civitatis.com>',
    subject: 'New booking A41629692: Tour del Grande Bazar',
    body,
    gmailMessageId: 'msg-tabs-001',
    gmailThreadId: 'thread-41629692',
    receivedAt: '2026-06-01T10:00:00.000Z',
  });
  assert.equal(r.ok, true, JSON.stringify(r.reasons));
  assert.equal(r.externalBookingId, '41629692');
  assert.equal(r.internalCode, 'Grand Bazaar Experience');
});

test('parses correctly with non-breaking spaces and doubled internal spaces inside labels', () => {
  const body = [
    'Reservation  number: 41629692',
    'Internal code : Grand Bazaar Experience',
    'Language:  Italiano',
    'City:  Istanbul',
    'Date:  Monday, november 2, 2026',
    'Hour:  9:00 (9:00 am)',
    'People:  2 Adulti',
    'Retail  price:  4,800 TL',
    'Net  price:  3,600 TL',
    'Client details:',
    'Name: Someone',
    'Surname: Example',
  ].join('\n');
  const r = parseCivitatisEmail({
    from: 'Civitatis <notificaciones@civitatis.com>',
    subject: 'New booking A41629692: Tour del Grande Bazar',
    body,
    gmailMessageId: 'msg-nbsp-001',
    gmailThreadId: 'thread-41629692',
    receivedAt: '2026-06-01T10:00:00.000Z',
  });
  assert.equal(r.ok, true, JSON.stringify(r.reasons));
  assert.equal(r.externalBookingId, '41629692');
  assert.equal(r.internalCode, 'Grand Bazaar Experience');
  assert.equal(r.retailAmount, 4800);
  assert.equal(r.netAmount, 3600);
});

// ── Subject reservation-number fallback ─────────────────────────────────

test('falls back to the subject-derived reservation number when the body has no parseable "Reservation number:" field', () => {
  const noBodyReservationNumber = {
    ...F.italianNewBooking,
    body: F.italianNewBooking.body.replace('Reservation number:\n41629692\n\n', ''),
  };
  const r = parseCivitatisEmail(noBodyReservationNumber);
  assert.equal(r.ok, true, JSON.stringify(r.reasons));
  assert.equal(r.externalBookingId, '41629692');
  assert.equal(r.reservationNumberSource, 'subject_fallback');
});

test('falls back to the subject-derived reservation number on a recognized "modified" subject too', () => {
  const noBodyReservationNumber = {
    ...F.italianModification,
    body: F.italianModification.body.replace('Reservation number:\n41629692\n\n', ''),
  };
  const r = parseCivitatisEmail(noBodyReservationNumber);
  assert.equal(r.ok, true, JSON.stringify(r.reasons));
  assert.equal(r.eventType, 'modified');
  assert.equal(r.externalBookingId, '41629692');
  assert.equal(r.reservationNumberSource, 'subject_fallback');
});

test('does NOT use the subject fallback for an unrecognized/unsupported subject shape', () => {
  // malformedBookingSubject is a "Booking A######## cancelled:" subject —
  // not a recognized new_booking/modified pattern, so eventDetector
  // routes it to needs_review before parser.js's body parsing (and thus
  // the reservation-number fallback) ever runs.
  const r = parseCivitatisEmail(F.malformedBookingSubject);
  assert.equal(r.ok, false);
  assert.equal(r.status, 'needs_review');
  assert.equal(r.reservationNumberSource, undefined);
});

test('records reservationNumberSource "body" when the body value is present and agrees with the subject', () => {
  const r = parseCivitatisEmail(F.italianNewBooking);
  assert.equal(r.ok, true);
  assert.equal(r.reservationNumberSource, 'body');
});

test('a body/subject reservation-number MISMATCH is still needs_review, never silently resolved by the subject fallback', () => {
  const tampered = {
    ...F.italianNewBooking,
    body: F.italianNewBooking.body.replace('41629692', '99999999'),
  };
  const r = parseCivitatisEmail(tampered);
  assert.equal(r.ok, false);
  assert.equal(r.status, 'needs_review');
  assert.equal(r.externalBookingId, null);
});
