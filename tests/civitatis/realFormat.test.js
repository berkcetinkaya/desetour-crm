'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

const { parseCivitatisEmail, extractGuestCounts, parseMoneyLine } = require('../../api/_civitatis/parser');
const { mergeChronologicalState, computeReservationDiff } = require('../../api/_civitatis/dryRun');
const F = require('./fixtures');

// No network access, no real Gmail mailbox, no Supabase connection —
// these fixtures are sanitized and modeled on the real ?debugParser=1
// output's STRUCTURE, not real customer data.

// ── A. PEOPLE: two-line value, first line is guest count, second is
// price-only and must not affect the count ─────────────────────────────
test('A: extracts guest count from the first line of a two-line PEOPLE value ("4 Adultos x US$ 49.20" / "US$ 196.80 (9,600 TL )")', () => {
  assert.deepEqual(extractGuestCounts('4 Adultos x US$ 49.20'), { adultCount: 4, childCount: null });
  // The second line is never even passed to extractGuestCounts by the
  // parser (findLabelValue only reads the first non-empty line after a
  // bare label) — confirmed end-to-end below.
});

// ── B. RETAIL PRICE / NET PRICE, no-colon bare-label form ───────────────
test('B: parses RETAIL PRICE / NET PRICE bare-label (no colon) two-field block', () => {
  assert.deepEqual(parseMoneyLine('9,600 TL'), { amount: 9600, currency: 'TL' });
  assert.deepEqual(parseMoneyLine('7,200 TL'), { amount: 7200, currency: 'TL' });
});

// ── C. RETAIL PRICE with a decimal amount and an extra non-price line
// immediately after it, which must not affect the parsed amount ────────
test('C: parses "4800.00 TL" as amount 4800, ignoring a following "(2x2400TRY)" line', () => {
  const r = parseCivitatisEmail(F.realFormatRetailWithExtraLine);
  assert.equal(r.ok, true, JSON.stringify(r.reasons));
  assert.equal(r.retailAmount, 4800);
  assert.equal(r.retailCurrency, 'TL');
  assert.equal(r.netAmount, 3600);
  assert.equal(r.netCurrency, 'TL');
});

// ── D. Repeated "PASSENGER INFORMATION N:" sections, "Full name" with
// no colon, value on the next non-empty line ────────────────────────────
test('D: parses repeated PASSENGER INFORMATION N sections with a colon-less "Full name" sub-label', () => {
  const body = `
RESERVATION NUMBER: 41900001

INTERNAL CODE: Grand Bazaar Experience

LANGUAGE: Italiano

DATE: Monday, november 2, 2026

HOUR: 9:00 (9:00 am)

PEOPLE
2 Adulti

PASSENGER INFORMATION 1:
Full name
PERSON ONE

PASSENGER INFORMATION 2:
Full name
PERSON TWO

RETAIL PRICE
4,800 TL

NET PRICE
3,600 TL

CLIENT DETAILS
NAME: Someone
SURNAME: Example
`;
  const r = parseCivitatisEmail({
    from: F.FROM_CIVITATIS,
    subject: 'New booking A41900001: Tour del Grande Bazar',
    body,
    gmailMessageId: 'msg-d-001',
    gmailThreadId: 'thread-41900001',
    receivedAt: '2026-06-01T10:00:00.000Z',
  });
  assert.equal(r.ok, true, JSON.stringify(r.reasons));
  assert.deepEqual(r.passengers.map(p => p.fullName), ['PERSON ONE', 'PERSON TWO']);
});

// ── E. CLIENT DETAILS with no colon on the header, and a "(Contact
// details)" marker stripped from the Surname value ─────────────────────
test('E: parses CLIENT DETAILS (no colon on the header) and strips the "(Contact details)" marker from Surname', () => {
  const body = `
RESERVATION NUMBER: 41900002

INTERNAL CODE: Grand Bazaar Experience

LANGUAGE: Italiano

DATE: Monday, november 2, 2026

HOUR: 9:00 (9:00 am)

PEOPLE
2 Adulti

RETAIL PRICE
4,800 TL

NET PRICE
3,600 TL

CLIENT DETAILS
NAME: Example
SURNAME: Person (Contact details)
`;
  const r = parseCivitatisEmail({
    from: F.FROM_CIVITATIS,
    subject: 'New booking A41900002: Tour del Grande Bazar',
    body,
    gmailMessageId: 'msg-e-001',
    gmailThreadId: 'thread-41900002',
    receivedAt: '2026-06-01T10:00:00.000Z',
  });
  assert.equal(r.ok, true, JSON.stringify(r.reasons));
  assert.equal(r.clientName, 'Example');
  assert.equal(r.clientSurname, 'Person'); // "(Contact details)" stripped
  assert.equal(r.clientFullName, 'Example Person');
});

