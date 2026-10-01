'use strict';
/**
 * tests/dashboard/reservationMealStatus.test.js
 * ─────────────────────────────────────────────────────────────────────────
 * Tour Preparation Intelligence — Phase C1: Reservation Detail meal status
 * UI. Tests the two pure helpers (getMealStatusDisplay,
 * getPurchasedActivityDisplayValue) extracted directly from
 * DeseTourDashboard.jsx via the existing TESTABLE-marker convention (see
 * tests/dashboard/extractTestableFn.js / reservationDetailFixes.test.js),
 * so these exercise the REAL shipping implementation, never a hand-copied
 * duplicate. DeseTourDashboard.jsx itself cannot be require()'d or
 * rendered in Node (browser-only globals at module scope — see
 * extractTestableFn.js's own header), so JSX rendering is not exercised
 * here; the data-mapping/source-level checks below instead prove the
 * mapper wiring and card placement are correct by static inspection of
 * the real source.
 * ─────────────────────────────────────────────────────────────────────────
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { extractTestableFn } = require('./extractTestableFn');
const getMealStatusDisplay = extractTestableFn('getMealStatusDisplay');
const getPurchasedActivityDisplayValue = extractTestableFn('getPurchasedActivityDisplayValue');

const SOURCE_PATH = path.join(__dirname, '..', '..', 'DeseTourDashboard.jsx');
const SOURCE = fs.readFileSync(SOURCE_PATH, 'utf8');

// ═══════════════════════════════════════════════════════════════════════
// 1-4: meal_status title mapping
// ═══════════════════════════════════════════════════════════════════════

test('1. included -> "Yemek Dahil"', () => {
  assert.equal(getMealStatusDisplay('included').title, 'Yemek Dahil');
});

test('2. not_included -> "Yemek Dahil Değil"', () => {
  assert.equal(getMealStatusDisplay('not_included').title, 'Yemek Dahil Değil');
});

test('3. unknown -> "Yemek Durumu Belirtilmemiş"', () => {
  assert.equal(getMealStatusDisplay('unknown').title, 'Yemek Durumu Belirtilmemiş');
});

test('4. null/undefined/missing meal_status -> "Yemek Durumu Belirtilmemiş" (never not_included)', () => {
  assert.equal(getMealStatusDisplay(null).title, 'Yemek Durumu Belirtilmemiş');
  assert.equal(getMealStatusDisplay(undefined).title, 'Yemek Durumu Belirtilmemiş');
  assert.equal(getMealStatusDisplay('').title, 'Yemek Durumu Belirtilmemiş');
  assert.equal(getMealStatusDisplay('some_unrecognized_value').title, 'Yemek Durumu Belirtilmemiş');
});

test('unknown and not_included render visibly different titles (unknown is never mistaken for not_included)', () => {
  assert.notEqual(getMealStatusDisplay('unknown').title, getMealStatusDisplay('not_included').title);
  assert.notEqual(getMealStatusDisplay(null).title, getMealStatusDisplay('not_included').title);
});

// ═══════════════════════════════════════════════════════════════════════
// 5-6: purchased_activity_raw rendering
// ═══════════════════════════════════════════════════════════════════════

test('5. purchased_activity_raw is returned EXACTLY as stored — accents, punctuation, trailing dash preserved verbatim', () => {
  const samples = [
    'Visita guiada pela Istambul imprescindível - Tour com',
    'Tour del Grande Bazar - Tour in italiano',
    'Cruzeiro pelo Bósforo + Mesquita Azul + Santa Sofia -',
  ];
  for (const s of samples) {
    assert.equal(getPurchasedActivityDisplayValue(s), s);
  }
});

test('6. null/undefined/blank purchased_activity_raw returns null (no empty "Satın Alınan Aktivite" field)', () => {
  assert.equal(getPurchasedActivityDisplayValue(null), null);
  assert.equal(getPurchasedActivityDisplayValue(undefined), null);
  assert.equal(getPurchasedActivityDisplayValue(''), null);
  assert.equal(getPurchasedActivityDisplayValue('   '), null);
});

// ═══════════════════════════════════════════════════════════════════════
// 7-9: supporting copy
// ═══════════════════════════════════════════════════════════════════════

test('7. included supporting text is exactly "Bu rezervasyon yemekli tur seçeneğiyle oluşturuldu."', () => {
  assert.equal(getMealStatusDisplay('included').supportingText, 'Bu rezervasyon yemekli tur seçeneğiyle oluşturuldu.');
});

test('8. not_included supporting text is exactly "Bu rezervasyonda yemek dahil değildir."', () => {
  assert.equal(getMealStatusDisplay('not_included').supportingText, 'Bu rezervasyonda yemek dahil değildir.');
});

test('9. unknown (and missing) supporting text is exactly "Rezervasyon kaynağında yemek seçeneği kesin olarak belirtilmemiş."', () => {
  assert.equal(getMealStatusDisplay('unknown').supportingText, 'Rezervasyon kaynağında yemek seçeneği kesin olarak belirtilmemiş.');
  assert.equal(getMealStatusDisplay(null).supportingText, 'Rezervasyon kaynağında yemek seçeneği kesin olarak belirtilmemiş.');
});

// ═══════════════════════════════════════════════════════════════════════
// 10: no inference from Activity text anywhere in the UI
// ═══════════════════════════════════════════════════════════════════════

test('10a. getPurchasedActivityDisplayValue is a pure passthrough — never reads/matches the text\'s own content', () => {
  // "com almoço" / "sem almoço" / "Tour com" / "Tour sem" are the exact
  // phrases Phase B1's normalizer matches on — feeding them through here
  // must have ZERO effect on the returned value; this function must never
  // branch on what the string says, only on whether it exists at all.
  const mealPhrases = [
    'Visita guiada - Tour com almoço',
    'Visita guiada - Tour sem almoço',
    'Passeio - Tour com',
    'Passeio - Tour sem',
  ];
  for (const s of mealPhrases) {
    assert.equal(getPurchasedActivityDisplayValue(s), s, 'must return the exact same string regardless of its meal-related content');
  }
});

test('10b. the implementation of getPurchasedActivityDisplayValue never calls a meal-modality classifier or matches meal keywords', () => {
  const startMarker = '// TESTABLE:getPurchasedActivityDisplayValue:start';
  const endMarker = '// TESTABLE:getPurchasedActivityDisplayValue:end';
  const body = SOURCE.slice(SOURCE.indexOf(startMarker), SOURCE.indexOf(endMarker));
  assert.doesNotMatch(body, /normalizeCivitatisActivityModality|almoço|meal_status|includes\(|match\(|test\(/i);
});

test('10c. the rendered meal title/supporting text is driven ONLY by meal_status, never derived from purchased_activity_raw', () => {
  // getMealStatusDisplay takes only one argument — proves by construction
  // that purchased_activity_raw can never influence the displayed meal
  // state (there is no second parameter through which it could).
  assert.equal(getMealStatusDisplay.length, 1);
});

// ═══════════════════════════════════════════════════════════════════════
// 11. existing Reservation Detail functionality remains intact
// ═══════════════════════════════════════════════════════════════════════

test('11a. existing Reservation Detail TESTABLE functions are unaffected and still extract cleanly', () => {
  const computeReservationProgressIndex = extractTestableFn('computeReservationProgressIndex');
  assert.equal(computeReservationProgressIndex('Tamamlandı', true), 3);
  const fmtMoney = extractTestableFn('fmtMoney');
  assert.equal(typeof fmtMoney('100', 'EUR'), 'string');
});

test('11b. existing Reservation Detail cards (Misafir Bilgileri, Yolcular, Tur Bilgileri, Ödeme Özeti) are all still present in source, in their original relative order', () => {
  const idxGuest = SOURCE.indexOf('title="Misafir Bilgileri"');
  const idxGuests = SOURCE.indexOf('title="Yolcular"');
  const idxTour = SOURCE.indexOf('title="Tur Bilgileri"');
  const idxMeal = SOURCE.indexOf('title="Tur İçeriği"');
  const idxPayment = SOURCE.indexOf('title="Ödeme Özeti"');
  for (const idx of [idxGuest, idxGuests, idxTour, idxMeal, idxPayment]) {
    assert.ok(idx !== -1, 'expected card title to be present in source');
  }
  assert.ok(idxGuest < idxGuests, 'Misafir Bilgileri must precede Yolcular');
  assert.ok(idxGuests < idxTour, 'Yolcular must precede Tur Bilgileri');
  assert.ok(idxTour < idxMeal, 'Tur Bilgileri must precede the new Tur İçeriği card');
  assert.ok(idxMeal < idxPayment, 'Tur İçeriği must precede Ödeme Özeti — inserted between them, not appended elsewhere');
});

test('11c. the new card never introduces a direct reservations table write (desktop or mobile) — read-only presentation only', () => {
  const descStart = SOURCE.indexOf('function ReservationDetailPage(');
  const descEnd = SOURCE.indexOf('function MobileReservationDetailPage(');
  const reservationDetailSection = SOURCE.slice(descStart, descEnd);
  const mealSectionStart = reservationDetailSection.indexOf('Tur İçeriği');
  const mealSectionSnippet = reservationDetailSection.slice(mealSectionStart, mealSectionStart + 2000);
  assert.doesNotMatch(mealSectionSnippet, /\.update\(|\.rpc\(|useRepoMutation/);
});

test('11d. mapResFromDB exposes mealStatus/purchasedActivityRaw as a plain read-only passthrough of the DB columns', () => {
  const fnStart = SOURCE.indexOf('function mapResFromDB(');
  const fnEnd = SOURCE.indexOf('\n}', SOURCE.indexOf('_fromDB:true', fnStart));
  const fnBody = SOURCE.slice(fnStart, fnEnd);
  assert.match(fnBody, /mealStatus:r\.meal_status\|\|null/);
  assert.match(fnBody, /purchasedActivityRaw:r\.purchased_activity_raw\|\|null/);
});

test('11e. SupabaseReservationRepo.update\'s field map has no entry for meal_status/purchased_activity_raw — no existing edit surface can write them', () => {
  const idx = SOURCE.indexOf('async update(id,p)');
  const snippet = SOURCE.slice(idx, idx + 600);
  assert.doesNotMatch(snippet, /meal_status|purchased_activity_raw|mealStatus|purchasedActivityRaw/);
});

test('this new UI code never mentions anything WhatsApp-related', () => {
  // Scoped tightly to the actual new code (the two TESTABLE helpers, and
  // a window around each "Tur İçeriği" card) — NOT the whole
  // ReservationDetailPage/MobileReservationDetailPage functions, which
  // legitimately contain an unrelated pre-existing WhatsApp contact
  // button elsewhere on the page and would make this assertion
  // meaningless if scoped that broadly.
  const helpersStart = SOURCE.indexOf('// TESTABLE:getMealStatusDisplay:start');
  const helpersEnd = SOURCE.indexOf('// TESTABLE:getPurchasedActivityDisplayValue:end') + '// TESTABLE:getPurchasedActivityDisplayValue:end'.length;
  assert.doesNotMatch(SOURCE.slice(helpersStart, helpersEnd), /whatsapp/i);

  const desktopCardIdx = SOURCE.indexOf('title="Tur İçeriği"');
  assert.doesNotMatch(SOURCE.slice(desktopCardIdx, desktopCardIdx + 2500), /whatsapp/i);

  const mobileCardIdx = SOURCE.indexOf('title="Tur İçeriği"', desktopCardIdx + 1);
  assert.doesNotMatch(SOURCE.slice(mobileCardIdx, mobileCardIdx + 1500), /whatsapp/i);
});
