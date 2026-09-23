'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { extractTestableFn } = require('./extractTestableFn');

const selectReviewableReservations = extractTestableFn('selectReviewableReservations');
const formatGuideReviewReservationOption = extractTestableFn('formatGuideReviewReservationOption');

const GUIDE_ID = 'guide-1';
const TODAY_ISO = '2026-09-15';

function res(overrides) {
  return {
    id: 'r-' + Math.random().toString(36).slice(2),
    resNumber: 'R-2026-0001',
    name: 'Jane Doe',
    tour: 'Grand Bazaar Experience',
    date: '10 Eyl 2026',
    checkIn: '2026-09-10',
    tourLanguage: 'İngilizce',
    guideId: null,
    assignedGuideName: '',
    opStatus: 'Onaylandı',
    ...overrides,
  };
}

// This is the exact regression the previous (too-restrictive) picker
// caused: real, currently active reservations — e.g. a Grand Bazaar
// Experience booked for a future date — must always appear.

// A future Grand Bazaar reservation appears.
test('a future Grand Bazaar reservation (not completed, not past) appears', () => {
  const r = res({ tour: 'Grand Bazaar Experience', opStatus: 'Onaylandı', checkIn: '2026-10-06' });
  const out = selectReviewableReservations([r]);
  assert.equal(out.length, 1);
  assert.equal(out[0].id, r.id);
});

// A past reservation appears.
test('a past reservation appears', () => {
  const r = res({ opStatus: 'Tamamlandı', checkIn: '2026-08-01' });
  const out = selectReviewableReservations([r]);
  assert.equal(out.length, 1);
});

// An unassigned reservation (guide_id null) appears.
test('an unassigned reservation (guide_id null) appears', () => {
  const r = res({ guideId: null });
  const out = selectReviewableReservations([r]);
  assert.equal(out.length, 1);
});

// A reservation assigned to another guide appears (the modal is
// responsible for the warning — the selector itself never hides it).
test('a reservation assigned to another guide still appears in the selector', () => {
  const r = res({ guideId: 'guide-2', assignedGuideName: 'Other Guide' });
  const out = selectReviewableReservations([r]);
  assert.equal(out.length, 1);
});

// A reservation that already has a review can still appear — multiple
// legitimate reviews per reservation are supported by the schema.
test('a reservation that already has a review still appears (hasReview is not a real reservation field, so it can never filter anything)', () => {
  const r = res({ hasReview: true, reviewCount: 3 });
  const out = selectReviewableReservations([r]);
  assert.equal(out.length, 1);
});

test('a cancelled reservation still appears — this selector is a lookup tool, not an operational filter', () => {
  const r = res({ opStatus: 'İptal' });
  const out = selectReviewableReservations([r]);
  assert.equal(out.length, 1);
});

test('a reservation with no checkIn date still appears', () => {
  const r = res({ checkIn: null, opStatus: 'Onaylandı' });
  const out = selectReviewableReservations([r]);
  assert.equal(out.length, 1);
});

test('the only exclusion is a record with no real reservation id', () => {
  const valid = res({ id: 'valid-1' });
  const out = selectReviewableReservations([valid, null, undefined, { id: '' }, { name: 'no id at all' }]);
  assert.deepEqual(out.map(r => r.id), ['valid-1']);
});

test('sorts newest tour date first by default (neutral, not guide-scoped)', () => {
  const older = res({ id: 'older', checkIn: '2026-08-01' });
  const newer = res({ id: 'newer', checkIn: '2026-09-20' });
  const noDate = res({ id: 'noDate', checkIn: null });
  const out = selectReviewableReservations([older, newer, noDate]);
  assert.deepEqual(out.map(r => r.id), ['newer', 'older', 'noDate']);
});

test('returns an empty array for an empty/missing reservations list', () => {
  assert.deepEqual(selectReviewableReservations([]), []);
  assert.deepEqual(selectReviewableReservations(null), []);
  assert.deepEqual(selectReviewableReservations(undefined), []);
});

