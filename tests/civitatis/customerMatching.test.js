'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  matchCustomer,
  matchCustomerByName,
  normalizeFullNameForComparison,
} = require('../../api/_civitatis/matching');
const { runCivitatisDryRun, OUTCOME } = require('../../api/_civitatis/dryRun');
const { createFakeRepo } = require('./fakeRepo');
const F = require('./fixtures');

// No network access, no real Gmail mailbox, no Supabase connection, no
// real customer PII anywhere in this file.

const CIVITATIS_SOURCE = { id: 'src-civitatis' };
const GRAND_BAZAAR_TOUR_CHANNEL = {
  id: 'tc-1', tour_id: 'tour-grand-bazaar', source_id: 'src-civitatis',
  external_product_id: 'Grand Bazaar Experience',
  tour: { id: 'tour-grand-bazaar', name: 'Grand Bazaar Experience' },
};

function baseRepoOptions(overrides = {}) {
  return {
    source: CIVITATIS_SOURCE,
    tourChannels: [GRAND_BAZAAR_TOUR_CHANNEL],
    reservations: [],
    reservationGuests: {},
    customers: [],
    ...overrides,
  };
}

/** Builds a minimal, parseable new-booking message with a customizable
 * Client details block (including an optional Email line, which none of
 * the shared fixtures happen to include) — needed for the email/phone
 * precedence and conflict tests below. */
function buildBookingMessage({ externalBookingId, gmailMessageId, name, surname, email, phone }) {
  const clientLines = [`Name: ${name}`, `Surname: ${surname}`];
  if (email) clientLines.push(`Email: ${email}`);
  if (phone) clientLines.push(`Phone: ${phone}`);
  return {
    from: F.FROM_CIVITATIS,
    subject: `New booking A${externalBookingId}: Tour del Grande Bazar`,
    gmailMessageId,
    gmailThreadId: `thread-${externalBookingId}`,
    receivedAt: '2026-06-01T10:00:00.000Z',
    body: `
Reservation number:
${externalBookingId}

Internal code:
Grand Bazaar Experience

Language:
Italiano

Date:
Monday, november 2, 2026

Hour:
9:00 (9:00 am)

People:
2 Adulti

Retail price:
4,800 TL

Net price:
3,600 TL

Client details:
${clientLines.join('\n')}
`,
  };
}

// ═══════════════════════════════════════════════════════════════════════
// Unit tests: api/_civitatis/matching.js
// ═══════════════════════════════════════════════════════════════════════

// 1. Exact email match remains automatic
test('matchCustomer: an exact email match is an automatic match', () => {
  const r = matchCustomer({
    email: 'contact@example.com',
    phone: null,
    customers: [{ id: 'cust-1', full_name: 'Someone Else', email: 'contact@example.com', phone: null }],
  });
  assert.equal(r.determined, true);
  assert.equal(r.matched, true);
  assert.equal(r.conflict, false);
  assert.equal(r.customer.id, 'cust-1');
});

test('matchCustomer: email comparison is case-insensitive', () => {
  const r = matchCustomer({
    email: 'Contact@Example.com',
    phone: null,
    customers: [{ id: 'cust-1', full_name: 'Someone Else', email: 'contact@example.com', phone: null }],
  });
  assert.equal(r.matched, true);
  assert.equal(r.customer.id, 'cust-1');
});

// 2. Exact normalized phone match remains automatic
test('matchCustomer: an exact phone match is an automatic match', () => {
  const r = matchCustomer({
    email: null,
    phone: '3714261643',
    customers: [{ id: 'cust-2', full_name: 'Someone Else', email: null, phone: '3714261643' }],
  });
  assert.equal(r.determined, true);
  assert.equal(r.matched, true);
  assert.equal(r.customer.id, 'cust-2');
});

// no email/phone at all
test('matchCustomer: no email or phone parsed -> undetermined, never a guess', () => {
  const r = matchCustomer({ email: null, phone: null, customers: [{ id: 'cust-1', full_name: 'X', email: null, phone: null }] });
  assert.equal(r.determined, false);
  assert.equal(r.matched, false);
});

