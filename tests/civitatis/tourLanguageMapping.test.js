'use strict';
/**
 * tests/civitatis/tourLanguageMapping.test.js
 * ─────────────────────────────────────────────────────────────────────────
 * Regression coverage for matchTourChannel's product + booking_language
 * precedence rule (see api/_civitatis/matching.js and
 * supabase_migration_tour_channels_v2_booking_language.sql): the SAME
 * Civitatis external_product_id ("Grand Bazaar Experience") must resolve
 * to DIFFERENT internal tours depending on booking language, deterministic
 * and fail-closed — never fuzzy, never a silent fallback, never a guess.
 *
 * Two layers, mirroring the existing test suite's own convention
 * (matching.js's pure functions tested directly in realFormat.test.js,
 * AND exercised end-to-end through dryRun.js/writeAdapter.js elsewhere):
 *   - Pure matchTourChannel unit tests (no repo, no parser) below.
 *   - End-to-end tests through runCivitatisDryRun and
 *     planCivitatisIngestion, using the real fixtures for the two actual
 *     production bookings this feature exists for (A41629692, A41534177 —
 *     already manually corrected in Supabase; NOT touched by anything
 *     here or by application code).
 * ─────────────────────────────────────────────────────────────────────────
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { matchTourChannel } = require('../../api/_civitatis/matching');
const { runCivitatisDryRun, OUTCOME } = require('../../api/_civitatis/dryRun');
const { planCivitatisIngestion } = require('../../api/_civitatis/writeAdapter');
const { createFakeRepo } = require('./fakeRepo');
const F = require('./fixtures');

const SOURCE_ID = 'src-civitatis';
const PRODUCT = 'Grand Bazaar Experience';

const GENERIC_ROW = {
  id: 'tc-generic', tour_id: 'tour-grand-bazaar-generic', source_id: SOURCE_ID,
  external_product_id: PRODUCT, booking_language: null,
  tour: { id: 'tour-grand-bazaar-generic', name: 'Grand Bazaar Experience' },
};
const SPANISH_ROW = {
  id: 'tc-es', tour_id: 'tour-grand-bazaar-es', source_id: SOURCE_ID,
  external_product_id: PRODUCT, booking_language: 'İspanyolca',
  tour: { id: 'tour-grand-bazaar-es', name: 'Grand Bazaar Experience (İspanyolca)' },
};
const ITALIAN_ROW = {
  id: 'tc-it', tour_id: 'tour-grand-bazaar-it', source_id: SOURCE_ID,
  external_product_id: PRODUCT, booking_language: 'İtalyanca',
  tour: { id: 'tour-grand-bazaar-it', name: 'Grand Bazaar Experience (İtalyanca)' },
};
// A second, misconfigured Italian row for the same product — the
// "duplicate language mapping" case.
const DUPLICATE_ITALIAN_ROW = {
  id: 'tc-it-2', tour_id: 'tour-grand-bazaar-it-2', source_id: SOURCE_ID,
  external_product_id: PRODUCT, booking_language: 'İtalyanca',
  tour: { id: 'tour-grand-bazaar-it-2', name: 'Grand Bazaar Experience (İtalyanca) — duplicate' },
};

// ── A. Spanish Grand Bazaar booking -> Spanish Grand Bazaar internal tour ──

test('A. Grand Bazaar Experience + İspanyolca resolves to the Spanish Grand Bazaar tour, never the Italian or generic one', () => {
  const match = matchTourChannel({
    internalCode: PRODUCT, civitatisSourceId: SOURCE_ID, bookingLanguage: 'İspanyolca',
    tourChannels: [SPANISH_ROW, ITALIAN_ROW],
  });
  assert.equal(match.matched, true);
  assert.equal(match.tour.id, 'tour-grand-bazaar-es');
  assert.equal(match.method, 'exact_external_product_id_and_language');
});

// ── B. Italian Grand Bazaar booking -> Italian Grand Bazaar internal tour ──

test('B. Grand Bazaar Experience + İtalyanca resolves to the Italian Grand Bazaar tour, never the Spanish or generic one', () => {
  const match = matchTourChannel({
    internalCode: PRODUCT, civitatisSourceId: SOURCE_ID, bookingLanguage: 'İtalyanca',
    tourChannels: [SPANISH_ROW, ITALIAN_ROW],
  });
  assert.equal(match.matched, true);
  assert.equal(match.tour.id, 'tour-grand-bazaar-it');
});

// ── C. Unknown language: product exists, but no mapping exists for it ──────

test('C. a language with no explicit mapping fails closed (needs_review), even though the product itself is configured', () => {
  const match = matchTourChannel({
    internalCode: PRODUCT, civitatisSourceId: SOURCE_ID, bookingLanguage: 'Fransızca',
    tourChannels: [SPANISH_ROW, ITALIAN_ROW],
  });
  assert.equal(match.matched, false);
  assert.match(match.reason, /no tour_channels row maps/);
  assert.match(match.reason, /Fransızca/);
});

test('C (variant). once ANY language-specific mapping exists for a product, a leftover generic row for it is NEVER used as a silent fallback for an unconfigured language', () => {
  const match = matchTourChannel({
    internalCode: PRODUCT, civitatisSourceId: SOURCE_ID, bookingLanguage: 'Portekizce',
    tourChannels: [GENERIC_ROW, ITALIAN_ROW],
  });
  assert.equal(match.matched, false, 'the generic row must not silently satisfy Portekizce just because it exists');
});

// ── D. Duplicate language mappings: ambiguous, fail closed ─────────────────

test('D. two tours both configured for Grand Bazaar Experience + İtalyanca is an ambiguous configuration — fails closed, never picks either arbitrarily', () => {
  const match = matchTourChannel({
    internalCode: PRODUCT, civitatisSourceId: SOURCE_ID, bookingLanguage: 'İtalyanca',
    tourChannels: [ITALIAN_ROW, DUPLICATE_ITALIAN_ROW],
  });
  assert.equal(match.matched, false);
  assert.match(match.reason, /ambiguous/);
});

// ── E. Unknown product: existing needs_review behavior is unchanged ────────

test('E. an unknown external_product_id still fails closed exactly as before — unaffected by language logic', () => {
  const match = matchTourChannel({
    internalCode: 'Some Other Tour', civitatisSourceId: SOURCE_ID, bookingLanguage: 'İtalyanca',
    tourChannels: [SPANISH_ROW, ITALIAN_ROW],
  });
  assert.equal(match.matched, false);
  assert.match(match.reason, /no tour_channels row has external_product_id exactly/);
});

// ── F. Backward compatibility: existing single-mapping products ────────────

test('F. a product with only a generic (no booking_language) row keeps matching exactly as before, for any language', () => {
  const forItalian = matchTourChannel({
    internalCode: PRODUCT, civitatisSourceId: SOURCE_ID, bookingLanguage: 'İtalyanca',
    tourChannels: [GENERIC_ROW],
  });
  assert.equal(forItalian.matched, true);
  assert.equal(forItalian.tour.id, 'tour-grand-bazaar-generic');
  assert.equal(forItalian.method, 'exact_external_product_id');

  const forSpanish = matchTourChannel({
    internalCode: PRODUCT, civitatisSourceId: SOURCE_ID, bookingLanguage: 'İspanyolca',
    tourChannels: [GENERIC_ROW],
  });
  assert.equal(forSpanish.matched, true);
  assert.equal(forSpanish.tour.id, 'tour-grand-bazaar-generic');
});

test('F (variant). a generic-only product still matches even when no bookingLanguage is supplied at all', () => {
  const match = matchTourChannel({ internalCode: PRODUCT, civitatisSourceId: SOURCE_ID, tourChannels: [GENERIC_ROW] });
  assert.equal(match.matched, true);
  assert.equal(match.tour.id, 'tour-grand-bazaar-generic');
});

test('F (variant). the pre-existing "more than one generic row" ambiguity is unaffected by this change', () => {
  const secondGeneric = { ...GENERIC_ROW, id: 'tc-generic-2', tour_id: 'tour-grand-bazaar-generic-2', tour: { id: 'tour-grand-bazaar-generic-2', name: 'Grand Bazaar Experience (2)' } };
  const match = matchTourChannel({ internalCode: PRODUCT, civitatisSourceId: SOURCE_ID, bookingLanguage: 'İtalyanca', tourChannels: [GENERIC_ROW, secondGeneric] });
  assert.equal(match.matched, false);
  assert.match(match.reason, /ambiguous/);
});

// ── End-to-end, via the real fixtures for the two actual production bookings ──
// A41629692 (italianNewBooking) and A41534177 (sampleSafeCreateBooking) — the
// two bookings the task states were manually corrected in Supabase already.
// Nothing here writes to or asserts about those reservation rows themselves;
// this only proves that FUTURE ingestion of a booking with this shape would
// now resolve to the correct language-specific tour.

function repoWithLanguageMappings(overrides = {}) {
  return {
    source: { id: SOURCE_ID },
    tourChannels: [SPANISH_ROW, ITALIAN_ROW],
    reservations: [],
    reservationGuests: {},
    customers: [],
    ...overrides,
  };
}

test('end-to-end (dry run): the real A41629692 Italian booking shape resolves to the Italian Grand Bazaar tour once both language mappings are configured', async () => {
  const repo = createFakeRepo(repoWithLanguageMappings());
  const report = await runCivitatisDryRun({ messages: [F.italianNewBooking], repo });
  const booking = report.bookings[0];
  assert.equal(booking.externalBookingId, '41629692');
  assert.equal(booking.tourMatch.matched, true);
  assert.equal(booking.tourMatch.tour.id, 'tour-grand-bazaar-it');
});

test('end-to-end (dry run): the real A41534177 Italian booking shape also resolves to the Italian Grand Bazaar tour', async () => {
  const repo = createFakeRepo(repoWithLanguageMappings());
  const report = await runCivitatisDryRun({ messages: [F.sampleSafeCreateBooking], repo });
  const booking = report.bookings[0];
  assert.equal(booking.externalBookingId, '41534177');
  assert.equal(booking.tourMatch.matched, true);
  assert.equal(booking.tourMatch.tour.id, 'tour-grand-bazaar-it');
});

test('end-to-end (dry run): a Spanish Grand Bazaar booking resolves to the Spanish tour, not the Italian one, once both are configured', async () => {
  const repo = createFakeRepo(repoWithLanguageMappings());
  const report = await runCivitatisDryRun({ messages: [F.spanishNewBooking], repo });
  const booking = report.bookings[0];
  assert.equal(booking.tourMatch.matched, true);
  assert.equal(booking.tourMatch.tour.id, 'tour-grand-bazaar-es');
});

test('C, end-to-end (dry run): a recognized language with NO explicit mapping (only an Italian-specific row configured) fails closed to NEEDS_REVIEW, never falls back to the Italian tour', async () => {
  const repo = createFakeRepo(repoWithLanguageMappings({ tourChannels: [ITALIAN_ROW] }));
  const report = await runCivitatisDryRun({ messages: [F.spanishNewBooking], repo });
  const booking = report.bookings[0];
  assert.equal(booking.outcome, OUTCOME.NEEDS_REVIEW);
  assert.equal(booking.tourMatch.matched, false);
  assert.match(booking.reasons[0], /İspanyolca/);
});

// ── G. Booking modification: must keep updating the SAME reservation, never duplicate ──

test('G. a new_booking + modification pair for the SAME external booking ID both resolve to the SAME (language-specific) tour and plan as ONE booking, two ordered calls', async () => {
  const repo = createFakeRepo(repoWithLanguageMappings());
  const plan = await planCivitatisIngestion({ messages: [F.italianNewBooking, F.italianModification], repo });
  assert.equal(plan.ok, true);
  assert.equal(plan.plans.length, 1, 'must plan exactly one booking, never two, regardless of tour-mapping changes');
  const entry = plan.plans[0];
  assert.equal(entry.eligible, true);
  assert.equal(entry.tourId, 'tour-grand-bazaar-it');
  assert.equal(entry.calls.length, 2);
  assert.equal(entry.calls[0].p_tour_id, 'tour-grand-bazaar-it');
  assert.equal(entry.calls[1].p_tour_id, 'tour-grand-bazaar-it');
  assert.equal(entry.calls[0].p_event_type, 'new_booking');
  assert.equal(entry.calls[1].p_event_type, 'modified');
});

test('G (existing-linked). a modification for a booking already linked to a reservation is still eligible (update path) with the same resolved tourId — the RPC itself never rewrites tour_id on update, so this can never revert or duplicate the earlier manual correction', async () => {
  const repo = createFakeRepo(repoWithLanguageMappings({
    reservations: [{ id: 'res-1', source_id: SOURCE_ID, external_booking_id: '41629692', tour_id: 'tour-grand-bazaar-it', customer_id: 'cust-1' }],
  }));
  const plan = await planCivitatisIngestion({ messages: [F.italianModification], repo });
  assert.equal(plan.plans.length, 1);
  assert.equal(plan.plans[0].eligible, true);
  assert.equal(plan.plans[0].tourId, 'tour-grand-bazaar-it');
});

// ── Reusable platform architecture: never hardcoded to one product/tour ────

test('matchTourChannel is fully data-driven — no hardcoded product/tour/language string ever appears in a comparison, only in explanatory comments (the same logic must work unmodified for French, Portuguese, English, or any future language)', () => {
  const matchingSource = fs.readFileSync(path.join(__dirname, '..', '..', 'api', '_civitatis', 'matching.js'), 'utf8');
  // Strip comment lines (this file's own doc comments illustrate the rule
  // with the real "Grand Bazaar" example, same as this test file does) —
  // what must never exist is a LITERAL VALUE in the executable logic.
  const codeOnly = matchingSource.split('\n').filter(line => !/^\s*(\/\/|\*|\/\*)/.test(line)).join('\n');
  assert.doesNotMatch(codeOnly, /['"]Grand Bazaar/i);
  assert.doesNotMatch(codeOnly, /['"](İtalyanca|İspanyolca|Italiano|Español)['"]/);
  // Every comparison against booking_language/bookingLanguage must be
  // between two variables/params, never a hardcoded language literal.
  assert.doesNotMatch(codeOnly, /booking_language\s*===\s*['"]/);
});

test('the migration adds only a generic, reusable column — no data row (product- or language-specific or otherwise) is created by the migration itself', () => {
  const migrationSource = fs.readFileSync(
    path.join(__dirname, '..', '..', 'supabase_migration_tour_channels_v2_booking_language.sql'), 'utf8'
  );
  assert.doesNotMatch(migrationSource, /INSERT INTO/i);
});
