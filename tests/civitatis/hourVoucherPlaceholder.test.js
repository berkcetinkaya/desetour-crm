'use strict';
/**
 * tests/civitatis/hourVoucherPlaceholder.test.js
 * ─────────────────────────────────────────────────────────────────────────
 * Regression coverage for a second, distinct "no fixed structured
 * check-in time" case, confirmed on real production booking A40466869
 * ("Estambul Historica", Português): the Hour field is PRESENT (not
 * absent, the case V11/the parser's dac5e9c commit already handled) but
 * holds Civitatis's own placeholder sentence "See more information in
 * the voucher" instead of a clock time. Semantically identical to an
 * absent Hour field — this is now recognized as a WHITELISTED, exact
 * (whitespace/case-normalized) match against that one known sentence,
 * never a generic "any unrecognized Hour prose means no time" rule.
 *
 * This same family (A38807986, A39762643, A39984703, A40446421,
 * A40466869) was previously stuck at NEEDS_REVIEW/PARSE_ERROR at the
 * planning stage for exactly this reason.
 * ─────────────────────────────────────────────────────────────────────────
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { parseCivitatisEmail } = require('../../api/_civitatis/parser');
const { planCivitatisIngestion } = require('../../api/_civitatis/writeAdapter');
const { createFakeRepo } = require('./fakeRepo');
const F = require('./fixtures');

const CIVITATIS_SOURCE = { id: 'src-civitatis' };

function baseMessage(overrides = {}) {
  return {
    from: F.FROM_CIVITATIS,
    subject: 'New booking A40999999: Estambul Historica',
    gmailMessageId: 'm-hour-test',
    gmailThreadId: 't-40999999',
    receivedAt: '2026-07-01T10:00:00.000Z',
    ...overrides,
  };
}

function bodyWithHour(hourLine) {
  const hourSection = hourLine ? `${hourLine}\n` : '';
  return `Activity: Visita guiada pela Istambul imprescindível
Reservation number: 40999999
City: Istanbul
Language: Português
Internal code: Estambul Historica
Date: Sunday, july 5, 2026
${hourSection}People: 1 Adults
Passenger information 1:
Name
TEST
Last Name
PASSENGER
Retail price: €683.30
Net price: €512.48
Client details
Name: Test
Surname: Contact
Email: test.contact@example.com`;
}

// ── 1. Exact placeholder ────────────────────────────────────────────────

test('Hour: See more information in the voucher -> check_in_time NULL, timeStatus absent, ok:true, no reason pushed', () => {
  const r = parseCivitatisEmail(baseMessage({ body: bodyWithHour('Hour: See more information in the voucher') }));
  assert.equal(r.ok, true, JSON.stringify(r.reasons));
  assert.equal(r.time, null);
  assert.equal(r.timeStatus, 'absent');
  assert.doesNotMatch(JSON.stringify(r.reasons), /voucher|hour/i);
});

test('the real A40466869 fixture (verbatim Activity/Language/Internal code/Hour/People/Retail/Net) parses ok:true with time NULL', () => {
  const r = parseCivitatisEmail(F.portugueseA40466869HourPlaceholderBooking);
  assert.equal(r.ok, true, JSON.stringify(r.reasons));
  assert.equal(r.externalBookingId, '40466869');
  assert.equal(r.internalCode, 'Estambul Historica');
  assert.equal(r.tourLanguage, 'Portekizce');
  assert.equal(r.time, null);
  assert.equal(r.timeStatus, 'absent');
  assert.equal(r.adultCount, 5);
  assert.equal(r.retailAmount, 683.30);
  assert.equal(r.retailCurrency, 'EUR');
  assert.equal(r.netAmount, 512.48);
  assert.equal(r.netCurrency, 'EUR');
});

// ── 2. Case / whitespace normalization ──────────────────────────────────

test('the placeholder match is case-insensitive', () => {
  const r = parseCivitatisEmail(baseMessage({ body: bodyWithHour('Hour: SEE MORE INFORMATION IN THE VOUCHER') }));
  assert.equal(r.ok, true, JSON.stringify(r.reasons));
  assert.equal(r.time, null);
  assert.equal(r.timeStatus, 'absent');
});

test('the placeholder match tolerates surrounding/collapsed internal whitespace', () => {
  const r = parseCivitatisEmail(baseMessage({ body: bodyWithHour('Hour:   See  more   information   in   the   voucher  ') }));
  assert.equal(r.ok, true, JSON.stringify(r.reasons));
  assert.equal(r.time, null);
  assert.equal(r.timeStatus, 'absent');
});

// ── 3. Absent Hour remains NULL (pre-existing behavior, unchanged) ─────

test('absent Hour field still parses to time:null, timeStatus:absent (unchanged)', () => {
  const r = parseCivitatisEmail(baseMessage({ body: bodyWithHour('') }));
  assert.equal(r.ok, true, JSON.stringify(r.reasons));
  assert.equal(r.time, null);
  assert.equal(r.timeStatus, 'absent');
});

// ── 4/5. Valid structured times still work unchanged ────────────────────

test('Hour: 09:00 still parses to the exact HH:MM, timeStatus:parsed (unchanged)', () => {
  const r = parseCivitatisEmail(baseMessage({ body: bodyWithHour('Hour: 09:00') }));
  assert.equal(r.ok, true, JSON.stringify(r.reasons));
  assert.equal(r.time, '09:00');
  assert.equal(r.timeStatus, 'parsed');
});

test('Hour: 09:00 (9:00 am) still parses to the exact HH:MM, timeStatus:parsed (unchanged)', () => {
  const r = parseCivitatisEmail(baseMessage({ body: bodyWithHour('Hour: 09:00 (9:00 am)') }));
  assert.equal(r.ok, true, JSON.stringify(r.reasons));
  assert.equal(r.time, '09:00');
  assert.equal(r.timeStatus, 'parsed');
});

test('existing real Italian fixture with a valid Hour is completely unaffected', () => {
  const r = parseCivitatisEmail(F.italianNewBooking);
  assert.equal(r.ok, true, JSON.stringify(r.reasons));
  assert.equal(r.timeStatus, 'parsed');
  assert.ok(r.time, 'expected a real parsed time, unchanged from before this fix');
});

// ── 6. Arbitrary unknown Hour prose still fails closed ──────────────────

test('an arbitrary unrecognized Hour value (NOT the whitelisted placeholder) still fails closed: ok:false, needs_review, timeStatus:invalid', () => {
  const r = parseCivitatisEmail(baseMessage({ body: bodyWithHour('Hour: Please contact the guide on arrival') }));
  assert.equal(r.ok, false);
  assert.equal(r.status, 'needs_review');
  assert.equal(r.time, null);
  assert.equal(r.timeStatus, 'invalid');
  assert.ok(r.reasons.some(x => /does not match a recognized pattern/i.test(x)), JSON.stringify(r.reasons));
});

test('a near-miss of the placeholder (extra/different words) is NOT whitelisted — still fails closed, proving this is an exact match, not a fuzzy/keyword rule', () => {
  const r = parseCivitatisEmail(baseMessage({ body: bodyWithHour('Hour: See more information in the voucher attached to your email') }));
  assert.equal(r.ok, false);
  assert.equal(r.timeStatus, 'invalid');
  assert.ok(r.reasons.some(x => /does not match a recognized pattern/i.test(x)), JSON.stringify(r.reasons));
});

test('"voucher" alone, or other voucher-adjacent phrasing, is NOT whitelisted — only the exact known sentence is', () => {
  const r = parseCivitatisEmail(baseMessage({ body: bodyWithHour('Hour: Check the voucher') }));
  assert.equal(r.ok, false);
  assert.equal(r.timeStatus, 'invalid');
});

// ── 7. No time extraction from pickup/free text anywhere else ──────────

test('a clock-like string appearing in unrelated free text (never under the structured Hour label) never becomes check_in_time', () => {
  // "09:00" appears inside the Activity description text itself, NOT as
  // a Hour: field value — must never be picked up as a check-in time.
  const body = `Activity: Meet your guide at 09:00 near the entrance
Reservation number: 40999999
City: Istanbul
Language: Português
Internal code: Estambul Historica
Date: Sunday, july 5, 2026
Hour: See more information in the voucher
People: 1 Adults
Passenger information 1:
Name
TEST
Last Name
PASSENGER
Retail price: €683.30
Net price: €512.48
Client details
Name: Test
Surname: Contact
Email: test.contact@example.com`;
  const r = parseCivitatisEmail(baseMessage({ body }));
  assert.equal(r.ok, true, JSON.stringify(r.reasons));
  assert.equal(r.time, null, 'a time-like string in the Activity/description text must never become check_in_time');
  assert.equal(r.timeStatus, 'absent');
});

test('the Hour value is read ONLY via the structured "Hour:" label (findLabelValue), never scanned from surrounding prose', () => {
  const fs = require('fs');
  const path = require('path');
  const SOURCE = fs.readFileSync(path.join(__dirname, '..', '..', 'api', '_civitatis', 'parser.js'), 'utf8');
  assert.match(SOURCE, /const hourRaw = findLabelValue\(lines, LABEL_NAMES\.HOUR\);/);
  // The placeholder comparison operates on hourRaw alone — never on the
  // full `lines`/body text.
  const idx = SOURCE.indexOf('HOUR_NO_FIXED_TIME_PLACEHOLDER', SOURCE.indexOf('let time = null;'));
  const nearby = SOURCE.slice(SOURCE.lastIndexOf('if (hourRaw)', idx), idx + 40);
  assert.match(nearby, /hourRaw\.trim\(\)/);
});

// ── 8. Portuguese booking with this placeholder reaches the planning
// stage successfully (eligible:true) ────────────────────────────────────

test('A40466869-shaped booking with the Hour placeholder is ELIGIBLE at the planning stage (not filtered out as a parse failure)', async () => {
  const repo = createFakeRepo({ source: CIVITATIS_SOURCE, tourChannels: [] }); // no existing mapping for Estambul Historica
  const plan = await planCivitatisIngestion({ messages: [F.portugueseA40466869HourPlaceholderBooking], repo });
  assert.equal(plan.ok, true);
  assert.equal(plan.plans.length, 1);
  assert.equal(plan.plans[0].eligible, true, JSON.stringify(plan.plans[0]));
  assert.equal(plan.plans[0].externalBookingId, '40466869');
});

test('item 9: once parsing succeeds, the SAME existing V12 auto-provisioning decision (tourId:null, autoProvisionTour:true) applies automatically — no additional RPC/provisioning change needed', async () => {
  const repo = createFakeRepo({ source: CIVITATIS_SOURCE, tourChannels: [] });
  const plan = await planCivitatisIngestion({ messages: [F.portugueseA40466869HourPlaceholderBooking], repo });
  const entry = plan.plans[0];
  assert.equal(entry.eligible, true);
  assert.equal(entry.tourId, null, 'no existing mapping for "Estambul Historica" / Portekizce yet — genuinely unmapped');
  assert.equal(entry.autoProvisionTour, true, 'the existing (untouched) auto-provisioning decision table already marks a wholly-unmapped product as provisionable');
});

test('a SECOND booking for the SAME (Estambul Historica, Portekizce) identity, once a mapping already exists, resolves to the existing tour instead of re-provisioning', async () => {
  const existingChannel = {
    id: 'tc-estambul', tour_id: 'tour-estambul-historica', source_id: 'src-civitatis',
    external_product_id: 'Estambul Historica', booking_language: 'Portekizce',
    tour: { id: 'tour-estambul-historica', name: 'Estambul Historica' },
  };
  const repo = createFakeRepo({ source: CIVITATIS_SOURCE, tourChannels: [existingChannel] });
  const plan = await planCivitatisIngestion({ messages: [F.portugueseA40466869HourPlaceholderBooking], repo });
  const entry = plan.plans[0];
  assert.equal(entry.eligible, true);
  assert.equal(entry.tourId, 'tour-estambul-historica');
  assert.equal(entry.autoProvisionTour, false, 'an already-mapped product/language must never re-provision');
});

// ── Whitelist discipline: the constant itself, and that it is the ONLY
// new comparison introduced ─────────────────────────────────────────────

test('the whitelist constant is exactly the one known Civitatis sentence, lowercase (comparison site lowercases hourRaw before comparing)', () => {
  const fs = require('fs');
  const path = require('path');
  const SOURCE = fs.readFileSync(path.join(__dirname, '..', '..', 'api', '_civitatis', 'parser.js'), 'utf8');
  assert.match(SOURCE, /const HOUR_NO_FIXED_TIME_PLACEHOLDER = 'see more information in the voucher';/);
  // Exactly one comparison site references it (no scattered duplicate
  // whitelist logic).
  const occurrences = (SOURCE.match(/HOUR_NO_FIXED_TIME_PLACEHOLDER/g) || []).length;
  assert.equal(occurrences, 2, 'expected exactly one declaration + one usage site'); // declaration + comparison
});

test('parseCivitatisTime itself (dateParser.js) is untouched — the whitelist lives in parser.js only, never inside the generic time-grammar function', () => {
  const fs = require('fs');
  const path = require('path');
  const SOURCE = fs.readFileSync(path.join(__dirname, '..', '..', 'api', '_civitatis', 'dateParser.js'), 'utf8');
  assert.doesNotMatch(SOURCE, /voucher/i);
  assert.doesNotMatch(SOURCE, /HOUR_NO_FIXED_TIME_PLACEHOLDER/);
});
