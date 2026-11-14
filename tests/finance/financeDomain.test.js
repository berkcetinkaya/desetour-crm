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
const { buildGuideServices, attributeGuidePayments } = F;
// Owner rule 2026-11-14: the guide fee is entered at assignment, one per
// tour date + tour + guide. Test reservations get a guide by default (res()),
// and every operation gets a €150 fee "entered at assignment" unless the test
// passes its own fee (or noAutoFees). A fee passed with a plain operation key
// is treated as that operation's entered fee.
const _realBuild = F.buildFinanceMonthSummary;
function autoFees(input) {
  if (input.noAutoFees) return [];
  const given = new Set((input.guideCostOverrides || []).map(o => String(o.operationKey).replace(/^fee\|/, '')));
  const out = new Map();
  for (const r of (input.reservations || [])) {
    if (!r || !r.checkIn) continue;
    const { key, guide } = F._financeOperationGroupKey(r, input.languageNames || LANGS);
    if (guide === 'unassigned' && !key.startsWith('unresolved:')) continue;
    if (given.has(key) || out.has(key)) continue;
    out.set(key, { id: 'FEE-' + key, operationKey: 'fee|' + key, tourDate: String(r.checkIn).slice(0, 10), amount: 150, currency: 'EUR', reason: '' });
  }
  return [...out.values()];
}
function buildFinanceMonthSummary(input) {
  const given = (input.guideCostOverrides || []).map(o => ({ ...o, operationKey: String(o.operationKey).startsWith('fee|') ? o.operationKey : 'fee|' + o.operationKey }));
  return _realBuild({ ...input, guideCostOverrides: [...autoFees(input), ...given] });
}

