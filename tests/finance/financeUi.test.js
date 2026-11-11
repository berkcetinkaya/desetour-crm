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
    'bilet hazırlığı tamamlandı, gerçek harcama tutarı girilmemiş', 'eşleştirilmemiş rehber ödemesi', 'Kur verisine erişilemiyor',
    'geçmiş rehber operasyonunun ödemesi tamamlanmamış', 'ödeme kaydı sabit maliyetle uyuşmuyor', 'rehber atanmamış', 'iptal edilmiş operasyonda rehber ödemesi var',
    'rehber operasyonu maliyeti sabit kuraldan', 'hesaplamada kullanılmıyor', 'ödeme farklı para biriminde — açık bakiye incelemede']) {
    assert.ok(d.includes(t), t);
  }
  assert.doesNotMatch(d, /rehber ödemesi kaydı yok/, 'a missing guide payment never makes the cost unknown');
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

test('routing: /finance and /finance/:tab render FinancePage; Tahsilatlar embeds the existing Payments experience; /payments is an alias', () => {
  assert.match(SOURCE, /if \(base === "finance"\) return <FinancePage tab=\{param\} navigate=\{navigate\}\/>;/);
  assert.match(SOURCE, /if \(base === "payments"\) return <_LegacyRedirect to="\/finance\/tahsilatlar"\/>;/);
  assert.match(body('FinancePage'), /isMobile \? <MobilePaymentsPage\/> : <PaymentsPage\/>/);
  assert.doesNotMatch(SOURCE, /return <PaymentsPage\/>;|return <MobilePaymentsPage\/>;/);
});

test('access: Finance mirrors Payments (Yönetici + Operasyon); Satış and Rehber cannot open it', () => {
  assert.match(SOURCE, /"Operasyon":\["dashboard","reservations","calendar","tours","guides","leads","quotes","reminders","finance","payments","reports","more","changelog","activity"\]/);
  const perms = SOURCE.slice(SOURCE.indexOf('const ROLE_PERMISSIONS'), SOURCE.indexOf('};', SOURCE.indexOf('const ROLE_PERMISSIONS')));
  assert.doesNotMatch(perms.split('\n').find(l => l.includes('"Satış"')), /finance/);
  assert.doesNotMatch(perms.split('\n').find(l => l.includes('"Rehber"')), /finance/);
});

