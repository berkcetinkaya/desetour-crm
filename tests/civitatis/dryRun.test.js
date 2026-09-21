'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

const { runCivitatisDryRun, OUTCOME } = require('../../api/civitatis/dryRun');
const { createFakeRepo } = require('./fakeRepo');
const F = require('./fixtures');

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

test('fails cleanly with no Civitatis source configured, rather than proceeding with a guessed one', async () => {
  const repo = createFakeRepo({ source: null });
  const report = await runCivitatisDryRun({ messages: [F.italianNewBooking], repo });
  assert.equal(report.ok, false);
  assert.ok(report.error.includes('No Civitatis source'));
});

// 9. Duplicate Gmail message ID — reprocessing the same message must be a no-op
test('skips a duplicate gmailMessageId entirely — never processed twice, never double-counted', async () => {
  const repo = createFakeRepo(baseRepoOptions());
  const report = await runCivitatisDryRun({
    messages: [F.italianNewBooking, F.duplicateOfItalianNewBooking],
    repo,
  });
  assert.equal(report.ok, true);
  assert.deepEqual(report.gmailDuplicatesSkipped, ['msg-it-new-001']);
  assert.equal(report.bookings.length, 1);
  assert.equal(report.bookings[0].eventHistory.length, 1);
});

// 10. New booking followed by a modification for the same external booking ID
// must produce ONE proposed reservation with the latest allowed values —
// never two.
test('merges a new_booking + modified pair for the same external booking ID into one WOULD_CREATE booking report', async () => {
  const repo = createFakeRepo(baseRepoOptions());
  const report = await runCivitatisDryRun({
    messages: [F.italianNewBooking, F.italianModification],
    repo,
  });
  assert.equal(report.bookings.length, 1, 'must collapse to exactly one booking, not two');
  const booking = report.bookings[0];
  assert.equal(booking.externalBookingId, '41629692');
  assert.equal(booking.eventHistory.length, 2);
  assert.equal(booking.outcome, OUTCOME.WOULD_CREATE);
  // Duration only appears on the modification email — confirms the merge
  // actually picked up the later event's field, not just the first one.
  assert.equal(booking.mergedState.durationRaw, '4 hours');
  assert.deepEqual(booking.mergedState.phones, ['3714261643', '3405557310']);
  assert.equal(booking.tourMatch.matched, true);
  assert.equal(booking.tourMatch.tour.id, 'tour-grand-bazaar');
  assert.equal(booking.proposedReservationStatus, 'pending_confirmation');
});

test('a later modification event overrides only the fields it actually provides — a field absent from the modification keeps the value from the new_booking event', async () => {
  const repo = createFakeRepo(baseRepoOptions());
  const report = await runCivitatisDryRun({ messages: [F.italianNewBooking, F.italianModification], repo });
  const booking = report.bookings[0];
  // City is only present on the new_booking body in these fixtures, and
  // is also present (unchanged) on the modification — either way it must
  // survive the merge.
  assert.equal(booking.mergedState.city, 'Istanbul');
  assert.equal(booking.mergedState.netAmount, 3600);
});

test('routes a booking to NEEDS_REVIEW as a whole when any event in its chain fails to parse, even if earlier events parsed cleanly', async () => {
  const repo = createFakeRepo(baseRepoOptions());
  const report = await runCivitatisDryRun({
    messages: [F.italianNewBooking, F.italianModification, F.malformedBookingSubject],
    repo,
  });
  assert.equal(report.bookings.length, 1);
  assert.equal(report.bookings[0].outcome, OUTCOME.NEEDS_REVIEW);
  assert.equal(report.bookings[0].mergedState, null, 'must not propose a merged state when part of the chain is unresolved');
});

test('no tour_channels match for the Internal code routes to NEEDS_REVIEW and proposes nothing', async () => {
  const repo = createFakeRepo(baseRepoOptions({ tourChannels: [] }));
  const report = await runCivitatisDryRun({ messages: [F.italianNewBooking], repo });
  const booking = report.bookings[0];
  assert.equal(booking.outcome, OUTCOME.NEEDS_REVIEW);
  assert.ok(booking.reasons[0].includes('no tour_channels row'));
});

test('an already-linked reservation with identical values reports ALREADY_MATCHES with an empty diff', async () => {
  const repo = createFakeRepo(baseRepoOptions({
    reservations: [{
      id: 'res-1', source_id: 'src-civitatis', external_booking_id: '41629692', tour_id: 'tour-grand-bazaar',
      check_in: '2026-11-02', check_in_time: '09:00:00', pax_adult: 2, pax_child: 0,
      tour_language: 'İtalyanca', total_amount: 3600, currency: 'TL', retail_amount: 4800, retail_currency: 'TL',
    }],
    reservationGuests: { 'res-1': ['ROMANO JUS', 'GRAZIELLA MINETTO'] },
  }));
  const report = await runCivitatisDryRun({ messages: [F.italianNewBooking, F.italianModification], repo });
  const booking = report.bookings[0];
  assert.equal(booking.outcome, OUTCOME.ALREADY_MATCHES);
  assert.deepEqual(booking.reservationDiff, []);
  assert.equal(booking.passengerDiff.changed, false);
});

