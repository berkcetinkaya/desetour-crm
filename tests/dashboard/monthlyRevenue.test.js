'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { extractTestableFn } = require('./extractTestableFn');

const computeMonthlyReservationRevenue = extractTestableFn('computeMonthlyReservationRevenue');
const summarizeMonthlyTRYRevenue = extractTestableFn('summarizeMonthlyTRYRevenue');

const TODAY_ISO = '2026-09-15'; // fixes "the current month" to September 2026 for every test below

function res(overrides) {
  return {
    id: 'r-' + Math.random().toString(36).slice(2),
    checkIn: '2026-09-10',
    opStatus: 'Onaylandı',
    total: 0,
    // The revenue figure is TRY-only (no conversion), so the shared factory
    // defaults to a TRY booking; currency tests below override it.
    currency: 'TRY',
    retailAmount: null,
    retailCurrency: null,
    ...overrides,
  };
}

// A. Multiple reservations in the current month are summed.
test('sums multiple reservations whose tour date falls in the current month', () => {
  const reservations = [
    res({ id: 'A', checkIn: '2026-09-03', total: 4800 }),
    res({ id: 'B', checkIn: '2026-09-18', total: 9600 }),
    res({ id: 'C', checkIn: '2026-09-29', total: 4800 }),
  ];
  assert.equal(computeMonthlyReservationRevenue(reservations, TODAY_ISO), 19200);
});

// B. A reservation outside the current month is excluded.
test('excludes reservations whose tour date falls outside the current month', () => {
  const reservations = [
    res({ id: 'inMonth', checkIn: '2026-09-10', total: 4800 }),
    res({ id: 'lastMonth', checkIn: '2026-08-31', total: 99999 }),
    res({ id: 'nextMonth', checkIn: '2026-10-01', total: 99999 }),
  ];
  assert.equal(computeMonthlyReservationRevenue(reservations, TODAY_ISO), 4800);
});

// C. A Civitatis reservation uses retail_amount, never total_amount.
test('a Civitatis reservation contributes its retail_amount, not its total_amount', () => {
  const reservations = [
    res({ id: 'civitatis', checkIn: '2026-09-10', total: 3600, retailAmount: 4800, retailCurrency: 'TRY' }),
  ];
  assert.equal(computeMonthlyReservationRevenue(reservations, TODAY_ISO), 4800);
});

// C (continued). A manual/non-Civitatis reservation (no retail_amount) falls
// back to total, since that IS the customer-facing price for those.
test('a manual reservation with no retail_amount falls back to total', () => {
  const reservations = [
    res({ id: 'manual', checkIn: '2026-09-10', total: 4800, retailAmount: null }),
  ];
  assert.equal(computeMonthlyReservationRevenue(reservations, TODAY_ISO), 4800);
});

// D. Multiple reservations are each counted exactly once.
test('each qualifying reservation is counted exactly once, including month boundaries', () => {
  const reservations = [
    res({ id: 'firstDay', checkIn: '2026-09-01', total: 1000 }),
    res({ id: 'lastDay',  checkIn: '2026-09-30', total: 2000 }),
    res({ id: 'mixed',    checkIn: '2026-09-15', total: 3000, retailAmount: 3500, retailCurrency: 'TRY' }),
  ];
  assert.equal(computeMonthlyReservationRevenue(reservations, TODAY_ISO), 1000 + 2000 + 3500);
});

// E. Payment records do not affect the monthly revenue result — enforced
// structurally: the function's signature never accepts a payments argument
// at all, so there is no channel through which payment data could leak in.
test('the function signature has no payments parameter — payment data cannot influence the result', () => {
  assert.equal(computeMonthlyReservationRevenue.length, 2);
  assert.deepEqual(
    Array.from(computeMonthlyReservationRevenue.toString().matchAll(/\bpayments?\b/gi)).map(m => m[0]),
    []
  );
});

// F. Zero reservations in the current month correctly returns ₺0.
test('returns 0 when no reservations fall in the current month', () => {
  assert.equal(computeMonthlyReservationRevenue([], TODAY_ISO), 0);
  const reservations = [res({ id: 'outside', checkIn: '2026-01-01', total: 5000 })];
  assert.equal(computeMonthlyReservationRevenue(reservations, TODAY_ISO), 0);
});

// Cancelled reservations won't take place, so they don't count as booked
// sales — but a tour already completed earlier this month still does.
test('excludes cancelled reservations but includes already-completed ones', () => {
  const reservations = [
    res({ id: 'cancelled', checkIn: '2026-09-05', total: 4800, opStatus: 'İptal' }),
    res({ id: 'completed', checkIn: '2026-09-05', total: 4800, opStatus: 'Tamamlandı' }),
  ];
  assert.equal(computeMonthlyReservationRevenue(reservations, TODAY_ISO), 4800);
});

test('a reservation with no checkIn date is excluded rather than throwing', () => {
  const reservations = [res({ id: 'noDate', checkIn: null, total: 4800 })];
  assert.equal(computeMonthlyReservationRevenue(reservations, TODAY_ISO), 0);
});

// --- Currency: TRY only, never mixed, never converted ---------------------