// 14. Email and phone conflicting between two different customers -> never silently choose one
test('matchCustomer: email matching one customer and phone matching a DIFFERENT customer is a conflict, never an automatic pick', () => {
  const r = matchCustomer({
    email: 'a@example.com',
    phone: '5551234567',
    customers: [
      { id: 'cust-A', full_name: 'Customer A', email: 'a@example.com', phone: '0000000000' },
      { id: 'cust-B', full_name: 'Customer B', email: 'b@example.com', phone: '5551234567' },
    ],
  });
  assert.equal(r.determined, true);
  assert.equal(r.matched, false);
  assert.equal(r.conflict, true);
  assert.equal(r.candidates.length, 2);
  assert.ok(r.candidates.some(c => c.id === 'cust-A'));
  assert.ok(r.candidates.some(c => c.id === 'cust-B'));
});

test('matchCustomer: email and phone both pointing to the SAME customer is not a conflict', () => {
  const r = matchCustomer({
    email: 'a@example.com',
    phone: '5551234567',
    customers: [{ id: 'cust-A', full_name: 'Customer A', email: 'a@example.com', phone: '5551234567' }],
  });
  assert.equal(r.matched, true);
  assert.equal(r.conflict, false);
  assert.equal(r.customer.id, 'cust-A');
});

// normalizeFullNameForComparison
test('normalizeFullNameForComparison: case differences are considered equal', () => {
  assert.equal(
    normalizeFullNameForComparison('Juan Armas Puente'),
    normalizeFullNameForComparison('JUAN ARMAS PUENTE')
  );
});

test('normalizeFullNameForComparison: repeated internal whitespace is collapsed', () => {
  assert.equal(
    normalizeFullNameForComparison('Juan Armas Puente'),
    normalizeFullNameForComparison('Juan   Armas    Puente')
  );
});

test('normalizeFullNameForComparison: leading/trailing whitespace is trimmed', () => {
  assert.equal(
    normalizeFullNameForComparison('Juan Armas Puente'),
    normalizeFullNameForComparison('  Juan Armas Puente  ')
  );
});

test('normalizeFullNameForComparison: a different full name is never equal', () => {
  assert.notEqual(
    normalizeFullNameForComparison('Juan Armas Puente'),
    normalizeFullNameForComparison('Carlos Armas Puente')
  );
});

test('normalizeFullNameForComparison: a partial/substring name is never equal (no substring matching)', () => {
  assert.notEqual(
    normalizeFullNameForComparison('Juan Armas'),
    normalizeFullNameForComparison('Juan Armas Puente')
  );
  assert.notEqual(
    normalizeFullNameForComparison('Armas Puente'),
    normalizeFullNameForComparison('Juan Armas Puente')
  );
});

test('normalizeFullNameForComparison: accented vs. unaccented names are never equal (no accent stripping)', () => {
  assert.notEqual(
    normalizeFullNameForComparison('Jose Garcia'),
    normalizeFullNameForComparison('José García')
  );
});

// matchCustomerByName
test('matchCustomerByName: exactly one normalized-name candidate is surfaced as matched (never an automatic bind by itself)', () => {
  const r = matchCustomerByName({
    fullName: 'Juan Armas Puente',
    customers: [{ id: 'cust-1', full_name: 'JUAN   ARMAS PUENTE', email: null, phone: null }],
  });
  assert.equal(r.matched, true);
  assert.equal(r.candidates.length, 1);
  assert.equal(r.candidates[0].id, 'cust-1');
});

test('matchCustomerByName: two customers sharing the exact same normalized name are BOTH surfaced, never auto-selected', () => {
  const r = matchCustomerByName({
    fullName: 'Juan Armas Puente',
    customers: [
      { id: 'cust-1', full_name: 'Juan Armas Puente', email: null, phone: null },
      { id: 'cust-2', full_name: '  juan armas puente  ', email: null, phone: null },
    ],
  });
  assert.equal(r.matched, true);
  assert.equal(r.candidates.length, 2);
});

