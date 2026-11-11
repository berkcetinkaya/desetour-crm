'use strict';
/**
 * tests/finance/financeDomain.test.js
 * The ONE canonical Finance calculation layer (buildFinanceMonthSummary /
 * buildGuideServices). Every amount below is FAKE TEST DATA; internal
 * planning amounts come from catalog rows supplied by the test.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const SOURCE = fs.readFileSync(path.join(__dirname, '..', '..', 'DeseTourDashboard.jsx'), 'utf8');
function extractCombined(names) {
  const bodies = names.map(name => {
    const s = SOURCE.indexOf(`// TESTABLE:${name}:start`), e = SOURCE.indexOf(`// TESTABLE:${name}:end`);
    if (s === -1 || e === -1 || e < s) throw new Error(`markers for ${name} not found`);
    return SOURCE.slice(s + `// TESTABLE:${name}:start`.length, e);
  });
  // eslint-disable-next-line no-new-func
  return new Function(`${bodies.join('\n')}\nreturn ${names[names.length - 1]};`)();
}
const F = extractCombined(['_selectLatestFxRatesToTry', '_financeDomain'])();
const { buildGuideServices, buildFinanceMonthSummary, attributeGuidePayments } = F;

const LANGS = ['İspanyolca', 'İngilizce', 'Portekizce', 'İtalyanca'];
const TODAY = '2026-11-10';
const MONTH = '2026-11';
let n = 0;
function res(o) {
  n += 1;
  return { id: 'R' + n, resNumber: 'RES-' + n, checkIn: '2026-11-12', tourId: 'T-TOP', tour: 'Topkapı', tourLanguage: 'İspanyolca',
    opStatus: 'Onaylandı', statusRaw: 'confirmed', pax: 2, paxChild: 0, total: 100, currency: 'EUR',
    retailAmount: null, retailCurrency: null, mealStatus: 'not_included', ...o };
}
const GUIDE = { id: 'CI-G', kind: 'internal', isActive: true, category: 'guide', basis: 'guide_service_group', amount: 150, currency: 'EUR', tourId: null, preparationRuleId: null, validFrom: '2026-01-01', validTo: null };
const MEAL = { id: 'CI-M', kind: 'internal', isActive: true, category: 'meal', basis: 'per_guest', amount: 10, currency: 'EUR', tourId: null, preparationRuleId: null, validFrom: '2026-01-01', validTo: null };
const TOP_RULE = { id: 'RULE-TOP', tourId: 'T-TOP', preparationType: 'entrance_ticket', label: 'Topkapı Sarayı Kombine Giriş Bileti', quantityRule: 'per_guest', isActive: true };
const TOP_COST = { id: 'CI-T', kind: 'internal', isActive: true, category: 'ticket', basis: 'preparation_rule', amount: 40, currency: 'EUR', tourId: 'T-TOP', preparationRuleId: 'RULE-TOP', validFrom: '2026-01-01', validTo: null };
const TOP_PUBLIC = { ...TOP_COST, id: 'CI-T-PUB', kind: 'public_reference', amount: 99 };
const RATES = [{ baseCurrency: 'EUR', quoteCurrency: 'TRY', rate: 50, rateDate: '2026-11-09' }, { baseCurrency: 'USD', quoteCurrency: 'TRY', rate: 40, rateDate: '2026-11-09' }];
const summary = (o) => buildFinanceMonthSummary({ monthISO: MONTH, todayISO: TODAY, languageNames: LANGS, costItems: [GUIDE, MEAL, TOP_COST, TOP_PUBLIC], rateRows: RATES, ...o });
const eur = (m) => (m && m.EUR) || 0;
const guideEur = (s) => eur(s.categories.guide.planned);

// ── Guide-service grouping ───────────────────────────────────────────────

test('same date + same tour + same language + 2 reservations = ONE service = €150', () => {
  const s = summary({ reservations: [res({ pax: 8 }), res({ pax: 12 })] });
  assert.equal(s.counts.guideServices, 1);
  assert.equal(guideEur(s), 150);
});

test('same group with 10 reservations = €150; 20 guests = €150 (pax and reservation count never multiply)', () => {
  assert.equal(guideEur(summary({ reservations: Array.from({ length: 10 }, () => res()) })), 150);
  assert.equal(guideEur(summary({ reservations: [res({ pax: 15, paxChild: 5 })] })), 150);
  assert.equal(guideEur(summary({ reservations: [res({ pax: 1 })] })), 150);
});

test('different language / different tour / different date each add a second €150 service', () => {
  assert.equal(guideEur(summary({ reservations: [res(), res({ tourLanguage: 'İngilizce' })] })), 300);
  assert.equal(guideEur(summary({ reservations: [res(), res({ tourId: 'T-OLD', tour: 'Old City' })] })), 300);
  assert.equal(guideEur(summary({ reservations: [res(), res({ checkIn: '2026-11-13' })] })), 300);
});

test('owner example: 4 services in November = €600 regardless of reservations/pax', () => {
  const s = summary({ reservations: [
    res({ checkIn: '2026-11-12', tourLanguage: 'İspanyolca', pax: 8 }), res({ checkIn: '2026-11-12', tourLanguage: 'İspanyolca', pax: 12 }),
    res({ checkIn: '2026-11-12', tourLanguage: 'İngilizce', pax: 6 }),
    res({ checkIn: '2026-11-14', tourLanguage: 'İspanyolca' }), res({ checkIn: '2026-11-14', tourId: 'T-OLD', tour: 'Old City', tourLanguage: 'İspanyolca' }),
  ] });
  assert.equal(s.counts.reservations, 5);
  assert.equal(s.counts.guideServices, 4);
  assert.equal(guideEur(s), 600);
});

test('language normalization: trim/case only; an UNRECOGNIZED value is unresolved per reservation — never merged, never translated', () => {
  const g = buildGuideServices([res({ tourLanguage: '  ispanyolca ' }), res({ tourLanguage: 'İspanyolca' }), res({ tourLanguage: 'Spanish' }), res({ tourLanguage: 'Spanish' })], { languageNames: LANGS });
  assert.equal(g.length, 3, 'one recognized Spanish service + one unresolved service per "Spanish" reservation');
  const odd = g.filter(x => x.languageStatus === 'unrecognized');
  assert.equal(odd.length, 2);
  assert.ok(odd.every(x => x.reservationCount === 1 && x.unresolvedReasons.includes('language_unrecognized') && x.language === 'Spanish'));
  const s = summary({ reservations: [res({ tourLanguage: 'Spanish' }), res({ tourLanguage: 'İspanyolca' })] });
  assert.equal(guideEur(s), 300);
  assert.equal(s.dataQuality.unrecognizedLanguageCount, 1);
  assert.equal(s.dataQuality.missingLanguageCount, 0);
});

test('missing tour is tracked as "Tur bilgisi eksik" — never as "Dil belirtilmemiş"; both counted separately', () => {
  const s = summary({ reservations: [
    res({ tourId: null, tour: 'Manual', tourLanguage: 'İspanyolca' }),
    res({ tourId: null, tour: 'Manual', tourLanguage: 'İspanyolca' }),
    res({ tourLanguage: '' }),
    res({ tourId: null, tourLanguage: '' }),
  ] });
  assert.equal(s.counts.guideServices, 4, 'each unresolved reservation is its own €150 service');
  assert.equal(guideEur(s), 600);
  assert.equal(s.dataQuality.missingTourCount, 3);
  assert.equal(s.dataQuality.missingLanguageCount, 2);
  const tourOnly = s.guideServices.filter(g => g.unresolvedReasons.length === 1 && g.unresolvedReasons[0] === 'tour_missing');
  assert.equal(tourOnly.length, 2);
  assert.ok(!tourOnly.some(g => g.unresolvedReasons.includes('language_missing')));
  const both = s.guideServices.find(g => g.unresolvedReasons.length === 2);
  assert.deepEqual(both.unresolvedReasons, ['tour_missing', 'language_missing']);
});

test('correcting a missing tour consolidates the service automatically', () => {
  const before = summary({ reservations: [res({ id: 'M1', tourId: null }), res({ id: 'M2' })] });
  const after = summary({ reservations: [res({ id: 'M1' }), res({ id: 'M2' })] });
  assert.equal(guideEur(before), 300);
  assert.equal(guideEur(after), 150);
});

test('blank-language reservations are separate unresolved services (one €150 each), flagged, never merged', () => {
  const s = summary({ reservations: [res({ tourLanguage: '' }), res({ tourLanguage: null }), res({ tourLanguage: 'İspanyolca' })] });
  assert.equal(s.counts.guideServices, 3);
  assert.equal(s.counts.unresolvedGuideServices, 2);
  assert.equal(guideEur(s), 450);
  assert.equal(s.dataQuality.missingLanguageCount, 2);
  assert.equal(s.dataQuality.missingTourCount, 0);
  assert.ok(s.guideServices.filter(g => g.unresolvedReason === 'language_missing').every(g => g.reservationCount === 1));
});

test('once language is corrected the services consolidate automatically', () => {
  const before = summary({ reservations: [res({ id: 'X1', tourLanguage: '' }), res({ id: 'X2', tourLanguage: 'İspanyolca' })] });
  const after = summary({ reservations: [res({ id: 'X1', tourLanguage: 'İspanyolca' }), res({ id: 'X2', tourLanguage: 'İspanyolca' })] });
  assert.equal(guideEur(before), 300);
  assert.equal(guideEur(after), 150);
});

test('cancelled-only group disappears; mixed active/cancelled group stays ONE €150 service', () => {
  assert.equal(summary({ reservations: [res({ opStatus: 'İptal', statusRaw: 'cancelled' })] }).counts.guideServices, 0);
  const s = summary({ reservations: [res(), res({ opStatus: 'İptal', statusRaw: 'cancelled' })] });
  assert.equal(s.counts.guideServices, 1);
  assert.equal(guideEur(s), 150);
  assert.equal(s.counts.cancelledExcluded, 1);
});

test('guide-service counts aggregate by tour and by date', () => {
  const s = summary({ reservations: [res(), res({ tourLanguage: 'İngilizce' }), res({ checkIn: '2026-11-20' }), res({ tourId: 'T-OLD', tour: 'Old City' })] });
  const top = s.tours.find(t => t.tourId === 'T-TOP');
  assert.equal(top.guideServices, 3);
  assert.equal(eur(top.guide), 450);
  assert.equal(s.tours.find(t => t.tourId === 'T-OLD').guideServices, 1);
  assert.equal(new Set(s.guideServices.filter(g => g.date === '2026-11-12').map(g => g.key)).size, 3);
});

// ── Guide actual / commitment ────────────────────────────────────────────

const gp = (o) => ({ id: 'GP' + Math.random(), resId: null, amount: 150, currency: 'EUR', statusRaw: 'pending', ...o });

test('pending guide payment REPLACES the forecast (commitment), never added to it', () => {
  const a = res({ id: 'A' }), b = res({ id: 'B' });
  const s = summary({ reservations: [a, b], guidePayments: [gp({ resId: 'A', amount: 160, statusRaw: 'pending' })] });
  const g = s.guideServices[0];
  assert.equal(g.state, 'committed');
  assert.equal(eur(g.best), 160);
  assert.equal(eur(s.categories.guide.remaining), 160);
});

test('paid guide payment replaces the forecast, becomes actual, and is not remaining budget', () => {
  const s = summary({ reservations: [res({ id: 'A' }), res({ id: 'B' })], guidePayments: [gp({ resId: 'A', amount: 150, statusRaw: 'paid' })] });
  assert.equal(s.guideServices[0].state, 'actual');
  assert.equal(eur(s.categories.guide.actual), 150);
  assert.equal(eur(s.categories.guide.remaining), 0);
});

test('cancelled guide payment is ignored (forecast stays)', () => {
  const s = summary({ reservations: [res({ id: 'A' })], guidePayments: [gp({ resId: 'A', statusRaw: 'cancelled' })] });
  assert.equal(s.guideServices[0].state, 'forecast');
  assert.equal(eur(s.categories.guide.remaining), 150);
});

test('one guide payment is never counted once per reservation sharing the service', () => {
  const s = summary({ reservations: [res({ id: 'A', pax: 8 }), res({ id: 'B', pax: 12 })], guidePayments: [gp({ id: 'GP1', resId: 'A', statusRaw: 'paid' })] });
  assert.equal(eur(s.categories.guide.actual), 150);
  assert.equal(s.guideServices[0].paymentIds.length, 1);
  // duplicate row with the same id is still counted once
  const dup = summary({ reservations: [res({ id: 'A' })], guidePayments: [gp({ id: 'GPX', resId: 'A', statusRaw: 'paid' }), gp({ id: 'GPX', resId: 'A', statusRaw: 'paid' })] });
  assert.equal(eur(dup.categories.guide.actual), 150);
});

test('multiple real guide payments in one service are each counted once and flagged', () => {
  const s = summary({ reservations: [res({ id: 'A' }), res({ id: 'B' })], guidePayments: [gp({ id: 'P1', resId: 'A', statusRaw: 'paid' }), gp({ id: 'P2', resId: 'B', amount: 50, statusRaw: 'paid' })] });
  assert.equal(eur(s.categories.guide.actual), 200);
  assert.equal(s.guideServices[0].multiPayment, true);
  assert.equal(s.dataQuality.multiPaymentGuideServices, 1);
});

test('unattributed guide payment stays in its own bucket, never allocated', () => {
  const s = summary({ reservations: [res({ id: 'A' })], guidePayments: [gp({ id: 'LOOSE', resId: null, amount: 70, statusRaw: 'paid' })] });
  assert.equal(s.unattributedGuidePayments.length, 1);
  assert.equal(eur(s.totals.unattributedGuidePayments), 70);
  assert.equal(eur(s.categories.guide.actual), 0);
  assert.equal(s.guideServices[0].state, 'forecast');
});

test('reservation-level guide allocation is reporting-only by pax share and sums to the group cost', () => {
  const s = summary({ reservations: [res({ id: 'A', pax: 8 }), res({ id: 'B', pax: 12 })] });
  const a = s.reservations.find(r => r.id === 'A').guideAllocation, b = s.reservations.find(r => r.id === 'B').guideAllocation;
  assert.equal(a.reportingOnly, true);
  assert.equal(eur(a.planned), 60);
  assert.equal(eur(b.planned), 90);
  assert.equal(eur(a.planned) + eur(b.planned), 150, 'never 150 per reservation');
  assert.equal(a.sharedLabel, '150 EUR toplam · 2 rezervasyon paylaşıyor');
});

// ── Meals / tickets / catalog ───────────────────────────────────────────

test('meal included = €10 × total pax; unknown = risk, not guessed; not_included = 0', () => {
  const s = summary({ reservations: [res({ mealStatus: 'included', pax: 3, paxChild: 1 }), res({ mealStatus: 'unknown' }), res({ mealStatus: 'not_included' })] });
  assert.equal(eur(s.categories.meal.planned), 40);
  assert.equal(s.dataQuality.unknownMealReservations, 1);
});

test('Topkapı: materialized preparation quantity drives €40; no own pax math; public reference ignored; no Harem charge', () => {
  const r = res({ id: 'A', pax: 7, paxChild: 3 });
  const s = summary({ reservations: [r], rules: [TOP_RULE], preparations: [{ id: 'P', reservationId: 'A', preparationRuleId: 'RULE-TOP', preparationType: 'entrance_ticket', label: 'Topkapı', requiredQuantity: 9, status: 'pending' }] });
  assert.equal(eur(s.categories.ticket.planned), 360, 'uses required_quantity (9), not pax (10), and the internal €40 — never the €99 reference');
});

test('multiple Topkapı reservations aggregate correctly', () => {
  const prep = (id, q) => ({ id: 'P' + id, reservationId: id, preparationRuleId: 'RULE-TOP', preparationType: 'entrance_ticket', requiredQuantity: q, status: 'pending' });
  const s = summary({ reservations: [res({ id: 'A' }), res({ id: 'B' }), res({ id: 'C', checkIn: '2026-11-20' })], rules: [TOP_RULE], preparations: [prep('A', 2), prep('B', 5), prep('C', 3)] });
  assert.equal(eur(s.categories.ticket.planned), 400);
});

test('rule without a materialized preparation = unresolved, not guessed; rule without internal cost = "Maliyet girilmemiş"', () => {
  const s = summary({ reservations: [res({ id: 'A' })], rules: [TOP_RULE] });
  assert.equal(eur(s.categories.ticket.planned), 0);
  assert.equal(s.dataQuality.notMaterializedPreparations, 1);
  const hs = { id: 'RULE-HS', tourId: 'T-TOP', preparationType: 'entrance_ticket', label: 'Ayasofya Giriş Bileti', isActive: true };
  const s2 = summary({ reservations: [res({ id: 'A' })], rules: [hs], preparations: [{ id: 'P', reservationId: 'A', preparationRuleId: 'RULE-HS', requiredQuantity: 2, status: 'pending' }] });
  assert.deepEqual(s2.dataQuality.missingCostItems, [{ label: 'Ayasofya Giriş Bileti', count: 1 }]);
  assert.equal(s2.kpis.remainingBudget.complete, true, 'a missing catalog cost never blocks the rest of the summary');
});

test('a public_reference catalog row never drives a forecast, even when it is the only row', () => {
  const s = buildFinanceMonthSummary({ monthISO: MONTH, todayISO: TODAY, languageNames: LANGS, reservations: [res()], costItems: [{ ...GUIDE, kind: 'public_reference' }], rateRows: RATES });
  assert.equal(guideEur(s), 0);
  assert.deepEqual(s.dataQuality.missingCostItems, [{ label: 'Guide Service', count: 1 }]);
});

// ── Actual expenses ──────────────────────────────────────────────────────

test('recorded actual expense replaces the forecast for that category and is not remaining budget', () => {
  const r = res({ id: 'A', mealStatus: 'included', pax: 4 });
  const s = summary({ reservations: [r], expenses: [{ id: 'E', reservationId: 'A', category: 'meal', totalAmount: 45, currency: 'EUR', tryAmount: 2250 }] });
  assert.equal(eur(s.categories.meal.planned), 40);
  assert.equal(eur(s.categories.meal.actual), 45);
  assert.equal(eur(s.categories.meal.remaining), 0);
  const row = s.reservations[0];
  assert.equal(row.tryView.variance, 250, 'meal actual €45 vs meal plan €40 = +€5 = +250 TRY; the un-actualized guide plan is NOT in the variance');
  assert.equal(summary({ reservations: [res({ id: 'Z' })] }).reservations[0].tryView.variance, null, 'no actual yet → no variance, never fabricated');
});

test('a "guide" reservation expense can never count (guide actual lives only in guide_payments)', () => {
  const s = summary({ reservations: [res({ id: 'A' })], expenses: [{ id: 'E', reservationId: 'A', category: 'guide', totalAmount: 150, currency: 'EUR' }] });
  assert.equal(eur(s.categories.guide.actual), 0);
  assert.equal(eur(s.totals.actualSpend), 0);
});

// ── Revenue ──────────────────────────────────────────────────────────────

test('Civitatis gross / commission / net (same currency)', () => {
  const s = summary({ reservations: [res({ id: 'A', retailAmount: 120, retailCurrency: 'EUR', total: 90, currency: 'EUR' })] });
  const rev = s.reservations[0].revenue;
  assert.equal(rev.isCivitatis, true);
  assert.equal(rev.gross, 120); assert.equal(rev.net, 90);
  assert.equal(rev.commission, 30); assert.equal(rev.commissionStatus, 'ok');
});

test('currency mismatch: commission via fresh ECB rates, else unresolved — never a raw cross-currency subtraction', () => {
  const r = res({ id: 'A', retailAmount: 100, retailCurrency: 'USD', total: 70, currency: 'EUR' });
  const ok = summary({ reservations: [r] }).reservations[0].revenue;
  assert.equal(ok.commissionStatus, 'fx_normalized');
  assert.equal(ok.commission, 100 * 40 - 70 * 50);
  const none = summary({ reservations: [r], rateRows: [] }).reservations[0].revenue;
  assert.equal(none.commissionStatus, 'unresolved_currency');
  assert.equal(none.commission, null);
});

test('direct booking: gross = net, commission 0', () => {
  const rev = summary({ reservations: [res({ total: 500, currency: 'TRY' })] }).reservations[0].revenue;
  assert.equal(rev.commission, 0);
  assert.equal(rev.commissionStatus, 'direct');
});

test('settlement item REPLACES the expected receivable — never both', () => {
  const r = res({ id: 'A', retailAmount: 120, retailCurrency: 'EUR', total: 90, currency: 'EUR', checkIn: '2026-11-02' });
  const s = summary({ reservations: [r], settlementItems: [{ reservationId: 'A', originalAmount: 88, originalCurrency: 'EUR', status: 'claimable' }] });
  assert.equal(eur(s.totals.expectedNet), 88);
  assert.equal(s.reservations[0].revenue.receivable.source, 'settlement');
  assert.equal(s.reservations[0].revenue.receivable.settlementStatus, 'claimable');
  // paid settlement = received cash
  const p = summary({ reservations: [r], settlementItems: [{ reservationId: 'A', originalAmount: 88, originalCurrency: 'EUR', status: 'paid' }] });
  assert.equal(eur(p.totals.received), 88);
  assert.equal(eur(p.totals.expectedNet), 88);
});

test('direct payments: pending/overdue/cancelled are not cash; refund subtracts', () => {
  const r = res({ id: 'A', total: 300 });
  const pay = (o) => ({ id: Math.random(), resId: 'A', amount: 100, currency: 'EUR', statusRaw: 'paid', paymentTypeRaw: 'deposit', ...o });
  const s = summary({ reservations: [r], payments: [
    pay({}), pay({ statusRaw: 'pending' }), pay({ statusRaw: 'overdue' }), pay({ statusRaw: 'cancelled' }),
    pay({ paymentTypeRaw: 'balance', amount: 200 }), pay({ paymentTypeRaw: 'refund', statusRaw: 'refunded', amount: 50 }),
  ] });
  assert.equal(eur(s.totals.received), 250);
});

// ── Remaining budget, dates, FX ──────────────────────────────────────────

test('remaining budget excludes past services/costs and already-paid obligations; future months include everything active', () => {
  const s = summary({ reservations: [
    res({ id: 'PAST', checkIn: '2026-11-05', mealStatus: 'included' }),
    res({ id: 'FUT', checkIn: '2026-11-25', mealStatus: 'included' }),
  ] });
  assert.equal(eur(s.categories.guide.planned), 300);
  assert.equal(eur(s.categories.guide.remaining), 150);
  assert.equal(eur(s.categories.meal.remaining), 20);
  assert.equal(s.dataQuality.missingActualGuideCost, 1);
  const dec = buildFinanceMonthSummary({ monthISO: '2026-12', todayISO: TODAY, languageNames: LANGS, costItems: [GUIDE], rateRows: RATES, reservations: [res({ checkIn: '2026-12-03' }), res({ checkIn: '2026-12-04' })] });
  assert.equal(eur(dec.totals.remainingBudget), 300);
});

test('a service dated TODAY is still a remaining obligation; yesterday is not', () => {
  const s = summary({ reservations: [res({ checkIn: TODAY }), res({ checkIn: '2026-11-09' })] });
  assert.equal(eur(s.categories.guide.remaining), 150);
});

test('Istanbul date boundary: 22:30 UTC on 9 Nov is already 10 Nov in Istanbul', () => {
  assert.equal(F._istanbulISODate(new Date('2026-11-09T22:30:00Z')), '2026-11-10');
  assert.equal(F._istanbulISODate(new Date('2026-11-09T20:30:00Z')), '2026-11-09');
  assert.match(SOURCE.slice(SOURCE.indexOf('// TESTABLE:_financeDomain:start'), SOURCE.indexOf('// TESTABLE:_financeDomain:end')).replace(/\/\/[^\n]*/g, ''), /^(?![\s\S]*_TODAY_ISO)/);
});