const LANGS = ['İspanyolca', 'İngilizce', 'Portekizce', 'İtalyanca'];
const TODAY = '2026-11-10';
const MONTH = '2026-11';
let n = 0;
function res(o) {
  n += 1;
  return { id: 'R' + n, resNumber: 'RES-' + n, checkIn: '2026-11-12', tourId: 'T-TOP', tour: 'Topkapı', tourLanguage: 'İspanyolca',
    opStatus: 'Onaylandı', statusRaw: 'confirmed', pax: 2, paxChild: 0, total: 100, currency: 'EUR', guideId: 'G1',
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





test('correcting a missing tour consolidates the service automatically', () => {
  const before = summary({ reservations: [res({ id: 'M1', tourId: null }), res({ id: 'M2' })] });
  const after = summary({ reservations: [res({ id: 'M1' }), res({ id: 'M2' })] });
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

// ── Cash to prepare (Genel Bakış) ───────────────────────────────────────

const { buildFinanceCashNeeds } = F;
const TOP_PREP = (rid, q, st) => ({ id: 'P-' + rid, reservationId: rid, preparationRuleId: 'RULE-TOP', preparationType: 'entrance_ticket', label: 'x', requiredQuantity: q, status: st || 'pending' });
const monthSum = (m, o) => buildFinanceMonthSummary({ monthISO: m, todayISO: TODAY, languageNames: LANGS, costItems: [GUIDE, MEAL, TOP_COST, TOP_PUBLIC], rules: [TOP_RULE], rateRows: RATES, ...o });

test('cash needs: one €150 per operation + entrance tickets, per 7 / 15 / 30-day window from today', () => {
  // TODAY = 2026-11-10 → 7d: 10–16 Nov, 15d: 10–24 Nov, 30d: 10 Nov – 9 Dec
  const resv = [
    res({ id: 'A', checkIn: '2026-11-12', pax: 2 }), res({ id: 'B', checkIn: '2026-11-12', pax: 4 }),   // one group, 6 tickets
    res({ id: 'C', checkIn: '2026-11-20', pax: 3 }),                                                   // 15d
    res({ id: 'D', checkIn: '2026-11-09', pax: 2 }),                                                   // past → excluded
  ];
  const nov = monthSum('2026-11', { reservations: resv, preparations: [TOP_PREP('A', 2), TOP_PREP('B', 4), TOP_PREP('C', 3), TOP_PREP('D', 2)] });
  const dec = monthSum('2026-12', { reservations: [res({ id: 'E', checkIn: '2026-12-05', pax: 1 }), res({ id: 'F', checkIn: '2026-12-10', pax: 1 })], preparations: [TOP_PREP('E', 1), TOP_PREP('F', 1)] });
  const n = buildFinanceCashNeeds({ summaries: [nov, dec, dec], todayISO: TODAY });
  const [w7, w15, w30] = n.windows;
  assert.deepEqual([w7.fromISO, w7.toISO, w15.toISO, w30.toISO], ['2026-11-10', '2026-11-16', '2026-11-24', '2026-12-09']);
  assert.equal(w7.operations, 1);
  assert.deepEqual(w7.guide, { EUR: 150 }, 'two reservations, one operation → one €150');
  assert.deepEqual(w7.tickets, { EUR: 6 * 40 });
  assert.deepEqual(w7.total, { EUR: 390 });
  assert.equal(w7.totalTry.tryTotal, 390 * 50);
  assert.deepEqual(w15.total, { EUR: 390 + 150 + 120 });
  assert.deepEqual(w30.total, { EUR: 390 + 270 + 190 }, 'crosses into December; 10 Dec is outside');
  assert.equal(w30.operations, 3);
  assert.equal(n.operations.length, 3, 'a month summary passed twice is counted once');
});

test('cash needs: paid guide and tickets with a recorded expense are not asked for again; pending guide payment still is', () => {
  const resv = [res({ id: 'A', checkIn: '2026-11-12', pax: 2 }), res({ id: 'B', checkIn: '2026-11-13', pax: 2 })];
  const s = monthSum('2026-11', { reservations: resv, preparations: [TOP_PREP('A', 2), TOP_PREP('B', 2)],
    guidePayments: [gp({ id: 'P', resId: 'A', amount: 150, statusRaw: 'paid' }), gp({ id: 'Q', resId: 'B', amount: 150, statusRaw: 'pending' })],
    expenses: [{ id: 'E', reservationId: 'A', category: 'ticket', totalAmount: 80, currency: 'EUR' }] });
  const n = buildFinanceCashNeeds({ summaries: [s], todayISO: TODAY });
  const a = n.operations.find(o => o.date === '2026-11-12'), b = n.operations.find(o => o.date === '2026-11-13');
  assert.deepEqual(a.guide, {}); assert.deepEqual(a.tickets, {}); assert.deepEqual(a.total, {});
  assert.deepEqual(b.guide, { EUR: 150 }, 'pending is not paid');
  assert.deepEqual(n.windows[0].total, { EUR: 150 + 80 });
});

test('cash needs: partial payment → only the remainder; currency review → full obligation, flagged; unknown ticket cost flagged', () => {
  const resv = [res({ id: 'A', checkIn: '2026-11-12' }), res({ id: 'B', checkIn: '2026-11-13' }), res({ id: 'C', checkIn: '2026-11-14', tourId: 'T-X', tour: 'X' })];
  const rules = [TOP_RULE, { id: 'RULE-X', tourId: 'T-X', preparationType: 'entrance_ticket', label: 'Ayasofya Giriş Bileti', isActive: true }];
  const s = monthSum('2026-11', { reservations: resv, rules,
    preparations: [TOP_PREP('A', 1), TOP_PREP('B', 1), { ...TOP_PREP('C', 2), id: 'PX', preparationRuleId: 'RULE-X' }],
    guidePayments: [gp({ id: 'P', resId: 'A', amount: 100, statusRaw: 'paid' }), gp({ id: 'Q', resId: 'B', amount: 3000, currency: 'TRY', statusRaw: 'paid' })] });
  const n = buildFinanceCashNeeds({ summaries: [s], todayISO: TODAY });
  const [a, b, c] = n.operations;
  assert.deepEqual(a.guide, { EUR: 50 });
  assert.deepEqual(b.guide, { EUR: 150 }); assert.equal(b.guideReview, true);
  assert.deepEqual(c.costGaps.map(g => g.label), ['Ayasofya Giriş Bileti']);
  assert.deepEqual(a.costGaps, []);
  assert.equal(n.windows[0].operationsWithCostGaps, 1);
  assert.equal(n.windows[0].operationsUnderReview, 1);
});

test('cash needs: a ticket rule without a materialized preparation is an unknown amount, flagged', () => {
  const s = monthSum('2026-11', { reservations: [res({ id: 'A', checkIn: '2026-11-12' })], preparations: [] });
  const o = buildFinanceCashNeeds({ summaries: [s], todayISO: TODAY }).operations[0];
  assert.deepEqual(o.costGaps.map(g => g.reason), ['not_materialized']);
  assert.deepEqual(o.tickets, {});
});

test('cash needs: cancelled reservations and fully cancelled operations need no money; TL view incomplete without a rate', () => {
  const s = monthSum('2026-11', { reservations: [res({ id: 'A', checkIn: '2026-11-12', opStatus: 'İptal', statusRaw: 'cancelled' })] });
  const n = buildFinanceCashNeeds({ summaries: [s], todayISO: TODAY });
  assert.equal(n.operations.length, 0);
  assert.deepEqual(n.windows[2].total, {});
  const noFx = buildFinanceMonthSummary({ monthISO: MONTH, todayISO: TODAY, languageNames: LANGS, costItems: [GUIDE], rateRows: [], reservations: [res({ checkIn: '2026-11-12' })] });
  const m = buildFinanceCashNeeds({ summaries: [noFx], todayISO: TODAY });
  assert.equal(m.windows[0].totalTry.complete, false, 'never a made-up TL figure');
  assert.deepEqual(m.windows[0].total, { EUR: 150 });
});

test('tour profitability exposes TL equivalents that explain the profit (net − cost)', () => {
  const s = summary({ reservations: [res({ id: 'G', checkIn: '2026-11-02', tourId: 'T-GB', tour: 'Grand Bazaar', tourLanguage: 'İtalyanca', total: 3600, currency: 'TRY' })] });
  const g = s.groups[0];
  assert.equal(g.projectedCostTry, 150 * 50);
  assert.equal(g.expectedNetTry, 3600);
  assert.equal(g.projectedProfit, 3600 - 150 * 50);
  assert.equal(s.tours[0].totalPlannedTry, 150 * 50);
});

// ── Ek satışlar (extra sales) ───────────────────────────────────────────

const XS = (o) => ({ id: 'XS' + Math.random(), reservationId: 'A', description: 'Lokum', amount: 450, currency: 'TRY', saleDate: '2026-11-12', ...o });

test('extra sales are added to the reservation, group, tour and month net income and to the projected profit; also reported on their own', () => {
  const resv = [res({ id: 'A', checkIn: '2026-11-12', total: 3000, currency: 'TRY' }), res({ id: 'B', checkIn: '2026-11-12', total: 2000, currency: 'TRY' })];
  const base = summary({ reservations: resv });
  const s = summary({ reservations: resv, extraSales: [XS({ id: 'X1' }), XS({ id: 'X2', reservationId: 'B', amount: 20, currency: 'EUR' })] });
  assert.deepEqual(s.totals.extraSales, { TRY: 450, EUR: 20 });
  assert.deepEqual(s.totals.tourNet, { TRY: 5000 });
  assert.deepEqual(s.totals.expectedNet, { TRY: 5450, EUR: 20 });
  assert.equal(s.kpis.extraSales.tryTotal, 450 + 20 * 50);
  assert.equal(s.kpis.expectedNet.tryTotal, 5000 + 450 + 1000);
  assert.equal(s.kpis.projectedProfit - base.kpis.projectedProfit, 450 + 1000, 'profit rises by exactly the extra sales');
  const a = s.reservations.find(x => x.id === 'A');
  assert.deepEqual(a.extraSales, { TRY: 450 }); assert.equal(a.extraSaleCount, 1);
  assert.deepEqual(a.netIncome, { TRY: 3450 });
  assert.equal(s.groups[0].expectedNetTry, 5000 + 450 + 1000);
  assert.deepEqual(s.tours[0].expectedNet, { TRY: 5450, EUR: 20 });
  assert.equal(guideEur(s), 150, 'costs unchanged');
  assert.equal(s.extraSales.items.length, 2);
  for (const it of s.extraSales.items) {
    const r = resv.find(x => x.id === it.reservationId);
    assert.equal(it.reservationRef, r.resNumber);
    assert.equal(it.tourLabel, 'Topkapı');
    assert.equal(it.tourDate, '2026-11-12');
  }
});

test('extra sales: each id once; a sale on a cancelled reservation is not income but is flagged; other months ignored', () => {
  const resv = [res({ id: 'A', checkIn: '2026-11-12', total: 1000, currency: 'TRY' }), res({ id: 'C', checkIn: '2026-11-12', opStatus: 'İptal', statusRaw: 'cancelled' })];
  const x = XS({ id: 'SAME' });
  const s = summary({ reservations: resv, extraSales: [x, { ...x }, XS({ id: 'ONC', reservationId: 'C' }), XS({ id: 'OTHER', reservationId: 'Z' })] });
  assert.deepEqual(s.totals.extraSales, { TRY: 450 });
  assert.equal(s.extraSales.items.length, 1);
  assert.equal(s.extraSales.onCancelledReservations, 1);
});

test('extra sales unavailable (migration not applied yet) is passed through, nothing breaks', () => {
  const s = summary({ reservations: [res({ id: 'A' })], extraSalesUnavailable: true });
  assert.equal(s.extraSales.unavailable, true);
  assert.deepEqual(s.totals.extraSales, {});
  assert.deepEqual(s.extraSales.items, []);
});

// ── Guide cost override (per operation) ─────────────────────────────────

const OV = (key, o) => ({ id: 'OV-' + key, operationKey: key, tourDate: '2026-11-12', amount: 100, currency: 'EUR', reason: 'yarım gün', ...o });


test('payments reconcile against the overridden amount; outstanding and cash needs follow it', () => {
  const resv = [res({ id: 'A', checkIn: '2026-11-12' })];
  const key = summary({ reservations: resv }).guideServices[0].key;
  const s = summary({ reservations: resv, guideCostOverrides: [OV(key)], guidePayments: [gp({ id: 'P', resId: 'A', amount: 100, statusRaw: 'paid' })] });
  assert.equal(s.guideServices[0].paymentStatus, 'paid');
  assert.deepEqual(s.guideServices[0].outstanding, {});
  assert.deepEqual(s.guideServices[0].discrepancies, []);
  const u = summary({ reservations: resv, guideCostOverrides: [OV(key, { amount: 120 })] });
  assert.deepEqual(F.buildFinanceCashNeeds({ summaries: [u], todayISO: TODAY }).windows[0].guide, { EUR: 120 });
  const tr = summary({ reservations: resv, guideCostOverrides: [OV(key, { amount: 5000, currency: 'TRY' })] });
  assert.deepEqual(tr.guideServices[0].planned, { TRY: 5000 });
  assert.equal(tr.kpis.projectedCost.tryTotal >= 5000, true);
});

test('override 0 = no guide cost for that operation ("maliyet yok"), nothing to prepare', () => {
  const resv = [res({ id: 'A', checkIn: '2026-11-12' })];
  const key = summary({ reservations: resv }).guideServices[0].key;
  const s = summary({ reservations: resv, guideCostOverrides: [OV(key, { amount: 0 })] });
  const g = s.guideServices[0];
  assert.deepEqual(g.planned, {});
  assert.equal(g.paymentStatus, 'no_cost');
  assert.deepEqual(g.outstanding, {});
  assert.equal(guideEur(s), 0);
  assert.equal(s.dataQuality.unpaidPastGuideServices, 0);
  assert.deepEqual(F.buildFinanceCashNeeds({ summaries: [s], todayISO: TODAY }).windows[0].guide, {});
  const paid = summary({ reservations: resv, guideCostOverrides: [OV(key, { amount: 0 })], guidePayments: [gp({ id: 'P', resId: 'A', amount: 50, statusRaw: 'paid' })] });
  assert.equal(paid.guideServices[0].paymentStatus, 'overpaid', 'a payment against a zero cost is surfaced');
});


// ── Guide cost by language + salaried what-if ───────────────────────────

const { buildGuideLanguageCosts, _financeCostItemRevisionPlan } = F;

test('language guide costs: operations, days, most on one day, total cost per language; cancelled operations excluded', () => {
  const s = summary({ reservations: [
    res({ id: 'A', checkIn: '2026-11-12' }), res({ id: 'B', checkIn: '2026-11-12', tourId: 'T-OLD', tour: 'Old City' }),   // ES: 2 ops same day
    res({ id: 'C', checkIn: '2026-11-13' }), res({ id: 'D', checkIn: '2026-11-13' }),                                       // ES: 1 op (shared)
    res({ id: 'E', checkIn: '2026-11-14', tourLanguage: 'İtalyanca' }),
    res({ id: 'X', checkIn: '2026-11-15', tourLanguage: 'İtalyanca', opStatus: 'İptal', statusRaw: 'cancelled' }),
  ] });
  const L = buildGuideLanguageCosts(s);
  const es = L.rows.find(r => r.language === 'İspanyolca'), it = L.rows.find(r => r.language === 'İtalyanca');
  assert.deepEqual([es.operations, es.days, es.maxSameDay], [3, 2, 2]);
  assert.deepEqual(es.cost, { EUR: 450 }); assert.equal(es.costTry, 450 * 50); assert.equal(es.avgPerOperationTry, 150 * 50);
  assert.deepEqual([it.operations, it.days, it.maxSameDay], [1, 1, 1]);
  assert.deepEqual(L.totalCost, { EUR: 600 }); assert.equal(L.totalOperations, 4);
  assert.equal(L.rows[0].language, 'İspanyolca', 'most expensive language first');
  assert.equal(es.comparison, null, 'no salary entered → no comparison');
});

test('salaried what-if: one guide covers one operation per day, extra same-day operations stay freelance; recommendation and break-even', () => {
  const s = summary({ reservations: [res({ id: 'A', checkIn: '2026-11-12' }), res({ id: 'B', checkIn: '2026-11-12', tourId: 'T-OLD', tour: 'Old City' }), res({ id: 'C', checkIn: '2026-11-13' })] });
  const cheap = buildGuideLanguageCosts(s, { salary: { amount: '10000', currency: 'TRY' } }).rows[0];
  assert.equal(cheap.extraOperations, 1);
  assert.deepEqual(cheap.extraCost, { EUR: 150 });
  assert.equal(cheap.comparison.inHouseTry, 10000 + 150 * 50);
  assert.equal(cheap.comparison.savingTry, 450 * 50 - (10000 + 7500));
  assert.equal(cheap.comparison.recommendation, 'salaried');
  assert.equal(cheap.comparison.breakEvenOperations, Math.ceil(10000 / 7500));
  const dear = buildGuideLanguageCosts(s, { salary: { amount: 1000, currency: 'EUR' } }).rows[0];
  assert.equal(dear.comparison.recommendation, 'freelance');
  assert.equal(dear.comparison.inHouseTry, 1000 * 50 + 150 * 50);
  assert.equal(buildGuideLanguageCosts(s, { salary: { amount: '', currency: 'TRY' } }).rows[0].comparison, null);
});

test('language costs follow per-operation overrides (0 = no cost) and never invent a TL figure without a rate', () => {
  const resv = [res({ id: 'A', checkIn: '2026-11-12' })];
  const key = summary({ reservations: resv }).guideServices[0].key;
  const s = summary({ reservations: resv, guideCostOverrides: [{ id: 'o', operationKey: key, tourDate: '2026-11-12', amount: 0, currency: 'EUR' }] });
  assert.deepEqual(buildGuideLanguageCosts(s).rows[0].cost, {});
  const noFx = buildFinanceMonthSummary({ monthISO: MONTH, todayISO: TODAY, languageNames: LANGS, costItems: [], rateRows: [], reservations: resv });
  const r = buildGuideLanguageCosts(noFx, { salary: { amount: 5000, currency: 'TRY' } }).rows[0];
  assert.equal(r.costTry, null); assert.equal(r.comparison.savingTry, null); assert.equal(r.comparison.recommendation, null);
});

// ── Cost catalog revision ───────────────────────────────────────────────

test('catalog revision "from today": old row ends yesterday, a new version starts today with the new amount', () => {
  const plan = _financeCostItemRevisionPlan({ ...TOP_COST, validFrom: '2026-01-01', sourceNote: 'x' }, { amount: '45,5', currency: 'eur', mode: 'from_today' }, '2026-11-11');
  assert.deepEqual(plan.update, { validTo: '2026-11-10' });
  assert.equal(plan.insert.amount, 45.5); assert.equal(plan.insert.currency, 'EUR');
  assert.equal(plan.insert.validFrom, '2026-11-11'); assert.equal(plan.insert.validTo, null);
  assert.equal(plan.insert.preparationRuleId, 'RULE-TOP'); assert.equal(plan.insert.kind, 'internal');
});

test('catalog revision: "all" or a row starting today is corrected in place; guide row and bad input refused', () => {
  assert.deepEqual(_financeCostItemRevisionPlan(TOP_COST, { amount: 42, currency: 'EUR', mode: 'all' }, '2026-11-11'), { update: { amount: 42, currency: 'EUR' }, insert: null });
  assert.deepEqual(_financeCostItemRevisionPlan({ ...TOP_COST, validFrom: '2026-11-11' }, { amount: 42, mode: 'from_today' }, '2026-11-11').insert, null);
  assert.throws(() => _financeCostItemRevisionPlan(GUIDE, { amount: 100, mode: 'all' }, '2026-11-11'), /rezervasyondan/);
  assert.throws(() => _financeCostItemRevisionPlan(TOP_COST, { amount: -1, mode: 'all' }, '2026-11-11'), /0 veya daha büyük/);
  assert.throws(() => _financeCostItemRevisionPlan({ ...TOP_COST, validTo: '2026-10-31' }, { amount: 1, mode: 'all' }, '2026-11-11'), /geçerliliği bitmiş/);
});

test('after a "from today" revision, past dates keep the old amount and today onward use the new one', () => {
  const plan = _financeCostItemRevisionPlan(TOP_COST, { amount: 50, currency: 'EUR', mode: 'from_today' }, '2026-11-11');
  const items = [GUIDE, MEAL, { ...TOP_COST, ...plan.update }, { ...plan.insert, id: 'CI-T2' }];
  const preps = [{ id: 'p1', reservationId: 'P', preparationRuleId: 'RULE-TOP', preparationType: 'entrance_ticket', requiredQuantity: 2, status: 'pending' },
                 { id: 'p2', reservationId: 'F', preparationRuleId: 'RULE-TOP', preparationType: 'entrance_ticket', requiredQuantity: 2, status: 'pending' }];
  const s = buildFinanceMonthSummary({ monthISO: MONTH, todayISO: '2026-11-11', languageNames: LANGS, rateRows: RATES, costItems: items, rules: [TOP_RULE], preparations: preps,
    reservations: [res({ id: 'P', checkIn: '2026-11-05' }), res({ id: 'F', checkIn: '2026-11-20' })] });
  assert.deepEqual(s.reservations.find(x => x.id === 'P').planned.ticket, { EUR: 80 });
  assert.deepEqual(s.reservations.find(x => x.id === 'F').planned.ticket, { EUR: 100 });
});

// ── Break-even guests + Fikirler data ───────────────────────────────────


test('break-even: (net − per-guest cost) per guest must exceed the operation guide cost; Topkapı-like example needs 5 guests', () => {
  // net ₺3,990 / guest, ticket €40 = ₺2,000 / guest at 50, guide €150 = ₺7,500
  const mk = (id, date, pax) => res({ id, checkIn: date, pax, total: 3990 * pax, currency: 'TRY' });
  const resv = [mk('A', '2026-11-06', 6), mk('B', '2026-11-12', 3)];
  const preps = [{ id: 'pa', reservationId: 'A', preparationRuleId: 'RULE-TOP', requiredQuantity: 6, status: 'pending' }, { id: 'pb', reservationId: 'B', preparationRuleId: 'RULE-TOP', requiredQuantity: 3, status: 'pending' }];
  const s = summary({ reservations: resv, rules: [TOP_RULE], preparations: preps });
  const e = s.tours[0].economics;
  assert.deepEqual([e.status, e.netPerPaxTry, e.variablePerPaxTry, e.contributionPerPaxTry, e.fixedPerOperationTry], ['ok', 3990, 2000, 1990, 7500]);
  assert.equal(e.breakEvenPax, 4, '7500 / 1990 = 3.77 → 4 guests');
  const [g6, g3] = s.tours[0].subgroups;
  assert.deepEqual([g6.pax, g6.breakEvenPax, g6.breakEvenReached], [6, 4, true]);
  assert.deepEqual([g3.pax, g3.breakEvenPax, g3.breakEvenReached], [3, 4, false]);
});

test('break-even: per-operation override changes that operation\'s threshold; per-guest cost ≥ net → never', () => {
  const resv = [res({ id: 'A', checkIn: '2026-11-12', pax: 2, total: 1000, currency: 'TRY' })];
  const key = summary({ reservations: resv }).guideServices[0].key;
  const s = summary({ reservations: resv, guideCostOverrides: [{ id: 'o', operationKey: key, tourDate: '2026-11-12', amount: 0, currency: 'EUR' }] });
  assert.equal(s.tours[0].subgroups[0].breakEvenPax, 1);
  const never = summary({ reservations: [res({ id: 'N', checkIn: '2026-11-12', pax: 2, total: 50, currency: 'TRY' })],
    rules: [TOP_RULE], preparations: [{ id: 'pn', reservationId: 'N', preparationRuleId: 'RULE-TOP', requiredQuantity: 2, status: 'pending' }] });
  assert.equal(never.tours[0].economics.status, 'never');
  assert.equal(never.tours[0].subgroups[0].breakEvenReached, false);
  const nofx = buildFinanceMonthSummary({ monthISO: MONTH, todayISO: TODAY, languageNames: LANGS, costItems: [], rateRows: [], reservations: resv });
  assert.equal(nofx.tours[0].economics.status, 'unknown');
});




test('break-even beyond a realistic group (30) is "impractical", still with the number', () => {
  const s = summary({ reservations: [res({ id: 'A', checkIn: '2026-11-12', pax: 2, total: 4200, currency: 'TRY' })],
    rules: [TOP_RULE], preparations: [{ id: 'p', reservationId: 'A', preparationRuleId: 'RULE-TOP', requiredQuantity: 2, status: 'pending' }] });
  const e = s.tours[0].economics;
  assert.equal(F.FINANCE_PRACTICAL_GROUP_MAX, 30);
  assert.equal(e.contributionPerPaxTry, 100);
  assert.equal(e.status, 'impractical'); assert.equal(e.breakEvenPax, 76);
  assert.equal(s.tours[0].subgroups[0].breakEvenReached, false);
});

// ── Tour profitability grouped by tour name, with language sub-rows ─────

test('same tour sold as separate products per language = ONE tour row with one sub-row per language', () => {
  const s = summary({ reservations: [
    res({ id: 'P1', tourId: 'T-BOS-PT', tour: 'Bosforo y Barrio Sultanahmet', tourLanguage: 'Portekizce', checkIn: '2026-11-03', pax: 2, total: 9900, currency: 'TRY' }),
    res({ id: 'I1', tourId: 'T-BOS-IT', tour: 'Bosforo y Barrio Sultanahmet ', tourLanguage: 'İtalyanca', checkIn: '2026-11-14', pax: 1, total: 4508, currency: 'TRY' }),
    res({ id: 'I2', tourId: 'T-BOS-IT', tour: 'Bosforo y Barrio Sultanahmet', tourLanguage: 'İtalyanca', checkIn: '2026-11-21', pax: 2, total: 9016, currency: 'TRY' }),
    res({ id: 'G1', tourId: 'T-GB', tour: 'Grand Bazaar', checkIn: '2026-11-05', pax: 4 }),
  ] });
  assert.equal(s.tours.length, 2);
  const b = s.tours.find(t => /Bosforo/.test(t.tourLabel));
  assert.deepEqual(b.tourIds.slice().sort(), ['T-BOS-IT', 'T-BOS-PT']);
  assert.deepEqual([b.reservations, b.pax, b.guideServices], [3, 5, 3]);
  assert.deepEqual(b.languages.map(l => [l.language, l.reservations, l.pax, l.guideServices]), [['İtalyanca', 2, 3, 2], ['Portekizce', 1, 2, 1]]);
  const it = b.languages[0], pt = b.languages[1];
  assert.equal(it.economics.netPerPaxTry, 4508); assert.equal(pt.economics.netPerPaxTry, 4950);
  assert.deepEqual(it.subgroups.map(g => g.date), ['2026-11-14', '2026-11-21'], 'operations under their language, by date');
  assert.equal(pt.subgroups[0].date, '2026-11-03');
  assert.equal(eur(b.guide), 450);
  assert.equal(b.projectedProfit, Math.round((9900 + 4508 + 9016 - 450 * 50) * 100) / 100);
});

test('identical costs on both language products → identical break-even (PT and IT Bosforo after the migration)', () => {
  const AY = { id: 'R-AY', tourId: null, preparationType: 'entrance_ticket', label: 'Ayasofya Giriş Bileti', isActive: true };
  const rules = [{ ...AY, id: 'R-PT', tourId: 'T-PT' }, { ...AY, id: 'R-IT', tourId: 'T-IT' }];
  const ci = (tourId, rule) => [{ id: 'A' + tourId, kind: 'internal', isActive: true, category: 'ticket', basis: 'preparation_rule', amount: 25, currency: 'EUR', tourId, preparationRuleId: rule, validFrom: '2026-01-01', validTo: null, isProvisional: true },
    { id: 'B' + tourId, kind: 'internal', isActive: true, category: 'transport', basis: 'per_guest', amount: 340, currency: 'TRY', tourId, preparationRuleId: null, validFrom: '2026-01-01', validTo: null, isProvisional: true }];
  const rs = [res({ id: 'P', tourId: 'T-PT', tour: 'Bosforo', tourLanguage: 'Portekizce', pax: 2, total: 9000, currency: 'TRY' }),
              res({ id: 'I', tourId: 'T-IT', tour: 'Bosforo', tourLanguage: 'İtalyanca', pax: 2, total: 9000, currency: 'TRY' })];
  const preps = [{ id: 'pp', reservationId: 'P', preparationRuleId: 'R-PT', requiredQuantity: 2, status: 'pending' }, { id: 'pi', reservationId: 'I', preparationRuleId: 'R-IT', requiredQuantity: 2, status: 'pending' }];
  const s = buildFinanceMonthSummary({ monthISO: MONTH, todayISO: TODAY, languageNames: LANGS, rateRows: RATES, costItems: [GUIDE, ...ci('T-PT', 'R-PT'), ...ci('T-IT', 'R-IT')], rules, preparations: preps, reservations: rs });
  const [a, b] = s.tours[0].languages;
  assert.equal(a.economics.variablePerPaxTry, 25 * 50 + 340);
  assert.deepEqual([a.economics.breakEvenPax, a.economics.contributionPerPaxTry], [b.economics.breakEvenPax, b.economics.contributionPerPaxTry]);
});

test('guide cost by tour: one row per tour name (language products merged), split into languages; cancelled excluded', () => {
  const s = summary({ reservations: [
    res({ id: 'A', tourId: 'T-BOS-PT', tour: 'Bosforo', tourLanguage: 'Portekizce', checkIn: '2026-11-03' }),
    res({ id: 'B', tourId: 'T-BOS-IT', tour: 'Bosforo', tourLanguage: 'İtalyanca', checkIn: '2026-11-14' }),
    res({ id: 'C', tourId: 'T-BOS-IT', tour: 'Bosforo', tourLanguage: 'İtalyanca', checkIn: '2026-11-14', pax: 3 }),
    res({ id: 'D', tourId: 'T-BOS-IT', tour: 'Bosforo', tourLanguage: 'İtalyanca', checkIn: '2026-11-21' }),
    res({ id: 'E', tourId: 'T-GB', tour: 'Grand Bazaar', tourLanguage: 'İspanyolca', checkIn: '2026-11-05' }),
    res({ id: 'X', tourId: 'T-GB', tour: 'Grand Bazaar', tourLanguage: 'İspanyolca', checkIn: '2026-11-06', opStatus: 'İptal', statusRaw: 'cancelled' }),
  ] });
  const G = F.buildGuideTourCosts(s);
  assert.deepEqual(G.rows.map(r => [r.tourLabel, r.operations, r.days]), [['Bosforo', 3, 3], ['Grand Bazaar', 1, 1]]);
  const b = G.rows[0];
  assert.deepEqual(b.cost, { EUR: 450 }); assert.equal(b.avgPerOperationTry, 150 * 50);
  assert.deepEqual(b.languages.map(l => [l.language, l.operations, l.days, l.maxSameDay]), [['İtalyanca', 2, 2, 1], ['Portekizce', 1, 1, 1]]);
  assert.deepEqual(G.totalCost, { EUR: 600 }); assert.equal(G.totalOperations, 4);
});

// ══ Owner rule 2026-11-14: guide fee entered at assignment, one per date + tour + guide ══

const real = (o) => _realBuild({ monthISO: MONTH, todayISO: TODAY, languageNames: LANGS, costItems: [GUIDE, MEAL, TOP_COST, TOP_PUBLIC], rateRows: RATES, ...o });
const FEE = (r, amount, currency, guideId) => ({ id: 'F' + Math.random(), operationKey: F._guideFeeKey(r, guideId !== undefined ? guideId : r.guideId, LANGS), tourDate: String(r.checkIn).slice(0, 10), amount, currency: currency || 'EUR', reason: '' });

test('owner example: 12 Jan Topkapı — X booked with the guide at €135, Y same guide/day/tour → ONE €135, never €270', () => {
  const x = res({ id: 'X', checkIn: '2026-11-12', tourId: 'T-TOP', guideId: 'G7', pax: 2 });
  const y = res({ id: 'Y', checkIn: '2026-11-12', tourId: 'T-TOP', guideId: 'G7', pax: 3, tourLanguage: 'İtalyanca' });
  assert.equal(F._guideFeeKey(x, 'G7', LANGS), F._guideFeeKey(y, 'G7', LANGS), 'Y finds X\'s fee');
  const s = real({ reservations: [x, y], guideCostOverrides: [FEE(x, 135)] });
  assert.equal(s.counts.guideServices, 1);
  assert.deepEqual(s.categories.guide.planned, { EUR: 135 });
  const g = s.guideServices[0];
  assert.equal(g.costSource, 'assignment_fee');
  assert.deepEqual(g.fee, { amount: 135, currency: 'EUR', reason: '', updatedAt: null, reservationId: null });
  assert.equal(g.language, 'İspanyolca / İtalyanca', 'languages do not split one guide\'s operation');
  assert.deepEqual(g.reservationIds.sort(), ['X', 'Y']);
});

test('no automatic €150 any more: an assigned operation without an entered fee costs nothing and is flagged; unassigned ones too', () => {
  const s = real({ reservations: [res({ id: 'A', checkIn: '2026-11-20', guideId: 'G1' }), res({ id: 'B', checkIn: '2026-11-21', guideId: null }), res({ id: 'C', checkIn: '2026-11-21', guideId: null })] });
  assert.deepEqual(s.categories.guide.planned, {});
  const a = s.guideServices.find(g => g.reservationIds.includes('A')), b = s.guideServices.find(g => g.reservationIds.includes('B'));
  assert.deepEqual([a.costSource, a.paymentStatus], ['fee_missing', 'fee_missing']);
  assert.deepEqual([b.costSource, b.paymentStatus, b.reservationCount], ['unassigned', 'unassigned', 2], 'unassigned bookings of a day + tour share one operation');
  assert.equal(s.dataQuality.guideFeeMissing, 1);
  assert.equal(s.dataQuality.unassignedGuideServices, 1);
  assert.equal(s.dataQuality.futureUnassignedGuideServices, 1);
  const w = F.buildFinanceCashNeeds({ summaries: [s], todayISO: TODAY }).windows[2];
  assert.deepEqual(w.guide, {});
  assert.equal(w.operationsUnassigned, 1); assert.equal(w.operationsFeeMissing, 1);
});

test('different guides on the same day and tour = two operations, two fees; different day or tour = separate', () => {
  const a = res({ id: 'A', checkIn: '2026-11-12', guideId: 'G1' }), b = res({ id: 'B', checkIn: '2026-11-12', guideId: 'G2' });
  const c = res({ id: 'C', checkIn: '2026-11-13', guideId: 'G1' }), d = res({ id: 'D', checkIn: '2026-11-12', guideId: 'G1', tourId: 'T-OLD', tour: 'Old City' });
  const s = real({ reservations: [a, b, c, d], guideCostOverrides: [FEE(a, 135), FEE(b, 120), FEE(c, 150), FEE(d, 100)] });
  assert.equal(s.counts.guideServices, 4);
  assert.deepEqual(s.categories.guide.planned, { EUR: 505 });
});

test('fee key: tour id (not the name), date and guide — a reservation created without a tour name still meets the same fee', () => {
  const civ = res({ id: 'A', checkIn: '2026-11-12', tourId: 'T-TOP', tour: 'Topkapi Palace Complete Tour', guideId: 'G1' });
  const manual = res({ id: 'B', checkIn: '2026-11-12', tourId: 'T-TOP', tour: '', guideId: 'G1' });
  assert.equal(F._guideFeeKey(civ, 'G1'), F._guideFeeKey(manual, 'G1'));
  assert.equal(F._guideFeeKey(civ, 'G1'), 'fee|2026-11-12|T-TOP|g:G1');
  assert.notEqual(F._guideFeeKey(civ, 'G2'), F._guideFeeKey(civ, 'G1'));
  assert.equal(F._guideFeeKey(res({ id: 'Z', tourId: null }), 'G1'), 'fee|unresolved:Z', 'no tour → its own operation');
});

test('reassigning a reservation to another guide moves it to that guide\'s operation (and fee)', () => {
  const a = res({ id: 'A', checkIn: '2026-11-12', guideId: 'G1' }), b = res({ id: 'B', checkIn: '2026-11-12', guideId: 'G1' });
  const before = real({ reservations: [a, b], guideCostOverrides: [FEE(a, 135)] });
  assert.equal(before.counts.guideServices, 1);
  const after = real({ reservations: [a, { ...b, guideId: 'G2' }], guideCostOverrides: [FEE(a, 135), FEE(b, 120, 'EUR', 'G2')] });
  assert.equal(after.counts.guideServices, 2);
  assert.deepEqual(after.categories.guide.planned, { EUR: 255 });
});

test('legacy per-language overrides (keys without "fee|") are ignored — no hidden cost from before the rule change', () => {
  const r = res({ id: 'A', checkIn: '2026-11-12' });
  const s = real({ reservations: [r], guideCostOverrides: [{ operationKey: '2026-11-12|T-TOP|İspanyolca', amount: 0, currency: 'EUR', tourDate: '2026-11-12' }] });
  assert.equal(s.guideServices[0].costSource, 'fee_missing');
});

test('language problems are reported per reservation but never split an operation; a missing tour is its own operation', () => {
  const s = real({ reservations: [res({ id: 'A' }), res({ id: 'B', tourLanguage: '' }), res({ id: 'C', tourLanguage: 'Spanish' }), res({ id: 'D', tourId: null, tour: 'Özel Tur' })] });
  assert.equal(s.counts.guideServices, 2);
  assert.equal(s.dataQuality.missingLanguageCount, 1);
  assert.equal(s.dataQuality.unrecognizedLanguageCount, 1);
  assert.equal(s.dataQuality.missingTourCount, 1);
  const u = s.guideServices.find(g => g.reservationIds.includes('D'));
  assert.equal(u.unresolvedReason, 'tour_missing');
});

test('break-even uses only operations with an entered fee; an operation without a fee shows no break-even', () => {
  const a = res({ id: 'A', checkIn: '2026-11-05', pax: 2, total: 9000, currency: 'TRY', guideId: 'G1' });
  const b = res({ id: 'B', checkIn: '2026-11-06', pax: 2, total: 9000, currency: 'TRY', guideId: 'G1' });
  const s = real({ reservations: [a, b], guideCostOverrides: [FEE(a, 150)] });
  const t = s.tours[0];
  assert.equal(t.economics.fixedPerOperationTry, 150 * 50, 'the fee-less operation does not halve the fixed cost');
  const sb = t.languages[0].subgroups.find(g => g.date === '2026-11-06');
  assert.equal(sb.breakEvenPax, null);
});