test('matchCustomerByName: no booking-contact full name at all -> not matched, clear reason', () => {
  const r = matchCustomerByName({ fullName: null, customers: [{ id: 'cust-1', full_name: 'Juan Armas Puente' }] });
  assert.equal(r.matched, false);
  assert.equal(r.candidates.length, 0);
  assert.ok(r.reason);
});

test('matchCustomerByName: no candidate shares the normalized name -> not matched', () => {
  const r = matchCustomerByName({
    fullName: 'Juan Armas Puente',
    customers: [{ id: 'cust-1', full_name: 'Someone Else Entirely', email: null, phone: null }],
  });
  assert.equal(r.matched, false);
  assert.equal(r.candidates.length, 0);
});

// ═══════════════════════════════════════════════════════════════════════
// Integration tests: api/_civitatis/dryRun.js (via fakeRepo)
// ═══════════════════════════════════════════════════════════════════════

// 3/4/5/6. no email/phone + exactly one exact normalized full-name
// candidate -> POSSIBLE_EXISTING_MATCH (booking contact is
// "No Stop Viaggi Di Fam Srl Neri Francesca" in F.italianNewBooking,
// which has no Email/Phone in its Client details block).
test('no email/phone + one exact normalized full-name candidate -> POSSIBLE_EXISTING_MATCH, never an automatic bind', async () => {
  const repo = createFakeRepo(baseRepoOptions({
    customers: [{ id: 'cust-1', full_name: '  no stop viaggi di fam srl   NERI FRANCESCA  ', email: null, phone: null }],
  }));
  const report = await runCivitatisDryRun({ messages: [F.italianNewBooking], repo });
  const booking = report.bookings[0];
  assert.equal(booking.outcome, OUTCOME.POSSIBLE_EXISTING_MATCH);
  assert.equal(booking.customerMatch.matched, false); // never an automatic bind
  assert.ok(booking.possibleExistingCustomerMatch);
  assert.equal(booking.possibleExistingCustomerMatch.matchType, 'exact_normalized_name');
  assert.equal(booking.possibleExistingCustomerMatch.candidates.length, 1);
  assert.equal(booking.possibleExistingCustomerMatch.candidates[0].id, 'cust-1');
  // Existing reservation-level possibleExistingMatch (a bare array) is
  // untouched/unused by this customer-level path.
  assert.equal(booking.possibleExistingMatch, null);
});

// 7. Different full name -> no candidate, WOULD_CREATE
test('a completely different existing customer name is never surfaced as a candidate -> WOULD_CREATE', async () => {
  const repo = createFakeRepo(baseRepoOptions({
    customers: [{ id: 'cust-1', full_name: 'Someone Totally Unrelated', email: null, phone: null }],
  }));
  const report = await runCivitatisDryRun({ messages: [F.italianNewBooking], repo });
  const booking = report.bookings[0];
  assert.equal(booking.outcome, OUTCOME.WOULD_CREATE);
  assert.equal(booking.possibleExistingCustomerMatch, null);
});

// 8/9/10. partial / substring / accent-different names -> no candidate
test('a partial (substring) existing customer name is never surfaced as a candidate -> WOULD_CREATE', async () => {
  const repo = createFakeRepo(baseRepoOptions({
    customers: [{ id: 'cust-1', full_name: 'No Stop Viaggi Di Fam Srl', email: null, phone: null }], // missing "Neri Francesca"
  }));
  const report = await runCivitatisDryRun({ messages: [F.italianNewBooking], repo });
  assert.equal(report.bookings[0].outcome, OUTCOME.WOULD_CREATE);
  assert.equal(report.bookings[0].possibleExistingCustomerMatch, null);
});