test('month boundaries: check_in on the 1st counts, the 1st of next month does not', () => {
  const s = summary({ reservations: [res({ checkIn: '2026-11-01' }), res({ checkIn: '2026-12-01' }), res({ checkIn: '2026-10-31' })] });
  assert.equal(s.counts.reservations, 1);
});

test('FX: fresh rate normalizes; missing/stale/source error mark totals incomplete — no hardcoded rate', () => {
  const r = [res({ checkIn: '2026-11-20' })];
  const ok = summary({ reservations: r });
  assert.equal(ok.kpis.remainingBudget.tryTotal, 150 * 50);
  assert.equal(ok.fx.incomplete, false);
  const missing = summary({ reservations: r, rateRows: [] });
  assert.equal(missing.kpis.remainingBudget.complete, false);
  assert.deepEqual(missing.fx.unresolvedCurrencies, ['EUR']);
  const stale = summary({ reservations: r, rateRows: [{ baseCurrency: 'EUR', quoteCurrency: 'TRY', rate: 50, rateDate: '2026-10-20' }] });
  assert.equal(stale.kpis.remainingBudget.complete, false);
  const err = summary({ reservations: r, rateSourceError: true });
  assert.equal(err.fx.rateSourceError, true);
  assert.equal(err.kpis.remainingBudget.complete, false);
  assert.deepEqual(err.totals.remainingBudget, { EUR: 150 }, 'original-currency totals survive an FX failure');
  const block = SOURCE.slice(SOURCE.indexOf('// TESTABLE:_financeDomain:start'), SOURCE.indexOf('// TESTABLE:_financeDomain:end'));
  assert.doesNotMatch(block, /_CIVITATIS_FIXED_EUR_TO_TRY_RATE|\b55\b/);
});

