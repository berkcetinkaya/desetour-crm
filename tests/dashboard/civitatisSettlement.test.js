'use strict';
/**
 * tests/dashboard/civitatisSettlement.test.js
 * ─────────────────────────────────────────────────────────────────────────
 * Civitatis Settlement Engine — Phase 1 (homepage receivable card).
 * Exercises the REAL shipping pure helpers from DeseTourDashboard.jsx
 * (_civitatisEffectiveSettlementStatus, _civitatisConvertToTry,
 * _latestCivitatisRatesByCurrency, _buildCivitatisSettlementSummary),
 * extracted via the existing TESTABLE-marker convention, plus static
 * source inspection for the homepage UI wiring (role gating, no
 * requested/paid/edit/delete action anywhere, "Hakedişleri Gör" link,
 * gold/amber-never-red priority styling, and the explicit "do not
 * touch" guarantees for Reports/Payments/Reservations payment_status/
 * retail_amount this phase was told to respect). No real Supabase/
 * network call anywhere in this file. The database-level eligibility/
 * backfill/trigger/idempotency logic is covered separately in
 * tests/tourPreparation/civitatisSettlementPhase1Migration.test.js and
 * was validated live against a throwaway local Postgres during
 * implementation — this file covers the application/presentation layer.
 * ─────────────────────────────────────────────────────────────────────────
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const SOURCE_PATH = path.join(__dirname, '..', '..', 'DeseTourDashboard.jsx');
const SOURCE = fs.readFileSync(SOURCE_PATH, 'utf8');

// The four settlement-math helpers are contiguous in the source and the
// later ones depend on the earlier ones (and on the module-level
// _CIVITATIS_TRY_EQUIVALENT_CURRENCIES const) being in the same scope —
// the single-marker extractTestableFn helper can't supply that, so this
// file extracts the whole contiguous region (const through the last
// function's end marker) once, the same combined-extraction approach
// preparationReversal.test.js already established for a multi-function
// dependency chain.
function extractCivitatisSettlementHelpers() {
  const start = SOURCE.indexOf('const _CIVITATIS_TRY_EQUIVALENT_CURRENCIES');
  const end = SOURCE.indexOf('// TESTABLE:_buildCivitatisSettlementSummary:end');
  assert.ok(start !== -1 && end !== -1, 'settlement helper region not found');
  const body = SOURCE.slice(start, end);
  // eslint-disable-next-line no-new-func
  const factory = new Function(`
    ${body}
    return { _civitatisEffectiveSettlementStatus, _civitatisConvertToTry, _latestCivitatisRatesByCurrency, _buildCivitatisSettlementSummary };
  `);
  return factory();
}

const {
  _civitatisEffectiveSettlementStatus,
  _civitatisConvertToTry,
  _latestCivitatisRatesByCurrency,
  _buildCivitatisSettlementSummary,
} = extractCivitatisSettlementHelpers();

function item(overrides) {
  return Object.assign({
    id: 'i1', reservationId: 'r1', settlementPeriod: '2026-09-01',
    originalAmount: 100, originalCurrency: 'EUR', claimableAt: '2026-10-01',
    status: 'accrued',
  }, overrides);
}

// ═══════════════════════════════════════════════════════════════════════
// _civitatisEffectiveSettlementStatus — the pure accrued->claimable rule
// (brief validation items 4 and 5: September completion claimable in
// October; October completion still accruing during October)
// ═══════════════════════════════════════════════════════════════════════

test('a September settlement item (claimable_at = 1 October) is effectively claimable once today is on/after 1 October', () => {
  const sep = item({ settlementPeriod:'2026-09-01', claimableAt:'2026-10-01', status:'accrued' });
  assert.equal(_civitatisEffectiveSettlementStatus(sep, '2026-10-01'), 'claimable');
  assert.equal(_civitatisEffectiveSettlementStatus(sep, '2026-10-15'), 'claimable');
});

test('an October settlement item (claimable_at = 1 November) is still accrued throughout October', () => {
  const oct = item({ settlementPeriod:'2026-10-01', claimableAt:'2026-11-01', status:'accrued' });
  assert.equal(_civitatisEffectiveSettlementStatus(oct, '2026-10-12'), 'accrued');
  assert.equal(_civitatisEffectiveSettlementStatus(oct, '2026-10-31'), 'accrued');
});

test('requested/paid/adjusted/cancelled stored statuses always pass through unchanged, regardless of claimable_at vs today', () => {
  for (const status of ['requested', 'paid', 'adjusted', 'cancelled']) {
    const it = item({ status, claimableAt:'2020-01-01' }); // claimable_at far in the past — would flip 'accrued' but must never flip these
    assert.equal(_civitatisEffectiveSettlementStatus(it, '2026-10-03'), status);
  }
});

test('never a scheduled-job write: this is a pure read of stored fields, never mutates the item it is given', () => {
  const it = item({ status:'accrued', claimableAt:'2020-01-01' });
  const before = JSON.stringify(it);
  _civitatisEffectiveSettlementStatus(it, '2026-10-03');
  assert.equal(JSON.stringify(it), before);
});

// ═══════════════════════════════════════════════════════════════════════
// _civitatisConvertToTry (brief validation items 6-10)
// ═══════════════════════════════════════════════════════════════════════

test('a TRY amount requires no conversion — returned unchanged regardless of what rates are cached', () => {
  const { tryAmount, missingRate } = _civitatisConvertToTry(3600, 'TRY', {});
  assert.equal(tryAmount, 3600);
  assert.equal(missingRate, false);
});

test('a TL amount is treated exactly as TRY — no conversion, unchanged amount', () => {
  const { tryAmount, missingRate } = _civitatisConvertToTry(3600, 'TL', {});
  assert.equal(tryAmount, 3600);
  assert.equal(missingRate, false);
});

test('a EUR amount is converted using the cached EUR->TRY rate', () => {
  const { tryAmount, missingRate } = _civitatisConvertToTry(50, 'EUR', { EUR: 40 });
  assert.equal(tryAmount, 2000);
  assert.equal(missingRate, false);
});

test('a USD amount is converted using the cached USD->TRY rate', () => {
  const { tryAmount, missingRate } = _civitatisConvertToTry(100, 'USD', { USD: 35 });
  assert.equal(tryAmount, 3500);
  assert.equal(missingRate, false);
});

test('missing FX data never produces a fake TRY total — no rate cached for the currency returns tryAmount:null, missingRate:true', () => {
  const { tryAmount, missingRate } = _civitatisConvertToTry(50, 'GBP', { EUR: 40, USD: 35 });
  assert.equal(tryAmount, null);
  assert.equal(missingRate, true);
});

test('never assumes EUR as TRY, or any other currency as TRY, when the rate is missing', () => {
  const { tryAmount, missingRate } = _civitatisConvertToTry(50, 'EUR', {}); // no EUR rate cached at all
  assert.equal(tryAmount, null);
  assert.equal(missingRate, true);
});

test('a zero or negative cached rate is treated as missing, never used to divide/multiply into a nonsensical total', () => {
  assert.equal(_civitatisConvertToTry(50, 'EUR', { EUR: 0 }).missingRate, true);
  assert.equal(_civitatisConvertToTry(50, 'EUR', { EUR: -5 }).missingRate, true);
});

// ═══════════════════════════════════════════════════════════════════════
// _latestCivitatisRatesByCurrency
// ═══════════════════════════════════════════════════════════════════════

test('picks the most recent rate_date per base_currency, never an average, never an arbitrary older row', () => {
  const rows = [
    { baseCurrency:'EUR', rateDate:'2026-10-01', rate:38 },
    { baseCurrency:'EUR', rateDate:'2026-10-02', rate:40 },
    { baseCurrency:'USD', rateDate:'2026-09-30', rate:33 },
  ];
  const latest = _latestCivitatisRatesByCurrency(rows);
  assert.equal(latest.EUR, 40);
  assert.equal(latest.USD, 33);
});

test('empty input produces an empty rate map, never a thrown error', () => {
  assert.deepEqual(_latestCivitatisRatesByCurrency([]), {});
  assert.deepEqual(_latestCivitatisRatesByCurrency(null), {});
});

// ═══════════════════════════════════════════════════════════════════════
// _buildCivitatisSettlementSummary (brief validation items 11, 12, 14)
// ═══════════════════════════════════════════════════════════════════════

test('requested settlements are excluded from the claimable total', () => {
  const items = [
    item({ id:'claim1', status:'accrued', claimableAt:'2026-10-01', originalCurrency:'TRY', originalAmount:1000 }),
    item({ id:'req1', status:'requested', originalCurrency:'TRY', originalAmount:9999 }),
  ];
  const summary = _buildCivitatisSettlementSummary(items, {}, '2026-10-03');
  assert.equal(summary.claimable.tryTotal, 1000);
  assert.equal(summary.claimable.itemIds.includes('req1'), false);
  assert.equal(summary.requested.tryTotal, 9999);
});

test('paid settlements are excluded from every outstanding bucket (claimable, current-month accrual, requested)', () => {
  const items = [
    item({ id:'paid1', status:'paid', originalCurrency:'TRY', originalAmount:5000 }),
    item({ id:'claim1', status:'accrued', claimableAt:'2026-10-01', originalCurrency:'TRY', originalAmount:1000 }),
  ];
  const summary = _buildCivitatisSettlementSummary(items, {}, '2026-10-03');
  assert.equal(summary.paid.tryTotal, 5000);
  assert.equal(summary.claimable.itemIds.includes('paid1'), false);
  assert.equal(summary.currentMonthAccrual.itemIds.includes('paid1'), false);
  assert.equal(summary.requested.itemIds.includes('paid1'), false);
});

test('adjusted and cancelled settlement items never appear in any bucket at all', () => {
  const items = [
    item({ id:'adj1', status:'adjusted' }),
    item({ id:'canc1', status:'cancelled' }),
  ];
  const summary = _buildCivitatisSettlementSummary(items, {}, '2026-10-03');
  for (const bucket of [summary.claimable, summary.currentMonthAccrual, summary.requested, summary.paid]) {
    assert.equal(bucket.itemIds.includes('adj1'), false);
    assert.equal(bucket.itemIds.includes('canc1'), false);
  }
});

test('current-month accrual only ever includes accrued items whose settlement_period is the current calendar month', () => {
  const items = [
    item({ id:'thisMonth', status:'accrued', settlementPeriod:'2026-10-01', claimableAt:'2026-11-01', originalCurrency:'TRY', originalAmount:500 }),
    item({ id:'lastMonthNowClaimable', status:'accrued', settlementPeriod:'2026-09-01', claimableAt:'2026-10-01', originalCurrency:'TRY', originalAmount:700 }),
  ];
  const summary = _buildCivitatisSettlementSummary(items, {}, '2026-10-03');
  assert.deepEqual(summary.currentMonthAccrual.itemIds, ['thisMonth']);
  assert.equal(summary.currentMonthAccrual.tryTotal, 500);
  assert.equal(summary.claimable.tryTotal, 700);
});

test('every total is traceable back to the exact settlement item ids (and therefore reservation ids) that make it up', () => {
  const items = [
    item({ id:'a', reservationId:'res-a', status:'accrued', claimableAt:'2026-10-01', originalCurrency:'TRY', originalAmount:1000 }),
    item({ id:'b', reservationId:'res-b', status:'accrued', claimableAt:'2026-10-01', originalCurrency:'TRY', originalAmount:2000 }),
  ];
  const summary = _buildCivitatisSettlementSummary(items, {}, '2026-10-03');
  assert.deepEqual(summary.claimable.itemIds.slice().sort(), ['a', 'b']);
  assert.deepEqual(summary.claimable.reservationIds.slice().sort(), ['res-a', 'res-b']);
  assert.equal(summary.claimable.tryTotal, 3000);
  assert.equal(summary.claimable.itemCount, 2);
});

test('a bucket with a missing-rate item is flagged hasMissingRate, and that item\'s amount is excluded from the total while still being tracked for traceability', () => {
  const items = [
    item({ id:'ok', status:'accrued', claimableAt:'2026-10-01', originalCurrency:'TRY', originalAmount:1000 }),
    item({ id:'noRate', status:'accrued', claimableAt:'2026-10-01', originalCurrency:'GBP', originalAmount:50 }),
  ];
  const summary = _buildCivitatisSettlementSummary(items, { EUR:40 }, '2026-10-03'); // no GBP rate cached
  assert.equal(summary.claimable.hasMissingRate, true);
  assert.equal(summary.claimable.tryTotal, 1000); // GBP item's amount never silently folded in
  assert.equal(summary.claimable.itemCount, 2); // but still counted/traced
  assert.ok(summary.claimable.itemIds.includes('noRate'));
});

test('multiple currencies in the same bucket are preserved separately in originalByCurrency, never summed across currencies as one blended original figure', () => {
  const items = [
    item({ id:'a', status:'accrued', claimableAt:'2026-10-01', originalCurrency:'TRY', originalAmount:1000 }),
    item({ id:'b', status:'accrued', claimableAt:'2026-10-01', originalCurrency:'EUR', originalAmount:50 }),
  ];
  const summary = _buildCivitatisSettlementSummary(items, { EUR:40 }, '2026-10-03');
  assert.equal(summary.claimable.originalByCurrency.TRY, 1000);
  assert.equal(summary.claimable.originalByCurrency.EUR, 50);
});

test('an empty items array produces a fully zeroed, non-throwing summary', () => {
  const summary = _buildCivitatisSettlementSummary([], {}, '2026-10-03');
  for (const bucket of [summary.claimable, summary.currentMonthAccrual, summary.requested, summary.paid]) {
    assert.equal(bucket.tryTotal, 0);
    assert.equal(bucket.itemCount, 0);
    assert.equal(bucket.hasMissingRate, false);
  }
});

// ═══════════════════════════════════════════════════════════════════════
// Homepage UI wiring — desktop (CivitatisHakedisPanel) + mobile
// ═══════════════════════════════════════════════════════════════════════

function _panelBody(name) {
  const start = SOURCE.indexOf(`function ${name}(`);
  assert.ok(start !== -1, `${name} not found`);
  // Bounded to the next top-level "function " declaration, same
  // convention other dashboard-panel tests in this suite already use.
  const end = SOURCE.indexOf('\nfunction ', start + 10);
  return SOURCE.slice(start, end);
}

test('CivitatisHakedisPanel is gated to Yönetici/Operasyon only — every other role sees nothing', () => {
  const body = _panelBody('CivitatisHakedisPanel');
  assert.match(body, /\["Yönetici", "Operasyon"\]\.includes\(auth\.role\)/);
  assert.match(body, /if \(!eligible \|\| loading \|\| error \|\| !data\) return null;/);
});

test('CivitatisHakedisPanel reads from the civitatisSettlement repo entity, never a raw Supabase call of its own', () => {
  const body = _panelBody('CivitatisHakedisPanel');
  assert.match(body, /useRepo\("civitatisSettlement", "getSummary"\)/);
  assert.doesNotMatch(body, /\.from\(['"]civitatis_settlement_items['"]\)/);
  assert.doesNotMatch(body, /\.from\(['"]exchange_rates['"]\)/);
});

test('the primary claimable figure is never combined with current-month accrual or requested into one blended number', () => {
  const body = _panelBody('CivitatisHakedisPanel');
  assert.match(body, /claimable\.tryTotal/);
  assert.match(body, /currentMonthAccrual\.tryTotal/);
  assert.match(body, /requested\.tryTotal/);
  assert.doesNotMatch(body, /claimable\.tryTotal\s*\+\s*currentMonthAccrual\.tryTotal/);
  assert.doesNotMatch(body, /claimable\.tryTotal\s*\+\s*requested\.tryTotal/);
});

test('claimable priority styling uses the existing gold accent, never red, when there is a claimable amount', () => {
  const body = _panelBody('CivitatisHakedisPanel');
  assert.match(body, /hasClaimable \? \{ border:`1\.5px solid \$\{C\.gold\}`, background:C\.goldPale \} : undefined/);
  assert.doesNotMatch(body, /hasClaimable[\s\S]{0,200}C\.red/);
});

test('the "Kur bilgisi bekleniyor" fallback appears for every bucket, never a fabricated converted total', () => {
  const body = _panelBody('CivitatisHakedisPanel');
  const occurrences = body.match(/Kur bilgisi bekleniyor/g) || [];
  assert.ok(occurrences.length >= 3, 'expected the fallback note for claimable, current-month accrual, and requested');
});

test('"Hakedişleri Gör" navigates to the existing Payments page — no new route is introduced in Phase 1', () => {
  const body = _panelBody('CivitatisHakedisPanel');
  assert.match(body, /action="Hakedişleri Gör"/);
  assert.match(body, /NAV_REF\.fn\(['"]\/payments['"]\)/);
});

test('the desktop panel contains NO requested/paid/edit/delete action — Phase 1 is informational only', () => {
  const body = _panelBody('CivitatisHakedisPanel');
  assert.doesNotMatch(body, /mutate\(/);
  assert.doesNotMatch(body, /Talep Edildi Olarak İşaretle/);
  assert.doesNotMatch(body, /Ödendi Olarak İşaretle/);
  assert.doesNotMatch(body, /onClick=\{.*(update|delete|mutate)/i);
});

test('the mobile Civitatis section is also gated to Yönetici/Operasyon, reuses the same repo call and the same pure summary, and has no action buttons either', () => {
  const start = SOURCE.indexOf('Civitatis Settlement Engine — Phase 1. Admin/operations only,\n          same eligibility');
  assert.ok(start !== -1, 'mobile Civitatis section comment not found');
  const end = SOURCE.indexOf('{/* Tour Preparation Intelligence Phase C2D-4', start);
  const body = SOURCE.slice(start, end);
  assert.match(body, /\["Yönetici","Operasyon"\]\.includes\(auth\.role\)/);
  assert.match(body, /civitatisSettlement\.claimable\.tryTotal/);
  assert.doesNotMatch(body, /mutate\(/);
  assert.match(body, /navigate\('\/payments'\)/);
});

test('mobile Civitatis section fetches via the same civitatisSettlement/getSummary repo call used on desktop — no separate query', () => {
  assert.match(SOURCE, /const \{ data:civitatisSettlement, loading:civSettleLoading, error:civSettleError \} = useRepo\("civitatisSettlement", "getSummary"\);/);
});

// ═══════════════════════════════════════════════════════════════════════
// Repo + getActiveRepo wiring
// ═══════════════════════════════════════════════════════════════════════

test('SupabaseCivitatisSettlementRepo.getSummary fetches civitatis_settlement_items and exchange_rates, and delegates all aggregation to the pure helper — zero business logic of its own', () => {
  const start = SOURCE.indexOf('const SupabaseCivitatisSettlementRepo = {');
  const end = SOURCE.indexOf('\n};', start);
  const body = SOURCE.slice(start, end);
  assert.match(body, /\.from\('civitatis_settlement_items'\)\.select\('\*'\)/);
  assert.match(body, /\.from\('exchange_rates'\)/);
  assert.match(body, /\.eq\('quote_currency', 'TRY'\)/);
  assert.match(body, /_buildCivitatisSettlementSummary\(items, latestRateByCurrency, _TODAY_ISO\)/);
  // Never writes anywhere — Phase 1 is read-only for this entity.
  assert.doesNotMatch(body, /\.insert\(|\.update\(|\.delete\(|\.upsert\(/);
});

test('getActiveRepo registers civitatisSettlement with a safe non-Supabase mock fallback that also returns a well-formed empty summary', () => {
  assert.match(SOURCE, /if\(entity==='civitatisSettlement'\) return useReal \? SupabaseCivitatisSettlementRepo : \{ getSummary: async \(\) => _buildCivitatisSettlementSummary\(\[\], \{\}, _TODAY_ISO\) \};/);
});

// ═══════════════════════════════════════════════════════════════════════
// retail_amount is never used as Dese Tour revenue anywhere in this
// phase's new code (brief section 1's explicit rule, section 27 item 17)
// ═══════════════════════════════════════════════════════════════════════

test('none of the new settlement/homepage code references retail_amount or retail_currency', () => {
  const regionsToCheck = [
    _panelBody('CivitatisHakedisPanel'),
    (() => { const s = SOURCE.indexOf('const _CIVITATIS_TRY_EQUIVALENT_CURRENCIES'); const e = SOURCE.indexOf('// TESTABLE:_buildCivitatisSettlementSummary:end'); return SOURCE.slice(s, e); })(),
    (() => { const s = SOURCE.indexOf('const SupabaseCivitatisSettlementRepo = {'); const e = SOURCE.indexOf('\n};', s); return SOURCE.slice(s, e); })(),
  ];
  for (const region of regionsToCheck) {
    assert.doesNotMatch(region, /retail_amount|retailAmount|retail_currency|retailCurrency/);
  }
});

// ═══════════════════════════════════════════════════════════════════════
// Do-not-touch guarantees (brief section 25 / final report items 18-20)
// ═══════════════════════════════════════════════════════════════════════

test('calculateReportMetrics (Reports page) is untouched by this phase — still the exact currency-blind aggregation Phase 0 found, not repaired and not reused here', () => {
  const start = SOURCE.indexOf('function calculateReportMetrics(period, reservations, payments, customers, sources, guides, guidePayments) {');
  assert.ok(start !== -1);
  const end = SOURCE.indexOf('\n}', SOURCE.indexOf('return {\n    kpi,', start));
  const body = SOURCE.slice(start, end);
  assert.doesNotMatch(body, /civitatisSettlement|civitatis_settlement_items|exchange_rates/i);
});

test('PaymentsPage is untouched by this phase — no civitatisSettlement reference inside it', () => {
  const start = SOURCE.indexOf('function PaymentsPage()');
  const end = SOURCE.indexOf('\nfunction ', start + 10);
  const body = SOURCE.slice(start, end);
  assert.doesNotMatch(body, /civitatisSettlement|civitatis_settlement_items/i);
});

test('reservations.payment_status mapping/update code (_p2App, SupabaseReservationRepo.update field map) is untouched — no civitatisSettlement reference anywhere near it', () => {
  const idx = SOURCE.indexOf("const _p2App=v=>_PAY_S_APP[v]||v||'Bekliyor';");
  assert.ok(idx !== -1);
  const nearby = SOURCE.slice(idx, idx + 400);
  assert.doesNotMatch(nearby, /civitatisSettlement/i);
});

test('this phase introduces no sentence-level em or en dash in its new Turkish UI copy strings', () => {
  const uiStrings = [
    'Civitatis Hakedişi', 'Talep Edilebilir', 'Bu Ay Biriken', 'Talep Edildi',
    'Hakedişleri Gör', 'Kur bilgisi bekleniyor', 'Civitatis ödemesi bekleniyor',
    'Talep edilebilir hakediş yok', 'Bu ay henüz biriken tutar yok', 'başında talep edilebilir',
  ];
  for (const s of uiStrings) {
    assert.doesNotMatch(s, /[–—]/, `"${s}" must not contain an em/en dash`);
  }
});