test('an accent-different existing customer name is never treated as equal -> WOULD_CREATE', async () => {
  const repo = createFakeRepo(baseRepoOptions({
    customers: [{ id: 'cust-1', full_name: 'David Galbárra Goñí', email: null, phone: null }], // accented differently than the fixture's "David Galbarra Goñi"
  }));
  const report = await runCivitatisDryRun({ messages: [F.spanishNewBooking], repo });
  assert.equal(report.bookings[0].outcome, OUTCOME.WOULD_CREATE);
  assert.equal(report.bookings[0].possibleExistingCustomerMatch, null);
});

// 11. Passenger name matches an existing customer but booking contact
// does not -> passenger must NOT be used for customer matching.
test('an existing customer matching a PASSENGER name (not the booking contact) is never surfaced -> WOULD_CREATE', async () => {
  // F.italianNewBooking's passengers are "ROMANO JUS" and "GRAZIELLA
  // MINETTO"; its booking contact is "No Stop Viaggi Di Fam Srl Neri
  // Francesca" — a completely different name.
  const repo = createFakeRepo(baseRepoOptions({
    customers: [{ id: 'cust-passenger', full_name: 'ROMANO JUS', email: null, phone: null }],
  }));
  const report = await runCivitatisDryRun({ messages: [F.italianNewBooking], repo });
  const booking = report.bookings[0];
  assert.equal(booking.outcome, OUTCOME.WOULD_CREATE);
  assert.equal(booking.possibleExistingCustomerMatch, null);
  // The passenger list itself is untouched and still reports the name —
  // it simply was never queried against the customers table.
  assert.ok(booking.mergedState.passengers.some(p => p.fullName === 'ROMANO JUS'));
});

// 12. Two customers with the same normalized full name -> POSSIBLE_EXISTING_MATCH with multiple candidates, no automatic selection
test('two existing customers sharing the same normalized full name -> POSSIBLE_EXISTING_MATCH with both candidates, never auto-selected', async () => {
  const repo = createFakeRepo(baseRepoOptions({
    customers: [
      { id: 'cust-1', full_name: 'No Stop Viaggi Di Fam Srl Neri Francesca', email: null, phone: null },
      { id: 'cust-2', full_name: 'no stop viaggi di fam srl neri francesca', email: null, phone: null },
    ],
  }));
  const report = await runCivitatisDryRun({ messages: [F.italianNewBooking], repo });
  const booking = report.bookings[0];
  assert.equal(booking.outcome, OUTCOME.POSSIBLE_EXISTING_MATCH);
  assert.equal(booking.possibleExistingCustomerMatch.matchType, 'exact_normalized_name');
  assert.equal(booking.possibleExistingCustomerMatch.candidates.length, 2);
  const ids = booking.possibleExistingCustomerMatch.candidates.map(c => c.id).sort();
  assert.deepEqual(ids, ['cust-1', 'cust-2']);
});

// 13. Valid email/phone match plus a totally different name -> the
// authoritative email/phone match remains selected; name is never
// consulted at all.
test('a valid email match is authoritative even when the matched customer has a completely different name', async () => {
  const message = buildBookingMessage({
    externalBookingId: '41900101', gmailMessageId: 'msg-email-precedence-001',
    name: 'Someone', surname: 'Example', email: 'contact@example.com',
  });
  const repo = createFakeRepo(baseRepoOptions({
    customers: [{ id: 'cust-real', full_name: 'A Totally Different Registered Name', email: 'contact@example.com', phone: null }],
  }));
  const report = await runCivitatisDryRun({ messages: [message], repo });
  const booking = report.bookings[0];
  assert.equal(booking.customerMatch.matched, true);
  assert.equal(booking.customerMatch.customer.id, 'cust-real');
  assert.equal(booking.possibleExistingCustomerMatch, null); // name fallback never even attempted
});