test('attributeGuidePayments maps through the reservation only — the payment\'s own tour_id is never used', () => {
  const services = buildGuideServices([res({ id: 'A' })], { languageNames: LANGS });
  const { perService, unattributed } = attributeGuidePayments(services, [gp({ id: 'X', resId: null, tourId: 'T-TOP', statusRaw: 'paid' })]);
  assert.equal(perService.get(services[0].key).length, 0);
  assert.equal(unattributed.length, 1);
});

// ── Phase C corrections ─────────────────────────────────────────────────

const topPrep = (id, status, q = 2) => ({ id: 'P' + id, reservationId: id, preparationRuleId: 'RULE-TOP', preparationType: 'entrance_ticket', label: 'Topkapı', requiredQuantity: q, status });

test('completed ticket preparation WITHOUT a recorded expense: still remaining budget, plan kept, actual 0, flagged', () => {
  const s = summary({ reservations: [res({ id: 'A', checkIn: '2026-11-20' })], rules: [TOP_RULE], preparations: [topPrep('A', 'completed')] });
  assert.equal(eur(s.categories.ticket.planned), 80, 'planned profitability keeps the original forecast');
  assert.equal(eur(s.categories.ticket.remaining), 80, '"Tamamlandı" never implies purchase/payment');
  assert.equal(eur(s.categories.ticket.actual), 0, 'actual comes ONLY from expense rows');
  assert.equal(s.dataQuality.completedTicketWithoutExpense, 1);
});

