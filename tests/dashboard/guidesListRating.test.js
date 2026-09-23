'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { extractTestableFn } = require('./extractTestableFn');

const SOURCE_PATH = path.join(__dirname, '..', '..', 'DeseTourDashboard.jsx');
const SOURCE = fs.readFileSync(SOURCE_PATH, 'utf8');

const computeGuideRatingStats = extractTestableFn('computeGuideRatingStats');
const formatGuideRatingLabel = extractTestableFn('formatGuideRatingLabel');

function extractFunctionBody(name, nextMarker) {
  const idx = SOURCE.indexOf(`function ${name}(`);
  assert.ok(idx !== -1, `could not find function ${name}`);
  return SOURCE.slice(idx, SOURCE.indexOf(nextMarker, idx));
}

const GUIDES_PAGE_BODY = extractFunctionBody('GuidesPage', '\nfunction AddGuidePaymentModal');
const GUIDE_DETAIL_BODY = extractFunctionBody('GuideDetailPage', '\nfunction GuideSectionCard');

// --- computeGuideRatingStats: the one shared calculation --------------------

test('a guide with multiple reviews gets the correct average', () => {
  const reviews = [{ rating: 5 }, { rating: 4 }, { rating: 5 }];
  const { avgRating, reviewCount } = computeGuideRatingStats(reviews);
  assert.equal(reviewCount, 3);
  assert.ok(Math.abs(avgRating - 4.6666666667) < 1e-9);
});

test('a guide with exactly one review gets a correct average of that single rating', () => {
  const { avgRating, reviewCount } = computeGuideRatingStats([{ rating: 5 }]);
  assert.equal(reviewCount, 1);
  assert.equal(avgRating, 5);
  const label = formatGuideRatingLabel(avgRating, reviewCount);
  assert.equal(label.rating, '5,0');
  assert.equal(label.countLabel, '1 değerlendirme');
});

test('a guide with no reviews produces the restrained empty state, never "0,0"', () => {
  const { avgRating, reviewCount } = computeGuideRatingStats([]);
  assert.equal(avgRating, null);
  assert.equal(reviewCount, 0);
  assert.equal(formatGuideRatingLabel(avgRating, reviewCount), null);
});

test('computeGuideRatingStats also treats null/undefined input as no reviews', () => {
  const { avgRating, reviewCount } = computeGuideRatingStats(null);
  assert.equal(avgRating, null);
  assert.equal(reviewCount, 0);
});

test('Turkish decimal formatting: 4.8 / 5 / 4.333... render as 4,8 / 5,0 / 4,3', () => {
  assert.equal(formatGuideRatingLabel(4.8, 12).rating, '4,8');
  assert.equal(formatGuideRatingLabel(5, 1).rating, '5,0');
  assert.equal(formatGuideRatingLabel(4.3333333, 3).rating, '4,3');
});

test('the compact multi-review example from the spec: ★ 4,8 / 12 değerlendirme', () => {
  const reviews = [
    { rating: 5 }, { rating: 5 }, { rating: 5 }, { rating: 5 }, { rating: 5 },
    { rating: 5 }, { rating: 5 }, { rating: 5 }, { rating: 4 }, { rating: 4 },
    { rating: 4 }, { rating: 5 },
  ]; // sum 57 / 12 = 4.75 -> "4,8"
  const { avgRating, reviewCount } = computeGuideRatingStats(reviews);
  const label = formatGuideRatingLabel(avgRating, reviewCount);
  assert.equal(reviewCount, 12);
  assert.equal(label.rating, '4,8');
  assert.equal(label.countLabel, '12 değerlendirme');
});

// --- Reviews belonging to another guide are excluded -------------------------

test('reviews belonging to another guide never affect this guide\'s stats (grouping happens by guide_id snapshot, not passed here)', () => {
  // computeGuideRatingStats deliberately does no guide filtering itself —
  // the caller passes only this guide's own reviews. Prove that a mixed
  // list, pre-filtered by guideId the way GuidesPage's statsByGuide does,
  // produces stats using only the matching guide's reviews.
  const allReviews = [
    { guideId: 'G1', rating: 5 },
    { guideId: 'G2', rating: 1 },
    { guideId: 'G1', rating: 3 },
    { guideId: 'G2', rating: 1 },
  ];
  const g1Reviews = allReviews.filter(r => r.guideId === 'G1');
  const { avgRating, reviewCount } = computeGuideRatingStats(g1Reviews);
  assert.equal(reviewCount, 2);
  assert.equal(avgRating, 4); // (5+3)/2, never influenced by G2's 1-star reviews
});

