'use strict';
/**
 * tests/dashboard/civitatisSettlementPhase2.test.js
 * ─────────────────────────────────────────────────────────────────────────
 * Civitatis Settlement Management — Phase 2 (Payments page transformation).
 * Exercises the new pure helper (_groupCivitatisSettlementItemsByPeriod,
 * extracted via the existing TESTABLE-marker convention together with
 * the Phase 1/1.3 helpers it depends on), plus static source inspection
 * for: the Payments page's two-domain tab split (Civitatis Hakedişleri
 * default, Doğrudan Ödemeler preserved), the repository layer
 * (getDetailed/markPeriodRequested/markPeriodPaid), role gating, the
 * exact required button label ("Talep Edildi Olarak İşaretle", never
 * "Talep Et"), no row-by-row update calls, and the explicit "do not
 * touch" guarantees (reservations.payment_status, retail_amount,
 * exchange_rates as a required dependency). No real Supabase/network
 * call anywhere in this file. The database-level transition logic
 * (eligibility, idempotency, authorization, immutability, audit
 * logging) is covered separately in
 * tests/tourPreparation/civitatisSettlementPhase2Migration.test.js and
 * was validated live against a throwaway local PostgreSQL instance
 * during implementation — this file covers the application/presentation
 * layer only.
 * ─────────────────────────────────────────────────────────────────────────
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const SOURCE_PATH = path.join(__dirname, '..', '..', 'DeseTourDashboard.jsx');
const SOURCE = fs.readFileSync(SOURCE_PATH, 'utf8');

// _groupCivitatisSettlementItemsByPeriod depends on
// _civitatisEffectiveSettlementStatus and _civitatisConvertToTry (Phase
// 1/1.3), which are contiguous with it in the source (same region the
// civitatisSettlement.test.js combined-extraction already covers) — so
// this file extracts the same contiguous const-through-end-marker region
// once, the same approach that file already established.
function extractHelpers() {
  const start = SOURCE.indexOf('const _CIVITATIS_TRY_EQUIVALENT_CURRENCIES');
  const end = SOURCE.indexOf('// TESTABLE:_groupCivitatisSettlementItemsByPeriod:end');
  assert.ok(start !== -1 && end !== -1, 'settlement + grouping helper region not found');
  const body = SOURCE.slice(start, end);
  // eslint-disable-next-line no-new-func
  const factory = new Function(`
    ${body}
    return { _civitatisEffectiveSettlementStatus, _civitatisConvertToTry, _groupCivitatisSettlementItemsByPeriod };
  `);
  return factory();
}

const { _groupCivitatisSettlementItemsByPeriod } = extractHelpers();

function item(overrides) {
  return Object.assign({
    id: 'i1', reservationId: 'r1', settlementPeriod: '2026-09-01',
    originalAmount: 100, originalCurrency: 'TRY', claimableAt: '2026-10-01',
    status: 'accrued', reservationNumber: 'R-2026-0001', destination: 'Grand Bazaar',
    checkIn: '2026-09-15', paxAdult: 2, paxChild: 0,
  }, overrides);
}

// ═══════════════════════════════════════════════════════════════════════
// _groupCivitatisSettlementItemsByPeriod
// ═══════════════════════════════════════════════════════════════════════

test('groups items by settlement_period, sorted ascending (oldest/most-overdue first)', () => {
  const items = [
    item({ id:'a', settlementPeriod:'2026-10-01', claimableAt:'2026-11-01' }),
    item({ id:'b', settlementPeriod:'2026-09-01', claimableAt:'2026-10-01' }),
  ];
  const groups = _groupCivitatisSettlementItemsByPeriod(items, '2026-10-04');
  assert.deepEqual(groups.map(g => g.settlementPeriod), ['2026-09-01', '2026-10-01']);
});

test('excludes adjusted and cancelled items — a cancelled period entry simply has one fewer item, never a dead row', () => {
  const items = [
    item({ id:'ok', status:'accrued' }),
    item({ id:'canc', status:'cancelled' }),
    item({ id:'adj', status:'adjusted' }),
  ];
  const groups = _groupCivitatisSettlementItemsByPeriod(items, '2026-10-04');
  assert.equal(groups.length, 1);
  assert.equal(groups[0].items.length, 1);
  assert.equal(groups[0].items[0].id, 'ok');
});

test('reservationCount and guestCount are summed correctly from pax_adult + pax_child', () => {
  const items = [
    item({ id:'a', paxAdult:2, paxChild:1 }),
    item({ id:'b', paxAdult:4, paxChild:0 }),
  ];
  const groups = _groupCivitatisSettlementItemsByPeriod(items, '2026-10-04');
  assert.equal(groups[0].reservationCount, 2);
  assert.equal(groups[0].guestCount, 7);
});

test('a period whose every item shares one effective status reports that status, never "mixed"', () => {
  const items = [
    item({ id:'a', status:'accrued', claimableAt:'2026-10-01' }),
    item({ id:'b', status:'accrued', claimableAt:'2026-10-01' }),
  ];
  const groups = _groupCivitatisSettlementItemsByPeriod(items, '2026-10-04');
  assert.equal(groups[0].effectiveStatus, 'claimable'); // accrued + claimable_at passed
});

test('a period with disagreeing effective statuses reports "mixed", defensively — the UI must never offer a transition button when unsure', () => {
  const items = [
    item({ id:'a', status:'requested' }),
    item({ id:'b', status:'accrued', claimableAt:'2026-10-01' }), // effectively claimable
  ];
  const groups = _groupCivitatisSettlementItemsByPeriod(items, '2026-10-04');
  assert.equal(groups[0].effectiveStatus, 'mixed');
});

test('a future accrued period (claimable_at not yet passed) reports effective status "accrued", not "claimable"', () => {
  const items = [item({ id:'a', status:'accrued', settlementPeriod:'2026-10-01', claimableAt:'2026-11-01' })];
  const groups = _groupCivitatisSettlementItemsByPeriod(items, '2026-10-04');
  assert.equal(groups[0].effectiveStatus, 'accrued');
});

test('TRY/TL totals pass through unconverted; 154.05 EUR converts to exactly 8472.75 at the fixed rate, summed with TRY', () => {
  const items = [
    item({ id:'a', originalCurrency:'TRY', originalAmount:3600 }),
    item({ id:'b', originalCurrency:'EUR', originalAmount:154.05 }),
  ];
  const groups = _groupCivitatisSettlementItemsByPeriod(items, '2026-10-04');
  assert.equal(groups[0].displayTryTotal, 12073); // Math.round(3600 + 8472.75)
  assert.equal(groups[0].hasUnsupportedCurrency, false);
});

test('a period containing an unsupported currency sets hasUnsupportedCurrency and displayTryTotal null — never a fabricated combined figure', () => {
  const items = [
    item({ id:'a', originalCurrency:'TRY', originalAmount:1000 }),
    item({ id:'b', originalCurrency:'USD', originalAmount:50 }),
  ];
  const groups = _groupCivitatisSettlementItemsByPeriod(items, '2026-10-04');
  assert.equal(groups[0].hasUnsupportedCurrency, true);
  assert.equal(groups[0].displayTryTotal, null);
});

test('originalByCurrency keeps each currency separate — never blended into one converted figure at the raw-amount level', () => {
  const items = [
    item({ id:'a', originalCurrency:'TRY', originalAmount:1000 }),
    item({ id:'b', originalCurrency:'EUR', originalAmount:50 }),
  ];
  const groups = _groupCivitatisSettlementItemsByPeriod(items, '2026-10-04');
  assert.equal(groups[0].originalByCurrency.TRY, 1000);
  assert.equal(groups[0].originalByCurrency.EUR, 50);
});

test('items within a period are returned sorted by check_in, for stable reservation-level display', () => {
  const items = [
    item({ id:'later', checkIn:'2026-09-29' }),
    item({ id:'earlier', checkIn:'2026-09-10' }),
  ];
  const groups = _groupCivitatisSettlementItemsByPeriod(items, '2026-10-04');
  assert.deepEqual(groups[0].items.map(i => i.id), ['earlier', 'later']);
});

test('empty input produces an empty array, never throwing', () => {
  assert.deepEqual(_groupCivitatisSettlementItemsByPeriod([], '2026-10-04'), []);
  assert.deepEqual(_groupCivitatisSettlementItemsByPeriod(null, '2026-10-04'), []);
});

test('an item with no settlement_period is silently skipped rather than corrupting a group', () => {
  const items = [item({ id:'a', settlementPeriod: null })];
  assert.deepEqual(_groupCivitatisSettlementItemsByPeriod(items, '2026-10-04'), []);
});

// ═══════════════════════════════════════════════════════════════════════
// Mapper — Phase 2 adds reservation join fields + requested_at/paid_at
// ═══════════════════════════════════════════════════════════════════════

test('mapCivitatisSettlementItemFromDB maps requested_at/paid_at and, when the row carries a joined reservation, its display fields', () => {
  const start = SOURCE.indexOf('function mapCivitatisSettlementItemFromDB');
  const end = SOURCE.indexOf('\n}', start);
  const body = SOURCE.slice(start, end);
  assert.match(body, /requestedAt: r\.requested_at \|\| null/);
  assert.match(body, /paidAt: r\.paid_at \|\| null/);
  assert.match(body, /reservationNumber: res\?\.reservation_number \|\| null/);
  assert.match(body, /destination: res\?\.destination \|\| null/);
  assert.match(body, /checkIn: res\?\.check_in \|\| null/);
  assert.match(body, /paxAdult: res\?\.pax_adult/);
  assert.match(body, /paxChild: res\?\.pax_child/);
});

// ═══════════════════════════════════════════════════════════════════════
// Repository layer — getDetailed / markPeriodRequested / markPeriodPaid
// ═══════════════════════════════════════════════════════════════════════

test('getDetailed joins reservations for display fields and returns both the aggregate summary and the period grouping from ONE query', () => {
  const start = SOURCE.indexOf('async getDetailed()');
  const end = SOURCE.indexOf('\n  },', start);
  const body = SOURCE.slice(start, end);
  assert.match(body, /\.from\('civitatis_settlement_items'\)/);
  assert.match(body, /reservation:reservations\(reservation_number,destination,check_in,pax_adult,pax_child,external_booking_id\)/);
  assert.match(body, /summary: _buildCivitatisSettlementSummary\(items, _TODAY_ISO\)/);
  assert.match(body, /periods: _groupCivitatisSettlementItemsByPeriod\(items, _TODAY_ISO\)/);
});

test('markPeriodRequested and markPeriodPaid call the atomic period-scoped RPCs — never a per-row .update() loop', () => {
  const requestedStart = SOURCE.indexOf('async markPeriodRequested(settlementPeriod)');
  const requestedEnd = SOURCE.indexOf('\n  },', requestedStart);
  const requestedBody = SOURCE.slice(requestedStart, requestedEnd);
  assert.match(requestedBody, /\.rpc\('fn_mark_civitatis_settlement_period_requested', \{ p_settlement_period: settlementPeriod \}\)/);
  assert.doesNotMatch(requestedBody, /\.from\(['"]civitatis_settlement_items['"]\)\.update\(/);

  const paidStart = SOURCE.indexOf('async markPeriodPaid(settlementPeriod)');
  const paidEnd = SOURCE.indexOf('\n  },', paidStart);
  const paidBody = SOURCE.slice(paidStart, paidEnd);
  assert.match(paidBody, /\.rpc\('fn_mark_civitatis_settlement_period_paid', \{ p_settlement_period: settlementPeriod \}\)/);
  assert.doesNotMatch(paidBody, /\.from\(['"]civitatis_settlement_items['"]\)\.update\(/);
});

test('getActiveRepo mock fallback covers getDetailed/markPeriodRequested/markPeriodPaid with safe, well-formed no-op results (Phase 2.1 structured shape)', () => {
  const start = SOURCE.indexOf("if(entity==='civitatisSettlement')");
  const end = SOURCE.indexOf('};', start) + 2;
  const body = SOURCE.slice(start, end);
  assert.match(body, /getDetailed: async \(\) => \(\{ summary: _buildCivitatisSettlementSummary\(\[\], _TODAY_ISO\), periods: \[\] \}\)/);
  assert.match(body, /markPeriodRequested: async \(\) => \(\{ result: 'no_actionable_items', affectedCount: 0, settlementPeriod: null \}\)/);
  assert.match(body, /markPeriodPaid: async \(\) => \(\{ result: 'no_actionable_items', affectedCount: 0, settlementPeriod: null \}\)/);
});

// ═══════════════════════════════════════════════════════════════════════
// PaymentsPage — two-domain tab split, Civitatis default
// ═══════════════════════════════════════════════════════════════════════

function componentBody(name) {
  const start = SOURCE.indexOf(`function ${name}(`);
  assert.ok(start !== -1, `${name} not found`);
  const end = SOURCE.indexOf('\nfunction ', start + 10);
  return SOURCE.slice(start, end);
}

test('PaymentsPage is a thin tab switcher defaulting to Civitatis Hakedişleri, with Doğrudan Ödemeler preserved and reachable', () => {
  const body = componentBody('PaymentsPage');
  assert.match(body, /useState\("civitatis"\)/);
  assert.match(body, /label:"Civitatis Hakedişleri"/);
  assert.match(body, /label:"Doğrudan Ödemeler"/);
  assert.match(body, /<_CivitatisHakedisleriView\/>/);
  assert.match(body, /<_DogrudanOdemelerView\/>/);
});

test('_DogrudanOdemelerView (renamed, unchanged body) still drives off the payment repo entity — public.payments is never deleted or repurposed', () => {
  const body = componentBody('_DogrudanOdemelerView');
  assert.match(body, /useRepo\("payment", "getAll"\)/);
  assert.doesNotMatch(body, /civitatisSettlement/);
});

test('_CivitatisHakedisleriView is gated to Yönetici/Operasyon only, same as the Dashboard homepage card', () => {
  const body = componentBody('_CivitatisHakedisleriView');
  assert.match(body, /\["Yönetici", "Operasyon"\]\.includes\(auth\.role\)/);
});

test('_CivitatisHakedisleriView reads via useRepo("civitatisSettlement","getDetailed") and mutates via useRepoMutation("civitatisSettlement") — never a raw Supabase call of its own', () => {
  const body = componentBody('_CivitatisHakedisleriView');
  assert.match(body, /useRepo\("civitatisSettlement", "getDetailed"\)/);
  assert.match(body, /useRepoMutation\("civitatisSettlement"\)/);
  assert.doesNotMatch(body, /\.from\(['"]civitatis_settlement_items['"]\)/);
});

test('the button label is exactly "Talep Edildi Olarak İşaretle" — never "Talep Et" — the CRM records an external action, it does not submit a claim', () => {
  const body = componentBody('_CivitatisHakedisleriView');
  assert.match(body, /Talep Edildi Olarak İşaretle/);
  assert.doesNotMatch(body, /["']Talep Et["']/);
  assert.doesNotMatch(body, />Talep Et</);
});

test('the paid button label is exactly "Ödeme Alındı Olarak İşaretle" — UI terminology cleanup: Civitatis owes DeseTour, so the CRM never implies DeseTour pays Civitatis ("Ödendi")', () => {
  const body = componentBody('_CivitatisHakedisleriView');
  assert.match(body, /Ödeme Alındı Olarak İşaretle/);
  assert.doesNotMatch(body, /"Ödendi Olarak İşaretle"/);
});

test('the requested-transition button only renders when effective status is claimable; the paid-transition button only when requested', () => {
  const body = componentBody('_CivitatisHakedisleriView');
  assert.match(body, /canRequest = p\.effectiveStatus === 'claimable'/);
  assert.match(body, /canMarkPaid = p\.effectiveStatus === 'requested'/);
  assert.match(body, /\{canRequest && \(/);
  assert.match(body, /\{canMarkPaid && \(/);
});

test('both transitions call mutate(...) through the shared mutation hook — never a direct supabase update call from the component', () => {
  const body = componentBody('_CivitatisHakedisleriView');
  assert.match(body, /handleTransition\('markPeriodRequested', p\.settlementPeriod\)/);
  assert.match(body, /handleTransition\('markPeriodPaid', p\.settlementPeriod\)/);
  assert.doesNotMatch(body, /\.update\(\{\s*status/);
});

test('a failed transition shows an error toast and never a fake success message', () => {
  const body = componentBody('_CivitatisHakedisleriView');
  const handlerStart = body.indexOf('async function handleTransition');
  const handlerEnd = body.indexOf('\n  }', handlerStart);
  const handler = body.slice(handlerStart, handlerEnd);
  assert.match(handler, /if \(err\) \{ showToast\("İşlem başarısız: " \+ err\); return; \}/);
});

test('the original net amount and currency are shown unconverted in the expanded reservation row; the EUR display conversion is a visibly separate, parenthetical figure, never a replacement', () => {
  const body = componentBody('_CivitatisHakedisleriView');
  assert.match(body, /it\.originalAmount\.toLocaleString\('tr-TR'\)\} \{it\.originalCurrency\}/);
  assert.match(body, /it\.originalCurrency === 'EUR'/);
  assert.match(body, /Math\.round\(it\.originalAmount\*55\)/);
});

test('the fixed-rate disclosure note is gated behind _civitatisHasEurExposure, same rule as Phase 1.3', () => {
  const body = componentBody('_CivitatisHakedisleriView');
  assert.match(body, /_civitatisHasEurExposure\(summary\)/);
  assert.match(body, /Sabit kur: €1 = ₺55/);
});

test('no new code in PaymentsPage/_CivitatisHakedisleriView/_DogrudanOdemelerView references reservations.payment_status or uses retail_amount as settlement revenue', () => {
  const regions = [componentBody('PaymentsPage'), componentBody('_CivitatisHakedisleriView'), componentBody('_DogrudanOdemelerView')];
  for (const body of regions) {
    assert.doesNotMatch(body, /payment_status/);
    assert.doesNotMatch(body, /retail_amount|retailAmount/);
  }
});

// ═══════════════════════════════════════════════════════════════════════
// Mobile — same two-domain split, same business rules
// ═══════════════════════════════════════════════════════════════════════

test('MobilePaymentsPage is also a thin tab switcher defaulting to Civitatis, with the direct-payments view preserved', () => {
  const body = componentBody('MobilePaymentsPage');
  assert.match(body, /useState\("civitatis"\)/);
  assert.match(body, /<_MobileCivitatisHakedisleriView\/>/);
  assert.match(body, /<_MobileDogrudanOdemelerView\/>/);
});

test('_MobileDogrudanOdemelerView (renamed, unchanged body) still drives off the payment repo entity', () => {
  const body = componentBody('_MobileDogrudanOdemelerView');
  assert.match(body, /useRepo\("payment", "getAll"\)/);
});

test('_MobileCivitatisHakedisleriView is gated to Yönetici/Operasyon, uses the same repo calls as desktop, and has the same two button labels', () => {
  const body = componentBody('_MobileCivitatisHakedisleriView');
  assert.match(body, /\["Yönetici", "Operasyon"\]\.includes\(auth\.role\)/);
  assert.match(body, /useRepo\("civitatisSettlement", "getDetailed"\)/);
  assert.match(body, /useRepoMutation\("civitatisSettlement"\)/);
  assert.match(body, /Talep Edildi Olarak İşaretle/);
  assert.match(body, /Ödeme Alındı Olarak İşaretle/);
  assert.doesNotMatch(body, /["']Talep Et["']/);
});

test('mobile transitions are also gated by effective status and never a row-by-row update', () => {
  const body = componentBody('_MobileCivitatisHakedisleriView');
  assert.match(body, /canRequest = p\.effectiveStatus === 'claimable'/);
  assert.match(body, /canMarkPaid = p\.effectiveStatus === 'requested'/);
  assert.doesNotMatch(body, /\.update\(\{\s*status/);
});

// ═══════════════════════════════════════════════════════════════════════
// No live exchange-rate dependency; no sentence-level dashes
// ═══════════════════════════════════════════════════════════════════════

test('neither the desktop nor mobile Civitatis view queries exchange_rates — the fixed 55 TRY rate needs no live/cached lookup', () => {
  for (const name of ['_CivitatisHakedisleriView', '_MobileCivitatisHakedisleriView']) {
    const body = componentBody(name);
    assert.doesNotMatch(body, /exchange_rates/);
  }
});

test('this phase introduces no sentence-level em or en dash in its new Turkish UI copy strings', () => {
  const uiStrings = [
    'Civitatis Hakedişleri', 'Doğrudan Ödemeler', 'Dönemlere Göre Hakedişler',
    'Talep Edildi Olarak İşaretle', 'Ödeme Alındı Olarak İşaretle',
    'Bu bölümü görüntüleme yetkiniz yok.', 'Henüz bir Civitatis hakediş kalemi yok.',
    'İşlem başarısız: ', 'kalem güncellendi', 'Bu dönem için güncellenecek kalem bulunamadı.',
  ];
  for (const s of uiStrings) {
    assert.doesNotMatch(s, /[–—]/, `"${s}" must not contain an em/en dash`);
  }
});

// ═══════════════════════════════════════════════════════════════════════
// Phase 2.1 — structured RPC result handling (financial integrity review)
// ═══════════════════════════════════════════════════════════════════════

test('CIVITATIS_TRANSITION_MESSAGES maps every non-success result to a distinct, honest Turkish message', () => {
  const start = SOURCE.indexOf('const CIVITATIS_TRANSITION_MESSAGES = {');
  const end = SOURCE.indexOf('\n};', start);
  const body = SOURCE.slice(start, end);
  assert.match(body, /already_requested: 'Bu dönemin hakediş talebi daha önce kaydedilmiş\.'/);
  assert.match(body, /already_paid: 'Bu dönem daha önce "Ödeme Alındı" olarak işaretlenmiş\.'/);
  assert.match(body, /not_yet_claimable: 'Bu dönem henüz talep edilebilir değil\.'/);
  assert.match(body, /mixed_or_ineligible_period: 'Bu dönemde farklı hakediş durumları bulundu\. İşlem yapılmadı; kontrol gerekli\.'/);
  assert.match(body, /no_actionable_items: 'Bu dönemde işleme uygun hakediş bulunmuyor\.'/);
  assert.match(body, /period_not_found: 'Hakediş dönemi bulunamadı\.'/);
  // Every value distinct -- no two outcomes silently collapse to the same text.
  const values = [...body.matchAll(/: '([^']*)'/g)].map(m => m[1]);
  assert.equal(new Set(values).size, values.length, 'every transition message must be distinct');
});

test('handleTransition (desktop and mobile) treats only result==="requested"/"paid" as success; every other result routes through CIVITATIS_TRANSITION_MESSAGES, never the old generic message for a real rejection', () => {
  for (const name of ['_CivitatisHakedisleriView', '_MobileCivitatisHakedisleriView']) {
    const body = componentBody(name);
    const start = body.indexOf('async function handleTransition');
    const end = body.indexOf('\n  }', start);
    const handler = body.slice(start, end);
    assert.match(handler, /res\?\.result === 'requested' \|\| res\?\.result === 'paid'/);
    assert.match(handler, /CIVITATIS_TRANSITION_MESSAGES\[res\?\.result\]/);
  }
});

test('repo markPeriodRequested/markPeriodPaid return {result, affectedCount, settlementPeriod}, reading the JSONB RPC response by its real keys', () => {
  const requestedStart = SOURCE.indexOf('async markPeriodRequested(settlementPeriod)');
  const requestedEnd = SOURCE.indexOf('\n  },', requestedStart);
  const requestedBody = SOURCE.slice(requestedStart, requestedEnd);
  assert.match(requestedBody, /result: data\?\.result \|\| null/);
  assert.match(requestedBody, /affectedCount: data\?\.affected_count \|\| 0/);
  assert.match(requestedBody, /settlementPeriod: data\?\.settlement_period \|\| null/);

  const paidStart = SOURCE.indexOf('async markPeriodPaid(settlementPeriod)');
  const paidEnd = SOURCE.indexOf('\n  },', paidStart);
  const paidBody = SOURCE.slice(paidStart, paidEnd);
  assert.match(paidBody, /result: data\?\.result \|\| null/);
});

test('a mixed-status period shows "Kontrol Gerekli" on both desktop and mobile, with no button at all alongside it', () => {
  for (const name of ['_CivitatisHakedisleriView', '_MobileCivitatisHakedisleriView']) {
    const body = componentBody(name);
    assert.match(body, /p\.effectiveStatus === 'mixed'/);
    assert.match(body, /Kontrol Gerekli/);
  }
});

test('the mixed-period notice is never a button or clickable control, and there is no force-transition button/onClick escape hatch anywhere in either view', () => {
  for (const name of ['_CivitatisHakedisleriView', '_MobileCivitatisHakedisleriView']) {
    const body = componentBody(name);
    const mixedBlockStart = body.indexOf("p.effectiveStatus === 'mixed'");
    const mixedBlock = body.slice(mixedBlockStart, mixedBlockStart + 300);
    assert.doesNotMatch(mixedBlock, /<button/);
    // Only the prior request/paid buttons may exist; neither is ever
    // labeled/wired as a bypass for a mixed period. Checked by control,
    // not by the bare word "force" (which this file's own explanatory
    // comments legitimately use to describe the absence of one).
    assert.doesNotMatch(body, /onClick=\{[^}]*[Ff]orce/);
    assert.doesNotMatch(body, />\s*(Zorla|Force)[^<]*</);
  }
});
