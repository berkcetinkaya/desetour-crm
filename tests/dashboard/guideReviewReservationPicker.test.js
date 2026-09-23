'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { extractTestableFn } = require('./extractTestableFn');

const selectEligibleGuideReviewReservations = extractTestableFn('selectEligibleGuideReviewReservations');
const formatGuideReviewReservationOption = extractTestableFn('formatGuideReviewReservationOption');

const TODAY_ISO = '2026-09-15';
const GUIDE_ID = 'guide-1';

function res(overrides) {
  return {
    id: 'r-' + Math.random().toString(36).slice(2),
    resNumber: 'R-2026-0001',
    name: 'Jane Doe',
    tour: 'Grand Bazaar Tour',
    date: '10 Eyl 2026',
    checkIn: '2026-09-10',
    tourLanguage: 'İngilizce',
    guideId: null,
    assignedGuideName: '',
    opStatus: 'Tamamlandı',
    ...overrides,
  };
}

// A. A reservation already assigned to THIS guide is included.
test('includes a reservation already assigned to this guide', () => {
  const r = res({ guideId: GUIDE_ID });
  const out = selectEligibleGuideReviewReservations([r], GUIDE_ID, TODAY_ISO);
  assert.equal(out.length, 1);
  assert.equal(out[0].id, r.id);
});

// B. An unassigned historical reservation (guide_id null) is included —
// this is the exact bug being fixed.
test('includes an unassigned historical reservation (guide_id null)', () => {
  const r = res({ guideId: null, opStatus: 'Tamamlandı' });
  const out = selectEligibleGuideReviewReservations([r], GUIDE_ID, TODAY_ISO);
  assert.equal(out.length, 1);
  assert.equal(out[0].id, r.id);
});

// C. A reservation assigned to ANOTHER guide is still shown (never silently
// excluded) — AddEditReviewModal is responsible for warning on selection.
test('includes a reservation assigned to another guide, rather than hiding it', () => {
  const r = res({ guideId: 'guide-2', assignedGuideName: 'Other Guide' });
  const out = selectEligibleGuideReviewReservations([r], GUIDE_ID, TODAY_ISO);
  assert.equal(out.length, 1);
  assert.equal(out[0].id, r.id);
});

test('excludes cancelled reservations regardless of guide assignment', () => {
  const r = res({ guideId: GUIDE_ID, opStatus: 'İptal' });
  const out = selectEligibleGuideReviewReservations([r], GUIDE_ID, TODAY_ISO);
  assert.equal(out.length, 0);
});

test('excludes a future (not-yet-happened) reservation that is not completed', () => {
  const r = res({ guideId: GUIDE_ID, opStatus: 'Onaylandı', checkIn: '2026-09-20' });
  const out = selectEligibleGuideReviewReservations([r], GUIDE_ID, TODAY_ISO);
  assert.equal(out.length, 0);
});

test('includes a past (not explicitly completed) reservation whose tour date has already passed', () => {
  const r = res({ guideId: GUIDE_ID, opStatus: 'Onaylandı', checkIn: '2026-09-01' });
  const out = selectEligibleGuideReviewReservations([r], GUIDE_ID, TODAY_ISO);
  assert.equal(out.length, 1);
});

test('includes a reservation whose tour date is today', () => {
  const r = res({ guideId: GUIDE_ID, opStatus: 'Onaylandı', checkIn: TODAY_ISO });
  const out = selectEligibleGuideReviewReservations([r], GUIDE_ID, TODAY_ISO);
  assert.equal(out.length, 1);
});

test('excludes a reservation with no checkIn that is not marked completed', () => {
  const r = res({ guideId: GUIDE_ID, opStatus: 'Onaylandı', checkIn: null });
  const out = selectEligibleGuideReviewReservations([r], GUIDE_ID, TODAY_ISO);
  assert.equal(out.length, 0);
});

test('sorts this-guide reservations before unassigned ones, before other-guide ones', () => {
  const mine = res({ id: 'mine', guideId: GUIDE_ID, checkIn: '2026-09-01' });
  const unassigned = res({ id: 'unassigned', guideId: null, checkIn: '2026-09-12' });
  const other = res({ id: 'other', guideId: 'guide-2', checkIn: '2026-09-14' });
  const out = selectEligibleGuideReviewReservations([other, unassigned, mine], GUIDE_ID, TODAY_ISO);
  assert.deepEqual(out.map(r => r.id), ['mine', 'unassigned', 'other']);
});