test('completed ticket preparation WITH a recorded ticket expense: leaves remaining budget, actual = the real amount (not €40×qty)', () => {
  const s = summary({ reservations: [res({ id: 'A', checkIn: '2026-11-20' })], rules: [TOP_RULE], preparations: [topPrep('A', 'completed')],
    expenses: [{ id: 'E', reservationId: 'A', category: 'ticket', totalAmount: 73.5, currency: 'EUR' }] });
  assert.equal(eur(s.categories.ticket.planned), 80);
  assert.equal(eur(s.categories.ticket.remaining), 0);
  assert.equal(eur(s.categories.ticket.actual), 73.5);
  assert.equal(s.dataQuality.completedTicketWithoutExpense, 0);
});

test('pending ticket preparation with no expense: remaining budget, no completion warning', () => {
  const s = summary({ reservations: [res({ id: 'A', checkIn: '2026-11-20' })], rules: [TOP_RULE], preparations: [topPrep('A', 'pending')] });
  assert.equal(eur(s.categories.ticket.remaining), 80);
  assert.equal(s.dataQuality.completedTicketWithoutExpense, 0);
});

test('past guide service without a guide payment is flagged as missing actual cost — never reported as €0 actual', () => {
  const s = summary({ reservations: [res({ id: 'A', checkIn: '2026-11-05', total: 400 })] });
  assert.equal(s.guideServices[0].missingActual, true);
  assert.equal(s.dataQuality.missingActualGuideCost, 1);
  assert.equal(s.realized.status, 'provisional');
  assert.equal(s.realized.statusLabel, 'Geçici / maliyet kayıtları eksik');
  assert.ok(s.realized.missingActualCostCount >= 1);
});

