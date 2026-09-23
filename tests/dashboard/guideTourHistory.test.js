'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { extractTestableFn } = require('./extractTestableFn');

const computeGuideReservationStats = extractTestableFn('computeGuideReservationStats');
const enrichGuideTourHistoryEntry = extractTestableFn('enrichGuideTourHistoryEntry');
const buildGuidePassengerHistory = extractTestableFn('buildGuidePassengerHistory');

const GUIDE_ID = 'guide-albert';
const TODAY_ISO = '2026-09-20';

function res(overrides) {
  return {
    id: 'r-' + Math.random().toString(36).slice(2),
    resNumber: 'R-2026-0005',
    name: 'Juan Armas Puente',
    tour: 'Grand Bazaar Experience',
    date: '15 Eylül 2026',
    checkIn: '2026-09-15',
    tourLanguage: 'İspanyolca',
    pax: 2, paxChild: 0,
    guideId: GUIDE_ID,
    opStatus: 'Tamamlandı',
    ...overrides,
  };
}

// --- computeGuideReservationStats -------------------------------------

// A guide with one reservation shows Toplam Tur = 1.
test('a guide with one associated reservation shows Toplam Tur = 1', () => {
  const stats = computeGuideReservationStats([res()], GUIDE_ID, TODAY_ISO);
  assert.equal(stats.totalTours, 1);
});

// Two passengers (pax) produce Toplam Misafir = 2.
test('a reservation with 2 pax produces Toplam Misafir = 2', () => {
  const stats = computeGuideReservationStats([res({ pax: 2, paxChild: 0 })], GUIDE_ID, TODAY_ISO);
  assert.equal(stats.totalGuests, 2);
});

test('reservations assigned to another guide, or unassigned, never count toward this guide\'s stats', () => {
  const other = res({ guideId: 'guide-other' });
  const unassigned = res({ guideId: null });
  const stats = computeGuideReservationStats([other, unassigned], GUIDE_ID, TODAY_ISO);
  assert.equal(stats.totalTours, 0);
  assert.equal(stats.totalGuests, 0);
});

test('cancelled reservations for this guide do not count', () => {
  const stats = computeGuideReservationStats([res({ opStatus: 'İptal' })], GUIDE_ID, TODAY_ISO);
  assert.equal(stats.totalTours, 0);
});

test('Bu Ay Tur only counts reservations whose tour date falls in the current month', () => {
  const thisMonth = res({ checkIn: '2026-09-05' });
  const lastMonth = res({ checkIn: '2026-08-30' });
  const stats = computeGuideReservationStats([thisMonth, lastMonth], GUIDE_ID, TODAY_ISO);
  assert.equal(stats.thisMonthTours, 1);
});

test('stats are computed purely from the reservations passed in — no mock DB reservation data can influence them', () => {
  assert.equal(computeGuideReservationStats.length, 3);
  assert.doesNotMatch(computeGuideReservationStats.toString(), /\bDB\.reservations\b/);
  // An empty/undefined list (as if the mock seed array were never consulted) is handled safely.
  assert.deepEqual(computeGuideReservationStats(undefined, GUIDE_ID, TODAY_ISO), { totalTours: 0, totalGuests: 0, thisMonthTours: 0 });
});

// --- enrichGuideTourHistoryEntry ---------------------------------------

// The reservation appears in Tur Geçmişi with full detail.
test('enriches a tour history entry with reservation number, tour, date, language, source and guest count', () => {
  const entry = enrichGuideTourHistoryEntry(res(), { sourceName: 'Civitatis' });
  assert.equal(entry.resNumber, 'R-2026-0005');
  assert.equal(entry.tour, 'Grand Bazaar Experience');
  assert.equal(entry.date, '15 Eylül 2026');
  assert.equal(entry.tourLanguage, 'İspanyolca');
  assert.equal(entry.sourceName, 'Civitatis');
  assert.equal(entry.guestCount, 2);
});

// Actual passenger names (reservation_guests) appear, distinct from the
// booking contact.
test('actual passenger names appear, kept distinct from the booking contact', () => {
  const guests = [{ id: 'g1', fullName: 'Juan Armas Puente' }, { id: 'g2', fullName: 'Carolina Fernanda Travieso Gonzalez' }];
  const entry = enrichGuideTourHistoryEntry(res({ name: 'Juan Armas Puente' }), { guests });
  assert.equal(entry.contactName, 'Juan Armas Puente');
  assert.deepEqual(entry.passengerNames, ['Juan Armas Puente', 'Carolina Fernanda Travieso Gonzalez']);
});

// A review attached to that reservation appears beneath the correct tour,
// with source and rating.
test('a review for this reservation is attached to the entry, with rating and source', () => {
  const review = { id: 'rv1', rating: 5, sourceName: 'Civitatis', reviewDate: '2026-09-16', reviewerName: 'Juan', reviewText: 'Harika tur!' };
  const entry = enrichGuideTourHistoryEntry(res(), { reviews: [review] });
  assert.equal(entry.reviews.length, 1);
  assert.equal(entry.reviews[0].rating, 5);
  assert.equal(entry.reviews[0].sourceName, 'Civitatis');
});

// Multiple reviews for one reservation are supported, never collapsed.
test('multiple reviews for the same reservation are all preserved', () => {
  const reviews = [
    { id: 'rv1', rating: 5, sourceName: 'Civitatis' },
    { id: 'rv2', rating: 4, sourceName: 'Google' },
  ];
  const entry = enrichGuideTourHistoryEntry(res(), { reviews });
  assert.equal(entry.reviews.length, 2);
  assert.deepEqual(entry.reviews.map(r => r.sourceName), ['Civitatis', 'Google']);
});

