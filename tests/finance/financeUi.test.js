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

test('approved tabs, in order; Genel Bakış shows only the cash to prepare (7 / 15 / 30 days) — no realized or remaining-budget KPIs', () => {
  assert.match(SOURCE, /\{ key: "genel",\s+label: "Genel Bakış" \},\s+\{ key: "butce",\s+label: "Bütçe & Tahmin" \},\s+\{ key: "turlar",\s+label: "Tur Karlılığı" \},\s+\{ key: "ek-satislar", label: "Ek Satışlar" \},\s+\{ key: "tahsilatlar", label: "Tahsilatlar" \},\s+\{ key: "katalog",\s+label: "Maliyet Kataloğu" \},/);
  const o = body('_FinOverview');
  assert.match(o, /useFinanceCashNeeds\(\)/);
  assert.match(o, /Hazırlanması Gereken Para · bugünden itibaren/);
  assert.match(o, /Önümüzdeki 1 ay/);
  assert.match(o, /Önümüzdeki \$\{w\.days\} gün/);
  assert.match(o, /Önümüzdeki 7 gün · operasyon bazında/);
  assert.match(o, /Yemek giderleri dahil değildir\./);
  for (const gone of ['Kalan Operasyon Bütçesi', 'Tahsil Edilen Nakit', 'Gerçekleşen Net Gelir', 'Gerçekleşen Operasyon Maliyeti', 'Gerçekleşen Net Kâr', 'Tahsil Edilmemiş Alacak']) {
    assert.ok(!o.includes(gone), gone);
  }
  const h = body('useFinanceCashNeeds');
  assert.match(h, /buildFinanceCashNeeds\(\{ summaries: \[a\.summary, b\.summary, c\.summary\], todayISO \}\)/);
  assert.match(h, /const todayISO = _istanbulISODate\(\);/);
  const page = body('FinancePage');
  assert.match(page, /current === "genel" \? \(\s*<_FinOverview\/>/);
  assert.match(page, /current !== "genel" &&/, 'no month selector on Genel Bakış');
});

test('an incomplete TRY view is never shown as a total', () => {
  assert.match(body('_finTry'), /r && r\.complete \? \{ value: _fmtFinanceTry\(r\) \} : \{ value: "—", sub: "TL karşılığı için kur verisi eksik" \}/);
  assert.match(body('_finValue'), /if \(tryResult && tryResult\.complete\)/);
});

test('data-quality panel names each condition separately', () => {
  const d = body('_FinDataQuality');
  for (const t of ['dil belirtilmemiş', 'dil tanınmıyor', 'tur bilgisi eksik', 'yemek durumu belirsiz', 'maliyet girilmemiş', 'geçici maliyet',
    'bilet hazırlığı tamamlandı, gerçek harcama tutarı girilmemiş', 'eşleştirilmemiş rehber ödemesi', 'Kur verisine erişilemiyor',
    'geçmiş rehber operasyonunun ödemesi tamamlanmamış', 'ödeme kaydı rehber ücretiyle uyuşmuyor', 'rehber atanmamış', 'iptal edilmiş operasyonda rehber ödemesi var',
    'rehber atanmış ama rehber ücreti girilmemiş', 'ödeme farklı para biriminde — açık bakiye incelemede']) {
    assert.ok(d.includes(t), t);
  }
  assert.doesNotMatch(d, /rehber ödemesi kaydı yok/, 'a missing guide payment never makes the cost unknown');
  assert.doesNotMatch(d, /Guide Service|sabit kural|Standart yerine/, 'no automatic guide cost any more');
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
  assert.match(c, /rezervasyon için tek ücret\./);
  assert.match(c, /yalnızca raporlama içindir/);
  assert.match(c, /Rehber atanmadı — rehber ücreti, rehber atanırken girilir\./);
  assert.match(c, /Rehber ücreti girilmemiş/);
  assert.match(c, /<_GuideFeeEditor r=\{r\} group=\{group\}/);
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


test('Tur Karlılığı explains the profit: cost with its TL equivalent and the expected net, per operation', () => {
  const tt = body('_FinTourTable');
  assert.match(tt, /Maliyet \{_fmtFinanceMap\(g\.pnl\.projectedCost\)\}/);
  assert.match(tt, /g\.pnl\.projectedCostTry/);
  assert.match(tt, /Beklenen net \{_fmtFinanceMap\(g\.pnl\.expectedNet\)\}/);
  assert.match(tt, /t\.totalPlannedTry/);
});

test('home: Tahmini Net Kâr next to the net income — finance roles only, picked from the Finance month summary', () => {
  const h = body('useHomeProjectedProfit');
  assert.match(h, /useFinanceMonth\(monthISO \|\| _istanbulISODate\(\)\.slice\(0, 7\)\)/);
  assert.match(h, /s\.kpis\.projectedProfit/);
  assert.match(h, /Net gelir \$\{_fmtFinanceTry\(s\.kpis\.expectedNet\)\} − tahmini gider \$\{_fmtFinanceTry\(s\.kpis\.projectedCost\)\}/);
  assert.match(h, /TL karşılığı için kur verisi eksik/, 'no made-up number when FX is incomplete');
  assert.doesNotMatch(h, /buildFinanceMonthSummary|buildGuideServices|_financeToTry|\b150\b/);
  assert.match(body('RevenueGoalCard'), /canAccess\(getAuthContext\(\)\.role, "finance"\) \? <_HomeNetAndProfit net=\{net\} monthISO=\{monthISO\} revenue=\{\{ summary, loading, extraSalesUnavailable \}\}\/> : net/);
  const h2 = body('_HomeNetAndProfit');
  assert.match(h2, /Tahmini Net Kâr/);
  assert.match(h2, /Ek Satış/);
  assert.match(h2, /Net gelir = tur geliri \{_fmtTRY\(revenue\.summary\.tourTotal \|\| 0\)\} \+ ek satış \{_fmtTRY\(revenue\.summary\.extraSalesTryTotal \|\| 0\)\}/);
});

// ── Ek satışlar (extra sales) ───────────────────────────────────────────

test('Ek Satışlar tab: totals from the summary, entry form, month list with delete, "not yet enabled" state', () => {
  const x = body('_FinExtraSales');
  assert.match(x, /const xs = s\.extraSales;/);
  assert.match(x, /_finValue\(s\.kpis\.extraSales, s\.totals\.extraSales\)/);
  assert.match(x, /_finValue\(s\.kpis\.expectedNet, s\.totals\.expectedNet\)/);
  assert.match(x, /_finProfit\(s\.kpis\.projectedProfit/);
  assert.match(x, /<_ExtraSaleForm onDone=/);
  assert.match(x, /mutate\("deleteExtraSale", x\.id\)/);
  assert.match(x, /window\.confirm\(/);
  assert.match(x, /xs\.unavailable \?/);
  assert.match(body('FinancePage'), /current === "ek-satislar" \? \(\s*<_FinExtraSales s=\{s\}\/>/);
});

test('extra-sale form: search every reservation (any date) by Civitatis code / reservation no / customer / tour; then product, amount, currency, date', () => {
  const f = body('_ExtraSaleForm');
  for (const l of ['Rezervasyon ara', 'Satılan ürün / hizmet', 'Tutar', 'Para birimi', 'Satış tarihi', 'Değiştir']) assert.ok(f.includes(l), l);
  assert.match(f, /useRepo\("reservation", "getAll"\)/, 'all reservations, not only the selected month');
  assert.match(f, /_searchReservationsForSale\(allRes \|\| \[\], q, 20\)/);
  assert.match(f, /useRepoMutation\("finance"\)/);
  assert.match(f, /mutate\("createExtraSale", \{ reservationId: rid,/);
  assert.match(SOURCE, /externalBookingId:r\.external_booking_id\|\|null,/);
  assert.match(body('_FinExtraSales'), /<_ExtraSaleForm onDone=\{\(\) => setOpen\(false\)\}\/>/);
});

test('reservation Finance card lists and records extra sales for that reservation (desktop + mobile share the card)', () => {
  const c = body('ReservationFinanceCard');
  assert.match(c, /\{r\.opStatus !== "İptal" && <_ReservationExtraSales r=\{r\} summary=\{summary\}\/>\}/);
  assert.match(c, /Ek satışlar \(\$\{row\.extraSaleCount\}\)/);
  const e = body('_ReservationExtraSales');
  assert.match(e, /summary\.extraSales\.items\.filter\(x => x\.reservationId === r\.id\)/);
  assert.match(e, /<_ExtraSaleForm reservationId=\{r\.id\}/);
  assert.match(body('ReservationFinanceSummary'), /_fmtFinanceMap\(row\.netIncome\)/);
});

test('repos: extra sales validated by one payload, logged, and Finance keeps working before the migration is applied', () => {
  const a = SOURCE.indexOf('const SupabaseFinanceRepo = {');
  const repo = SOURCE.slice(a, SOURCE.indexOf('\n};', a));
  assert.match(repo, /const row = \{ \.\.\._financeExtraSalePayload\(d\), created_by:/);
  assert.match(repo, /_sbLog\('reservation_extra_sale', data\.id, 'created'/);
  assert.match(repo, /_sbLog\('reservation_extra_sale', id, 'deleted'/);
  assert.match(repo, /if \(error\) return \{ sales: \[\], unavailable: true \};/, 'missing table → unavailable, never a broken Finance page');
  assert.match(repo, /extraSales: xs\.sales, extraSalesUnavailable: xs\.unavailable/);
  assert.match(repo, /if \(!monthISO \|\| !canAccess\(getAuthContext\(\)\.role, 'finance'\)\) return \{ sales: \[\], unavailable: false \};/);
  const m = SOURCE.indexOf('const FinanceRepository = {');
  assert.match(SOURCE.slice(m, SOURCE.indexOf('\n};', m)), /const row = _financeExtraSalePayload\(d\);/);
});

// ── Bütçe & Tahmin: language guide cost, no operations table / remaining budget ──

test('Bütçe & Tahmin: headline + guide cost by TOUR (expandable into languages) + separate salaried comparison + data quality', () => {
  const b = body('_FinBudget');
  assert.match(b, /<_FinGuideTours s=\{s\}\/>\n\s+<_FinGuideSalary s=\{s\}\/>/);
  assert.match(b, /<_FinDataQuality s=\{s\}\/>/);
  assert.doesNotMatch(b, /_FinGuideOperations|_FinCategoryTable|Kalan Bütçe|Turlara Göre"|_FinGuideLanguages/);
  assert.doesNotMatch(SOURCE, /function _FinGuideOperations\(|function _FinCategoryTable\(|function _FinGuideLanguages\(|Dillere Göre Rehber Maliyeti/);
  const g = body('_FinGuideTours');
  assert.match(g, /buildGuideTourCosts\(s\)/);
  for (const h of ['Turlara Göre Rehber Maliyeti', 'Tur', 'Operasyon', 'Gün', 'Aynı gün en fazla', 'Rehberlere ödenecek', 'Operasyon başı', 'guide-tour-language-row']) assert.ok(g.includes(h), h);
  const m = body('_FinGuideSalary');
  assert.match(m, /buildGuideLanguageCosts\(s, \{ salary \}\)/);
  for (const h of ['Maaşlı Rehber Karşılaştırması', 'Serbest rehberle', 'Maaşlı rehberle', 'Fark', 'Daha uygun']) assert.ok(m.includes(h), h);
  assert.match(m, /localStorage/);
  assert.doesNotMatch(g + m, /_financeToTry|buildGuideServices/);
});

test('data quality keeps every guide review item (the operations table is gone, the warnings are not)', () => {
  const d = body('_FinDataQuality');
  for (const t2 of ['geçmiş rehber operasyonunun ödemesi tamamlanmamış', 'ödeme kaydı rehber ücretiyle uyuşmuyor', 'iptal edilmiş operasyonda rehber ödemesi var',
    'ödeme farklı para biriminde — açık bakiye incelemede', 'yeniden açılan operasyonda önceki iptal operasyonun rehber ödemesi var', 'rehber ücreti girilmemiş']) assert.ok(d.includes(t2), t2);
});

test('catalog: amounts editable on screen (from today = versioned, or all dates); guide row is not edited here; tour names shown', () => {
  const c = body('_FinCatalog');
  assert.match(c, /mutate\("reviseCostItem", c\.id, \{ amount: edit\.amount, currency: edit\.currency, mode: edit\.mode \}\)/);
  assert.match(c, /Bugünden itibaren \(geçmiş aylar eski tutarla kalır\)/);
  assert.match(c, /Tüm tarihler için düzelt/);
  assert.match(c, /c\.category === "guide"/);
  assert.match(c, /rezervasyondan düzenlenir/);
  assert.match(c, /useRepo\("tour", "getAll"\)/);
  assert.match(c, /const current = \(c\) => !c\.validTo \|\| c\.validTo >= today;/);
  const a = SOURCE.indexOf('const SupabaseFinanceRepo = {');
  const repo = SOURCE.slice(a, SOURCE.indexOf('\n};', a));
  assert.match(repo, /if \(plan\.insert\) await SupabaseFinanceRepo\.createCostItem\(plan\.insert\);\n\s+await SupabaseFinanceRepo\.updateCostItem\(id, plan\.update\);/, 'new version first, then close the old one');
});

test('Tur Karlılığı shows break-even guests per tour and per operation; no Fikirler tab', () => {
  const tt = body('_FinTourTable');
  assert.match(tt, /\["Kâra geçiş", t => <_FinBreakEven e=\{t\.economics\}\/>\]/);
  assert.match(tt, /g\.breakEvenPax/);
  assert.match(tt, /kâra geçmek için/);
  assert.doesNotMatch(SOURCE, /key: "fikirler"|function _FinIdeas\(|_FIN_IDEAS|buildProfitIdeas/);
});

test('Tur Karlılığı: one row per tour; expanding shows a row per language (all columns, own break-even) and its operations', () => {
  const tt = body('_FinTourTable');
  assert.match(tt, /isOpen && t\.languages\.map\(l => \(/);
  assert.match(tt, /data-testid="tour-language-row"/);
  assert.match(tt, /\{cols\.map\(\(\[lb, f\]\) => <td key=\{lb\} style=\{td\}>\{f\(l\)\}<\/td>\)\}/);
  assert.match(tt, /\{l\.subgroups\.map\(g => \(/);
});

test('Italian Bosforo migration mirrors the PT product: Ayasofya €25 rule + ₺340 cruise, guarded; backfill covers both products from November', () => {
  const M = fs.readFileSync(path.join(__dirname, '..', '..', 'supabase_migration_finance_bosforo_it_costs.sql'), 'utf8');
  const BF = fs.readFileSync(path.join(__dirname, '..', '..', 'finance_bosforo_backfill.sql'), 'utf8');
  assert.match(M, /v_it    CONSTANT UUID := '2ea5551f-f59f-4ba4-976c-0b5c916094a8';/);
  assert.match(M, /VALUES \(v_it, NULL, 'entrance_ticket', v_label, 'per_guest', NULL, TRUE\)/);
  assert.match(M, /'Hagia Sophia Visitor Gallery', 'ticket', 'preparation_rule', 25, 'EUR', v_it, v_rule,\s+DATE '2026-01-01', 'internal', TRUE/);
  assert.match(M, /'Bosphorus Cruise \(Şehir Hatları short tour\)', 'transport', 'per_guest', 340, 'TRY', v_it,\s+DATE '2026-01-01', 'internal', TRUE/);
  assert.match(M, /already has a different active Ayasofya rule/);
  assert.match(BF, /public\.materialize_reservation_preparations\(r\.id\)/);
  assert.match(BF, /r\.tour_id IN \('2ea5551f-f59f-4ba4-976c-0b5c916094a8', '8f308669-2bb6-42ac-9b2f-a07f77e231d4'\)/);
  assert.match(BF, /r\.check_in >= DATE '2026-11-01'/);
});