// Earned vs cash

const settled = (status, amount = 88) => ({ reservationId: 'C', originalAmount: amount, originalCurrency: 'EUR', status });
const civ = () => res({ id: 'C', checkIn: '2026-11-05', retailAmount: 120, retailCurrency: 'EUR', total: 90, currency: 'EUR' });

test('completed Civitatis, no settlement yet: earned = net total_amount, cash 0, outstanding = earned', () => {
  const s = summary({ reservations: [civ()], guidePayments: [gp({ resId: 'C', statusRaw: 'paid', amount: 0.01 })] });
  const x = s.reservations[0];
  assert.deepEqual(x.earned.amount, { EUR: 90 });
  assert.equal(x.earned.source, 'civitatis_expected');
  assert.deepEqual(x.received, {});
  assert.deepEqual(x.outstanding, { EUR: 90 });
  assert.equal(x.revenue.commission, 30);
});

test('accrued / claimable / requested settlement = outstanding receivable, NOT cash; replaces (never adds to) the expectation', () => {
  for (const status of ['accrued', 'claimable', 'requested']) {
    const s = summary({ reservations: [civ()], settlementItems: [settled(status)] });
    const x = s.reservations[0];
    assert.deepEqual(x.earned.amount, { EUR: 88 }, status);
    assert.equal(x.earned.source, 'settlement');
    assert.deepEqual(x.received, {}, `${status} is not cash`);
    assert.deepEqual(x.outstanding, { EUR: 88 });
    assert.equal(eur(s.totals.expectedNet), 88, 'never 90 + 88');
  }
});