test('within the same group, completed tours sort before non-completed, then newest first', () => {
  const older = res({ id: 'older', guideId: GUIDE_ID, opStatus: 'Tamamlandı', checkIn: '2026-09-01' });
  const newer = res({ id: 'newer', guideId: GUIDE_ID, opStatus: 'Tamamlandı', checkIn: '2026-09-05' });
  const pastNotDone = res({ id: 'pastNotDone', guideId: GUIDE_ID, opStatus: 'Onaylandı', checkIn: '2026-09-10' });
  const out = selectEligibleGuideReviewReservations([pastNotDone, older, newer], GUIDE_ID, TODAY_ISO);
  assert.deepEqual(out.map(r => r.id), ['newer', 'older', 'pastNotDone']);
});

test('returns an empty array when nothing is eligible', () => {
  assert.deepEqual(selectEligibleGuideReviewReservations([], GUIDE_ID, TODAY_ISO), []);
  const cancelled = res({ guideId: GUIDE_ID, opStatus: 'İptal' });
  const future = res({ guideId: GUIDE_ID, opStatus: 'Onaylandı', checkIn: '2026-12-01' });
  assert.deepEqual(selectEligibleGuideReviewReservations([cancelled, future], GUIDE_ID, TODAY_ISO), []);
});

// --- Dropdown option labels -------------------------------------------------

test('formats the option label as reservation number · tour · date · language · customer name', () => {
  const r = res({ resNumber: 'R-2026-0042', tour: 'Bosphorus Cruise', date: '10 Eyl 2026', tourLanguage: 'İtalyanca', name: 'Mario Rossi' });
  assert.equal(formatGuideReviewReservationOption(r), 'R-2026-0042 · Bosphorus Cruise · 10 Eyl 2026 · İtalyanca · Mario Rossi');
});

test('omits the customer name segment entirely when no customer name is available', () => {
  const r = res({ resNumber: 'R-2026-0042', tour: 'Bosphorus Cruise', date: '10 Eyl 2026', tourLanguage: 'İtalyanca', name: '' });
  assert.equal(formatGuideReviewReservationOption(r), 'R-2026-0042 · Bosphorus Cruise · 10 Eyl 2026 · İtalyanca');
});

test('falls back to the raw id when resNumber is missing, and em-dash for missing tour/date/language', () => {
  const r = res({ resNumber: '', id: 'raw-id-123', tour: '', date: '', tourLanguage: '', name: '' });
  assert.equal(formatGuideReviewReservationOption(r), 'raw-id-123 · — · — · —');
});

// --- Static source checks: guide_id snapshot behavior + wiring ------------
const SOURCE = fs.readFileSync(path.join(__dirname, '..', '..', 'DeseTourDashboard.jsx'), 'utf8');

function extractFunctionBody(name, nextMarker) {
  const idx = SOURCE.indexOf(`function ${name}(`);
  assert.ok(idx !== -1, `could not find function ${name}`);
  return SOURCE.slice(idx, SOURCE.indexOf(nextMarker, idx));
}

test('the create payload always uses the guideId prop, never the selected reservation\'s own guideId', () => {
  const body = extractFunctionBody('AddEditReviewModal', '\nfunction ReviewCard');
  assert.match(body, /await mutate\("create", \{ \.\.\.payload, resId: effectiveResId, guideId \}\)/);
  assert.doesNotMatch(body, /guideId:\s*selectedRes\.guideId/);
});

test('SupabaseReviewRepo.create never writes to the reservations table, only reservation_reviews', () => {
  const idx = SOURCE.indexOf("const SupabaseReviewRepo = {");
  const body = SOURCE.slice(idx, SOURCE.indexOf('async update(id,p){', idx));
  assert.match(body, /sb\.from\('reservation_reviews'\)\.insert/);
  assert.doesNotMatch(body, /sb\.from\('reservations'\)\.update/);
});

test('a warning is shown when the selected reservation is assigned to another guide, and the review still targets the open guide', () => {
  const body = extractFunctionBody('AddEditReviewModal', '\nfunction ReviewCard');
  assert.match(body, /const assignedToOtherGuide = !!\(selectedRes && selectedRes\.guideId && selectedRes\.guideId !== guideId\);/);
  assert.match(body, /\{assignedToOtherGuide && \(/);
});

test('the empty-state message no longer claims "assigned to this guide" and only renders when the eligible list is truly empty', () => {
  const body = extractFunctionBody('AddEditReviewModal', '\nfunction ReviewCard');
  assert.doesNotMatch(body, /Bu rehbere atanmış bir rezervasyon bulunamadı/);
  assert.match(body, /\{guideReservations\.length===0 && \(/);
});

test('the picker is built from selectEligibleGuideReviewReservations, not a guideId-filtered list', () => {
  const body = extractFunctionBody('AddEditReviewModal', '\nfunction ReviewCard');
  assert.match(body, /selectEligibleGuideReviewReservations\(repoRes, guideId, _TODAY_ISO\)/);
});
