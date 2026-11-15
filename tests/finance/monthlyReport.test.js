'use strict';
/**
 * tests/finance/monthlyReport.test.js — aylık harcamalar (monthly expenses)
 * and the monthly detailed PDF report. Fake data only.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { extractTestableFn } = require('../dashboard/extractTestableFn');

const ROOT = path.join(__dirname, '..', '..');
const SOURCE = fs.readFileSync(path.join(ROOT, 'DeseTourDashboard.jsx'), 'utf8');
const MIG = fs.readFileSync(path.join(ROOT, 'supabase_migration_finance_monthly_expenses.sql'), 'utf8');
const RB = fs.readFileSync(path.join(ROOT, 'supabase_migration_finance_monthly_expenses_ROLLBACK.sql'), 'utf8');
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
const payload = extractTestableFn('_financeMonthlyExpensePayload');
const html = extractTestableFn('_monthlyReportHtml');
const pageBreaks = extractTestableFn('_reportPageBreaks');

const LANGS = ['İspanyolca', 'İngilizce', 'Portekizce', 'İtalyanca'];
const RATES = [{ baseCurrency: 'EUR', quoteCurrency: 'TRY', rate: 50, rateDate: '2026-11-14' }, { baseCurrency: 'USD', quoteCurrency: 'TRY', rate: 40, rateDate: '2026-11-14' }];
let n = 0;
function res(o) {
  n += 1;
  return { id: 'R' + n, resNumber: 'RES-' + n, checkIn: '2026-10-12', tourId: 'T-TOP', tour: 'Topkapı', tourLanguage: 'İspanyolca',
    opStatus: 'Tamamlandı', statusRaw: 'completed', pax: 2, paxChild: 0, total: 100, currency: 'EUR', guideId: 'G1', guide: 'Ayşe',
    retailAmount: null, retailCurrency: null, mealStatus: 'not_included', createdAtTs: '2026-09-20T10:00:00Z', ...o };
}
const fee = (date, tour, guide, amount) => ({ id: 'F' + date + tour + guide, operationKey: `fee|${date}|${tour}|g:${guide}`, tourDate: date, amount, currency: 'EUR' });
function summary(input) {
  return F.buildFinanceMonthSummary({ monthISO: '2026-10', todayISO: '2026-11-15', languageNames: LANGS, rateRows: RATES, ...input });
}

test('payload: month + name + amount; Turkish amounts ("10.000", "1.250,50") parse correctly', () => {
  assert.deepEqual(payload({ month: '2026-10', label: ' Meta Reklam ', amount: '10.000', currency: 'try' }),
    { month: '2026-10-01', label: 'Meta Reklam', amount: 10000, currency: 'TRY', notes: '' });
  assert.equal(payload({ month: '2026-10', label: 'Higgsfield', amount: '1.250,50', currency: 'TRY' }).amount, 1250.5);
  assert.equal(payload({ month: '2026-10', label: 'X', amount: '49.99', currency: 'USD' }).amount, 49.99);
  assert.equal(payload({ month: '2026-10', label: 'X', amount: 5000, currency: 'TRY' }).amount, 5000);
  assert.throws(() => payload({ month: '', label: 'X', amount: 1, currency: 'TRY' }), /Ayı seçin/);
  assert.throws(() => payload({ month: '2026-13', label: 'X', amount: 1, currency: 'TRY' }), /Ayı seçin/);
  assert.throws(() => payload({ month: '2026-10', label: '  ', amount: 1, currency: 'TRY' }), /adını yazın/);
  for (const amount of [0, -5, 'abc', '']) assert.throws(() => payload({ month: '2026-10', label: 'X', amount, currency: 'TRY' }), /sıfırdan büyük/);
  assert.throws(() => payload({ month: '2026-10', label: 'X', amount: 1, currency: 'CHF' }), /para birimi/);
});

test('month summary: monthly expenses of THAT month only, grouped by name, reduce profit after tour profit', () => {
  const s = summary({
    reservations: [res({ id: 'A' })], guideCostOverrides: [fee('2026-10-12', 'T-TOP', 'G1', 100)],
    monthlyExpenses: [
      { id: 'M1', month: '2026-10', label: 'Meta Reklam', amount: 10000, currency: 'TRY' },
      { id: 'M2', month: '2026-10', label: 'meta reklam', amount: 2000, currency: 'TRY' },
      { id: 'M3', month: '2026-10', label: 'Higgsfield', amount: 100, currency: 'USD' },
      { id: 'M4', month: '2026-09', label: 'Meta Reklam', amount: 9999, currency: 'TRY' },
    ],
  });
  assert.equal(s.monthlyExpenses.items.length, 3);
  assert.deepEqual(s.monthlyExpenses.byLabel.map(g => [g.label, g.count, g.totalTry]), [['Meta Reklam', 2, 12000], ['Higgsfield', 1, 4000]]);
  assert.equal(s.kpis.monthlyExpenses.tryTotal, 16000);
  assert.equal(s.kpis.profitAfterMonthlyExpenses, Math.round((s.kpis.projectedProfit - 16000) * 100) / 100);
});

test('report: tours by sales, languages, guides by earnings, one fee per operation, unassigned operations', () => {
  const rows = [
    res({ id: 'A', pax: 2 }), res({ id: 'B', pax: 4 }), // same guide/day/tour → 1 operation, 1 fee
    res({ id: 'C', checkIn: '2026-10-20', tourId: 'T-BOS', tour: 'Bosforo', tourLanguage: 'Portekizce', guideId: 'G2', guide: 'Mehmet', pax: 3 }),
    res({ id: 'D', checkIn: '2026-10-25', tourId: 'T-BOS', tour: 'Bosforo', tourLanguage: 'İtalyanca', guideId: null, guide: '', pax: 2, opStatus: 'Onaylandı', statusRaw: 'confirmed' }),
    res({ id: 'E', checkIn: '2026-10-26', statusRaw: 'cancelled', opStatus: 'İptal' }),
  ];
  const s = summary({ reservations: rows, noop: 1,
    guideCostOverrides: [fee('2026-10-12', 'T-TOP', 'G1', 150), fee('2026-10-20', 'T-BOS', 'G2', 120)],
    monthlyExpenses: [{ id: 'M1', month: '2026-10', label: 'Meta Reklam', amount: 10000, currency: 'TRY' }] });
  const all = [...rows, res({ id: 'Z', checkIn: '2026-12-01', createdAtTs: '2026-10-03T09:00:00Z' })];
  const r = F.buildMonthlyReport({ summary: s, allReservations: all, todayISO: '2026-11-15' });
  assert.deepEqual(r.headline, { operations: 3, reservations: 4, pax: 11, cancelled: 1, avgGroup: 3.7, tours: 2, languages: 3, guides: 2,
    unassignedOperations: 1, bookedInMonth: 1, bookedInMonthCancelled: 0, cancelledInMonth: 0, operationDays: 3 });
  assert.deepEqual(r.tours.map(t => [t.label, t.reservations, t.pax, t.operations]), [['Topkapı', 2, 6, 1], ['Bosforo', 2, 5, 2]]);
  assert.equal(r.topTour.label, 'Topkapı');
  assert.deepEqual(r.languages.map(l => [l.language, l.reservations, l.pax]), [['İspanyolca', 2, 6], ['Portekizce', 1, 3], ['İtalyanca', 1, 2]]);
  assert.deepEqual(r.guides.map(g => [g.name, g.operations, g.pax, g.feeTry]), [['Ayşe', 1, 6, 7500], ['Mehmet', 1, 3, 6000]]);
  assert.equal(r.topGuide.name, 'Ayşe');
  assert.deepEqual(r.unassignedOps.map(o => [o.date, o.tour, o.pax]), [['2026-10-25', 'Bosforo', 2]]);
  assert.equal(r.finance.monthlyExpensesTry, 10000);
  assert.equal(r.finance.finalProfitTry, r.finance.tourProfitTry - 10000);
  assert.equal(r.daily.length, 31);
  assert.equal(r.daily[11].pax, 6);
  const keys = r.gaps.map(g => g.key);
  assert.ok(keys.includes('unassigned'));
  assert.ok(keys.includes('pastNotCompleted'), 'a past tour still "Onaylandı" is a gap');
  assert.ok(!keys.includes('noMonthlyExpenses'));
});

test('report gaps: missing fee and missing monthly expenses are reported with their impact', () => {
  const s = summary({ reservations: [res({ id: 'A' })], guideCostOverrides: [], monthlyExpenses: [] });
  const r = F.buildMonthlyReport({ summary: s, allReservations: [], todayISO: '2026-11-15' });
  const g = Object.fromEntries(r.gaps.map(x => [x.key, x]));
  assert.equal(g.feeMissing.count, 1);
  assert.match(g.feeMissing.impact, /kâr olduğundan yüksek/);
  assert.equal(g.noMonthlyExpenses.count, 1);
  assert.equal(r.guides[0].feeMissing, 1);
});

test('report HTML: every section, Turkish labels, escaped names, no reservation customer data', () => {
  const s = summary({ reservations: [res({ id: 'A', name: 'Gizli Müşteri', tour: 'Topkapı <b>' })], guideCostOverrides: [fee('2026-10-12', 'T-TOP', 'G1', 150)],
    monthlyExpenses: [{ id: 'M1', month: '2026-10', label: 'Higgsfield', amount: 5000, currency: 'TRY' }] });
  const out = html(F.buildMonthlyReport({ summary: s, allReservations: [], todayISO: '2026-11-15' }), {});
  for (const t of ['Ekim 2026 Raporu', 'Finans Özeti', 'Turlar', 'Dillere Göre', 'Rehberler', 'Takvim', 'Eksik Kalanlar', 'En çok satan tur', 'Higgsfield', 'Net kâr']) assert.ok(out.includes(t), t);
  assert.ok(out.includes('Topkapı &lt;b&gt;'));
  assert.ok(!out.includes('Gizli Müşteri'));
});

test('page breaks: blocks never straddle a page; an oversized block is split', () => {
  assert.deepEqual(pageBreaks([{ top: 0, height: 400 }, { top: 400, height: 400 }, { top: 800, height: 300 }], 1000, 1100), [{ start: 0, end: 800 }, { start: 800, end: 1100 }]);
  assert.deepEqual(pageBreaks([{ top: 0, height: 100 }, { top: 100, height: 2500 }], 1000, 2600), [{ start: 0, end: 100 }, { start: 100, end: 1100 }, { start: 1100, end: 2100 }, { start: 2100, end: 2600 }]);
});

test('Finance: "Aylık Harcamalar" tab adds per month; Raporlar: PDF card for finance roles', () => {
  assert.match(SOURCE, /current === "harcamalar" \? \(\s*<_FinMonthlyExpenses s=\{s\} onMonth=\{setMonthISO\}\/>/);
  assert.match(SOURCE, /mutate\("createMonthlyExpense", f\)/);
  assert.match(SOURCE, /mutate\("deleteMonthlyExpense", x\.id\)/);
  assert.match(SOURCE, /<MonthlyReportCard\/>/);
  const card = SOURCE.slice(SOURCE.indexOf('function MonthlyReportCard()'), SOURCE.indexOf('function ReportsPage() {'));
  assert.match(card, /if \(!canAccess\(auth\.role, "finance"\)\) return null;/);
  assert.match(SOURCE, /monthlyExpenses: mx\.items, monthlyExpensesUnavailable: mx\.unavailable,/);
});

test('migration: month table, RLS admin + operations with aal2, CHECK widened by one value; rollback guarded', () => {
  assert.match(MIG, /CREATE TABLE IF NOT EXISTS public\.finance_monthly_expenses \(/);
  assert.match(MIG, /month\s+DATE\s+NOT NULL CHECK \(EXTRACT\(DAY FROM month\) = 1\)/);
  assert.match(MIG, /amount\s+NUMERIC\(12,2\) NOT NULL CHECK \(amount > 0\)/);
  assert.match(MIG, /"finance_monthly_expenses: admin full access"[^;]*USING \( is_admin\(\) AND is_aal2\(\) \) WITH CHECK \( is_admin\(\) AND is_aal2\(\) \);/);
  assert.match(MIG, /"finance_monthly_expenses: operations full access"[^;]*USING \( is_operations\(\) AND is_aal2\(\) \) WITH CHECK \( is_operations\(\) AND is_aal2\(\) \);/);
  assert.equal((MIG.match(/CREATE POLICY/g) || []).length, 2);
  assert.match(MIG, /v_new := v_live \|\| ARRAY\['finance_monthly_expense'\];/);
  assert.match(RB, /MONTHLY EXPENSES ROLLBACK REFUSED/);
  assert.match(RB, /WHERE x <> 'finance_monthly_expense'/);
});