test('paid settlement = cash received; outstanding 0', () => {
  const s = summary({ reservations: [civ()], settlementItems: [settled('paid')] });
  const x = s.reservations[0];
  assert.deepEqual(x.earned.amount, { EUR: 88 });
  assert.deepEqual(x.received, { EUR: 88 });
  assert.deepEqual(x.outstanding, {});
});

test('completed direct booking: earned = booked total − refunds; cash = paid − refunds; pending/overdue never cash; no double refund', () => {
  const r = res({ id: 'D', checkIn: '2026-11-05', total: 300 });
  const pay = (o) => ({ id: Math.random(), resId: 'D', amount: 100, currency: 'EUR', statusRaw: 'paid', paymentTypeRaw: 'deposit', ...o });
  const s = summary({ reservations: [r], payments: [pay({}), pay({ statusRaw: 'pending' }), pay({ statusRaw: 'overdue' }), pay({ paymentTypeRaw: 'refund', statusRaw: 'refunded', amount: 40 })] });
  const x = s.reservations[0];
  assert.deepEqual(x.earned.amount, { EUR: 260 });
  assert.deepEqual(x.received, { EUR: 60 });
  assert.deepEqual(x.outstanding, { EUR: 200 }, 'outstanding = earned − cash = booked − paid (refund counted once)');
});

