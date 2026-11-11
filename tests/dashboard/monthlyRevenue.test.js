'use strict';
/**
 * tests/dashboard/monthlyRevenue.test.js
 * "Bu Ay Beklenen Ciro" — summarizeMonthlyExpectedRevenue, the ONE
 * calculation behind the KPI card, the RevenueGoalCard, its milestones and
 * its celebration. TRY/TL is used as-is; EUR/USD/GBP are converted with the
 * newest fresh ECB →TRY rate from exchange_rates; anything else (or a
 * missing/stale rate) is excluded — never guessed, never a fixed rate.
 *
 * Every exchange rate below is FAKE TEST DATA passed in as rate rows. No
 * rate value is hardcoded in production logic (asserted at the bottom).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { extractTestableFn } = require('./extractTestableFn');

const summarize = extractTestableFn('summarizeMonthlyExpectedRevenue');
const selectRates = extractTestableFn('_selectLatestFxRatesToTry');
const progress = extractTestableFn('_revenueMilestoneProgress');
const shouldCelebrate = extractTestableFn('_shouldCelebrateMilestone');
const canCelebrate = extractTestableFn('_canCelebrateRevenue');

const SOURCE = fs.readFileSync(path.join(__dirname, '..', '..', 'DeseTourDashboard.jsx'), 'utf8');

const TODAY_ISO = '2026-09-15'; // fixes "the current month" to September 2026

function res(overrides) {
  return {
    id: 'r-' + Math.random().toString(36).slice(2),
    checkIn: '2026-09-10',
    opStatus: 'Onaylandı',
    total: 0,
    currency: 'TRY',
    retailAmount: null,
    retailCurrency: null,
    ...overrides,
  };
}

// Fake rate rows in the repo's mapped shape. 1 base = rate TRY.
function rate(base, value, rateDate = '2026-09-14') {
  return { baseCurrency: base, quoteCurrency: 'TRY', rate: value, rateDate };
}
const FRESH_RATES = [rate('EUR', 40), rate('USD', 30), rate('GBP', 50)];

// ── Month window, amount choice, cancellations ───────────────────────────

test('TRY-only month: sums every in-month reservation, nothing converted or excluded', () => {
  const s = summarize([
    res({ checkIn: '2026-09-01', total: 4800 }),
    res({ checkIn: '2026-09-18', total: 9600, currency: 'TL' }),
    res({ checkIn: '2026-09-30', total: 4800, currency: ' try ' }),
  ], TODAY_ISO, []);
  assert.equal(s.total, 19200);
  assert.equal(s.nativeTryTotal, 19200);
  assert.equal(s.convertedTryTotal, 0);
  assert.equal(s.nativeCount, 3);
  assert.equal(s.convertedCount, 0);
  assert.equal(s.excludedCount, 0);
  assert.equal(s.hasMissingOrStaleRate, false);
});

test('reservations outside the current month (by check_in) are ignored entirely', () => {
  const s = summarize([
    res({ checkIn: '2026-09-10', total: 4800 }),
    res({ checkIn: '2026-08-31', total: 99999 }),
    res({ checkIn: '2026-10-01', total: 99999, currency: 'EUR' }),
    res({ checkIn: null, total: 99999 }),
  ], TODAY_ISO, FRESH_RATES);
  assert.equal(s.total, 4800);
  assert.equal(s.excludedCount, 0);
});

test('cancelled reservations are excluded from the total AND from converted/excluded counts', () => {
  const s = summarize([
    res({ total: 4800, opStatus: 'İptal' }),
    res({ total: 100, currency: 'EUR', opStatus: 'İptal' }),
    res({ total: 100, currency: 'XYZ', opStatus: 'İptal' }),
    res({ total: 4800, opStatus: 'Tamamlandı' }),
  ], TODAY_ISO, FRESH_RATES);
  assert.equal(s.total, 4800);
  assert.equal(s.convertedCount, 0);
  assert.equal(s.excludedCount, 0);
});

test('NET amount: Civitatis total_amount (commission deducted) is used; the customer-facing retail price never is', () => {
  const s = summarize([
    // net proceeds in EUR, retail price in TRY → EUR net converted
    res({ total: 50, currency: 'EUR', retailAmount: 4800, retailCurrency: 'TRY' }),
    // net in TRY, retail price in EUR → TRY net as-is
    res({ total: 3000, currency: 'TRY', retailAmount: 90, retailCurrency: 'eur' }),
  ], TODAY_ISO, FRESH_RATES);
  assert.equal(s.nativeTryTotal, 3000);
  assert.equal(s.convertedTryTotal, 50 * 40);
  assert.equal(s.total, 3000 + 2000);
});

test('total amount + currency are the fallback when retail_amount is absent', () => {
  const s = summarize([
    res({ total: 100, currency: 'USD', retailAmount: null, retailCurrency: 'TRY' }),
  ], TODAY_ISO, FRESH_RATES);
  assert.equal(s.total, 3000, 'retail fields are ignored');
  assert.deepEqual(s.convertedByCurrency, { USD: 1 });
});

// ── Conversion ───────────────────────────────────────────────────────────

test('TRY + EUR: EUR converted with the EUR→TRY rate', () => {
  const s = summarize([res({ total: 10000 }), res({ total: 250, currency: 'EUR' })], TODAY_ISO, FRESH_RATES);
  assert.equal(s.nativeTryTotal, 10000);
  assert.equal(s.convertedTryTotal, 10000);
  assert.equal(s.total, 20000);
  assert.equal(s.convertedCount, 1);
  assert.equal(s.excludedCount, 0);
  assert.deepEqual(s.rateDatesUsed, { EUR: '2026-09-14' });
});

test('TRY + USD: USD converted with the USD→TRY rate', () => {
  const s = summarize([res({ total: 1000 }), res({ total: 100, currency: 'USD' })], TODAY_ISO, FRESH_RATES);
  assert.equal(s.total, 1000 + 3000);
  assert.deepEqual(s.convertedByCurrency, { USD: 1 });
});

test('TRY + GBP: GBP converted with the GBP→TRY rate', () => {
  const s = summarize([res({ total: 1000 }), res({ total: 100, currency: 'gbp ' })], TODAY_ISO, FRESH_RATES);
  assert.equal(s.total, 1000 + 5000);
  assert.deepEqual(s.convertedByCurrency, { GBP: 1 });
});

test('TRY + EUR + USD + GBP: each foreign currency uses its own pair; counts add up', () => {
  const s = summarize([
    res({ total: 1000 }),
    res({ total: 10, currency: 'EUR' }),
    res({ total: 10, currency: 'USD' }),
    res({ total: 10, currency: 'GBP' }),
  ], TODAY_ISO, FRESH_RATES);
  assert.equal(s.total, 1000 + 400 + 300 + 500);
  assert.equal(s.nativeCount, 1);
  assert.equal(s.convertedCount, 3);
  assert.equal(s.excludedCount, 0);
});

// ── Rate selection, missing, stale ───────────────────────────────────────

test('latest rate selection: newest rate_date per pair wins, regardless of row order', () => {
  const rows = [rate('EUR', 38, '2026-09-08'), rate('EUR', 41, '2026-09-11'), rate('EUR', 39, '2026-09-10')];
  const r = selectRates(rows, TODAY_ISO);
  assert.equal(r.EUR.rate, 41);
  assert.equal(r.EUR.rateDate, '2026-09-11');
  const s = summarize([res({ total: 100, currency: 'EUR' })], TODAY_ISO, rows);
  assert.equal(s.total, 4100);
  assert.deepEqual(s.rateDatesUsed, { EUR: '2026-09-11' });
});

test('rate selection ignores non-TRY quotes, unsupported bases and invalid rates', () => {
  const r = selectRates([
    { baseCurrency: 'EUR', quoteCurrency: 'USD', rate: 1.1, rateDate: '2026-09-14' },
    rate('CHF', 45),
    rate('EUR', 0),
    rate('EUR', 'abc'),
    rate('USD', -3),
    null,
  ], TODAY_ISO);
  assert.deepEqual(r, {});
});

test('weekend/holiday: a rate a few days old is still fresh — rate date need not equal today', () => {
  const s = summarize([res({ total: 100, currency: 'EUR' })], '2026-09-14', [rate('EUR', 40, '2026-09-11')]);
  assert.equal(s.total, 4000);
  assert.equal(s.hasMissingOrStaleRate, false);
});

test('a rate exactly 7 days old is used; 8 days old is stale', () => {
  const sixth = summarize([res({ total: 100, currency: 'EUR' })], TODAY_ISO, [rate('EUR', 40, '2026-09-08')]);
  assert.equal(sixth.total, 4000);
  const stale = selectRates([rate('EUR', 40, '2026-09-07')], TODAY_ISO);
  assert.equal(stale.EUR.ageDays, 8);
  assert.equal(stale.EUR.stale, true);
});

test('stale rate: reservations needing it are excluded (not converted silently) and flagged', () => {
  const s = summarize([
    res({ total: 1000 }),
    res({ total: 100, currency: 'EUR' }),
    res({ total: 100, currency: 'USD' }),
  ], TODAY_ISO, [rate('EUR', 40, '2026-08-20'), rate('USD', 30)]);
  assert.equal(s.total, 1000 + 3000);
  assert.equal(s.convertedCount, 1);
  assert.equal(s.excludedCount, 1);
  assert.deepEqual(s.excludedByCurrency, { EUR: 1 });
  assert.equal(s.excludedByReason.stale_rate, 1);
  assert.deepEqual(s.staleRateCurrencies, ['EUR']);
  assert.equal(s.hasMissingOrStaleRate, true);
  assert.deepEqual(s.rateDatesUsed, { USD: '2026-09-14' }, 'a stale rate is never reported as used');
});

test('missing rate (e.g. empty exchange_rates): foreign reservations excluded, TRY unaffected', () => {
  const s = summarize([res({ total: 1000 }), res({ total: 100, currency: 'GBP' })], TODAY_ISO, []);
  assert.equal(s.total, 1000);
  assert.equal(s.excludedCount, 1);
  assert.equal(s.excludedByReason.missing_rate, 1);
  assert.deepEqual(s.missingRateCurrencies, ['GBP']);
  assert.equal(s.hasMissingOrStaleRate, true);
  // a null/undefined rate list (failed read) behaves the same way
  assert.equal(summarize([res({ total: 100, currency: 'GBP' })], TODAY_ISO, null).excludedCount, 1);
  assert.equal(summarize([res({ total: 100, currency: 'GBP' })], TODAY_ISO).excludedCount, 1);
});

test('unsupported or blank currency is excluded, never treated as TRY or EUR', () => {
  const s = summarize([
    res({ total: 5000, currency: 'CHF' }),
    res({ total: 5000, currency: null }),
    res({ total: 5000, currency: '  ' }),
  ], TODAY_ISO, FRESH_RATES.concat([rate('CHF', 45)]));
  assert.equal(s.total, 0);
  assert.equal(s.excludedCount, 3);
  assert.deepEqual(s.excludedByCurrency, { CHF: 1, 'BELİRSİZ': 2 });
  assert.equal(s.excludedByReason.unsupported_currency, 3);
  assert.equal(s.hasMissingOrStaleRate, false, 'unsupported currency is not a rate problem');
});

// ── November 2026 production structure (fake rate) ───────────────────────

test('November-like scenario: ₺168,600 TRY net + €500 net converted with a supplied test rate', () => {
  const TEST_EUR_RATE = 48.5; // FAKE test data only
  const reservations = [
    // 16 TRY/TL reservations; the Civitatis ones count with their NET total
    ...Array.from({ length: 15 }, (_, i) => res({ checkIn: '2026-11-' + String(i + 2).padStart(2, '0'), total: 11000, currency: i % 2 ? 'TL' : 'TRY' })),
    res({ checkIn: '2026-11-25', total: 3600, currency: 'TL', retailAmount: 14835, retailCurrency: 'TL' }),
    res({ checkIn: '2026-11-20', total: 500, currency: 'EUR', retailAmount: 683.30, retailCurrency: 'EUR' }),
    // 4 cancelled
    ...Array.from({ length: 4 }, () => res({ checkIn: '2026-11-12', total: 9000, opStatus: 'İptal' })),
  ];
  const s = summarize(reservations, '2026-11-10', [rate('EUR', TEST_EUR_RATE, '2026-11-09')]);
  assert.equal(s.nativeCount, 16);
  assert.equal(s.nativeTryTotal, 15 * 11000 + 3600);
  assert.equal(s.convertedCount, 1);
  assert.equal(s.convertedTryTotal, Math.round(500 * TEST_EUR_RATE * 100) / 100);
  assert.equal(s.total, Math.round((15 * 11000 + 3600 + 500 * TEST_EUR_RATE) * 100) / 100);
  assert.equal(s.excludedCount, 0);
  assert.deepEqual(s.rateDatesUsed, { EUR: '2026-11-09' });

  // Same data with today's empty production table: the EUR booking is excluded.
  const empty = summarize(reservations, '2026-11-10', []);
  assert.equal(empty.total, 15 * 11000 + 3600);
  assert.equal(empty.excludedCount, 1);
  assert.deepEqual(empty.missingRateCurrencies, ['EUR']);
});

// ── Milestones + celebration on the normalized total ─────────────────────

test('100K milestone crossing caused by converted revenue, and celebration on that same total', () => {
  const reservations = [res({ total: 95000 }), res({ total: 200, currency: 'EUR' })];
  const tryOnly = summarize(reservations, TODAY_ISO, []);
  assert.equal(progress(tryOnly.total, 100000).milestone, 0, 'without a rate, 95K has not crossed');
  const s = summarize(reservations, TODAY_ISO, [rate('EUR', 40)]);
  assert.equal(s.total, 103000);
  const p = progress(s.total, 100000);
  assert.equal(p.milestone, 100000);
  assert.equal(p.next, 200000);
  assert.equal(p.remaining, 97000);
  assert.equal(shouldCelebrate(p.milestone, 0), true);
});

test('milestone math example: ₺212,000 normalized → passed 200K, next 300K, 12% / 88%, ₺88,000 left', () => {
  const s = summarize([res({ total: 200000 }), res({ total: 300, currency: 'EUR' })], TODAY_ISO, [rate('EUR', 40)]);
  assert.equal(s.total, 212000);
  assert.deepEqual(progress(s.total, 100000), { value: 212000, milestone: 200000, next: 300000, pct: 12, remainingPct: 88, remaining: 88000 });
});

test('the helper never reads payments: its only inputs are reservations, today and rate rows', () => {
  assert.equal(summarize.length, 4);
  assert.doesNotMatch(summarize.toString(), /\bpayments?\b/i);
});

// ── No hardcoded / fixed-55 fallback ─────────────────────────────────────

function block(name) {
  const a = SOURCE.indexOf(`// TESTABLE:${name}:start`);
  const b = SOURCE.indexOf(`// TESTABLE:${name}:end`);
  assert.ok(a !== -1 && b > a, `markers for ${name}`);
  return SOURCE.slice(a, b);
}

test('no fixed EUR = 55 (or any hardcoded rate) fallback in the revenue normalization', () => {
  const src = block('summarizeMonthlyExpectedRevenue');
  assert.doesNotMatch(src, /_CIVITATIS_FIXED_EUR_TO_TRY_RATE|_civitatisConvertToTry/);
  assert.doesNotMatch(src, /\b55\b/);
  // the only numeric literals multiplied with an amount must be the looked-up rate
  assert.match(src, /convertedTryTotal \+= amount \* rates\[currency\]\.rate;/);
  assert.doesNotMatch(src, /amount \* \d/);
  assert.match(src, /const FX_MAX_RATE_AGE_DAYS = 7;/);
  assert.match(src, /const FX_SUPPORTED_FOREIGN_CURRENCIES = \['EUR', 'USD', 'GBP'\];/);
});

// ── Wiring: one calculation for KPI + revenue card ───────────────────────

test('KPI and RevenueGoalCard both read the one useMonthlyRevenueSummary hook — no parallel calculation', () => {
  assert.match(SOURCE, /function useMonthlyRevenueSummary\(\) \{/);
  assert.match(SOURCE, /summarizeMonthlyExpectedRevenue\(repoRes \|\| \[\], _TODAY_ISO, fxRows \|\| \[\], \{ rateSourceError \}\)/);
  assert.match(SOURCE, /useRepo\("exchangeRate", "getLatestToTry"\)/);
  assert.match(SOURCE, /return \{ summary, loading: resLoading \|\| fxLoading \};/, 'loading until BOTH reads settle');
  const calls = SOURCE.match(/summarizeMonthlyExpectedRevenue\(/g) || [];
  assert.equal(calls.length, 2, 'one definition + one call site (inside the shared hook)');
  assert.doesNotMatch(SOURCE, /summarizeMonthlyTRYRevenue|computeMonthlyReservationRevenue\(/);
});

test('"Beklenen Net Gelir" KPI (net of Civitatis commission) shows ₺ and the normalized total, with converted/excluded sub-labels', () => {
  const m = SOURCE.match(/label:"Beklenen Net Gelir",\s*\n\s*value:([^\n]+)\n\s*sub:([\s\S]*?)icon:/);
  assert.ok(m, 'KPI card definition');
  assert.match(m[1], /revLoading \? '…' : `₺\$\{rev\.total\.toLocaleString\("tr-TR"/);
  assert.match(m[2], /rev\.excludedCount > 0 \? `Bu ay · \$\{rev\.excludedCount\} rezervasyon hariç`/);
  assert.match(m[2], /rev\.convertedCount > 0 \? `Bu ay · \$\{rev\.convertedCount\} dövizli, ECB kuru ile`/);
  assert.match(m[2], /"Bu ay · Civitatis komisyonu düşülmüş"/);
  assert.match(SOURCE, /const \{ summary:rev, loading:revLoading \} = useMonthlyRevenueSummary\(\);/);
});

test('calculateDashboardMetrics no longer computes a (TRY-only) monthly revenue of its own', () => {
  const a = SOURCE.indexOf('function calculateDashboardMetrics(');
  const body = SOURCE.slice(a, SOURCE.indexOf('\nfunction ', a + 10));
  assert.doesNotMatch(body, /monthRev/);
});

// ── Browser read path: read-only, normal authenticated client ────────────

test('exchange rates are read with the normal CRM client, read-only, no service key in the browser', () => {
  const a = SOURCE.indexOf('const SupabaseExchangeRateRepo = {');
  assert.ok(a !== -1);
  const repo = SOURCE.slice(a, SOURCE.indexOf('\n};', a));
  assert.match(repo, /const sb = getSB\(\);/);
  assert.match(repo, /\.from\('exchange_rates'\)\s*\n\s*\.select\('base_currency,quote_currency,rate,rate_date'\)/);
  assert.doesNotMatch(repo, /\.(insert|upsert|update|delete|rpc)\(/);
  assert.doesNotMatch(SOURCE, /SUPABASE_SERVICE_ROLE_KEY|service_role_key|sb_secret_/i);
  assert.match(SOURCE, /if\(entity==='exchangeRate'\) return useReal \? SupabaseExchangeRateRepo : ExchangeRateRepository;/);
  assert.match(SOURCE, /const ExchangeRateRepository = \{ getLatestToTry: async \(\) => \[\] \};/, 'demo mode never invents a rate');
});

// ── Rate SOURCE error vs. missing rate ───────────────────────────────────

test('successful FX read: rateSourceError false, total complete, conversion normal', () => {
  const s = summarize([res({ total: 1000 }), res({ total: 10, currency: 'EUR' })], TODAY_ISO, FRESH_RATES, { rateSourceError: false });
  assert.equal(s.total, 1400);
  assert.equal(s.rateSourceError, false);
  assert.equal(s.fxUnresolved, false);
  assert.equal(s.isComplete, true);
});

test('missing rate after a SUCCESSFUL read is "missing_rate", not a source error', () => {
  const s = summarize([res({ total: 1000 }), res({ total: 10, currency: 'EUR' })], TODAY_ISO, [], { rateSourceError: false });
  assert.equal(s.excludedByReason.missing_rate, 1);
  assert.equal(s.excludedByReason.rate_source_error, 0);
  assert.deepEqual(s.missingRateCurrencies, ['EUR']);
  assert.equal(s.fxUnresolved, false);
  assert.equal(s.isComplete, false);
});

test('stale rate after a successful read is "stale_rate", not a source error', () => {
  const s = summarize([res({ total: 10, currency: 'EUR' })], TODAY_ISO, [rate('EUR', 40, '2026-09-01')], { rateSourceError: false });
  assert.equal(s.excludedByReason.stale_rate, 1);
  assert.equal(s.fxUnresolved, false);
});

test('repository / network / RLS read error: foreign reservations excluded as rate_source_error, never "missing rate"', () => {
  // Even if some (possibly partial) rows were around, a failed read trusts none of them.
  const s = summarize([
    res({ total: 1000 }),
    res({ total: 10, currency: 'EUR' }),
    res({ total: 10, currency: 'USD' }),
  ], TODAY_ISO, FRESH_RATES, { rateSourceError: true });
  assert.equal(s.total, 1000, 'only trusted native TRY remains');
  assert.equal(s.convertedCount, 0);
  assert.equal(s.excludedByReason.rate_source_error, 2);
  assert.equal(s.excludedByReason.missing_rate, 0);
  assert.deepEqual(s.missingRateCurrencies, []);
  assert.deepEqual(s.staleRateCurrencies, []);
  assert.equal(s.hasMissingOrStaleRate, false);
  assert.equal(s.rateSourceError, true);
  assert.equal(s.fxUnresolved, true);
  assert.equal(s.isComplete, false);
});

test('an unsupported currency during a source error stays "unsupported" — it never needed FX', () => {
  const s = summarize([res({ total: 10, currency: 'CHF' })], TODAY_ISO, [], { rateSourceError: true });
  assert.equal(s.excludedByReason.unsupported_currency, 1);
  assert.equal(s.excludedByReason.rate_source_error, 0);
  assert.equal(s.fxUnresolved, false);
});

test('pure TRY month with an FX source failure: complete, not blocked, celebration allowed', () => {
  const s = summarize([res({ total: 60000 }), res({ total: 45000 })], TODAY_ISO, null, { rateSourceError: true });
  assert.equal(s.total, 105000);
  assert.equal(s.rateSourceError, true);
  assert.equal(s.fxUnresolved, false);
  assert.equal(s.isComplete, true);
  assert.equal(canCelebrate(false, s), true);
  assert.equal(shouldCelebrate(progress(s.total, 100000).milestone, 0), true);
});

// ── Celebration safety ───────────────────────────────────────────────────

test('no celebration while anything is loading — a TRY-only subtotal can never celebrate before rates arrive', () => {
  const reservations = [res({ total: 95000 }), res({ total: 200, currency: 'EUR' })];
  // Rates still loading: the hook reports loading=true (and the summary has no rates yet).
  const preRates = summarize(reservations, TODAY_ISO, []);
  assert.equal(canCelebrate(true, preRates), false);
  // A TRY subtotal that already crossed 100K must not celebrate during loading either.
  const big = summarize([res({ total: 120000 }), res({ total: 10, currency: 'EUR' })], TODAY_ISO, []);
  assert.equal(canCelebrate(true, big), false);
  assert.equal(canCelebrate(true, null), false);
});

test('foreign reservation + FX source failure: no celebration even if the TRY subtotal crossed a step', () => {
  const s = summarize([res({ total: 130000 }), res({ total: 100, currency: 'EUR' })], TODAY_ISO, [], { rateSourceError: true });
  assert.equal(progress(s.total, 100000).milestone, 100000);
  assert.equal(canCelebrate(false, s), false);
});

test('celebration after the valid normalized total resolves', () => {
  const reservations = [res({ total: 95000 }), res({ total: 200, currency: 'EUR' })];
  const failed = summarize(reservations, TODAY_ISO, [], { rateSourceError: true });
  assert.equal(canCelebrate(false, failed), false);
  const resolved = summarize(reservations, TODAY_ISO, [rate('EUR', 40)], { rateSourceError: false });
  assert.equal(resolved.total, 103000);
  assert.equal(canCelebrate(false, resolved), true);
  assert.equal(shouldCelebrate(progress(resolved.total, 100000).milestone, 0), true);
  // once-per-month: the same step is not celebrated twice
  assert.equal(shouldCelebrate(100000, 100000), false);
});

test('a missing (not failed) rate still allows celebrating the trusted lower-bound total', () => {
  const s = summarize([res({ total: 130000 }), res({ total: 100, currency: 'EUR' })], TODAY_ISO, []);
  assert.equal(s.fxUnresolved, false);
  assert.equal(canCelebrate(false, s), true);
});