// 14 (integration). Email and phone conflicting between two different
// customers -> never silently choose one; surfaced as POSSIBLE_EXISTING_MATCH.
test('email/phone pointing to two different existing customers surfaces as POSSIBLE_EXISTING_MATCH, never an automatic pick', async () => {
  const message = buildBookingMessage({
    externalBookingId: '41900102', gmailMessageId: 'msg-conflict-001',
    name: 'Someone', surname: 'Example', email: 'a@example.com', phone: '5551234567',
  });
  const repo = createFakeRepo(baseRepoOptions({
    customers: [
      { id: 'cust-A', full_name: 'Customer A', email: 'a@example.com', phone: '0000000000' },
      { id: 'cust-B', full_name: 'Customer B', email: 'b@example.com', phone: '5551234567' },
    ],
  }));
  const report = await runCivitatisDryRun({ messages: [message], repo });
  const booking = report.bookings[0];
  assert.equal(booking.outcome, OUTCOME.POSSIBLE_EXISTING_MATCH);
  assert.equal(booking.customerMatch.conflict, true);
  assert.equal(booking.possibleExistingCustomerMatch.matchType, 'contact_conflict');
  assert.equal(booking.possibleExistingCustomerMatch.candidates.length, 2);
});

// 15. No customer candidate at all -> WOULD_CREATE
test('no email, no phone, and no name candidate at all -> WOULD_CREATE with a clear reason', async () => {
  const repo = createFakeRepo(baseRepoOptions()); // no customers
  const report = await runCivitatisDryRun({ messages: [F.italianNewBooking], repo });
  const booking = report.bookings[0];
  assert.equal(booking.outcome, OUTCOME.WOULD_CREATE);
  assert.equal(booking.possibleExistingCustomerMatch, null);
  assert.equal(booking.customerMatch.determined, false);
});

// 16/17/18. Existing reservation matching, tour matching, and new+modification
// grouping all remain unchanged by this task (regression coverage).
test('regression: an unlinked legacy reservation match (tour+date+time+guest-count) still reports POSSIBLE_EXISTING_MATCH via the ORIGINAL bare-array possibleExistingMatch field, unaffected by customer-name matching', async () => {
  const repo = createFakeRepo(baseRepoOptions({
    reservations: [{
      id: 'res-legacy-1', source_id: null, external_booking_id: null, tour_id: 'tour-grand-bazaar',
      check_in: '2026-11-02', check_in_time: '09:00:00', pax_adult: 2, pax_child: 0,
    }],
    customers: [{ id: 'cust-x', full_name: 'No Stop Viaggi Di Fam Srl Neri Francesca', email: null, phone: null }],
  }));
  const report = await runCivitatisDryRun({ messages: [F.italianNewBooking], repo });
  const booking = report.bookings[0];
  assert.equal(booking.outcome, OUTCOME.POSSIBLE_EXISTING_MATCH);
  assert.equal(booking.possibleExistingMatch.length, 1);
  assert.equal(booking.possibleExistingMatch[0].id, 'res-legacy-1');
  // Customer matching never even runs — the reservation-level heuristic
  // short-circuits first, exactly as before this task.
  assert.equal(booking.customerMatch, null);
  assert.equal(booking.possibleExistingCustomerMatch, null);
});

test('regression: tour matching (exact tour_channels.external_product_id, no fuzzy matching) is unchanged', async () => {
  const repo = createFakeRepo(baseRepoOptions({ tourChannels: [] }));
  const report = await runCivitatisDryRun({ messages: [F.italianNewBooking], repo });
  const booking = report.bookings[0];
  assert.equal(booking.outcome, OUTCOME.NEEDS_REVIEW);
  assert.equal(booking.tourMatch.matched, false);
});

test('regression: a new_booking + modification pair for the same external booking ID still merges into exactly one booking report', async () => {
  const repo = createFakeRepo(baseRepoOptions());
  const report = await runCivitatisDryRun({ messages: [F.italianNewBooking, F.italianModification], repo });
  assert.equal(report.bookings.length, 1);
  assert.equal(report.bookings[0].eventHistory.length, 2);
});