test('navigation: Finans in sidebar (role-gated on desktop), mobile drawer and More page', () => {
  assert.match(SOURCE, /const NAV_BOT = \[\s*\{ id:"finance",\s+label:"Finans"/);
  assert.match(SOURCE, /NAV_BOT\.filter\(it => canAccess\(auth\.role, it\.id\)\)\.map/);
  assert.match(SOURCE, /\{ id:"finance",\s+label:"Finans",\s+icon:/);
  assert.match(SOURCE, /finance:"Finans", payments:"Ödemeler"/);
});

// ── Phase E ─────────────────────────────────────────────────────────────

test('reservation finance is picked from the SAME month summary — never recomputed', () => {
  const h = body('useReservationFinance');
  assert.match(h, /const \{ summary, loading, error \} = useFinanceMonth\(monthISO\);/);
  assert.match(h, /summary\.reservations\.find\(x => x\.id === resId\)/);
  assert.match(h, /summary\.groups\.find\(g => g\.key === row\.guideAllocation\.serviceKey\)/);
  const ui = body('ReservationFinanceCard') + body('ReservationFinanceSummary');
  assert.doesNotMatch(ui, /buildFinanceMonthSummary|buildGuideServices|_financeToTry|\b150\b|\* 40|rate \*/);
});

test('Finance card: Admin/Operations only, shows shared guide cost as reporting share, never a payable', () => {
  assert.match(SOURCE, /\{canAccess\(auth\.role, "finance"\) && <ReservationFinanceCard r=\{r\}\/>\}/);
  const c = body('ReservationFinanceCard');
  assert.match(c, /rezervasyon paylaşıyor\./);
  assert.match(c, /yalnızca raporlama içindir/);
  assert.match(c, /İptal edilen rezervasyonlar finans hesaplarına dahil edilmez\./);
  assert.doesNotMatch(c, /ödeme kaydı yok/, 'guide cost is fixed; payment status is shown instead');
  assert.match(c, /_FIN_GUIDE_PAY_LABEL\[group\.guide\.paymentStatus\]/);
  assert.match(c, /girilmedi/);
});

test('expense entry: only ticket/meal/transport/other, through the finance repo, guide explicitly excluded', () => {
  assert.match(SOURCE, /const FINANCE_EXPENSE_CATEGORY_OPTIONS = \[\s*\{ value: "ticket", label: "Bilet" \}, \{ value: "meal", label: "Yemek" \},\s*\{ value: "transport", label: "Ulaşım" \}, \{ value: "other", label: "Diğer" \},\s*\];/);
  const c = body('ReservationFinanceCard');
  assert.match(c, /useRepoMutation\("finance"\)/);
  assert.match(c, /mutate\("createExpense", \{ reservationId: r\.id,/);
  assert.match(c, /mutate\("deleteExpense", x\.id\)/);
  assert.match(c, /window\.confirm\(/, 'delete asks for confirmation');
  assert.match(c, /Rehber maliyeti buraya girilmez — operasyon başına sabit maliyet olarak hesaplanır, ödemesi rehber ödemelerinden girilir\./);
  assert.doesNotMatch(c, /exchangeRateUsed|tryAmount|exchange_rate_used|try_amount/, 'the browser never sends frozen FX');
});

test('Calendar Quick View finance summary: finance roles only, never for cancelled, group guide cost shown as shared', () => {
  assert.match(SOURCE, /\{!vm\.isCancelled && canAccess\(auth\.role, "finance"\) && \(\s*<_QvSection title="Finans">\s*<ReservationFinanceSummary resId=\{vm\.id\} checkIn=\{r\.checkIn\}\/>/);
  const q = body('ReservationFinanceSummary');
  for (const l of ['Beklenen net gelir', 'Planlanan maliyet', 'Tahmini kâr']) assert.ok(q.includes(l), l);
  assert.match(q, /rezervasyon paylaşıyor/);
  assert.match(q, /yalnızca bu rezervasyon/);
});

test('mock repo validates expenses with the same payload rules (guide refused)', () => {
  const a = SOURCE.indexOf('const FinanceRepository = {');
  const repo = SOURCE.slice(a, SOURCE.indexOf('\n};', a));
  assert.match(repo, /const row = _financeExpensePayload\(d\);/);
});

test('mobile reservation detail shows the same Finance card, finance roles only', () => {
  const m = body('MobileReservationDetailPage');
  assert.match(m, /\{canAccess\(mobAuth\.role, "finance"\) && <ReservationFinanceCard r=\{r\}\/>\}/);
});

// ── Fixed guide operation cost per group ───────────────────────────────

test('guide operations: one line per operation group with tour, language, reservations, guide or "Rehber atanmadı", cost, payment status, outstanding', () => {
  const g = body('_FinGuideOperations');
  assert.match(g, /const rows = s\.guideServices;/, 'rows come from the canonical group list, never per reservation');
  for (const h of ['"Tarih"', '"Tur"', '"Dil"', '"Rez."', '"Rehber"', '"Maliyet"', '"Ödeme"', '"Açık bakiye"']) assert.ok(g.includes(h), h);
  assert.match(g, /Rehber atanmadı/);
  assert.match(g, /_fmtFinanceMap\(g\.planned\)/);
  assert.match(g, /_FIN_GUIDE_PAY_LABEL\[g\.paymentStatus\]/);
  assert.match(g, /_fmtFinanceMap\(g\.outstanding\)/);
  assert.match(g, /s\.cancelledGroups/);
  assert.match(body('_FinBudget'), /<_FinGuideOperations s=\{s\}\/>/);
  assert.match(body('_FinTourTable'), /_FIN_GUIDE_PAY_LABEL\[g\.state\]/);
});

test('guide header never silently omits an unresolved balance: confirmed open + groups under currency review', () => {
  const b = body('_FinBudget');
  assert.match(b, /açık bakiye \{_fmtFinanceMap\(guide\.outstanding\)\}/);
  assert.match(b, /guide\.underReview\.groups > 0 &&/);
  assert.match(b, /operasyon para birimi incelemesinde/);
  const g = body('_FinGuideOperations');
  assert.match(g, /para birimi incelemesi/);
  assert.match(g, /bekleyen \{_fmtFinanceMap\(g\.cashPending\)\}/, 'original-currency pending amount visible in detail');
  assert.match(g, /Rehber atandı \(isim yok\)/);
  assert.match(g, /rehber ödemesi \(\$\{_fmtFinanceMap\(c\.paymentAmount\)\}\) — inceleyin/);
});

test('reactivation review (option B) and review payments are visible in the table, header and data quality', () => {
  const g = body('_FinGuideOperations');
  assert.match(g, /önceki iptal operasyondan \{g\.priorPayments\.length\} ödeme/);
  assert.match(g, /bu maliyete sayılmadı/);
  assert.match(body('_FinBudget'), /guide\.reviewPayments\.count > 0 &&/);
  assert.match(body('_FinBudget'), /_fmtFinanceMap\(guide\.reviewPayments\.total\)/);
  assert.match(body('_FinDataQuality'), /yeniden açılan operasyonda önceki iptal operasyonun rehber ödemesi var/);
});

test('loader: linked guide payments by reservation_id with NO payment-date filter; unlinked ones by payment_date', () => {
  const a = SOURCE.indexOf('const SupabaseFinanceRepo = {');
  const repo = SOURCE.slice(a, SOURCE.indexOf('\n};', a));
  assert.match(repo, /byIds\(sb\.from\('guide_payments'\)\.select\('\*'\)\.in\('reservation_id', ids\)\),/);
  assert.match(repo, /sb\.from\('guide_payments'\)\.select\('\*'\)\.is\('reservation_id', null\)\.gte\('payment_date', startISO\)\.lt\('payment_date', endISO\)/);
  assert.match(repo, /from\('reservations'\)\.select\('\*'\)\.gte\('check_in', startISO\)\.lt\('check_in', endISO\)/);
});

test('reservation mapping carries full created_at / cancelled_at timestamps for the continuity rule', () => {
  assert.match(body('mapResFromDB'), /createdAtTs:r\.created_at\|\|null, cancelledAt:r\.cancelled_at\|\|null,/);
});

test('one combined catalog-reference notice in the data-quality panel (never one per catalog value)', () => {
  const d = body('_FinDataQuality');
  assert.equal((d.match(/Guide Service/g) || []).length, 1);
  assert.doesNotMatch(d, /guideCatalogDiffers\.map\(d => \(\{/);
});