// ── F. MODIFIED INFORMATION / PHONE, bare label + next-line value ──────
test('F: parses MODIFIED INFORMATION / PHONE bare-label block', () => {
  const body = `
RESERVATION NUMBER: 41900003

INTERNAL CODE: Grand Bazaar Experience

LANGUAGE: Italiano

DATE: Monday, november 2, 2026

HOUR: 9:00 (9:00 am)

PEOPLE
2 Adulti

RETAIL PRICE
4,800 TL

NET PRICE
3,600 TL

CLIENT DETAILS
NAME: Someone
SURNAME: Example

MODIFIED INFORMATION
PHONE
3714261643
`;
  const r = parseCivitatisEmail({
    from: F.FROM_CIVITATIS,
    subject: 'Booking A41900003 modified: Tour del Grande Bazar',
    body,
    gmailMessageId: 'msg-f-001',
    gmailThreadId: 'thread-41900003',
    receivedAt: '2026-06-01T10:00:00.000Z',
  });
  assert.equal(r.ok, true, JSON.stringify(r.reasons));
  assert.deepEqual(r.phones, ['3714261643']);
});

test('PHONE with a colon and inline value on the same line ("PHONE: 3714261643") is also supported', () => {
  const body = `
RESERVATION NUMBER: 41900004

INTERNAL CODE: Grand Bazaar Experience

LANGUAGE: Italiano

DATE: Monday, november 2, 2026

HOUR: 9:00 (9:00 am)

PEOPLE
2 Adulti

RETAIL PRICE
4,800 TL

NET PRICE
3,600 TL

CLIENT DETAILS
NAME: Someone
SURNAME: Example

MODIFIED INFORMATION
PHONE: 3714261643
`;
  const r = parseCivitatisEmail({
    from: F.FROM_CIVITATIS,
    subject: 'Booking A41900004 modified: Tour del Grande Bazar',
    body,
    gmailMessageId: 'msg-f-002',
    gmailThreadId: 'thread-41900004',
    receivedAt: '2026-06-01T10:00:00.000Z',
  });
  assert.equal(r.ok, true, JSON.stringify(r.reasons));
  assert.deepEqual(r.phones, ['3714261643']);
});

// ── G. Complete sanitized Spanish booking matching the real structure ──
test('G: parses a complete real-format Spanish booking end to end', () => {
  const r = parseCivitatisEmail(F.spanishRealFormatBooking);
  assert.equal(r.ok, true, JSON.stringify(r.reasons));
  assert.equal(r.status, 'parsed');
  assert.equal(r.eventType, 'new_booking');
  assert.equal(r.externalBookingId, '41659924');
  assert.equal(r.reservationNumberSource, 'body');
  assert.equal(r.city, 'Estambul');
  assert.equal(r.languageRaw, 'Español');
  assert.equal(r.internalCode, 'Grand Bazaar Experience');
  assert.equal(r.date, '2026-09-29');
  assert.equal(r.time, '09:00');
  assert.equal(r.adultCount, 4);
  assert.equal(r.totalGuestCount, 4);
  assert.deepEqual(r.passengers.map(p => p.fullName), [
    'BALUTT, ADRIANA MARIA',
    'TOME, ROSANA',
    'BENSEÑOR, MARIA ISABEL',
    'PEREZ, JUAN CARLOS',
  ]);
  // Passenger names preserved exactly — never reordered or re-cased.
  assert.equal(r.passengers[0].fullName, 'BALUTT, ADRIANA MARIA');
  assert.equal(r.retailAmount, 9600);
  assert.equal(r.retailCurrency, 'TL');
  assert.equal(r.netAmount, 7200);
  assert.equal(r.netCurrency, 'TL');
  assert.equal(r.clientName, 'Adriana Maria');
  assert.equal(r.clientSurname, 'Balutt');
  assert.equal(r.clientFullName, 'Adriana Maria Balutt');
  // Booking contact is never assumed to be passenger 1.
  assert.notEqual(r.clientFullName, r.passengers[0].fullName);
});

