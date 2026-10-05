'use strict';
/**
 * tests/dashboard/reportsCleanup.test.js
 * ─────────────────────────────────────────────────────────────────────────
 * Reports Cleanup Phase — regression coverage for the pre-Phase-3 Reports
 * rewrite: removal of every public.payments-only/mixed-currency legacy
 * metric the read-only audit flagged, the new currency-safe Kaynak
 * Performansı/En Çok Satan Turlar/Ülke Analizi/Doğrudan Ödemeler, the new
 * "Civitatis Hakediş Durumu" section (built on the existing Phase 1.3/
 * Phase 2 settlement helpers, never a duplicate rule), and the Operasyon
 * Analizi/tour-date period-filtering fixes.
 *
 * Static assertions against DeseTourDashboard.jsx source text follow this
 * codebase's own established convention for non-pure, UI-layer code (see
 * tests/dashboard/crmChangelog.test.js) — calculateReportMetrics/
 * ReportsPage are not marked TESTABLE (they depend on filterByDateRange,
 * DB.sources, countryFlag, etc., so they are not isolated pure functions).
 * The one new pure helper, _buildCivitatisReportsSettlementTotals, IS
 * marked TESTABLE and is exercised behaviorally below.
 * ─────────────────────────────────────────────────────────────────────────
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { extractTestableFn } = require('./extractTestableFn');

const REPO_ROOT = path.join(__dirname, '..', '..');
const SOURCE = fs.readFileSync(path.join(REPO_ROOT, 'DeseTourDashboard.jsx'), 'utf8');

const crmStart = SOURCE.indexOf('function calculateReportMetrics(');
const crmEnd = SOURCE.indexOf('\nconst EMPTY_REPORT_METRICS', crmStart);
const CRM_BODY = SOURCE.slice(crmStart, crmEnd);

const rpStart = SOURCE.indexOf('function ReportsPage()');
const rpEnd = SOURCE.indexOf('\nconst GUEST_STATUS_CFG', rpStart);
const RP_BODY = SOURCE.slice(rpStart, rpEnd);

// Scoped to the Yönetici Özeti insights array specifically, not the whole
// ReportsPage body — so a coincidental match elsewhere never hides a bug.
const yosStart = RP_BODY.indexOf('const topSource');
const yosEnd = RP_BODY.indexOf('})().map((ins,i)=>(', yosStart);
const YOS_BODY = RP_BODY.slice(yosStart, yosEnd);

// Scoped to the new "Civitatis Hakediş Durumu" RpSection only.
const civSecStart = RP_BODY.indexOf('title="Civitatis Hakediş Durumu"');
const civSecEnd = RP_BODY.indexOf('</RpSection>', civSecStart);
const CIV_SECTION_BODY = RP_BODY.slice(civSecStart, civSecEnd);

const _buildCivitatisReportsSettlementTotals = extractTestableFn('_buildCivitatisReportsSettlementTotals');
const _filterReportReservationsByTourPeriod = extractTestableFn('_filterReportReservationsByTourPeriod');

function res(overrides) {
  return { id: 'R', checkIn: '2026-10-04', opStatus: 'Onaylandı', ...overrides };
}

function period(overrides) {
  return {
    settlementPeriod: '2026-10-01',
    effectiveStatus: 'accrued',
    reservationCount: 1,
    originalByCurrency: { TRY: 1000 },
    displayTryTotal: 1000,
    hasUnsupportedCurrency: false,
    ...overrides,
  };
}

// ── Legacy KPI / insight removal ────────────────────────────────────────

test('legacy top-KPI "Beklenen Gelir" card is removed', () => {
  assert.doesNotMatch(RP_BODY, /label="Beklenen Gelir"/);
  assert.doesNotMatch(CRM_BODY, /expectedEur/);
});

test('legacy top-KPI "Tahsil Edilen Gelir" card is removed', () => {
  assert.doesNotMatch(RP_BODY, /label="Tahsil Edilen Gelir"/);
  assert.doesNotMatch(CRM_BODY, /collectedEur/);
});

test('"Yüksek Tutarlı Bekleyenler" and its ACİL badge are removed from ReportsPage (as rendered UI, not merely mentioned in an explanatory comment)', () => {
  const rpNoComments = RP_BODY.replace(/\/\/[^\n]*/g, '');
  assert.doesNotMatch(rpNoComments, /Yüksek Tutarlı Bekleyenler/);
  assert.doesNotMatch(rpNoComments, /ACİL/);
  assert.doesNotMatch(CRM_BODY, /highValuePays|highValue/);
});