test('only TRY/TL amounts are summed; EUR/USD amounts are never added, converted or assumed to be TRY', () => {
  const reservations = [
    res({ id: 'try', total: 50000, currency: 'TRY' }),
    res({ id: 'tl',  total: 10000, currency: 'TL' }),
    res({ id: 'eur', total: 900,   currency: 'EUR' }),
    res({ id: 'usd', total: 1200,  currency: 'USD' }),
  ];
  assert.equal(computeMonthlyReservationRevenue(reservations, TODAY_ISO), 60000);
});

test('currency codes are matched case-insensitively and with surrounding spaces trimmed', () => {
  const reservations = [
    res({ id: 'lower', total: 1000, currency: 'try' }),
    res({ id: 'padded', total: 2000, currency: ' TRY ' }),
  ];
  assert.equal(computeMonthlyReservationRevenue(reservations, TODAY_ISO), 3000);
});

test('summary counts foreign-currency reservations as excluded, broken down by currency', () => {
  const s = summarizeMonthlyTRYRevenue([
    res({ id: 'try', total: 40000, currency: 'TRY' }),
    res({ id: 'eur1', total: 800, currency: 'EUR' }),
    res({ id: 'eur2', total: 600, currency: 'EUR' }),
    res({ id: 'usd', total: 700, currency: 'USD' }),
  ], TODAY_ISO);
  assert.deepEqual(s, { tryTotal: 40000, includedCount: 1, excludedCount: 3, excludedByCurrency: { EUR: 2, USD: 1 } });
});

test('a Civitatis retail amount is judged by retail_currency, not by the reservation currency', () => {
  const s = summarizeMonthlyTRYRevenue([
    // net proceeds in EUR, retail price in TRY → counts, with the retail amount
    res({ id: 'retailTry', total: 50, currency: 'EUR', retailAmount: 4800, retailCurrency: 'TRY' }),
    // net proceeds in TRY, retail price in EUR → excluded (retail is the sale price)
    res({ id: 'retailEur', total: 3000, currency: 'TRY', retailAmount: 90, retailCurrency: 'EUR' }),
  ], TODAY_ISO);
  assert.equal(s.tryTotal, 4800);
  assert.equal(s.includedCount, 1);
  assert.deepEqual(s.excludedByCurrency, { EUR: 1 });
});

test('a missing/unknown currency is never assumed to be TRY — it is excluded under BELİRSİZ', () => {
  const s = summarizeMonthlyTRYRevenue([
    res({ id: 'noCur', total: 5000, currency: null }),
    res({ id: 'blank', total: 5000, currency: '' }),
  ], TODAY_ISO);
  assert.equal(s.tryTotal, 0);
  assert.deepEqual(s.excludedByCurrency, { 'BELİRSİZ': 2 });
});

test('cancelled and out-of-month foreign reservations are not counted as excluded either', () => {
  const s = summarizeMonthlyTRYRevenue([
    res({ id: 'cancelledEur', total: 900, currency: 'EUR', opStatus: 'İptal' }),
    res({ id: 'lastMonthEur', total: 900, currency: 'EUR', checkIn: '2026-08-20' }),
  ], TODAY_ISO);
  assert.equal(s.excludedCount, 0);
});

test('summarizeMonthlyTRYRevenue never touches payments and has no exchange rate or conversion', () => {
  const src = summarizeMonthlyTRYRevenue.toString();
  assert.equal(summarizeMonthlyTRYRevenue.length, 2);
  assert.doesNotMatch(src, /\bpayments?\b/i);
  assert.doesNotMatch(src, /rate|_civitatisConvertToTry|\*\s*\d/i, 'no FX rate, no conversion helper, no multiplication by a constant');
});

// --- Static source checks: currency symbol + KPI wiring -------------------
const SOURCE = fs.readFileSync(path.join(__dirname, '..', '..', 'DeseTourDashboard.jsx'), 'utf8');

test('"Bu Ay Beklenen Ciro" KPI displays with the ₺ symbol and reads from monthRevTRY', () => {
  const m = SOURCE.match(/label:"Bu Ay Beklenen Ciro",\s*\n\s*value:`([^`]+)`/);
  assert.ok(m, 'could not find the "Bu Ay Beklenen Ciro" KPI card definition');
  assert.match(m[1], /^₺\$\{m\.monthRevTRY\.toLocaleString\("tr-TR"/);
});

test('calculateDashboardMetrics computes monthRevTRY via computeMonthlyReservationRevenue, not from payments', () => {
  assert.match(SOURCE, /const monthRevTRY = computeMonthlyReservationRevenue\(_res, todayISO\);/);
});

test('the KPI notes excluded reservations only when there are any, without implying they are all foreign currency', () => {
  assert.match(SOURCE, /const monthRevExcludedCount = summarizeMonthlyTRYRevenue\(_res, todayISO\)\.excludedCount;/);
  assert.match(SOURCE, /m\.monthRevExcludedCount > 0 \? `Bu ay · \$\{m\.monthRevExcludedCount\} rezervasyon hariç` : "Bu ay"/);
  assert.doesNotMatch(SOURCE, /döviz rez\. hariç|Döviz cinsinden/);
});