// --- Dropdown option labels -------------------------------------------------

test('formats the option label as reservation number · tour · date · language · customer name', () => {
  const r = res({ resNumber: 'R-2026-0005', tour: 'Grand Bazaar Experience', date: '06.10.2026', tourLanguage: 'İtalyanca', name: 'Mario Rossi' });
  assert.equal(formatGuideReviewReservationOption(r), 'R-2026-0005 · Grand Bazaar Experience · 06.10.2026 · İtalyanca · Mario Rossi');
});

test('omits the customer name segment entirely when no customer name is available', () => {
  const r = res({ resNumber: 'R-2026-0005', tour: 'Grand Bazaar Experience', date: '06.10.2026', tourLanguage: 'İtalyanca', name: '' });
  assert.equal(formatGuideReviewReservationOption(r), 'R-2026-0005 · Grand Bazaar Experience · 06.10.2026 · İtalyanca');
});

// --- Static source checks: real data source, guide_id snapshot behavior ---
const SOURCE = fs.readFileSync(path.join(__dirname, '..', '..', 'DeseTourDashboard.jsx'), 'utf8');

function extractFunctionBody(name, nextMarker) {
  const idx = SOURCE.indexOf(`function ${name}(`);
  assert.ok(idx !== -1, `could not find function ${name}`);
  return SOURCE.slice(idx, SOURCE.indexOf(nextMarker, idx));
}

test('the picker is built from the real "reservation" repo (useRepo), not a guide-scoped or mock-only subset', () => {
  const body = extractFunctionBody('AddEditReviewModal', '\nfunction ReviewCard');
  assert.match(body, /const \{ data: repoRes \} = useRepo\("reservation", "getAll"\);/);
  assert.match(body, /selectReviewableReservations\(repoRes\)/);
  assert.doesNotMatch(body, /DB\.reservations/, 'must never read the mock seed array directly');
});

test('selecting a reservation never mutates reservations.guide_id: the create payload always uses the guideId prop', () => {
  const body = extractFunctionBody('AddEditReviewModal', '\nfunction ReviewCard');
  assert.match(body, /await mutate\("create", \{ \.\.\.payload, resId: effectiveResId, guideId \}\)/);
  assert.doesNotMatch(body, /guideId:\s*selectedRes\.guideId/);
});

test('SupabaseReviewRepo.create/update never write to the reservations table, only reservation_reviews', () => {
  const idx = SOURCE.indexOf("const SupabaseReviewRepo = {");
  const endIdx = SOURCE.indexOf("const SupabaseGuideRepo = {", idx);
  const body = SOURCE.slice(idx, endIdx);
  assert.match(body, /sb\.from\('reservation_reviews'\)\.insert/);
  assert.match(body, /sb\.from\('reservation_reviews'\)\.update/);
  assert.doesNotMatch(body, /sb\.from\('reservations'\)\.(update|insert)/);
});

test('a warning is shown when the selected reservation is assigned to another guide, and selection is never blocked', () => {
  const body = extractFunctionBody('AddEditReviewModal', '\nfunction ReviewCard');
  assert.match(body, /const assignedToOtherGuide = !!\(selectedRes && selectedRes\.guideId && selectedRes\.guideId !== guideId\);/);
  assert.match(body, /\{assignedToOtherGuide && \(/);
  // The warning is purely informational — nothing gates handleSubmit on it.
  const submitIdx = body.indexOf('async function handleSubmit()');
  const submitBody = body.slice(submitIdx, body.indexOf('\n  }', submitIdx));
  assert.doesNotMatch(submitBody, /assignedToOtherGuide/);
});

test('a search box exists to narrow the list as it grows', () => {
  const body = extractFunctionBody('AddEditReviewModal', '\nfunction ReviewCard');
  assert.match(body, /const \[resSearch, setResSearch\] = useState\(""\);/);
  assert.match(body, /FRow label="Rezervasyon Ara"/);
});