test('the old "total_amount - deposit_amount as customer receivable" computation is gone, not just hidden', () => {
  assert.doesNotMatch(CRM_BODY, /r\.remaining\s*>\s*0/);
  assert.doesNotMatch(CRM_BODY, /remaining>1000|remaining\s*>\s*1000/);
});

test('"Toplam Beklenen" and "Tahsilat Oranı" (the public.payments-only, business-wide-sounding metrics) are removed', () => {
  assert.doesNotMatch(RP_BODY, /Toplam Beklenen/);
  assert.doesNotMatch(RP_BODY, /Tahsilat Oranı/);
});

test('Yönetici Özeti "Bekleyen Ödeme" insight is removed', () => {
  assert.doesNotMatch(YOS_BODY, /Bekleyen Ödeme/);
});

test('Yönetici Özeti "En Yüksek Ortalama" insight is removed', () => {
  assert.doesNotMatch(YOS_BODY, /En Yüksek Ortalama/);
  assert.doesNotMatch(CRM_BODY, /\.avgRevenue\b|avgRevenue:/);
});

// ── Civitatis Hakediş Durumu ─────────────────────────────────────────────

test('"Civitatis Hakediş Durumu" section is present and role-gated to Yönetici/Operasyon', () => {
  assert.ok(civSecStart !== -1, 'Civitatis Hakediş Durumu section not found');
  assert.match(RP_BODY, /civitatisEligible && \(\s*<RpSection title="Civitatis Hakediş Durumu"/);
  assert.match(RP_BODY, /civitatisEligible = \["Yönetici","Operasyon"\]\.includes\(auth\.role\)/);
});

test('the section reuses SupabaseCivitatisSettlementRepo.getDetailed() — no new settlement-read logic', () => {
  assert.match(RP_BODY, /useRepo\("civitatisSettlement", "getDetailed"\)/);
});

test('the section shows all four required buckets with their exact labels', () => {
  for (const label of ['Biriken Hakediş', 'Talep Edilebilir', 'Talep Edildi', 'Ödeme Alındı']) {
    assert.match(CIV_SECTION_BODY, new RegExp(label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
});

test('"Ödeme Alındı" wording explicitly avoids implying bank reconciliation (and never reads "Ödendi", which would wrongly imply DeseTour pays Civitatis)', () => {
  assert.match(CIV_SECTION_BODY, /CRM'de ödeme alındı olarak işaretlenen/);
  assert.doesNotMatch(CIV_SECTION_BODY, /banka|reconcil|mutabakat/i);
  assert.doesNotMatch(CIV_SECTION_BODY, /label:"Ödendi"/);
});

test('mixed-status periods are surfaced separately, never silently folded into a total', () => {
  assert.match(CIV_SECTION_BODY, /mixedPeriodCount/);
  assert.match(CIV_SECTION_BODY, /kontrol gerekiyor/);
});

test('the section is explicitly documented as independent of the Bugün/Bu Hafta/Bu Ay/Son 3 Ay selector', () => {
  assert.match(CIV_SECTION_BODY, /bağımsızdır/);
});

test('_buildCivitatisReportsSettlementTotals introduces no new currency-conversion rule (no literal fixed-rate math)', () => {
  const src = fs.readFileSync(path.join(REPO_ROOT, 'DeseTourDashboard.jsx'), 'utf8');
  const start = src.indexOf('// TESTABLE:_buildCivitatisReportsSettlementTotals:start');
  const end = src.indexOf('// TESTABLE:_buildCivitatisReportsSettlementTotals:end');
  const body = src.slice(start, end);
  assert.doesNotMatch(body, /\*\s*55|55\s*\*/);
  assert.equal((src.match(/function _civitatisConvertToTry\(/g) || []).length, 1, 'the fixed-rate conversion function must not be redefined');
  assert.equal((src.match(/_CIVITATIS_FIXED_EUR_TO_TRY_RATE\s*=\s*55/g) || []).length, 1, 'the fixed rate constant must not be redefined');
});

test('settlement totals: accrued bucket sums only effectiveStatus "accrued" periods, across every period (not just the current month)', () => {
  const r = _buildCivitatisReportsSettlementTotals([
    period({ settlementPeriod:'2026-11-01', effectiveStatus:'accrued', displayTryTotal:1000 }),
    period({ settlementPeriod:'2027-01-01', effectiveStatus:'accrued', displayTryTotal:2000 }), // a FUTURE period, not just "this month"
    period({ settlementPeriod:'2026-09-01', effectiveStatus:'claimable', displayTryTotal:5000 }),
  ]);
  assert.equal(r.accrued.tryTotal, 3000);
  assert.equal(r.accrued.periodCount, 2);
  assert.equal(r.claimable.tryTotal, 5000);
  assert.equal(r.claimable.periodCount, 1);
});

test('settlement totals: claimable bucket reflects the effective (derived) state, not the raw stored status', () => {
  // _groupCivitatisSettlementItemsByPeriod already resolves accrued-but-
  // past-claimable_at rows to effectiveStatus 'claimable' — this reducer
  // must trust that, never re-derive it.
  const r = _buildCivitatisReportsSettlementTotals([
    period({ effectiveStatus:'claimable', displayTryTotal:4000, reservationCount:3 }),
  ]);
  assert.equal(r.claimable.tryTotal, 4000);
  assert.equal(r.claimable.reservationCount, 3);
  assert.equal(r.accrued.periodCount, 0);
});

test('settlement totals: requested bucket correct', () => {
  const r = _buildCivitatisReportsSettlementTotals([
    period({ effectiveStatus:'requested', displayTryTotal:7700 }),
    period({ settlementPeriod:'2026-08-01', effectiveStatus:'requested', displayTryTotal:300 }),
  ]);
  assert.equal(r.requested.tryTotal, 8000);
  assert.equal(r.requested.periodCount, 2);
});

test('settlement totals: paid bucket correct and distinct from requested/claimable/accrued', () => {
  const r = _buildCivitatisReportsSettlementTotals([
    period({ effectiveStatus:'paid', displayTryTotal:9999 }),
    period({ settlementPeriod:'2026-07-01', effectiveStatus:'requested', displayTryTotal:111 }),
  ]);
  assert.equal(r.paid.tryTotal, 9999);
  assert.equal(r.paid.periodCount, 1);
  assert.equal(r.requested.tryTotal, 111);
  assert.equal(r.claimable.periodCount, 0);
  assert.equal(r.accrued.periodCount, 0);
});

test('settlement totals: "mixed" periods are excluded from all four buckets and counted separately', () => {
  const r = _buildCivitatisReportsSettlementTotals([
    period({ effectiveStatus:'mixed', displayTryTotal:5000 }),
    period({ settlementPeriod:'2026-06-01', effectiveStatus:'paid', displayTryTotal:100 }),
  ]);
  assert.equal(r.mixedPeriodCount, 1);
  assert.equal(r.paid.tryTotal, 100);
  for (const key of ['accrued', 'claimable', 'requested']) assert.equal(r[key].periodCount, 0);
});

test('settlement totals: an unsupported-currency period is never fake-converted — flags the bucket instead of inventing a number', () => {
  const r = _buildCivitatisReportsSettlementTotals([
    period({ effectiveStatus:'claimable', displayTryTotal:0, hasUnsupportedCurrency:true, originalByCurrency:{ USD:50 } }),
  ]);
  assert.equal(r.claimable.hasUnsupportedCurrency, true);
  assert.equal(r.claimable.tryTotal, 0);
});

test('settlement totals: TRY/TL periods pass through unchanged, EUR periods already converted at the fixed rate by the reused helper', () => {
  // displayTryTotal is produced upstream by _groupCivitatisSettlementItemsByPeriod
  // via _civitatisConvertToTry — this reducer just sums it, proving no
  // second conversion happens here.
  const r = _buildCivitatisReportsSettlementTotals([
    period({ effectiveStatus:'claimable', displayTryTotal:1000, originalByCurrency:{ TRY:1000 } }), // TRY unchanged
    period({ settlementPeriod:'2026-05-01', effectiveStatus:'claimable', displayTryTotal:5500, originalByCurrency:{ EUR:100 } }), // 100 EUR * 55
  ]);
  assert.equal(r.claimable.tryTotal, 6500);
  assert.equal(r.hasEurExposure, true);
});

test('settlement totals: no EUR exposure anywhere means no fixed-rate disclosure is needed', () => {
  const r = _buildCivitatisReportsSettlementTotals([period({ originalByCurrency:{ TRY:1000 } })]);
  assert.equal(r.hasEurExposure, false);
});

test('the fixed-rate disclosure note appears in the Civitatis section only when EUR exposure exists', () => {
  assert.match(CIV_SECTION_BODY, /civTotals\.hasEurExposure && \(/);
  assert.match(CIV_SECTION_BODY, /Sabit kur: €1 = ₺55/);
});

// ── Kaynak Performansı / En Çok Satan Turlar / Ülke Analizi ─────────────

test('Kaynak Performansı no longer raw-sums total_amount across currencies', () => {
  assert.doesNotMatch(CRM_BODY, /sourceMap\[src\]\.revenue/);
  assert.match(CRM_BODY, /s\.originalByCurrency\[r\.currency\]/);
  assert.match(CRM_BODY, /_civitatisConvertToTry\(r\.total, r\.currency\)/);
});

test('Kaynak Performansı table renders the currency-safe operational amount, not a raw € sum', () => {
  assert.doesNotMatch(RP_BODY, /€\{s\.revenue/);
  assert.match(RP_BODY, /_civFmtOperationalTry\(s\.operationalTryTotal, s\.hasUnsupportedCurrency\)/);
});

test('En Çok Satan Turlar ranks PRIMARILY by reservation count, not raw revenue', () => {
  assert.match(CRM_BODY, /const toursData = Object\.values\(tourMap\)\s*\n\s*\.sort\(\(a,b\)=>b\.reservations-a\.reservations\)/);
  assert.doesNotMatch(CRM_BODY, /\.sort\(\(a,b\)=>b\.revenue-a\.revenue\)/);
});

test('En Çok Satan Turlar no longer shows avgPrice (a mixed-currency per-person average)', () => {
  assert.doesNotMatch(CRM_BODY, /avgPrice/);
  assert.doesNotMatch(RP_BODY, /avgPrice/);
});

test('Ülke Analizi has no mixed-currency revenue or average left', () => {
  assert.doesNotMatch(CRM_BODY, /totalRevenue/);
  assert.doesNotMatch(CRM_BODY, /\.avgRevenue\b|avgRevenue:/);
  assert.doesNotMatch(RP_BODY, /Ort\. Tutar/);
});

test('Ülke Analizi keeps country + reservation count + share only', () => {
  assert.match(CRM_BODY, /share: totalCountryRes>0 \? Math\.round\(c\.reservations\/totalCountryRes\*100\) : 0/);
  assert.match(RP_BODY, /%\{c\.share\}/);
});

// ── Doğrudan Ödemeler ─────────────────────────────────────────────────────

test('"Ödeme Analizi" is renamed to "Doğrudan Ödemeler" and explicitly scoped away from Civitatis', () => {
  assert.doesNotMatch(RP_BODY, /title="Ödeme Analizi"/);
  assert.match(RP_BODY, /title="Doğrudan Ödemeler"/);
  assert.match(RP_BODY, /tamamen ayrı/);
});

test('direct payment currencies are bucketed per-currency, never silently dropped or blended', () => {
  assert.match(CRM_BODY, /const payByCurrency = \{\};/);
  assert.match(CRM_BODY, /payByCurrency\[cur\]/);
  assert.doesNotMatch(CRM_BODY, /fPays\.filter\(p=>p\.currency==="EUR"\)/);
});

test('direct payment status buckets are mutually exclusive (no payment can land in two buckets at once)', () => {
  assert.match(CRM_BODY, /if \(p\.status === 'İade Edildi'\) b\.refunded \+= amt;\s*\n\s*else if \(p\.status === 'Kısmi Ödendi'\) b\.partial \+= amt;\s*\n\s*else if \(p\.status === 'Bekliyor' \|\| p\.status === 'Gecikmiş'\) b\.pending \+= amt;\s*\n\s*else b\.collected \+= amt;/);
});

test('the four approved Doğrudan Ödemeler metrics render per currency with no fabricated combined total', () => {
  for (const label of ['Tahsil Edilen', 'Bekleyen', 'Kısmi Ödenen', 'İade']) {
    assert.match(RP_BODY, new RegExp(label));
  }
  assert.match(RP_BODY, /_fmtByCurrency\(b\.collected, cur\)/);
  assert.match(RP_BODY, /_fmtByCurrency\(b\.refunded, cur\)/);
});

// ── Guide payments ───────────────────────────────────────────────────────

test('guide payment totals no longer silently drop non-EUR currencies', () => {
  assert.doesNotMatch(CRM_BODY, /fGPays\.filter\(p=>p\.currency==="EUR"/);
  assert.match(CRM_BODY, /guidePayByCurrency\[cur\]/);
});

test('Rehber Performansı action line shows every currency present, not a hardcoded €', () => {
  assert.doesNotMatch(RP_BODY, /action=\{`€\$\{metrics\.guidePayments\.paidEur/);
  assert.match(RP_BODY, /action=\{guidePaySummary\}/);
  assert.match(RP_BODY, /guidePayCurrencies\s*\.flatMap/);
});

// ── Operasyon Analizi / date-filter correctness ─────────────────────────

test('Operasyon Analizi now respects the selected period (built from fRes/periodReservations, not raw all-time _res)', () => {
  const opsStart = CRM_BODY.indexOf('const opsData = {');
  const opsEnd = CRM_BODY.indexOf('};', opsStart);
  const opsBody = CRM_BODY.slice(opsStart, opsEnd);
  assert.doesNotMatch(opsBody, /\b_res\.filter/);
  assert.equal((opsBody.match(/fRes\.filter/g) || []).length, 4, 'upcoming/completed/noGuide/noPickup read fRes');
  assert.match(opsBody, /cancelled:\s*periodReservations\.filter\(r=>r\.opStatus==="İptal"\)\.length,/);
});

test('periodReservations (status-agnostic) and fRes (active only) are both derived from the one _filterReportReservationsByTourPeriod call, never from filterByDateRange', () => {
  assert.match(CRM_BODY, /const periodReservations\s*=\s*_filterReportReservationsByTourPeriod\(_res, period, _TODAY_ISO\);/);
  assert.match(CRM_BODY, /const fRes\s*=\s*periodReservations\.filter\(r => r\.opStatus !== 'İptal'\);/);
  assert.doesNotMatch(CRM_BODY, /filterByDateRange\(_res\b/);
  // Only one CALL to the date-window helper — the second population is a
  // plain .filter() on its result, not a second independent date pass.
  // (CRM_BODY also contains the helper's own `function ...(` declaration,
  // which repeats the name once more — count the call pattern instead.)
  assert.equal((CRM_BODY.match(/_filterReportReservationsByTourPeriod\(_res, period, _TODAY_ISO\)/g) || []).length, 1);
});

test('[1][2] a cancelled reservation in the selected period is excluded from Rezervasyon/Operasyon Akışı (both read kpi.reservations, built from fRes)', () => {
  const periodItems = [res({ id:'Active', opStatus:'Onaylandı' }), res({ id:'Cancelled', opStatus:'İptal' })];
  const periodRes = _filterReportReservationsByTourPeriod(periodItems, 'Bu Ay', '2026-10-04');
  const activeRes = periodRes.filter(r => r.opStatus !== 'İptal');
  assert.deepEqual(periodRes.map(r=>r.id).sort(), ['Active', 'Cancelled'], 'periodReservations keeps both');
  assert.deepEqual(activeRes.map(r=>r.id), ['Active'], 'fRes (active) drops the cancelled one — this is kpi.reservations/Operasyon Akışı\'s Rezervasyon');
});

test('[3][4][5][6] Kaynak Performansı/Rehber Performansı/En Çok Satan Turlar/Ülke Analizi all iterate fRes, which excludes cancelled', () => {
  for (const pattern of [/sourceMap\[src\] = \{ source:src/, /tourMap\[name\] = \{ name, reservations:0/, /countryMap\[country\] = \{ country, flag:countryFlag\(country\)/, /guideMap\[r\.guideId\] = \{ id:r\.guideId/]) {
    assert.match(CRM_BODY, pattern);
  }
  // All four maps are populated inside an `fRes.forEach(...)` — never
  // `periodReservations.forEach` or `_res.forEach` — so a cancelled
  // reservation (already dropped from fRes) can never reach any of them.
  assert.equal((CRM_BODY.match(/fRes\.forEach\(r => \{/g) || []).length, 4);
  assert.doesNotMatch(CRM_BODY, /periodReservations\.forEach/);
});

test('[7] the exact same cancelled reservation IS counted by Operasyon Analizi\'s "İptal Edilen" (periodReservations, not fRes)', () => {
  const periodItems = [res({ id:'Cancelled', checkIn:'2026-10-15', opStatus:'İptal' })];
  const periodRes = _filterReportReservationsByTourPeriod(periodItems, 'Bu Ay', '2026-10-04');
  const cancelledCount = periodRes.filter(r => r.opStatus === 'İptal').length;
  assert.equal(cancelledCount, 1);
  // And it is NOT in fRes, so it never reaches Rezervasyon etc.
  assert.equal(periodRes.filter(r => r.opStatus !== 'İptal').length, 0);
});

test('[8] a cancelled reservation OUTSIDE the selected period is not counted in İptal Edilen either', () => {
  const outsidePeriod = [res({ id:'CancelledNovember', checkIn:'2026-11-05', opStatus:'İptal' })];
  const periodRes = _filterReportReservationsByTourPeriod(outsidePeriod, 'Bu Ay', '2026-10-04');
  assert.equal(periodRes.filter(r => r.opStatus === 'İptal').length, 0, 'November cancellation must not count toward October\'s İptal Edilen');
});

test('kpi.reservations/confirmed/inProgress/completed derive directly from fRes with no further date restriction (so a future-in-period tour reaches them)', () => {
  assert.match(CRM_BODY, /reservations:\s*fRes\.length,/);
  assert.match(CRM_BODY, /confirmed:\s*fRes\.filter\(r=>\["Onaylandı","Tur Günü","Tamamlandı"\]\.includes\(r\.opStatus\)\)\.length,/);
  assert.match(CRM_BODY, /completed:\s*fRes\.filter\(r=>r\.opStatus==="Tamamlandı"\)\.length,/);
});

// ── _filterReportReservationsByTourPeriod (the tour-date period fix) ───

test('[1] "Bu Ay" on October 4 includes an October 26 tour (the exact bug the audit found)', () => {
  const out = _filterReportReservationsByTourPeriod([res({ id:'Oct26', checkIn:'2026-10-26' })], 'Bu Ay', '2026-10-04');
  assert.deepEqual(out.map(r=>r.id), ['Oct26']);
});

test('[2] "Bu Ay" on October 4 excludes a November 1 tour', () => {
  const out = _filterReportReservationsByTourPeriod([res({ id:'Nov1', checkIn:'2026-11-01' })], 'Bu Ay', '2026-10-04');
  assert.deepEqual(out, []);
});

test('[3] "Bu Ay" includes the October 1 and October 31 boundary dates', () => {
  const items = [res({ id:'Oct1', checkIn:'2026-10-01' }), res({ id:'Oct31', checkIn:'2026-10-31' }), res({ id:'Sep30', checkIn:'2026-09-30' })];
  const out = _filterReportReservationsByTourPeriod(items, 'Bu Ay', '2026-10-04');
  assert.deepEqual(out.map(r=>r.id).sort(), ['Oct1', 'Oct31']);
});

test('[4] "Bugün" includes only October 4', () => {
  const items = [res({ id:'Oct3', checkIn:'2026-10-03' }), res({ id:'Oct4', checkIn:'2026-10-04' }), res({ id:'Oct5', checkIn:'2026-10-05' })];
  const out = _filterReportReservationsByTourPeriod(items, 'Bugün', '2026-10-04');
  assert.deepEqual(out.map(r=>r.id), ['Oct4']);
});

test('[5] "Bu Hafta" includes a future date later in the same (Monday-start) calendar week', () => {
  // 2026-10-07 is a Wednesday; its Mon-Sun week is Oct 5 - Oct 11.
  const items = [res({ id:'Mon', checkIn:'2026-10-05' }), res({ id:'Fri', checkIn:'2026-10-09' })];
  const out = _filterReportReservationsByTourPeriod(items, 'Bu Hafta', '2026-10-07');
  assert.deepEqual(out.map(r=>r.id).sort(), ['Fri', 'Mon']);
});

test('[6] "Bu Hafta" excludes dates outside that calendar week', () => {
  const items = [res({ id:'PrevSun', checkIn:'2026-10-04' }), res({ id:'NextMon', checkIn:'2026-10-12' })];
  const out = _filterReportReservationsByTourPeriod(items, 'Bu Hafta', '2026-10-07');
  assert.deepEqual(out, []);
});

test('[7] "Son 3 Ay" spans the 1st of the month 3 months back through the end of the CURRENT month (never truncated at "today")', () => {
  const items = [
    res({ id:'JuneTooEarly', checkIn:'2026-06-30' }),
    res({ id:'JulyStart', checkIn:'2026-07-01' }),
    res({ id:'OctFuture', checkIn:'2026-10-31' }),
    res({ id:'NovTooLate', checkIn:'2026-11-01' }),
  ];
  const out = _filterReportReservationsByTourPeriod(items, 'Son 3 Ay', '2026-10-04');
  assert.deepEqual(out.map(r=>r.id).sort(), ['JulyStart', 'OctFuture']);
});

test('_filterReportReservationsByTourPeriod is status-agnostic by design (cancellation exclusion is the caller\'s job, not this date-window helper\'s — see periodReservations/fRes in calculateReportMetrics)', () => {
  const cancelled = res({ id:'Cancelled', checkIn:'2026-10-04', opStatus:'İptal' });
  for (const p of ['Bugün', 'Bu Hafta', 'Bu Ay', 'Son 3 Ay']) {
    assert.deepEqual(_filterReportReservationsByTourPeriod([cancelled], p, '2026-10-04').map(r=>r.id), ['Cancelled'], `period ${p} must still return the cancelled reservation — it is in-window`);
  }
});

test('[9] a future-in-period confirmed reservation is included in the set that feeds Rezervasyon (fRes.length)', () => {
  const out = _filterReportReservationsByTourPeriod([res({ id:'FutureConfirmed', checkIn:'2026-10-26', opStatus:'Onaylandı' })], 'Bu Ay', '2026-10-04');
  assert.equal(out.length, 1);
});

test('[10] that same future-in-period confirmed reservation is counted by the existing cumulative Onaylanan formula', () => {
  const out = _filterReportReservationsByTourPeriod([res({ id:'FutureConfirmed', checkIn:'2026-10-26', opStatus:'Onaylandı' })], 'Bu Ay', '2026-10-04');
  const confirmedCount = out.filter(r => ['Onaylandı','Tur Günü','Tamamlandı'].includes(r.opStatus)).length;
  assert.equal(confirmedCount, 1);
});

test('[11] a completed reservation within the period is still included and counted', () => {
  const out = _filterReportReservationsByTourPeriod([res({ id:'Done', checkIn:'2026-10-02', opStatus:'Tamamlandı' })], 'Bu Ay', '2026-10-04');
  assert.equal(out.length, 1);
  assert.equal(out.filter(r=>r.opStatus==='Tamamlandı').length, 1);
});

test('a reservation with no checkIn at all is excluded (defensive — reservations.check_in is DATE NOT NULL in production)', () => {
  const out = _filterReportReservationsByTourPeriod([res({ id:'NoDate', checkIn: null })], 'Bu Ay', '2026-10-04');
  assert.deepEqual(out, []);
});

test('Kaynak Performansı/En Çok Satan Turlar/Ülke Analizi/Rehber Performansı/Operasyon Analizi all iterate the SAME cancellation-excluding fRes (one source of truth, not five separate filters)', () => {
  for (const pattern of [/fRes\.forEach\(r => \{\s*\n\s*const cust = _custs\.find\(c=>c\.id===r\.customerId\);\s*\n\s*const src/, /fRes\.forEach\(r => \{\s*\n\s*const name = r\.tour/, /fRes\.forEach\(r => \{\s*\n\s*const cust = _custs\.find\(c=>c\.id===r\.customerId\);\s*\n\s*const country/, /fRes\.forEach\(r => \{\s*\n\s*if \(!r\.guideId\) return;/]) {
    assert.match(CRM_BODY, pattern);
  }
});

// ── [12]/[13]/[14]/[15] isolation guarantees ────────────────────────────

test('[12] the shared filterByDateRange() helper is completely unchanged by this fix', () => {
  assert.match(SOURCE, /function filterByDateRange\(items, dateField, period\) \{\s*\n\s*const now=new Date\(\), todayISO=_TODAY_ISO;/);
  assert.match(SOURCE, /let raw=item\[dateField\]\|\|item\.createdAt\|\|item\.date\|\|"";/);
  assert.match(SOURCE, /case "Bu Ay":\s*return iso>=moISO&&iso<=todayISO;/);
  assert.match(CRM_BODY, /const fPays\s*=\s*filterByDateRange\(_pays,\s*"createdAt",\s*period\);/);
});

test('[13] Calendar logic (useCalendarEvents / CalendarPage) is untouched by this fix', () => {
  const idx = SOURCE.indexOf('function useCalendarEvents()');
  const body = SOURCE.slice(idx, SOURCE.indexOf('\nfunction CalendarPage()', idx));
  assert.match(body, /\.filter\(r => r\.opStatus !== "İptal"\)/);
  assert.match(body, /const raw = r\.checkIn \|\| r\.travelStart \|\| r\.check_in \|\| r\.date \|\| null;/);
  assert.doesNotMatch(body, /_filterReportReservationsByTourPeriod/);
});

test('[14] no Civitatis settlement logic changed (Phase 1/2, the settlement RPCs, the fixed 55 TRY rate, the Civitatis Hakediş Durumu reducer)', () => {
  assert.doesNotMatch(CRM_BODY, /civitatis_settlement_items|fn_mark_civitatis/);
  assert.equal((SOURCE.match(/function _buildCivitatisReportsSettlementTotals\(/g) || []).length, 1);
  assert.equal((SOURCE.match(/_CIVITATIS_FIXED_EUR_TO_TRY_RATE\s*=\s*55/g) || []).length, 1);
});

test('[15] no Civitatis ingestion code referenced or changed by the new helper', () => {
  const start = SOURCE.indexOf('// TESTABLE:_filterReportReservationsByTourPeriod:start');
  const end = SOURCE.indexOf('// TESTABLE:_filterReportReservationsByTourPeriod:end');
  const body = SOURCE.slice(start, end);
  assert.doesNotMatch(body, /ingest_civitatis_booking|civitatis_settlement|supabase|getSB\(/i);
});

// ── Yönetici Özeti ranking inheritance ──────────────────────────────────

test('Yönetici Özeti "En Güçlü Kaynak"/"En Çok Satan Tur" read from the already reservation-count-ranked sources/tours, with a currency-safe sub-label', () => {
  assert.match(YOS_BODY, /topSource\.reservations.*_civFmtOperationalTry\(topSource\.operationalTryTotal, topSource\.hasUnsupportedCurrency\)/);
  assert.match(YOS_BODY, /topTour\.reservations.*_civFmtOperationalTry\(topTour\.operationalTryTotal, topTour\.hasUnsupportedCurrency\)/);
  assert.doesNotMatch(YOS_BODY, /topSource\.revenue|topTour\.revenue/);
});

test('Yönetici Özeti "Operasyon Uyarısı" is unchanged', () => {
  assert.match(YOS_BODY, /Operasyon Uyarısı/);
  assert.match(YOS_BODY, /noGuide = metrics\.ops\.noGuide/);
});

test('no speculative AI insight was added to Yönetici Özeti (exactly 3 cards remain)', () => {
  const matches = YOS_BODY.match(/label:"/g) || [];
  assert.equal(matches.length, 3);
});

// ── Do-not-touch guarantees specific to this phase ──────────────────────

test('no reservations.payment_status (payStatus) dependency was introduced into Reports', () => {
  assert.doesNotMatch(CRM_BODY, /payStatus|payment_status/);
  assert.doesNotMatch(RP_BODY, /payStatus|payment_status/);
});

test('retail_amount is never used as Dese Tour settlement/report revenue', () => {
  assert.doesNotMatch(CRM_BODY, /retailAmount|retail_amount/);
  assert.doesNotMatch(RP_BODY, /retailAmount|retail_amount/);
});

test('no live exchange_rates dependency was introduced — the settlement section only reads already-converted period data', () => {
  assert.doesNotMatch(RP_BODY, /exchange_rate/i);
  assert.doesNotMatch(CRM_BODY, /exchange_rate/i);
  const totalsStart = SOURCE.indexOf('// TESTABLE:_buildCivitatisReportsSettlementTotals:start');
  const totalsEnd = SOURCE.indexOf('// TESTABLE:_buildCivitatisReportsSettlementTotals:end');
  assert.doesNotMatch(SOURCE.slice(totalsStart, totalsEnd), /exchange_rate/i);
});

test('the Payments page\'s own, legitimate "Yüksek Tutarlı Bekleyenler" (PaySidebar, public.payments-based) is untouched by this phase', () => {
  const idx = SOURCE.indexOf('function PaySidebar(');
  const body = SOURCE.slice(idx, SOURCE.indexOf('\nfunction ', idx + 10));
  assert.match(body, /Yüksek Tutarlı Bekleyenler/);
  assert.match(body, /fmtMoney\(p\.remaining, p\.currency\)/);
});

test('no em or en dash introduced in any new user-facing Reports sentence copy (the quoted "—" empty-value placeholder glyph, this codebase\'s existing convention, is not a sentence-level dash and is excluded)', () => {
  const withoutPlaceholder = CIV_SECTION_BODY.replace(/"—"/g, '""');
  assert.doesNotMatch(withoutPlaceholder, /[–—]/);
});

test('no DB migration file or new SQL was introduced by this phase', () => {
  const sqlFiles = fs.readdirSync(REPO_ROOT).filter(f => /civitatis_settlement_phase3|reports_cleanup/i.test(f));
  assert.equal(sqlFiles.length, 0);
});