test('an already-linked reservation with different values reports WOULD_UPDATE with an exact field-level diff, and never touches internal-only fields', async () => {
  const repo = createFakeRepo(baseRepoOptions({
    reservations: [{
      id: 'res-1', source_id: 'src-civitatis', external_booking_id: '41629692', tour_id: 'tour-grand-bazaar',
      check_in: '2026-11-01', check_in_time: '09:00:00', pax_adult: 2, pax_child: 0,
      tour_language: 'İtalyanca', total_amount: 3000, currency: 'TL', retail_amount: 4800, retail_currency: 'TL',
      // Internal/CRM-managed fields that must never appear in the diff:
      guide_name: 'Ahmet Yılmaz', internal_notes: 'VIP misafir, özel ilgi göster', status: 'confirmed',
    }],
    reservationGuests: { 'res-1': ['ROMANO JUS', 'GRAZIELLA MINETTO'] },
  }));
  const report = await runCivitatisDryRun({ messages: [F.italianNewBooking, F.italianModification], repo });
  const booking = report.bookings[0];
  assert.equal(booking.outcome, OUTCOME.WOULD_UPDATE);
  const fields = booking.reservationDiff.map(d => d.field);
  assert.ok(fields.includes('check_in'));
  assert.ok(fields.includes('total_amount'));
  assert.ok(!fields.includes('guide_name'), 'guide_name must never be proposed for update');
  assert.ok(!fields.includes('internal_notes'), 'internal_notes must never be proposed for update');
  assert.ok(!fields.includes('status'), 'status must never be proposed for update');
  const checkInDiff = booking.reservationDiff.find(d => d.field === 'check_in');
  assert.equal(checkInDiff.current, '2026-11-01');
  assert.equal(checkInDiff.proposed, '2026-11-02');
});

test('an unlinked existing reservation matching on tour+date+time+guest-count is POSSIBLE_EXISTING_MATCH, never an automatic merge', async () => {
  const repo = createFakeRepo(baseRepoOptions({
    reservations: [{
      id: 'res-legacy-1', source_id: null, external_booking_id: null, tour_id: 'tour-grand-bazaar',
      check_in: '2026-11-02', check_in_time: '09:00:00', pax_adult: 2, pax_child: 0,
    }],
  }));
  const report = await runCivitatisDryRun({ messages: [F.italianNewBooking], repo });
  const booking = report.bookings[0];
  assert.equal(booking.outcome, OUTCOME.POSSIBLE_EXISTING_MATCH);
  assert.equal(booking.possibleExistingMatch.length, 1);
  assert.equal(booking.possibleExistingMatch[0].id, 'res-legacy-1');
});

test('a legacy reservation that only matches on date (not tour+time+guests) is NOT flagged as a possible match', async () => {
  const repo = createFakeRepo(baseRepoOptions({
    reservations: [{
      id: 'res-legacy-2', source_id: null, external_booking_id: null, tour_id: 'tour-grand-bazaar',
      check_in: '2026-11-02', check_in_time: '14:00:00', pax_adult: 6, pax_child: 0, // different time & guest count
    }],
  }));
  const report = await runCivitatisDryRun({ messages: [F.italianNewBooking], repo });
  assert.equal(report.bookings[0].outcome, OUTCOME.WOULD_CREATE);
});

test('matches an existing customer by phone when one is available (from a modification), never by name alone', async () => {
  const repo = createFakeRepo(baseRepoOptions({
    customers: [{ id: 'cust-1', full_name: 'No Stop Viaggi Di Fam Srl', phone: '3714261643', email: null }],
  }));
  const report = await runCivitatisDryRun({ messages: [F.italianNewBooking, F.italianModification], repo });
  const booking = report.bookings[0];
  assert.equal(booking.customerMatch.determined, true);
  assert.equal(booking.customerMatch.matched, true);
  assert.equal(booking.customerMatch.customer.id, 'cust-1');
});

test('reports customer identity as undetermined (never guessed by name) when no email/phone was parsed', async () => {
  const repo = createFakeRepo(baseRepoOptions());
  const report = await runCivitatisDryRun({ messages: [F.italianNewBooking], repo }); // new_booking alone, no phone
  const booking = report.bookings[0];
  assert.equal(booking.outcome, OUTCOME.WOULD_CREATE);
  assert.equal(booking.customerMatch.determined, false);
});

test('a standalone ignored/needs_review message with no resolvable external booking ID is reported individually, not merged into any booking group', async () => {
  const repo = createFakeRepo(baseRepoOptions());
  const report = await runCivitatisDryRun({ messages: [F.invoiceEmail, F.marketingEmail], repo });
  assert.equal(report.bookings.length, 0);
  assert.equal(report.standalone.length, 2);
  assert.ok(report.standalone.every(s => s.outcome === OUTCOME.IGNORED));
});