test('direct earned revenue that cannot be derived safely is UNRESOLVED — cash is never substituted', () => {
  const zero = summary({ reservations: [res({ id: 'Z', checkIn: '2026-11-05', total: 0 })], payments: [{ id: 'p', resId: 'Z', amount: 100, currency: 'EUR', statusRaw: 'paid', paymentTypeRaw: 'full' }] });
  assert.equal(zero.reservations[0].earned.resolved, false);
  assert.equal(zero.realized.earnedRevenueUnresolvedCount, 1);
  assert.equal(zero.realized.status, 'provisional');
  const fxRefund = summary({ reservations: [res({ id: 'F', checkIn: '2026-11-05', total: 300 })], payments: [{ id: 'p', resId: 'F', amount: 50, currency: 'USD', statusRaw: 'refunded', paymentTypeRaw: 'refund' }] });
  assert.equal(fxRefund.reservations[0].earned.reason, 'refund_currency_mismatch');
});

test('realized net profit = earned net − actual operating cost (recorded expenses + recorded guide payments); FINAL only when coverage is complete', () => {
  const r = res({ id: 'A', checkIn: '2026-11-05', total: 400, mealStatus: 'included', pax: 2 });
  const s = summary({ reservations: [r],
    guidePayments: [gp({ id: 'G1', resId: 'A', amount: 150, statusRaw: 'paid' })],
    expenses: [{ id: 'E1', reservationId: 'A', category: 'meal', totalAmount: 22, currency: 'EUR' }] });
  assert.equal(s.realized.status, 'final');
  assert.equal(s.realized.earnedNetRevenue.tryTotal, 400 * 50);
  assert.equal(s.realized.actualOperatingCost.tryTotal, (150 + 22) * 50);
  assert.equal(s.realized.netProfit, (400 - 172) * 50);
  assert.equal(s.kpis.realizedNetProfit, (400 - 172) * 50);
  assert.equal(s.kpis.realizedNetProfitStatus, 'final');
  assert.equal(s.realized.cashReceived.tryTotal, 0, 'cash is a separate KPI — profit uses earned revenue');
});

test('realized profit never uses the €150 guide forecast or the €40 Topkapı planning amount as actual cost', () => {
  const r = res({ id: 'A', checkIn: '2026-11-05', total: 400 });
  const s = summary({ reservations: [r], rules: [TOP_RULE], preparations: [topPrep('A', 'completed', 2)] });
  assert.equal(s.realized.actualOperatingCost.tryTotal, 0);
  assert.equal(s.realized.status, 'provisional');
  assert.ok(s.realized.missingActualCostCount >= 2, 'missing guide payment + missing ticket expense');
  assert.equal(s.dataQuality.missingActualExpenseCount, 1);
});

test('pending guide payment on a past service counts as recorded (incurred) cost, not forecast', () => {
  const s = summary({ reservations: [res({ id: 'A', checkIn: '2026-11-05', total: 400 })], guidePayments: [gp({ resId: 'A', amount: 140, statusRaw: 'pending' })] });
  assert.equal(s.realized.actualOperatingCost.tryTotal, 140 * 50);
  assert.equal(s.guideServices[0].missingActual, false);
  assert.equal(eur(s.categories.guide.actual), 0, '"actual" guide spend (paid) stays separate from incurred');
});

