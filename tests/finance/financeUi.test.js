'use strict';
/**
 * tests/finance/financeUi.test.js — Finance Center Phase D shell.
 * The UI is presentation only: every number comes from useFinanceMonth →
 * buildFinanceMonthSummary. Routing, role access and navigation are additive;
 * /payments keeps working unchanged until Phase F.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { extractTestableFn } = require('../dashboard/extractTestableFn');

const SOURCE = fs.readFileSync(path.join(__dirname, '..', '..', 'DeseTourDashboard.jsx'), 'utf8');
function body(name) {
  const idx = SOURCE.indexOf(`function ${name}(`);
  assert.ok(idx !== -1, `function ${name} not found`);
  return SOURCE.slice(idx, SOURCE.indexOf('\nfunction ', idx + 10));
}
const fmt = extractTestableFn('_fmtFinanceMap');

test('_fmtFinanceMap keeps original currencies (never converts) and shows "—" for nothing', () => {
  assert.equal(fmt({ EUR: 1250, TRY: 3400 }), '₺3.400 · €1.250');
  assert.equal(fmt({ EUR: -40 }), '−€40');
  assert.equal(fmt({ CHF: 10 }), '10 CHF');
  assert.equal(fmt({}), '—');
  assert.equal(fmt(null), '—');
});

test('one summary per month, built only by the canonical layer, with Istanbul date and CRM languages', () => {
  const h = body('useFinanceMonth');
  assert.match(h, /useRepo\("finance", "getMonthData", monthISO\)/);
  assert.match(h, /const todayISO = _istanbulISODate\(\);/);
  assert.match(h, /buildFinanceMonthSummary\(\{\s*\.\.\.data, monthISO, todayISO, languageNames: LANGUAGES\.map\(l => l\[1\]\),\s*\}\)/);
  const calls = SOURCE.match(/buildFinanceMonthSummary\(/g) || [];
  assert.equal(calls.length, 2, 'one definition + one UI call site');
});

test('Finance UI components never compute money themselves', () => {
  const ui = SOURCE.slice(SOURCE.indexOf('const FINANCE_TABS = ['), SOURCE.indexOf('function PaymentsPage() {'));
  assert.doesNotMatch(ui, /buildGuideServices|attributeGuidePayments|_financeToTry|_financePickCostItem|_selectLatestFxRatesToTry|_financeEarnedNetRevenue|\b150\b|\b40\b \* |rate \*/);
  assert.doesNotMatch(ui, /_CIVITATIS_FIXED_EUR_TO_TRY_RATE|\b55\b/);
});

test('approved tabs, in order, and the planning + realized KPI sets', () => {
  assert.match(SOURCE, /\{ key: "genel",\s+label: "Genel Bakış" \},\s+\{ key: "butce",\s+label: "Bütçe & Tahmin" \},\s+\{ key: "turlar",\s+label: "Tur Karlılığı" \},\s+\{ key: "tahsilatlar", label: "Tahsilatlar" \},\s+\{ key: "katalog",\s+label: "Maliyet Kataloğu" \},/);
  const o = body('_FinOverview');
  for (const l of ['Kalan Operasyon Bütçesi', 'Beklenen Net Tahsilat', 'Tahmini Net Kâr', 'Gerçekleşen Net Gelir', 'Tahsil Edilen Nakit', 'Gerçekleşen Operasyon Maliyeti', 'Gerçekleşen Net Kâr', 'Tahsil Edilmemiş Alacak']) {
    assert.ok(o.includes(`label="${l}"`), l);
  }
  assert.match(o, /badge=\{prov\}/, 'provisional realized profit is badged "Geçici"');
  assert.match(o, /r\.statusLabel/);
});

test('an incomplete TRY view is never shown as a total', () => {
  assert.match(body('_finTry'), /r && r\.complete \? \{ value: _fmtFinanceTry\(r\) \} : \{ value: "—", sub: "TL karşılığı için kur verisi eksik" \}/);
  assert.match(body('_finValue'), /if \(tryResult && tryResult\.complete\)/);
});

test('data-quality panel names each condition separately', () => {
  const d = body('_FinDataQuality');
  for (const t of ['dil belirtilmemiş', 'dil tanınmıyor', 'tur bilgisi eksik', 'yemek durumu belirsiz', 'maliyet girilmemiş', 'geçici maliyet',
    'bilet hazırlığı tamamlandı, gerçek harcama tutarı girilmemiş', 'rehber ödemesi kaydı yok', 'eşleştirilmemiş rehber ödemesi', 'Kur verisine erişilemiyor']) {
    assert.ok(d.includes(t), t);
  }
});

test('budget view uses the operational guide concept, never "N × €150"', () => {
  const b = body('_FinBudget');
  assert.match(b, /rezervasyon<\/span>/);
  assert.match(b, /rehber operasyonu<\/span>/);
  assert.match(b, /rehber bütçesi<\/span>/);
  assert.match(body('_FinTourTable'), /rezervasyon paylaşıyor/);
  assert.doesNotMatch(b + body('_FinTourTable'), /× ?€?150|\* ?150/);
});

test('catalog separates internal costs from public references, which never drive calculations', () => {
  const c = body('_FinCatalog');
  assert.match(c, /c\.kind === "internal"/);
  assert.match(c, /c\.kind === "public_reference"/);
  assert.match(c, /Yalnızca bilgi amaçlı — hesaplamalarda kullanılmaz/);
  assert.match(c, /rel="noopener noreferrer"/);
});

test('routing: /finance and /finance/:tab render FinancePage; /payments is unchanged until Phase F', () => {
  assert.match(SOURCE, /if \(base === "finance"\) return <FinancePage tab=\{param\} navigate=\{navigate\}\/>;/);
  assert.match(SOURCE, /if \(base === "payments"\)  return <PaymentsPage\/>;/);
  assert.match(SOURCE, /if \(base === "payments"\) return <MobilePaymentsPage\/>;/);
  assert.match(body('FinancePage'), /navigate\("\/payments"\)/, 'Tahsilatlar hands off to the existing Payments page');
});

test('access: Finance mirrors Payments (Yönetici + Operasyon); Satış and Rehber cannot open it', () => {
  assert.match(SOURCE, /"Operasyon":\["dashboard","reservations","calendar","tours","guides","leads","quotes","reminders","finance","payments","reports","more","changelog","activity"\]/);
  const perms = SOURCE.slice(SOURCE.indexOf('const ROLE_PERMISSIONS'), SOURCE.indexOf('};', SOURCE.indexOf('const ROLE_PERMISSIONS')));
  assert.doesNotMatch(perms.split('\n').find(l => l.includes('"Satış"')), /finance/);
  assert.doesNotMatch(perms.split('\n').find(l => l.includes('"Rehber"')), /finance/);
});

test('navigation: Finans in sidebar (role-gated on desktop), mobile drawer and More page', () => {
  assert.match(SOURCE, /const NAV_BOT = \[\s*\{ id:"finance",\s+label:"Finans"/);
  assert.match(SOURCE, /NAV_BOT\.filter\(it => it\.id !== "finance" \|\| canAccess\(auth\.role, "finance"\)\)\.map/);
  assert.match(SOURCE, /\{ id:"finance",\s+label:"Finans",\s+icon:/);
  assert.match(SOURCE, /finance:"Finans", payments:"Ödemeler"/);
});