test('a tour with no review yet has an empty reviews array, not null/undefined', () => {
  const entry = enrichGuideTourHistoryEntry(res(), {});
  assert.deepEqual(entry.reviews, []);
});

test('a tour with no passengers loaded yet has an empty passengerNames array', () => {
  const entry = enrichGuideTourHistoryEntry(res(), {});
  assert.deepEqual(entry.passengerNames, []);
});

// --- buildGuidePassengerHistory -----------------------------------------

test('Misafir Geçmişi derives passengers from reservation_guests, not the booking contact', () => {
  const r = res({ id: 'res-1', name: 'Juan Armas Puente' });
  const guestsByResId = { 'res-1': [{ id: 'g1', fullName: 'Carolina Fernanda Travieso Gonzalez' }] };
  const history = buildGuidePassengerHistory([r], GUIDE_ID, guestsByResId);
  assert.deepEqual(history.map(h => h.name), ['Carolina Fernanda Travieso Gonzalez']);
});

test('the same passenger across two of this guide\'s tours is listed once, with both reservations kept', () => {
  const r1 = res({ id: 'res-1' });
  const r2 = res({ id: 'res-2', date: '20 Eylül 2026', checkIn: '2026-09-20' });
  const guestsByResId = {
    'res-1': [{ id: 'g1', fullName: 'Juan Armas Puente' }],
    'res-2': [{ id: 'g2', fullName: 'Juan Armas Puente' }],
  };
  const history = buildGuidePassengerHistory([r1, r2], GUIDE_ID, guestsByResId);
  assert.equal(history.length, 1);
  assert.equal(history[0].tourCount, 2);
  assert.deepEqual(history[0].reservationIds.sort(), ['res-1', 'res-2']);
});

test('passengers from a reservation assigned to a different guide never appear', () => {
  const r = res({ id: 'res-1', guideId: 'guide-other' });
  const guestsByResId = { 'res-1': [{ id: 'g1', fullName: 'Someone Else' }] };
  const history = buildGuidePassengerHistory([r], GUIDE_ID, guestsByResId);
  assert.deepEqual(history, []);
});

// --- Static source checks: real repo, contextual add-review, no mock leakage ---
const SOURCE = fs.readFileSync(path.join(__dirname, '..', '..', 'DeseTourDashboard.jsx'), 'utf8');

function extractFunctionBody(name, nextMarker) {
  const idx = SOURCE.indexOf(`function ${name}(`);
  assert.ok(idx !== -1, `could not find function ${name}`);
  return SOURCE.slice(idx, SOURCE.indexOf(nextMarker, idx));
}

test('reservations.guide_id is the authoritative filter for every guide-scoped derivation — never guide_name or notes', () => {
  const body = extractFunctionBody('GuideDetailPage', '\nfunction GuideSectionCard');
  assert.match(body, /allRes\.filter\(r => r && r\.guideId === guideId/);
  assert.doesNotMatch(body, /r\.guide\s*===\s*guide\.name/, 'must never match on the free-text guide_name field');
  assert.doesNotMatch(body, /\.notes\b.*guideId|guideId.*\.notes\b/);
});

test('passengers are fetched via a real, batched reservation_guests query, never DB.reservations or a mock array', () => {
  const idx = SOURCE.indexOf("async getGuestsForReservations(resIds){");
  assert.ok(idx !== -1, 'getGuestsForReservations not found on SupabaseReservationRepo');
  const body = SOURCE.slice(idx, idx + 700);
  assert.match(body, /sb\.from\('reservation_guests'\)\.select\('id,reservation_id,full_name,sort_order'\)\.in\('reservation_id',ids\)/);
  assert.doesNotMatch(body, /DB\.reservations/);
});

test('the contextual "Değerlendirme Ekle" on a tour row preselects both the reservation and the currently-viewed guide', () => {
  const body = extractFunctionBody('GuideDetailPage', '\nfunction GuideSectionCard');
  assert.match(body, /const \[addReviewForResId, setAddReviewForResId\] = useState\(null\);/);
  assert.match(body, /<AddEditReviewModal resId=\{addReviewForResId\} guideId=\{guide\.id\} guideName=\{guide\.name\} onClose=\{\(\)=>setAddReviewForResId\(null\)\}\/>/);
  assert.match(body, /onAddReview=\{\(\)=>setAddReviewForResId\(entry\.id\)\}/);
});

test('the generic "+ Değerlendirme Ekle" action still exists as a secondary path', () => {
  const body = extractFunctionBody('GuideDetailPage', '\nfunction GuideSectionCard');
  assert.match(body, /setShowAddReview\(true\)/);
});

test('AddEditReviewModal skips its reservation picker entirely when resId is already known (the contextual path)', () => {
  const idx = SOURCE.indexOf('function AddEditReviewModal(');
  const body = SOURCE.slice(idx, SOURCE.indexOf('\nfunction ReviewCard', idx));
  assert.match(body, /const needsResPicker = !isEdit && !resId;/);
});

test('Tur Geçmişi is rendered from real reservation history, not the old contact-based customer aggregation', () => {
  const body = extractFunctionBody('GuideDetailPage', '\nfunction GuideSectionCard');
  assert.match(body, /pastHistory\.map\(entry=>/);
  assert.doesNotMatch(body, /customerMap/);
});