test('future reservations never enter the realized view', () => {
  const s = summary({ reservations: [res({ id: 'A', checkIn: '2026-11-25', total: 400 })] });
  assert.equal(s.realized.reservations, 0);
  assert.equal(s.realized.earnedNetRevenue.tryTotal, 0);
  assert.equal(s.realized.status, 'final');
});

// Catalog: provisional vs public reference

test('a provisional internal cost drives the forecast and is surfaced as provisional; a public reference on the same rule never does', () => {
  const HS_RULE = { id: 'RULE-HS', tourId: 'T-TOP', preparationType: 'entrance_ticket', label: 'Ayasofya Giriş Bileti', isActive: true };
  const prep = { id: 'PH', reservationId: 'A', preparationRuleId: 'RULE-HS', preparationType: 'entrance_ticket', requiredQuantity: 3, status: 'pending' };
  const pub = { id: 'HS-PUB', kind: 'public_reference', isActive: true, category: 'ticket', basis: 'preparation_rule', amount: 25, currency: 'EUR', tourId: 'T-TOP', preparationRuleId: 'RULE-HS', validFrom: '2026-11-11' };
  const onlyPub = summary({ reservations: [res({ id: 'A' })], rules: [HS_RULE], preparations: [prep], costItems: [GUIDE, MEAL, pub] });
  assert.equal(eur(onlyPub.categories.ticket.planned), 0);
  assert.deepEqual(onlyPub.dataQuality.missingCostItems, [{ label: 'Ayasofya Giriş Bileti', count: 1 }], 'shows "Maliyet girilmemiş"');
  const prov = { ...pub, id: 'HS-INT', kind: 'internal', isProvisional: true, label: 'Hagia Sophia Visitor Gallery', validFrom: '2026-01-01' };
  const withProv = summary({ reservations: [res({ id: 'A' })], rules: [HS_RULE], preparations: [prep], costItems: [GUIDE, MEAL, pub, prov] });
  assert.equal(eur(withProv.categories.ticket.planned), 75);
  assert.deepEqual(withProv.dataQuality.provisionalCostItemsUsed, [{ label: 'Hagia Sophia Visitor Gallery', count: 1 }]);
});

test('a TRY public reference (₺2,750 Topkapı tariff) never replaces the internal €40', () => {
  const pubTry = { ...TOP_PUBLIC, id: 'T-PUB-TRY', amount: 2750, currency: 'TRY' };
  const s = summary({ reservations: [res({ id: 'A' })], rules: [TOP_RULE], preparations: [topPrep('A', 'pending', 3)], costItems: [GUIDE, MEAL, TOP_COST, pubTry] });
  assert.deepEqual(s.categories.ticket.planned, { EUR: 120 });
});

// ── Phase E: group-level P&L ────────────────────────────────────────────

test('group P&L: guide counted ONCE per service (not per reservation allocation), ticket/meal summed over reservations', () => {
  const s = summary({ reservations: [res({ id: 'A', pax: 8, mealStatus: 'included' }), res({ id: 'B', pax: 12 })], rules: [TOP_RULE],
    preparations: [topPrep('A', 'pending', 8), topPrep('B', 'pending', 12)] });
  assert.equal(s.groups.length, 1);
  const g = s.groups[0];
  assert.deepEqual(g.plannedCost, { EUR: 150 + 20 * 40 + 8 * 10 });
  assert.equal(g.reservations, 2);
  assert.equal(g.actualStatus, 'not_yet');
  assert.equal(g.varianceTry, null);
});

test('group variance is like-for-like: only categories with recorded actuals + the guide once', () => {
  const s = summary({ reservations: [res({ id: 'A', checkIn: '2026-11-05', mealStatus: 'included', pax: 4 }), res({ id: 'B', checkIn: '2026-11-05', mealStatus: 'included', pax: 2 })],
    expenses: [{ id: 'E', reservationId: 'A', category: 'meal', totalAmount: 35, currency: 'EUR' }],
    guidePayments: [gp({ id: 'G', resId: 'B', amount: 160, statusRaw: 'paid' })] });
  const g = s.groups[0];
  assert.deepEqual(g.varianceMap, { EUR: (35 - 40) + (160 - 150) }, 'B\'s un-actualized meal plan is not in the variance');
  assert.equal(g.varianceTry, 5 * 50);
  assert.equal(g.actualStatus, 'provisional', 'B has a planned meal without a recorded expense');
});

test('reservation variance is also available in original currencies', () => {
  const s = summary({ reservations: [res({ id: 'A', mealStatus: 'included', pax: 4 })], expenses: [{ id: 'E', reservationId: 'A', category: 'meal', totalAmount: 45, currency: 'EUR' }] });
  assert.deepEqual(s.reservations[0].varianceMap, { EUR: 5 });
});

test('tour subgroups carry the group P&L', () => {
  const s = summary({ reservations: [res({ id: 'A' }), res({ id: 'B', tourLanguage: 'İngilizce' })] });
  const t = s.tours.find(x => x.tourId === 'T-TOP');
  assert.equal(t.subgroups.length, 2);
  assert.ok(t.subgroups.every(sg => sg.pnl && sg.pnl.key === sg.key));
});