// ── H. Complete sanitized Italian booking matching the real structure ──
test('H: parses a complete real-format Italian booking end to end', () => {
  const r = parseCivitatisEmail(F.italianRealFormatBooking);
  assert.equal(r.ok, true, JSON.stringify(r.reasons));
  assert.equal(r.externalBookingId, '41629692');
  assert.equal(r.city, 'Istanbul');
  assert.equal(r.languageRaw, 'Italiano');
  assert.equal(r.tourLanguage, 'İtalyanca');
  assert.equal(r.internalCode, 'Grand Bazaar Experience');
  assert.equal(r.date, '2026-11-02');
  assert.equal(r.time, '09:00');
  assert.equal(r.adultCount, 2);
  assert.deepEqual(r.passengers.map(p => p.fullName), ['ROMANO JUS', 'GRAZIELLA MINETTO']);
  assert.equal(r.retailAmount, 4800);
  assert.equal(r.netAmount, 3600);
  assert.equal(r.clientName, 'No Stop Viaggi Di Fam Srl');
  assert.equal(r.clientSurname, 'Neri Francesca');
  assert.equal(r.clientFullName, 'No Stop Viaggi Di Fam Srl Neri Francesca');
});

// ── I. New booking + modification for the same external booking ID,
// real mixed structure, merged chronologically into one booking state ──
test('I: a real-format new booking followed by a modification for the same external ID merges into one intended state', () => {
  const newEvent = parseCivitatisEmail(F.italianRealFormatBooking);
  const modEvent = parseCivitatisEmail(F.italianRealFormatModification);
  assert.equal(newEvent.ok, true, JSON.stringify(newEvent.reasons));
  assert.equal(modEvent.ok, true, JSON.stringify(modEvent.reasons));
  assert.equal(newEvent.externalBookingId, modEvent.externalBookingId);

  const merged = mergeChronologicalState([newEvent, modEvent]);
  // Duration and the modification's phone only exist on the modification
  // event, but must still be present in the merged state.
  assert.equal(merged.durationRaw, '4 hours');
  assert.deepEqual(merged.phones, ['3714261643']);
  // Fields present on both events keep their (identical, in this case)
  // final value.
  assert.equal(merged.tourLanguage, 'İtalyanca');
  assert.equal(merged.date, '2026-11-02');
  assert.equal(merged.retailAmount, 4800);
  assert.deepEqual(merged.passengers.map(p => p.fullName), ['ROMANO JUS', 'GRAZIELLA MINETTO']);

  // A CRM reservation that already matches the merged state exactly
  // reports no diff — confirms the merge produced ONE coherent proposed
  // state, not two conflicting ones.
  const existingReservation = {
    check_in: '2026-11-02',
    check_in_time: '09:00:00',
    pax_adult: 2,
    pax_child: 0,
    tour_language: 'İtalyanca',
    total_amount: 3600,
    currency: 'TL',
    retail_amount: 4800,
    retail_currency: 'TL',
  };
  assert.deepEqual(computeReservationDiff(existingReservation, merged), []);
});

test('a body/subject reservation-number MISMATCH in real-format text is still needs_review, never resolved by the subject fallback', () => {
  const tampered = {
    ...F.spanishRealFormatBooking,
    body: F.spanishRealFormatBooking.body.replace('RESERVATION NUMBER: 41659924', 'RESERVATION NUMBER: 99999999'),
  };
  const r = parseCivitatisEmail(tampered);
  assert.equal(r.ok, false);
  assert.equal(r.status, 'needs_review');
  assert.equal(r.externalBookingId, null);
  assert.ok(r.reasons.some(m => m.includes('mismatch')));
});

test('tour internal code from real-format text is available for exact tour_channels matching (matching.js untouched)', () => {
  const { matchTourChannel } = require('../../api/_civitatis/matching');
  const r = parseCivitatisEmail(F.italianRealFormatBooking);
  const tourChannels = [{
    id: 'tc-1', source_id: 'civitatis-source-1', external_product_id: 'Grand Bazaar Experience',
    tour: { id: 'tour-1', name: 'Grand Bazaar Tour' },
  }];
  const match = matchTourChannel({ internalCode: r.internalCode, civitatisSourceId: 'civitatis-source-1', tourChannels });
  assert.equal(match.matched, true);
  assert.equal(match.tour.id, 'tour-1');
});

test('an unmapped internal code in real-format text yields NEEDS_REVIEW with an explicit tour-mapping reason (no fuzzy matching)', () => {
  const { matchTourChannel } = require('../../api/_civitatis/matching');
  const r = parseCivitatisEmail(F.italianRealFormatBooking);
  const tourChannels = [{ id: 'tour-2', external_product_id: 'Some Other Tour', source_id: 'civitatis-source-1' }];
  const match = matchTourChannel({ internalCode: r.internalCode, civitatisSourceId: 'civitatis-source-1', tourChannels });
  assert.equal(match.matched, false);
  assert.ok(match.reason);
});