// --- GuidesPage: source-level wiring -----------------------------------------

test('GuidesPage fetches reviews via the same "review"/"getAll" repo call, never a separate rating table/entity', () => {
  assert.match(GUIDES_PAGE_BODY, /useRepo\("review",\s*"getAll"\)/);
});

test('GuidesPage groups reviews into each guide\'s stats strictly by the review\'s own guide_id snapshot (rv.guideId), never by reading guide_name off a reservation/review', () => {
  assert.match(GUIDES_PAGE_BODY, /reviews\.forEach\(rv => \{\s*\n\s*if \(!rv\.guideId \|\| !map\[rv\.guideId\]\) return;\s*\n\s*map\[rv\.guideId\]\.reviews\.push\(rv\);/);
  // The only place "guide_name" appears is a doc-comment explaining what
  // NOT to use — never a live property read (rv.guide_name / rv.guideName).
  assert.doesNotMatch(GUIDES_PAGE_BODY, /rv\.guide_name/);
  assert.doesNotMatch(GUIDES_PAGE_BODY, /rv\.guideName/);
});

test('GuidesPage computes each guide\'s avgRating/reviewCount via the shared computeGuideRatingStats helper', () => {
  assert.match(GUIDES_PAGE_BODY, /computeGuideRatingStats\(map\[g\.id\]\.reviews\)/);
});

test('the Guides table renders the rating via the shared formatGuideRatingLabel helper, with the gold accent star and a restrained empty state', () => {
  assert.match(GUIDES_PAGE_BODY, /formatGuideRatingLabel\(s\.avgRating,\s*s\.reviewCount\)/);
  assert.match(GUIDES_PAGE_BODY, /color:C\.gold\}\}>★<\/span>/);
  assert.match(GUIDES_PAGE_BODY, /Henüz yok/);
  assert.doesNotMatch(GUIDES_PAGE_BODY, /0,0/);
});

test('"Ortalama Puan" is a header in the Guides table, positioned alongside the other performance columns', () => {
  assert.match(GUIDES_PAGE_BODY, /\["Rehber","Diller","Telefon","Yaklaşan Tur","Toplam Tur","Toplam Ödeme","Ortalama Puan","Durum",""\]/);
});

// --- GuideDetailPage: same calculation, no second implementation ------------

test('GuideDetailPage computes avgRating via the exact same shared computeGuideRatingStats helper, not an independent inline calculation', () => {
  assert.match(GUIDE_DETAIL_BODY, /const \{ avgRating \} = computeGuideRatingStats\(reviews\);/);
  assert.doesNotMatch(GUIDE_DETAIL_BODY, /reviews\.reduce\(\(s,rv\)=>s\+\(rv\.rating\|\|0\)/);
});

test('GuideDetailPage and GuidesPage are the only two call sites of computeGuideRatingStats — one calculation, used everywhere a guide rating is shown', () => {
  // Actual invocations only — excludes the function's own declaration line
  // ("function computeGuideRatingStats(") and the doc-comment mentioning
  // its name without calling it ("computeGuideRatingStats()'s output").
  const invocations = SOURCE.match(/(?<!function )computeGuideRatingStats\([^)]/g) || [];
  assert.equal(invocations.length, 2, `expected computeGuideRatingStats to be invoked from exactly 2 places, found ${invocations.length}`);
});

// --- Root cause / no separate rating system ----------------------------------

test('no separate rating system exists: reviews come from the same reservation_reviews-backed "review" repo entity everywhere', () => {
  assert.doesNotMatch(SOURCE, /function\s+\w*Rating\w*Repo/);
  assert.match(SOURCE, /getByGuide\(guideId\)\{return SupabaseReviewRepo\.getAll\(\{guideId\}\);\}/);
});

test('review-to-guide association comes from reservation_reviews.guide_id (a snapshot captured at review creation, never re-derived), mapped to guideId', () => {
  const mapIdx = SOURCE.indexOf('function mapReviewFromDB(r) {');
  const mapBody = SOURCE.slice(mapIdx, SOURCE.indexOf('\n}', mapIdx));
  assert.match(mapBody, /guideId:r\.guide_id\|\|null/);
});
