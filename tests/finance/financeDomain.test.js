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

test('a public_reference catalog row never drives a forecast — the guide obligation stays the fixed rule', () => {
  const s = buildFinanceMonthSummary({ monthISO: MONTH, todayISO: TODAY, languageNames: LANGS, reservations: [res()], costItems: [{ ...GUIDE, kind: 'public_reference', amount: 999 }], rateRows: RATES });
  assert.equal(guideEur(s), 150);
  assert.deepEqual(s.dataQuality.missingCostItems, []);
  assert.equal(s.dataQuality.guideCatalogMissing, 1, 'no internal catalog row is reported, never used');
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

test('realized net profit = earned net − actual operating cost (recorded expenses + the fixed guide obligation of past operations); FINAL only when coverage is complete', () => {
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

test('realized guide cost is the fixed obligation whether or not the guide payment exists or matches', () => {
  const base = (pays) => summary({ reservations: [res({ id: 'A', checkIn: '2026-11-05', total: 400 })], guidePayments: pays });
  for (const pays of [[], [gp({ id: 'G', resId: 'A', amount: 90, statusRaw: 'paid' })], [gp({ id: 'G', resId: 'A', amount: 150, statusRaw: 'pending' })]]) {
    assert.equal(base(pays).realized.actualOperatingCost.tryTotal, 150 * 50, JSON.stringify(pays));
  }
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

test('tour-scoped provisional per-guest cost in TRY (Bosphorus ₺340) applies per guest, keeps TRY, is flagged provisional; its public reference does not double it', () => {
  const BOS = { id: 'BOS', kind: 'internal', isActive: true, isProvisional: true, label: 'Bosphorus Cruise', category: 'transport', basis: 'per_guest', amount: 340, currency: 'TRY', tourId: 'T-BOS', preparationRuleId: null, validFrom: '2026-01-01' };
  const BOS_PUB = { ...BOS, id: 'BOS-PUB', kind: 'public_reference', isProvisional: false };
  const s = summary({ reservations: [res({ id: 'A', tourId: 'T-BOS', tour: 'Bosforo', pax: 3, paxChild: 1 })], costItems: [GUIDE, MEAL, BOS, BOS_PUB] });
  assert.deepEqual(s.categories.transport.planned, { TRY: 1360 });
  assert.deepEqual(s.dataQuality.provisionalCostItemsUsed, [{ label: 'Bosphorus Cruise', count: 1 }]);
});

// ══════════════════════════════════════════════════════════════════════════
// CONFIRMED BUSINESS RULE: one non-cancelled operation group
// (date + tour + language) = exactly one fixed €150 guide operation cost.
// Guide assignment, reservation count and guide payments never change it.
// ══════════════════════════════════════════════════════════════════════════
const grp = (s) => s.guideServices.filter(g => !g.unresolvedReason);
const op = (s, date, tourId, lang) => s.guideServices.find(g => g.date === date && g.tourId === tourId && g.language === lang);

test('[1] first reservation creates exactly one €150 cost', () => {
  const s = summary({ reservations: [res({ id: 'R1' })] });
  assert.equal(s.guideServices.length, 1);
  assert.deepEqual(s.guideServices[0].planned, { EUR: 150 });
});

test('[2][3] more reservations with the same key add nothing — still exactly €150', () => {
  assert.equal(guideEur(summary({ reservations: [res({ id: 'R1' }), res({ id: 'R2' })] })), 150);
  assert.equal(guideEur(summary({ reservations: Array.from({ length: 7 }, (_, i) => res({ id: 'M' + i, pax: 9 })) })), 150);
});

test('[4] no assigned guide does not prevent the cost; the group is flagged unassigned', () => {
  const s = summary({ reservations: [res({ id: 'R1', guideId: null, guide: '' })] });
  assert.equal(guideEur(s), 150);
  assert.deepEqual(s.guideServices[0].guideNames, []);
  assert.equal(s.guideServices[0].unassignedReservations, 1);
  assert.equal(s.dataQuality.unassignedGuideServices, 1);
});

test('[5] assigning, changing or removing a guide never changes the group cost', () => {
  const variants = [
    [res({ id: 'R1', guideId: 'G1', guide: 'Ayşe' }), res({ id: 'R2', guideId: 'G1', guide: 'Ayşe' })],
    [res({ id: 'R1', guideId: 'G2', guide: 'Mehmet' }), res({ id: 'R2', guideId: 'G1', guide: 'Ayşe' })],
    [res({ id: 'R1', guideId: null, guide: '' }), res({ id: 'R2', guideId: null, guide: '' })],
  ];
  for (const v of variants) assert.equal(guideEur(summary({ reservations: v })), 150);
  const mixed = summary({ reservations: variants[1] });
  assert.deepEqual(mixed.guideServices[0].guideNames.sort(), ['Ayşe', 'Mehmet']);
});

test('[owner table] R1–R5: Nov 12 Topkapı ES ×3 (assigned / assigned / unassigned) = €150, ES/IT and Nov 13 separate → €450 total', () => {
  const s = summary({ reservations: [
    res({ id: 'R1', checkIn: '2026-11-12', tourLanguage: 'İspanyolca', guideId: 'G1', guide: 'Ayşe' }),
    res({ id: 'R2', checkIn: '2026-11-12', tourLanguage: 'İspanyolca', guideId: 'G1', guide: 'Ayşe' }),
    res({ id: 'R3', checkIn: '2026-11-12', tourLanguage: 'İspanyolca', guideId: null, guide: '' }),
    res({ id: 'R4', checkIn: '2026-11-12', tourLanguage: 'İtalyanca', guideId: null, guide: '' }),
    res({ id: 'R5', checkIn: '2026-11-13', tourLanguage: 'İspanyolca', guideId: 'G2', guide: 'Mehmet' }),
  ] });
  assert.equal(s.counts.guideServices, 3);
  assert.equal(guideEur(s), 450);
  assert.equal(op(s, '2026-11-12', 'T-TOP', 'İspanyolca').reservationCount, 3);
});

test('[6][7][8] different language / tour / date each create a separate €150', () => {
  assert.equal(guideEur(summary({ reservations: [res(), res({ tourLanguage: 'İngilizce' })] })), 300);
  assert.equal(guideEur(summary({ reservations: [res(), res({ tourId: 'T-OLD', tour: 'Old City' })] })), 300);
  assert.equal(guideEur(summary({ reservations: [res(), res({ checkIn: '2026-11-13' })] })), 300);
});

test('[9] cancelling one reservation while another remains keeps the €150', () => {
  const s = summary({ reservations: [res({ id: 'R1' }), res({ id: 'R2', opStatus: 'İptal', statusRaw: 'cancelled' })] });
  assert.equal(guideEur(s), 150);
  assert.equal(s.guideServices[0].reservationCount, 1, 'only non-cancelled reservations are counted');
  assert.equal(s.cancelledGroups.length, 0);
});

test('[10] cancelling the final reservation cancels the charge — kept as an auditable cancelled group, nothing deleted', () => {
  const s = summary({ reservations: [res({ id: 'R1', opStatus: 'İptal', statusRaw: 'cancelled' }), res({ id: 'R2', opStatus: 'İptal', statusRaw: 'cancelled' })] });
  assert.equal(guideEur(s), 0);
  assert.equal(s.counts.guideServices, 0);
  assert.equal(s.cancelledGroups.length, 1);
  assert.deepEqual(s.cancelledGroups[0].cost, {});
  assert.equal(s.cancelledGroups[0].reservations, 2);
});

test('[11] a new reservation on a previously cancelled group restores exactly one €150', () => {
  const s = summary({ reservations: [res({ id: 'R1', opStatus: 'İptal', statusRaw: 'cancelled' }), res({ id: 'R2', opStatus: 'İptal', statusRaw: 'cancelled' }), res({ id: 'R3' })] });
  assert.equal(guideEur(s), 150);
  assert.equal(s.counts.guideServices, 1);
  assert.equal(s.cancelledGroups.length, 0);
});

test('[12] completed reservations keep the charge (completion is not cancellation)', () => {
  const s = summary({ reservations: [res({ id: 'R1', checkIn: '2026-11-05', opStatus: 'Tamamlandı', statusRaw: 'completed' })] });
  assert.equal(guideEur(s), 150);
  assert.deepEqual(s.categories.guide.actual, { EUR: 150 }, 'a past operation recognizes the fixed cost');
});

test('[13] rescheduling or changing tour / language recalculates both the old and the new group', () => {
  const before = summary({ reservations: [res({ id: 'R1' }), res({ id: 'R2' })] });
  assert.equal(before.counts.guideServices, 1);
  for (const change of [{ checkIn: '2026-11-20' }, { tourId: 'T-OLD', tour: 'Old City' }, { tourLanguage: 'İngilizce' }]) {
    const after = summary({ reservations: [res({ id: 'R1' }), res({ id: 'R2', ...change })] });
    assert.equal(after.counts.guideServices, 2, JSON.stringify(change));
    assert.equal(guideEur(after), 300);
  }
  // Moving the ONLY reservation away removes the old group and creates the new one — never both charged.
  const moved = summary({ reservations: [res({ id: 'R1', checkIn: '2026-11-20' })] });
  assert.equal(moved.counts.guideServices, 1);
  assert.equal(moved.guideServices[0].date, '2026-11-20');
  assert.equal(guideEur(moved), 150);
});

test('[14] repeated processing is idempotent — same input, same single charge, no duplicates', () => {
  const input = { reservations: [res({ id: 'R1' }), res({ id: 'R2' }), res({ id: 'R3', opStatus: 'İptal', statusRaw: 'cancelled' })], guidePayments: [gp({ id: 'P1', resId: 'R1', statusRaw: 'paid' })] };
  const a = summary(input), b = summary(input), c = summary(JSON.parse(JSON.stringify(input)));
  for (const x of [a, b, c]) { assert.equal(guideEur(x), 150); assert.equal(x.counts.guideServices, 1); }
  assert.deepEqual(JSON.parse(JSON.stringify(a.categories)), JSON.parse(JSON.stringify(b.categories)));
  // duplicate payment rows with the same id are counted once
  const dup = summary({ ...input, guidePayments: [gp({ id: 'P1', resId: 'R1', statusRaw: 'paid' }), gp({ id: 'P1', resId: 'R2', statusRaw: 'paid' })] });
  assert.deepEqual(dup.categories.guide.cashPaid, { EUR: 150 });
});

test('[15] guide payments never add a second cost and never replace the fixed €150', () => {
  for (const pays of [[], [gp({ resId: 'R1', statusRaw: 'pending' })], [gp({ resId: 'R1', statusRaw: 'paid' })], [gp({ resId: 'R1', amount: 160, statusRaw: 'paid' })]]) {
    const s = summary({ reservations: [res({ id: 'R1' }), res({ id: 'R2' })], guidePayments: pays });
    assert.equal(guideEur(s), 150, JSON.stringify(pays));
    assert.deepEqual(s.guideServices[0].best, { EUR: 150 });
  }
});

test('[16] paid vs unpaid guide payments in cash flow; pending is never cash', () => {
  const pend = summary({ reservations: [res({ id: 'R1' })], guidePayments: [gp({ id: 'P', resId: 'R1', statusRaw: 'pending' })] });
  assert.deepEqual(pend.cashFlow.guidePaid, {});
  assert.deepEqual(pend.cashFlow.guidePending, { EUR: 150 });
  assert.equal(pend.guideServices[0].paymentStatus, 'pending');
  assert.deepEqual(pend.guideServices[0].outstanding, { EUR: 150 }, 'pending does not reduce what is still owed');
  assert.deepEqual(pend.categories.guide.remaining, { EUR: 150 });
  const paid = summary({ reservations: [res({ id: 'R1' })], guidePayments: [gp({ id: 'P', resId: 'R1', statusRaw: 'paid' })] });
  assert.deepEqual(paid.cashFlow.guidePaid, { EUR: 150 });
  assert.deepEqual(paid.cashFlow.outflow, { EUR: 150 });
  assert.equal(paid.guideServices[0].paymentStatus, 'paid');
  assert.deepEqual(paid.guideServices[0].outstanding, {});
  assert.deepEqual(paid.categories.guide.remaining, {}, 'a fully paid future operation needs no more cash');
  assert.deepEqual(paid.categories.guide.planned, { EUR: 150 }, 'but its cost stays €150');
  const part = summary({ reservations: [res({ id: 'R1' })], guidePayments: [gp({ id: 'P', resId: 'R1', amount: 100, statusRaw: 'paid' })] });
  assert.equal(part.guideServices[0].paymentStatus, 'partially_paid');
  assert.deepEqual(part.guideServices[0].outstanding, { EUR: 50 });
  assert.deepEqual(part.categories.guide.remaining, { EUR: 50 });
  const none = summary({ reservations: [res({ id: 'R1' })] });
  assert.equal(none.guideServices[0].paymentStatus, 'unpaid');
  const cxl = summary({ reservations: [res({ id: 'R1' })], guidePayments: [gp({ id: 'P', resId: 'R1', statusRaw: 'cancelled' })] });
  assert.equal(cxl.guideServices[0].paymentStatus, 'unpaid', 'a cancelled payment is ignored');
});

test('[15b] conflicting payment records are surfaced as discrepancies, never silently change the €150', () => {
  const over = summary({ reservations: [res({ id: 'R1' })], guidePayments: [gp({ id: 'P', resId: 'R1', amount: 180, statusRaw: 'paid' })] });
  assert.equal(over.guideServices[0].paymentStatus, 'overpaid');
  assert.ok(over.guideServices[0].discrepancies.includes('amount_differs'));
  assert.equal(over.dataQuality.guidePaymentDiscrepancies, 1);
  assert.equal(guideEur(over), 150);
  const fx = summary({ reservations: [res({ id: 'R1' })], guidePayments: [gp({ id: 'P', resId: 'R1', amount: 7500, currency: 'TRY', statusRaw: 'paid' })] });
  assert.ok(fx.guideServices[0].discrepancies.includes('currency_mismatch'));
  assert.equal(fx.guideServices[0].outstanding, null, 'cannot net a TRY payment against a EUR obligation without review');
  assert.deepEqual(fx.cashFlow.guidePaid, { TRY: 7500 });
  const multi = summary({ reservations: [res({ id: 'R1' }), res({ id: 'R2' })], guidePayments: [gp({ id: 'P1', resId: 'R1', amount: 100, statusRaw: 'paid' }), gp({ id: 'P2', resId: 'R2', amount: 50, statusRaw: 'paid' })] });
  assert.equal(multi.guideServices[0].paymentStatus, 'paid');
  assert.ok(multi.guideServices[0].discrepancies.includes('multiple_payments'));
  assert.deepEqual(multi.categories.guide.cashPaid, { EUR: 150 });
});

test('a past operation without any payment: cost is known (€150, realized profit NOT provisional for it), the payment is flagged as outstanding', () => {
  const s = summary({ reservations: [res({ id: 'A', checkIn: '2026-11-05', total: 400 })] });
  assert.equal(s.guideServices[0].missingActual, false);
  assert.equal(s.dataQuality.unpaidPastGuideServices, 1);
  assert.deepEqual(s.categories.guide.outstanding, { EUR: 150 });
  assert.equal(s.realized.actualOperatingCost.tryTotal, 150 * 50);
  assert.equal(s.realized.netProfit, (400 - 150) * 50);
  assert.equal(s.realized.status, 'final');
  assert.deepEqual(s.categories.guide.remaining, {}, 'remaining budget is today onward only');
});

test('unattributed guide payment stays in its own bucket; a payment on a fully cancelled group is flagged for review', () => {
  const loose = summary({ reservations: [res({ id: 'A' })], guidePayments: [gp({ id: 'L', resId: null, amount: 70, statusRaw: 'paid' })] });
  assert.equal(loose.unattributedGuidePayments.length, 1);
  assert.deepEqual(loose.categories.guide.cashPaid, {});
  const cg = summary({ reservations: [res({ id: 'X', opStatus: 'İptal', statusRaw: 'cancelled' })], guidePayments: [gp({ id: 'PX', resId: 'X', statusRaw: 'paid' })] });
  assert.deepEqual(cg.cancelledGroups[0].paymentsToReview, ['PX']);
});

test('unresolved reservations (no tour / blank / unrecognized language) are never merged into a normal group', () => {
  const s = summary({ reservations: [res({ id: 'A' }), res({ id: 'B', tourLanguage: '' }), res({ id: 'C', tourId: null }), res({ id: 'D', tourLanguage: 'Spanish' })] });
  assert.equal(grp(s).length, 1);
  assert.equal(grp(s)[0].reservationCount, 1);
  assert.equal(s.counts.unresolvedGuideServices, 3);
  assert.equal(guideEur(s), 600);
});

test('[17] summary totals equal the sum of the group lines (dashboard ↔ detail consistency)', () => {
  const s = summary({ reservations: [
    res({ id: 'A' }), res({ id: 'B' }), res({ id: 'C', tourLanguage: 'İngilizce' }), res({ id: 'D', checkIn: '2026-11-05' }),
    res({ id: 'E', tourId: 'T-OLD', tour: 'Old City', checkIn: '2026-11-25' }),
  ], guidePayments: [gp({ id: 'P1', resId: 'A', amount: 100, statusRaw: 'paid' }), gp({ id: 'P2', resId: 'C', statusRaw: 'pending' })] });
  const sum = (field) => s.guideServices.reduce((t, g) => t + ((g[field] || {}).EUR || 0), 0);
  assert.equal(eur(s.categories.guide.planned), sum('planned'));
  assert.equal(eur(s.categories.guide.cashPaid), sum('cashPaid'));
  assert.equal(eur(s.categories.guide.outstanding), sum('outstanding'));
  assert.equal(eur(s.categories.guide.remaining), sum('remaining'));
  const tourTotal = s.tours.reduce((t, x) => t + eur(x.guide), 0);
  assert.equal(tourTotal, eur(s.categories.guide.planned), 'tour table = category total');
  const groupTotal = s.groups.reduce((t, x) => t + eur(x.guide.planned), 0);
  assert.equal(groupTotal, eur(s.categories.guide.planned), 'group P&L = category total');
  const alloc = s.reservations.reduce((t, x) => t + eur(x.guideAllocation.planned), 0);
  assert.equal(Math.round(alloc), eur(s.categories.guide.planned), 'reporting allocation sums back to the group total');
});

// ── Fixed €150 is independent of the "Guide Service" catalog row ─────────

const sumGuide = (o) => buildFinanceMonthSummary({ monthISO: MONTH, todayISO: TODAY, languageNames: LANGS, rateRows: RATES, ...o });

test('single source of truth: FINANCE_GUIDE_OPERATION_COST is €150', () => {
  assert.deepEqual({ ...F.FINANCE_GUIDE_OPERATION_COST }, { amount: 150, currency: 'EUR' });
  assert.ok(Object.isFrozen(F.FINANCE_GUIDE_OPERATION_COST));
});

test('catalog item MISSING: an eligible group still generates exactly €150 (past and future)', () => {
  for (const checkIn of ['2026-11-05', '2026-11-20']) {
    const s = sumGuide({ reservations: [res({ checkIn }), res({ checkIn })], costItems: [MEAL] });
    assert.equal(guideEur(s), 150, checkIn);
    assert.deepEqual(s.guideServices[0].planned, { EUR: 150 });
    assert.deepEqual(s.guideServices[0].outstanding, { EUR: 150 });
    assert.equal(s.guideServices[0].costSource, 'fixed_rule');
    assert.deepEqual(s.dataQuality.missingCostItems, [], 'never "Maliyet girilmemiş" for the guide');
    assert.equal(s.dataQuality.guideCatalogMissing, 1);
  }
  const none = sumGuide({ reservations: [res({ checkIn: '2026-11-05' })], costItems: [] });
  assert.deepEqual(none.categories.guide.actual, { EUR: 150 }, 'realized cost recognized even with an empty catalog');
  assert.deepEqual(none.categories.guide.planned, none.guideOperationCost);
});

test('catalog item INACTIVE, expired or deleted does not suppress the cost', () => {
  for (const item of [{ ...GUIDE, isActive: false }, { ...GUIDE, validTo: '2026-10-31' }, { ...GUIDE, validFrom: '2027-01-01' }]) {
    const s = sumGuide({ reservations: [res()], costItems: [item, MEAL] });
    assert.equal(guideEur(s), 150, JSON.stringify(item));
    assert.equal(s.dataQuality.guideCatalogMissing, 1);
  }
});

test('catalog item with a WRONG amount or currency cannot change the €150 — the mismatch is reported, not used', () => {
  for (const [item, label] of [[{ ...GUIDE, amount: 90 }, '90 EUR'], [{ ...GUIDE, amount: 300 }, '300 EUR'], [{ ...GUIDE, currency: 'TRY', amount: 150 }, '150 TRY'],
    [{ ...GUIDE, amount: 0 }, '0 EUR'], [{ ...GUIDE, isProvisional: true, amount: 120 }, '120 EUR'], [{ ...GUIDE, id: 'CI-G-TOUR', tourId: 'T-TOP', amount: 200 }, '200 EUR']]) {
    const s = sumGuide({ reservations: [res(), res({ checkIn: '2026-11-20' })], costItems: [item, MEAL] });
    assert.equal(guideEur(s), 300, label);
    assert.deepEqual(Object.keys(s.categories.guide.planned), ['EUR'], 'never converted to the catalog currency');
    assert.deepEqual(s.dataQuality.guideCatalogDiffers, [{ catalog: label, label: item.label || 'Guide Service', count: 2 }]);
    assert.deepEqual(s.dataQuality.provisionalCostItemsUsed, [], 'the catalog row is not "used"');
  }
  const ok = sumGuide({ reservations: [res()], costItems: [{ ...GUIDE, label: 'Guide Service' }, MEAL] });
  assert.equal(ok.dataQuality.guideCatalogMissing, 0);
  assert.deepEqual(ok.dataQuality.guideCatalogDiffers, []);
});

// ── A5: R-2026-0040 + R-2026-0041 = ONE group, one payment counted once ──

const a5 = () => [
  res({ id: 'R40', resNumber: 'R-2026-0040', checkIn: '2026-11-06', tourId: 'T-TOP', tour: 'Topkapı', tourLanguage: 'İspanyolca', pax: 2 }),
  res({ id: 'R41', resNumber: 'R-2026-0041', checkIn: '2026-11-06', tourId: 'T-TOP', tour: 'Topkapı', tourLanguage: ' ispanyolca', pax: 3 }),
];

test('A5: R-2026-0040 and R-2026-0041 (6 Nov, Topkapı, Spanish) form ONE operation group with ONE €150', () => {
  const s = summary({ reservations: a5() });
  assert.equal(s.counts.guideServices, 1);
  assert.equal(s.guideServices[0].reservationCount, 2);
  assert.deepEqual(s.guideServices[0].reservationIds.slice().sort(), ['R40', 'R41']);
  assert.equal(guideEur(s), 150, 'two reservations never create a second €150');
});

test('A5: one guide payment linked to EITHER reservation reconciles once against the single group obligation', () => {
  for (const resId of ['R40', 'R41']) {
    const s = summary({ reservations: a5(), guidePayments: [gp({ id: 'A5', resId, amount: 150, statusRaw: 'paid' })] });
    const g = s.guideServices[0];
    assert.equal(s.counts.guideServices, 1, resId);
    assert.deepEqual(g.paymentIds, ['A5']);
    assert.equal(g.paymentStatus, 'paid');
    assert.deepEqual(g.outstanding, {}, 'nothing left to pay');
    assert.deepEqual(g.discrepancies, [], 'not a shared / multi-group payment, no discrepancy');
    assert.equal(g.multiPayment, false);
    assert.deepEqual(s.cashFlow.guidePaid, { EUR: 150 }, 'counted exactly once in cash out');
    assert.deepEqual(s.categories.guide.cashPaid, { EUR: 150 });
    assert.equal(guideEur(s), 150);
    assert.equal(s.unattributedGuidePayments.length, 0);
    assert.equal(s.dataQuality.multiPaymentGuideServices, 0);
    assert.equal(s.dataQuality.guidePaymentDiscrepancies, 0);
    const grpRow = s.groups.find(x => x.key === g.key);
    assert.deepEqual(grpRow.guide.cashPaid, { EUR: 150 });
    const both = s.reservations.filter(r => r.id === 'R40' || r.id === 'R41');
    assert.ok(both.every(r => r.guideAllocation.serviceKey === g.key), 'both reservations point at the same group');
  }
});

test('the same payment row delivered twice (duplicate id) is still counted once', () => {
  const p = gp({ id: 'A5', resId: 'R41', amount: 150, statusRaw: 'paid' });
  const s = summary({ reservations: a5(), guidePayments: [p, { ...p }] });
  assert.deepEqual(s.guideServices[0].paymentIds, ['A5']);
  assert.deepEqual(s.cashFlow.guidePaid, { EUR: 150 });
});

test('one payment linked to one reservation of a multi-reservation group reconciles once against the group\'s single €150', () => {
  const rs = [res({ id: 'M1' }), res({ id: 'M2' }), res({ id: 'M3' }), res({ id: 'M4' })];
  const s = summary({ reservations: rs, guidePayments: [gp({ id: 'PM', resId: 'M3', amount: 150, statusRaw: 'paid' })] });
  assert.equal(s.counts.guideServices, 1);
  const g = s.guideServices[0];
  assert.equal(g.reservationCount, 4);
  assert.deepEqual(g.planned, { EUR: 150 });
  assert.deepEqual(g.paymentIds, ['PM']);
  assert.equal(g.paymentStatus, 'paid');
  assert.deepEqual(g.outstanding, {});
  assert.deepEqual(g.discrepancies, []);
  assert.deepEqual(s.cashFlow.guidePaid, { EUR: 150 });
  const partial = summary({ reservations: rs, guidePayments: [gp({ id: 'PM', resId: 'M1', amount: 100, statusRaw: 'paid' })] });
  assert.equal(partial.guideServices[0].paymentStatus, 'partially_paid');
  assert.deepEqual(partial.guideServices[0].outstanding, { EUR: 50 }, 'outstanding is against the ONE group obligation, not 4 × €150');
});

test('consistency after the fix: summary totals = group lines = tour table, with and without a catalog row; cancelled groups carry no cost', () => {
  const rows = [...a5(), res({ id: 'C1', checkIn: '2026-11-08', tourLanguage: 'İngilizce' }), res({ id: 'X1', checkIn: '2026-11-09', tourLanguage: 'İtalyanca', opStatus: 'İptal', statusRaw: 'cancelled' })];
  const pays = [gp({ id: 'A5', resId: 'R40', amount: 150, statusRaw: 'paid' }), gp({ id: 'PX', resId: 'X1', amount: 150, statusRaw: 'paid' })];
  const withCat = summary({ reservations: rows, guidePayments: pays });
  const noCat = sumGuide({ reservations: rows, guidePayments: pays, costItems: [] });
  for (const s of [withCat, noCat]) {
    assert.equal(guideEur(s), 300);
    const sum = (f) => s.guideServices.reduce((t, g) => t + eur(g[f]), 0);
    assert.equal(eur(s.categories.guide.planned), sum('planned'));
    assert.equal(eur(s.categories.guide.outstanding), sum('outstanding'));
    assert.equal(eur(s.categories.guide.cashPaid), 150, 'cancelled-group payment is not cash against an active obligation');
    assert.equal(s.tours.reduce((t, x) => t + eur(x.guide), 0), 300);
    assert.equal(s.groups.reduce((t, x) => t + eur(x.guide.planned), 0), 300);
    assert.equal(s.cancelledGroups.length, 1);
    assert.deepEqual(s.cancelledGroups[0].cost, {});
    assert.deepEqual(s.cancelledGroups[0].paymentsToReview, ['PX']);
  }
  assert.deepEqual(withCat.categories.guide, noCat.categories.guide, 'the catalog row changes nothing');
});

// ── Payment attribution through cancelled reservations ──────────────────

const r40 = (o) => res({ id: 'R40', resNumber: 'R-2026-0040', checkIn: '2026-11-06', tourId: 'T-TOP', tour: 'Topkapı', tourLanguage: 'İspanyolca', ...o });
const r41 = (o) => res({ id: 'R41', resNumber: 'R-2026-0041', checkIn: '2026-11-06', tourId: 'T-TOP', tour: 'Topkapı', tourLanguage: 'İspanyolca', ...o });
const CXL = { opStatus: 'İptal', statusRaw: 'cancelled' };
// Realistic timestamps: both booked on 1 Oct; R40 cancelled on 20 Oct.
const BOOKED = '2026-10-01T09:00:00Z', CXL_AT = '2026-10-20T10:00:00Z', LATER = '2026-10-25T08:00:00Z';
const cxl = (at) => ({ ...CXL, cancelledAt: at || CXL_AT });

test('Scenario A: R-2026-0040 cancelled, R-2026-0041 active, payment linked to R-2026-0040 → settles the ONE active group once', () => {
  for (const [amount, status, outstanding] of [[150, 'paid', {}], [100, 'partially_paid', { EUR: 50 }]]) {
    const s = summary({ reservations: [r40({ ...cxl(), createdAtTs: BOOKED }), r41({ createdAtTs: BOOKED })], guidePayments: [gp({ id: 'A5', resId: 'R40', amount, statusRaw: 'paid' })] });
    assert.equal(s.counts.guideServices, 1, 'exactly one active operation group');
    assert.equal(guideEur(s), 150, 'exactly €150, no duplicate cost');
    const g = s.guideServices[0];
    assert.deepEqual(g.reservationIds, ['R41']);
    assert.deepEqual(g.paymentIds, ['A5'], 'attributed once to that group');
    assert.equal(g.paymentStatus, status);
    assert.deepEqual(g.outstanding, outstanding);
    assert.deepEqual(s.unattributedGuidePayments, [], 'no unmatched payment warning');
    assert.deepEqual(s.totals.unattributedGuidePayments, {});
    assert.deepEqual(s.cancelledGroups, [], 'the group is still active — not a cancelled operation');
    assert.deepEqual(s.cashFlow.guidePaid, { EUR: amount }, 'counted exactly once in cash out');
    assert.deepEqual(s.categories.guide.cashPaid, { EUR: amount });
    assert.deepEqual(s.groups[0].guide.cashPaid, { EUR: amount }, 'group P&L sees the same payment');
  }
});

test('Scenario B: both reservations cancelled, payment linked to R-2026-0040 → no active obligation, payment kept in the cancelled-operation audit and flagged', () => {
  const s = summary({ reservations: [r40(CXL), r41(CXL)], guidePayments: [gp({ id: 'A5', resId: 'R40', amount: 150, statusRaw: 'paid' })] });
  assert.equal(s.counts.guideServices, 0);
  assert.equal(guideEur(s), 0, 'no active €150 obligation');
  assert.deepEqual(s.categories.guide.cashPaid, {}, 'not treated as payment against an active obligation');
  assert.deepEqual(s.categories.guide.outstanding, {});
  assert.equal(s.cancelledGroups.length, 1);
  const cg = s.cancelledGroups[0];
  assert.deepEqual(cg.reservationIds.slice().sort(), ['R40', 'R41']);
  assert.deepEqual(cg.cost, {});
  assert.deepEqual(cg.paymentsToReview, ['A5'], 'flagged for review, not discarded');
  assert.deepEqual(cg.paymentAmount, { EUR: 150 });
  assert.deepEqual(cg.payments, [{ id: 'A5', resId: 'R40', amount: 150, currency: 'EUR', statusRaw: 'paid' }]);
  assert.deepEqual(s.unattributedGuidePayments, [], 'shown once — under the cancelled operation, not also as unmatched');
});

// ── Option B: reactivation after full cancellation ──────────────────────

const reactivated = (pays) => summary({ reservations: [
  r40({ ...cxl('2026-10-20T10:00:00Z'), createdAtTs: BOOKED }), r41({ ...cxl('2026-10-21T10:00:00Z'), createdAtTs: BOOKED }),
  res({ id: 'R99', checkIn: '2026-11-06', tourId: 'T-TOP', tourLanguage: 'ispanyolca', createdAtTs: LATER }),
], guidePayments: pays });

test('[B] reactivation: the earlier payment stays for manual review; the reactivated group starts with its own unpaid €150', () => {
  const s = reactivated([gp({ id: 'A5', resId: 'R40', amount: 150, statusRaw: 'paid' })]);
  assert.equal(s.counts.guideServices, 1);
  assert.equal(guideEur(s), 150, 'exactly one new obligation, never two');
  const g = s.guideServices[0];
  assert.deepEqual(g.reservationIds, ['R99']);
  assert.deepEqual(g.paymentIds, [], 'the old payment does NOT settle the new obligation');
  assert.equal(g.paymentStatus, 'unpaid');
  assert.deepEqual(g.outstanding, { EUR: 150 });
  assert.deepEqual(g.priorPayments, [{ id: 'A5', resId: 'R40', amount: 150, currency: 'EUR', statusRaw: 'paid', reason: 'group_reactivated' }]);
  assert.deepEqual(g.priorAmount, { EUR: 150 });
  assert.ok(g.discrepancies.includes('prior_operation_payment'));
  assert.equal(s.dataQuality.priorOperationPaymentGroups, 1);
  assert.equal(s.dataQuality.guidePaymentDiscrepancies, 0, 'reported separately, not as an amount discrepancy');
  assert.deepEqual(s.unattributedGuidePayments, [], 'not "unmatched"');
  assert.deepEqual(s.cancelledGroups, [], 'the key is active again');
  assert.deepEqual(s.categories.guide.cashPaid, {}, 'not cash against the new obligation');
  assert.deepEqual(s.categories.guide.reviewPayments, { count: 1, paid: { EUR: 150 }, pending: {}, total: { EUR: 150 } }, 'never silently omitted');
  assert.deepEqual(s.cashFlow.guidePaidUnderReview, { EUR: 150 });
  assert.deepEqual(s.groups[0].guide.cashPaid, {});
});

test('[B] a NEW payment for the reactivated group settles it normally; the old one stays under review — nothing double-counted', () => {
  const s = reactivated([gp({ id: 'A5', resId: 'R40', amount: 150, statusRaw: 'paid' }), gp({ id: 'N1', resId: 'R99', amount: 150, statusRaw: 'paid' })]);
  const g = s.guideServices[0];
  assert.deepEqual(g.paymentIds, ['N1']);
  assert.equal(g.paymentStatus, 'paid');
  assert.deepEqual(g.outstanding, {});
  assert.deepEqual(g.priorPayments.map(p => p.id), ['A5']);
  assert.deepEqual(s.categories.guide.cashPaid, { EUR: 150 });
  assert.deepEqual(s.categories.guide.reviewPayments.paid, { EUR: 150 });
  assert.equal(guideEur(s), 150);
});

test('[B] missing timestamps: continuity cannot be proven → the payment goes to review, never auto-carried', () => {
  const s = summary({ reservations: [r40(CXL), r41()], guidePayments: [gp({ id: 'A5', resId: 'R40', amount: 150, statusRaw: 'paid' })] });
  const g = s.guideServices[0];
  assert.equal(guideEur(s), 150);
  assert.deepEqual(g.paymentIds, []);
  assert.equal(g.paymentStatus, 'unpaid');
  assert.equal(g.priorPayments[0].reason, 'continuity_unknown');
  assert.deepEqual(s.unattributedGuidePayments, [], 'visible on its group, not as unmatched');
  // only the cancellation time missing
  const s2 = summary({ reservations: [r40({ ...CXL, createdAtTs: BOOKED }), r41({ createdAtTs: BOOKED })], guidePayments: [gp({ id: 'A5', resId: 'R40', statusRaw: 'paid' })] });
  assert.equal(s2.guideServices[0].priorPayments[0].reason, 'continuity_unknown');
});

test('[B] a reservation restored after its own cancellation is not proof of continuity (its active-since time is unknown)', () => {
  const s = summary({ reservations: [r40({ ...cxl(), createdAtTs: BOOKED }), r41({ createdAtTs: BOOKED, cancelledAt: '2026-10-10T00:00:00Z' })],
    guidePayments: [gp({ id: 'A5', resId: 'R40', amount: 150, statusRaw: 'paid' })] });
  assert.deepEqual(s.guideServices[0].paymentIds, []);
  assert.equal(s.guideServices[0].priorPayments[0].reason, 'continuity_unknown');
});

test('[B] continuity holds if ANY active reservation predates the cancellation, even when newer ones joined later', () => {
  const s = summary({ reservations: [r40({ ...cxl(), createdAtTs: BOOKED }), r41({ createdAtTs: BOOKED }),
    res({ id: 'R99', checkIn: '2026-11-06', tourId: 'T-TOP', tourLanguage: 'İspanyolca', createdAtTs: LATER })],
  guidePayments: [gp({ id: 'A5', resId: 'R40', amount: 150, statusRaw: 'paid' })] });
  assert.deepEqual(s.guideServices[0].paymentIds, ['A5']);
  assert.equal(s.guideServices[0].paymentStatus, 'paid');
  assert.deepEqual(s.guideServices[0].priorPayments, []);
  assert.equal(s.categories.guide.reviewPayments.count, 0);
});

test('[B] chain: cancelled while active, then the group fully cancelled, then reactivated → review (the group was not continuous)', () => {
  const s = summary({ reservations: [r40({ ...cxl('2026-10-20T10:00:00Z'), createdAtTs: BOOKED }), r41({ ...cxl('2026-10-22T10:00:00Z'), createdAtTs: BOOKED }),
    res({ id: 'R99', checkIn: '2026-11-06', tourId: 'T-TOP', tourLanguage: 'İspanyolca', createdAtTs: LATER })],
  guidePayments: [gp({ id: 'A5', resId: 'R40', amount: 150, statusRaw: 'paid' })] });
  assert.deepEqual(s.guideServices[0].paymentIds, []);
  assert.equal(s.guideServices[0].priorPayments[0].reason, 'group_reactivated');
});

test('payments on BOTH a cancelled and an active reservation of the same group: each counted once, flagged as multiple payments', () => {
  const s = summary({ reservations: [r40({ ...cxl(), createdAtTs: BOOKED }), r41({ createdAtTs: BOOKED })], guidePayments: [gp({ id: 'P1', resId: 'R40', amount: 150, statusRaw: 'paid' }), gp({ id: 'P2', resId: 'R41', amount: 150, statusRaw: 'paid' })] });
  const g = s.guideServices[0];
  assert.deepEqual(g.paymentIds.slice().sort(), ['P1', 'P2']);
  assert.equal(guideEur(s), 150, 'never a second cost');
  assert.equal(g.paymentStatus, 'overpaid');
  assert.ok(g.discrepancies.includes('multiple_payments') && g.discrepancies.includes('amount_differs'));
});

test('payment linked to a cancelled reservation with no tour / language stays visible as unmatched (reservation_cancelled)', () => {
  const s = summary({ reservations: [res({ id: 'U1', tourId: null, ...CXL }), res({ id: 'OK' })], guidePayments: [gp({ id: 'PU', resId: 'U1', statusRaw: 'paid' })] });
  assert.deepEqual(s.unattributedGuidePayments.map(p => [p.id, p.reason]), [['PU', 'reservation_cancelled']]);
  assert.deepEqual(s.categories.guide.cashPaid, {});
});

test('attributeGuidePayments without cancelled keys keeps its old contract (backwards compatible)', () => {
  const { perService, unattributed, cancelled } = attributeGuidePayments([{ key: 'K', reservationIds: ['A'] }], [{ id: 'P', resId: 'B', amount: 1, currency: 'EUR', statusRaw: 'paid' }]);
  assert.deepEqual(perService.get('K'), []);
  assert.equal(unattributed[0].reason, 'reservation_not_active');
  assert.deepEqual(cancelled, []);
});

test('cancelled-group listing uses the same key helper as grouping', () => {
  const k = F._financeOperationGroupKey(r40(CXL), LANGS);
  const live = buildGuideServices([r41()], { languageNames: LANGS });
  assert.equal(k.key, live[0].key);
  assert.equal(F._financeOperationGroupKey(res({ id: 'Z', tourLanguage: 'Spanish' }), LANGS).key, 'unresolved:Z');
});

// ── Mixed-currency payments ─────────────────────────────────────────────

test('mixed currency: confirmed EUR outstanding stays in the EUR total; the TRY-paid group is counted separately under review, never converted or dropped', () => {
  const s = summary({ reservations: [res({ id: 'A', checkIn: '2026-11-05' }), res({ id: 'B', checkIn: '2026-11-06' }), res({ id: 'C', checkIn: '2026-11-07' }), res({ id: 'D', checkIn: '2026-11-08' })],
    guidePayments: [gp({ id: 'PA', resId: 'A', amount: 150, statusRaw: 'paid' }), gp({ id: 'PB', resId: 'B', amount: 5000, currency: 'TRY', statusRaw: 'paid' })] });
  const gB = s.guideServices.find(g => g.reservationIds.includes('B'));
  assert.equal(gB.paymentStatus, 'review');
  assert.equal(gB.outstanding, null, 'no invented exchange rate');
  assert.deepEqual(gB.cashPaid, { TRY: 5000 }, 'original currency and amount preserved');
  assert.ok(gB.discrepancies.includes('currency_mismatch'));
  const g = s.categories.guide;
  assert.deepEqual(g.outstanding, { EUR: 300 }, 'C + D confirmed open');
  assert.deepEqual(g.underReview, { groups: 1, obligation: { EUR: 150 }, paid: { TRY: 5000 }, pending: {} });
  assert.deepEqual(g.cashPaid, { EUR: 150, TRY: 5000 }, 'cash keeps original currencies');
  assert.equal(guideEur(s), 600);
});

test('header ↔ detail table: confirmed open + under-review obligation together account for every unpaid group line', () => {
  const s = summary({ reservations: [res({ id: 'A' }), res({ id: 'B', checkIn: '2026-11-13' }), res({ id: 'C', checkIn: '2026-11-14' }), res({ id: 'X', checkIn: '2026-11-15', ...CXL })],
    guidePayments: [gp({ id: 'P1', resId: 'A', amount: 60, statusRaw: 'paid' }), gp({ id: 'P2', resId: 'B', amount: 20, currency: 'USD', statusRaw: 'pending' }), gp({ id: 'PX', resId: 'X', amount: 150, statusRaw: 'paid' })] });
  const rows = s.guideServices;
  const g = s.categories.guide;
  assert.equal(eur(g.outstanding), rows.filter(r => r.outstanding).reduce((t, r) => t + eur(r.outstanding), 0));
  assert.equal(g.underReview.groups, rows.filter(r => r.outstanding === null).length);
  assert.equal(eur(g.underReview.obligation), rows.filter(r => r.outstanding === null).reduce((t, r) => t + eur(r.planned), 0));
  assert.equal(eur(g.planned), rows.reduce((t, r) => t + eur(r.planned), 0));
  assert.deepEqual(g.cashPending, rows.reduce((m, r) => { for (const [c, v] of Object.entries(r.cashPending)) m[c] = (m[c] || 0) + v; return m; }, {}));
  assert.deepEqual(g.cashPaid, { EUR: 60 }, 'cancelled-group payment is never cash against an active obligation');
  assert.deepEqual(s.cancelledGroups[0].paymentsToReview, ['PX']);
  assert.equal(eur(g.outstanding) + eur(g.underReview.obligation), 90 + 150 + 150, 'A: 90 open, B: 150 under review (USD pending), C: 150 open');
});

// ── Guide assignment display ────────────────────────────────────────────

test('a guideId without a resolvable name counts as assigned (name unavailable), never as unassigned', () => {
  const s = summary({ reservations: [res({ id: 'A', guideId: 'G-1' })] });
  assert.equal(s.guideServices[0].assignedWithoutName, 1);
  assert.equal(s.guideServices[0].unassignedReservations, 0);
  assert.equal(s.dataQuality.unassignedGuideServices, 0);
  const none = summary({ reservations: [res({ id: 'B' })] });
  assert.equal(none.dataQuality.unassignedGuideServices, 1);
  assert.equal(none.guideServices[0].unassignedReservations, 1);
});

test('Scenario B also feeds the review total: a fully cancelled operation payment is never silently omitted', () => {
  const s = summary({ reservations: [r40(cxl()), r41(cxl())], guidePayments: [gp({ id: 'A5', resId: 'R40', amount: 150, statusRaw: 'paid' })] });
  assert.deepEqual(s.categories.guide.reviewPayments, { count: 1, paid: { EUR: 150 }, pending: {}, total: { EUR: 150 } });
  assert.deepEqual(s.cashFlow.guidePaidUnderReview, { EUR: 150 });
  assert.deepEqual(s.cashFlow.guidePaid, {});
});

// ── Cross-month guard (operation month, not payment date) ───────────────

test('a payment made on 1 Dec for a 30 Nov operation belongs to November once; December never shows it', () => {
  const R = res({ id: 'N30', checkIn: '2026-11-30' });
  const P = gp({ id: 'GP1', resId: 'N30', amount: 150, statusRaw: 'paid', paymentDate: '2026-12-01' });
  const nov = summary({ reservations: [R], guidePayments: [P] });
  assert.deepEqual(nov.guideServices[0].paymentIds, ['GP1']);
  assert.deepEqual(nov.categories.guide.cashPaid, { EUR: 150 });
  assert.deepEqual(nov.unattributedGuidePayments, []);
  // December loader only fetches linked payments of December reservations.
  const dec = buildFinanceMonthSummary({ monthISO: '2026-12', todayISO: TODAY, languageNames: LANGS, rateRows: RATES, costItems: [GUIDE], reservations: [], guidePayments: [] });
  assert.deepEqual(dec.categories.guide.cashPaid, {});
  assert.deepEqual(dec.unattributedGuidePayments, []);
});
