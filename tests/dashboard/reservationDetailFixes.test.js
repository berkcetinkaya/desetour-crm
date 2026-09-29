'use strict';
/**
 * tests/dashboard/reservationDetailFixes.test.js
 * ─────────────────────────────────────────────────────────────────────────
 * Regression coverage for two Reservation Detail UI bugs:
 *
 * BUG 1 — "Rezervasyon Durumu" (StatusStepper) never marked "Rehber
 * Atandı" as reached for a reservation that already had a real assigned
 * guide, because the stepper read ONLY the stored opStatus string, and
 * assignReservationGuide (the actual guide-assignment write path — left
 * completely untouched by this fix) only ever writes {guideId, guide},
 * never opStatus. Fixed by deriving the displayed stage from BOTH
 * signals (computeReservationProgressIndex), never by persisting a new
 * status.
 *
 * BUG 2 — fmtMoney's currency-to-symbol mapping only recognized the
 * literal strings "TRY"/"USD"/"GBP" and silently defaulted every other
 * currency (including "TL", the literal label Civitatis's own parsed
 * emails carry into reservations.currency/retail_currency) to "€" —
 * producing exactly the reported "€7.200 TL" (a fabricated Euro symbol
 * immediately followed by the real, correct "TL" text shown separately).
 * Fixed with an explicit, closed symbol map (EUR/TRY/TL/USD/GBP) and no
 * currency-guessing fallback.
 * ─────────────────────────────────────────────────────────────────────────
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { extractTestableFn } = require('./extractTestableFn');
const fmtMoney = extractTestableFn('fmtMoney');
const computeReservationProgressIndex = extractTestableFn('computeReservationProgressIndex');

const SOURCE_PATH = path.join(__dirname, '..', '..', 'DeseTourDashboard.jsx');
const SOURCE = fs.readFileSync(SOURCE_PATH, 'utf8');

// ═══════════════════════════════════════════════════════════════════════
// BUG 1 — Rezervasyon Durumu / "Rehber Atandı" progress
// ═══════════════════════════════════════════════════════════════════════

// ── Required regression test 1: assigned guide marks "Rehber Atandı" ───
test('1. a reservation with an assigned guide marks "Rehber Atandı" as reached, even if opStatus is still "Hazırlanıyor"', () => {
  const idx = computeReservationProgressIndex('Hazırlanıyor', true);
  assert.equal(idx, 1, '"Rehber Atandı" is index 1 in the 4-stage flow');
});

// ── Required regression test 2: no guide -> not marked ──────────────────
test('2. a reservation without a guide does NOT mark "Rehber Atandı" as reached', () => {
  const idx = computeReservationProgressIndex('Hazırlanıyor', false);
  assert.equal(idx, 0, 'stays at "Hazırlanıyor" (index 0) with no guide assigned');
});

// ── Required regression test 3: completed reservation keeps full progression ──
test('3. a completed reservation ("Tamamlandı") still displays the full correct progression, with or without a guide flag', () => {
  assert.equal(computeReservationProgressIndex('Tamamlandı', true), 3);
  assert.equal(computeReservationProgressIndex('Tamamlandı', false), 3, 'guide assignment is never required to reach a later opStatus that already implies it');
});

test('a "Hazır" reservation is never regressed backward by the guide-derived floor', () => {
  assert.equal(computeReservationProgressIndex('Hazır', true), 2);
  assert.equal(computeReservationProgressIndex('Hazır', false), 2);
});

test('a reservation already explicitly at "Rehber Atandı" is unaffected either way', () => {
  assert.equal(computeReservationProgressIndex('Rehber Atandı', true), 1);
  assert.equal(computeReservationProgressIndex('Rehber Atandı', false), 1);
});

test('computeReservationProgressIndex never regresses a later opStatus below its own stage — Math.max only ever moves the index forward', () => {
  for (const status of ['Hazırlanıyor', 'Rehber Atandı', 'Hazır', 'Tamamlandı']) {
    const withGuide = computeReservationProgressIndex(status, true);
    const withoutGuide = computeReservationProgressIndex(status, false);
    assert.ok(withGuide >= withoutGuide, `guide=true must never show an EARLIER stage than guide=false for opStatus="${status}"`);
  }
});

test('an unrecognized/empty opStatus with no guide safely resolves to -1 (nothing shown as done), never a crash', () => {
  assert.equal(computeReservationProgressIndex('', false), -1);
  assert.equal(computeReservationProgressIndex(undefined, false), -1);
});

// ── Wiring: StatusStepper actually uses the derived index, and the call
// site passes the same guide signal "Operasyon Bilgileri" itself uses ──

test('StatusStepper derives its stage from computeReservationProgressIndex(current, hasGuide), never from the raw opStatus alone', () => {
  const idx = SOURCE.indexOf('function StatusStepper(');
  const body = SOURCE.slice(idx, SOURCE.indexOf('\nfunction ', idx + 10));
  assert.match(body, /const currentIdx = computeReservationProgressIndex\(current, hasGuide\);/);
});

test('the Reservation Detail page passes hasGuide={!!r.guideId} to StatusStepper — the SAME guideId signal "Operasyon Bilgileri" already uses to decide whether a real guide is assigned', () => {
  assert.match(SOURCE, /<StatusStepper current=\{r\.opStatus\} hasGuide=\{!!r\.guideId\}\/>/);
  // Confirm r.guideId really is "Operasyon Bilgileri"'s own established
  // truthy signal for "a real guide is assigned" (not merely assumed) —
  // both its guide-vs-no-guide branch and its "Değiştir"/"Ata" button
  // label already gate on r.guideId.
  const opIdx = SOURCE.indexOf('title="Operasyon Bilgileri"');
  const opBody = SOURCE.slice(opIdx, opIdx + 2000);
  assert.match(opBody, /r\.guideId/);
  assert.match(opBody, /r\.guideId \? "Değiştir" : "Ata"/);
});

test('assignReservationGuide (the guide-assignment write path) is completely untouched by this fix — it still writes only {guideId, guide}, never opStatus', () => {
  const idx = SOURCE.indexOf('async function assignReservationGuide(');
  const body = SOURCE.slice(idx, SOURCE.indexOf('\n}', idx) + 2);
  assert.match(body, /mutate\("update", resId, \{ guideId: guideId \|\| null, guide: guide\?\.name \|\| null \}\)/);
  assert.doesNotMatch(body, /opStatus/);
});

test('the cancelled-reservation branch (İptal) is untouched — still its own explicit message, not routed through the stepper steps at all', () => {
  const idx = SOURCE.indexOf('function StatusStepper(');
  const body = SOURCE.slice(idx, SOURCE.indexOf('\nfunction ', idx + 10));
  assert.match(body, /const isCancelled = current === "İptal";/);
  assert.match(body, /Bu rezervasyon iptal edildi/);
});

// ═══════════════════════════════════════════════════════════════════════
// BUG 2 — Currency rendering (fmtMoney + payment-row currency sources)
// ═══════════════════════════════════════════════════════════════════════

// ── Required regression test 4: TL never gets a € prefix ────────────────
test('4. a TL amount never renders with a € prefix', () => {
  const out = fmtMoney(7200, 'TL');
  assert.equal(out, '₺7.200');
  assert.doesNotMatch(out, /€/);
});

// ── Required regression test 5: EUR renders as EUR (€) ───────────────────
test('5. a EUR amount renders with the € symbol', () => {
  assert.equal(fmtMoney(154.05, 'EUR'), '€154');
});

// ── Required regression test 6: retail currency respected independently ─
test('6. retail currency is formatted independently of the reservation\'s own total-amount currency', () => {
  // A reservation whose own currency is EUR but whose retail_currency
  // (a genuinely separate column) is TL — each must format with ITS OWN
  // currency's symbol, never inherit the other's.
  assert.equal(fmtMoney(4800, 'TL'), '₺4.800');
  assert.equal(fmtMoney(3600, 'EUR'), '€3.600');
});

test('TRY (the ISO code manual reservations use) still renders correctly — unchanged from before this fix', () => {
  assert.equal(fmtMoney(18000, 'TRY'), '₺18.000');
});

test('USD and GBP are unchanged by this fix', () => {
  assert.equal(fmtMoney(100, 'USD'), '$100');
  assert.equal(fmtMoney(100, 'GBP'), '£100');
});

test('an unrecognized currency code gets NO fabricated symbol — never guesses, matching this codebase\'s existing "never fabricate" convention', () => {
  const out = fmtMoney(500, 'XYZ');
  assert.equal(out, '500');
  assert.doesNotMatch(out, /€|\$|£|₺/);
});

test('a non-numeric amount still safely renders "—", unchanged from before', () => {
  assert.equal(fmtMoney(null, 'EUR'), '—');
  assert.equal(fmtMoney(undefined, 'TRY'), '—');
  assert.equal(fmtMoney('not-a-number', 'TL'), '—');
});

// ── Currency SOURCE audit: each Reservation Detail payment row uses the
// correct, independent currency field for that specific amount ────────

function extractPaymentCardBody() {
  const idx = SOURCE.indexOf('<RCardHead title="Ödeme Özeti"/>');
  assert.ok(idx !== -1, 'Ödeme Özeti card not found');
  return SOURCE.slice(idx, SOURCE.indexOf('\n        </div>\n\n        {}\n        <div style={{ display:"flex", flexDirection:"column", gap:18 }}>', idx)) || SOURCE.slice(idx, idx + 3000);
}

test('Net Tutar uses r.total with r.currency (the reservation\'s own total-amount currency)', () => {
  const body = extractPaymentCardBody();
  assert.match(body, /fmtMoney\(r\.total, r\.currency\)/);
});

test('Satış Fiyatı (retail price) uses r.retailAmount with r.retailCurrency, falling back to r.currency only when retailCurrency is genuinely absent — never assumed equal to the total\'s own currency', () => {
  const body = extractPaymentCardBody();
  assert.match(body, /fmtMoney\(r\.retailAmount, r\.retailCurrency \|\| r\.currency\)/);
});

test('Kapora (deposit) and Kalan Ödeme (remaining) both use r.currency — correct, since deposit/remaining are both derived from total_amount, which shares one currency by construction (mapResFromDB: remaining = total - deposit)', () => {
  const body = extractPaymentCardBody();
  assert.match(body, /fmtMoney\(r\.deposit, r\.currency\)/);
  assert.match(body, /fmtMoney\(r\.remaining, r\.currency\)/);
});

test('Ödeme İlerlemesi (payment progress) renders a percentage, never a currency amount — no currency-source question applies to it', () => {
  const body = extractPaymentCardBody();
  const progressIdx = body.indexOf('Ödeme İlerlemesi');
  assert.ok(progressIdx !== -1);
  const progressBlock = body.slice(progressIdx, progressIdx + 300);
  assert.match(progressBlock, /%\{paidPct\}/);
  assert.doesNotMatch(progressBlock, /fmtMoney/);
});

test('mapResFromDB keeps retail_amount/retail_currency as fields fully independent from total/currency — the data model this fix relies on', () => {
  const idx = SOURCE.indexOf('function mapResFromDB(');
  const body = SOURCE.slice(idx, SOURCE.indexOf('\nfunction mapPayFromDB', idx));
  assert.match(body, /retailAmount:r\.retail_amount!=null\?parseFloat\(r\.retail_amount\):null/);
  assert.match(body, /retailCurrency:r\.retail_currency\|\|null/);
  assert.match(body, /currency:r\.currency\|\|'EUR'/);
});

// ── fmtMoney is the ONE shared helper used by every Reservation Detail
// payment row — no scattered hardcoded symbol logic was added ─────────

test('fmtMoney is a single shared currency-symbol source (CURRENCY_SYMBOLS), not a repeated inline ternary, for every value in the Ödeme Özeti card', () => {
  const body = extractPaymentCardBody();
  const fmtMoneyCalls = (body.match(/fmtMoney\(/g) || []).length;
  assert.ok(fmtMoneyCalls >= 4, `expected every payment row (Net Tutar, Satış Fiyatı, Kapora, Kalan Ödeme) to go through fmtMoney, found ${fmtMoneyCalls} call(s)`);
  // No ad-hoc "currency === 'TRY' ? ... : '€'"-style symbol guess was
  // introduced inside this card as a new, second currency-formatting path.
  assert.doesNotMatch(body, /currency\s*===\s*['"]TRY['"]\s*\?/);
});

test('CURRENCY_SYMBOLS is a plain closed lookup table, not a chained ternary that silently defaults to € for anything unrecognized', () => {
  const idx = SOURCE.indexOf('const CURRENCY_SYMBOLS');
  assert.ok(idx !== -1);
  const line = SOURCE.slice(idx, SOURCE.indexOf('\n', idx));
  assert.match(line, /EUR: "€", TRY: "₺", TL: "₺", USD: "\$", GBP: "£"/);
});
