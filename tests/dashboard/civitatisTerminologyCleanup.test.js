'use strict';
/**
 * tests/dashboard/civitatisTerminologyCleanup.test.js
 * ─────────────────────────────────────────────────────────────────────────
 * Civitatis settlement UI terminology cleanup — a display-only rename.
 * DeseTour does not pay Civitatis; Civitatis owes DeseTour. The old
 * "Ödendi"/"Ödendi Olarak İşaretle" copy read as if the CRM were tracking
 * a payment DeseTour made, so Civitatis-specific UI now reads "Ödeme
 * Alındı" ("Ödeme alındı" = payment received) for the same lifecycle
 * stage. The technical status string, DB column, and RPC result all
 * stay the literal "paid"/"paid_at" — only JS object VALUES (user-facing
 * labels) changed, never a key, enum, column name, or RPC contract.
 *
 * Scope is deliberately narrow: Direct Payments (_DogrudanOdemelerView /
 * _MobileDogrudanOdemelerView, public.payments) and guide payments
 * (_GPS_APP, GuideDetailPage's "Toplam Ödenen") keep "Ödendi" — they are
 * a different business concept (DeseTour collecting from a guest /
 * DeseTour paying a guide) and were never in scope for this cleanup.
 * ─────────────────────────────────────────────────────────────────────────
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.join(__dirname, '..', '..');
const SOURCE = fs.readFileSync(path.join(REPO_ROOT, 'DeseTourDashboard.jsx'), 'utf8');
const MIGRATION = fs.readFileSync(path.join(REPO_ROOT, 'supabase_migration_civitatis_settlement_phase2.sql'), 'utf8');

function componentBody(name) {
  const start = SOURCE.indexOf(`function ${name}(`);
  assert.ok(start !== -1, `${name} not found`);
  const end = SOURCE.indexOf('\nfunction ', start + 10);
  return SOURCE.slice(start, end);
}

// ── [1][2] Civitatis "paid" renders as "Ödeme Alındı" everywhere user-facing ──

test('[1] CIVITATIS_STATUS_LABEL renders the "paid" status to users as "Ödeme Alındı", never "Ödendi"', () => {
  const start = SOURCE.indexOf('const CIVITATIS_STATUS_LABEL = {');
  const end = SOURCE.indexOf('\n};', start);
  const body = SOURCE.slice(start, end);
  assert.match(body, /paid:\s*"Ödeme Alındı"/);
  assert.doesNotMatch(body, /paid:\s*"Ödendi"/);
});

test('[1] desktop and mobile Civitatis summary tiles label the "paid" bucket "Ödeme Alındı"', () => {
  for (const name of ['_CivitatisHakedisleriView', '_MobileCivitatisHakedisleriView']) {
    const body = componentBody(name);
    assert.match(body, /label:"Ödeme Alındı",\s*bucket:summary\.paid/, `${name} must label the paid tile "Ödeme Alındı"`);
    assert.doesNotMatch(body, /label:"Ödenen"/, `${name} must not use the old "Ödenen" label`);
  }
});

test('[2] the paid-transition action label is exactly "Ödeme Alındı Olarak İşaretle" on both desktop and mobile', () => {
  for (const name of ['_CivitatisHakedisleriView', '_MobileCivitatisHakedisleriView']) {
    const body = componentBody(name);
    assert.match(body, /"Ödeme Alındı Olarak İşaretle"/, `${name} must use the new action label`);
    assert.doesNotMatch(body, /"Ödendi Olarak İşaretle"/, `${name} must not render the old action label`);
  }
});

test('the "already paid" transition message reads "ödeme ... alındı", never "ödendi"', () => {
  const start = SOURCE.indexOf('const CIVITATIS_TRANSITION_MESSAGES = {');
  const end = SOURCE.indexOf('\n};', start);
  const body = SOURCE.slice(start, end);
  assert.match(body, /already_paid: 'Bu dönem daha önce "Ödeme Alındı" olarak işaretlenmiş\.'/);
  assert.doesNotMatch(body, /ödendi olarak işaretlenmiş/);
});

// ── [3] Reports → Civitatis Hakediş Durumu ──────────────────────────────

test('[3] Reports\' "Civitatis Hakediş Durumu" section labels the paid bucket "Ödeme Alındı" and its sub-text reads "ödeme alındı", not "ödendi"', () => {
  const rpStart = SOURCE.indexOf('function ReportsPage()');
  const rpEnd = SOURCE.indexOf('\nconst GUEST_STATUS_CFG', rpStart);
  const civSecStart = SOURCE.indexOf('title="Civitatis Hakediş Durumu"', rpStart);
  assert.ok(civSecStart !== -1 && civSecStart < rpEnd, 'Civitatis Hakediş Durumu section not found in ReportsPage');
  const civSecEnd = SOURCE.indexOf('</RpSection>', civSecStart);
  const body = SOURCE.slice(civSecStart, civSecEnd);
  assert.match(body, /key:"paid",\s*label:"Ödeme Alındı"/);
  assert.match(body, /sub:"CRM'de ödeme alındı olarak işaretlenen"/);
  assert.doesNotMatch(body, /label:"Ödenen"/);
  assert.doesNotMatch(body, /ödendi olarak işaretlenen/);
});

// ── [4][5][6] technical layer is untouched ──────────────────────────────

test('[4] the technical settlement status "paid" (object keys, effectiveStatus values, bucket keys) is unchanged', () => {
  // The JS object KEY (not the label VALUE) stays "paid" everywhere.
  assert.match(SOURCE, /paid:\s*"Ödeme Alındı"/); // CIVITATIS_STATUS_LABEL key
  assert.match(SOURCE, /key:"paid",\s*label:"Ödeme Alındı"/); // Reports bucket key
  assert.match(SOURCE, /summary\.paid/); // settlement summary bucket accessor
  assert.match(SOURCE, /p\.effectiveStatus === 'requested'/); // canMarkPaid gating logic (unchanged business rule)
  assert.match(SOURCE, /_buildCivitatisReportsSettlementTotals/); // Reports' settlement reducer, untouched by this cleanup
});

test('[5] the technical paid_at column name is unchanged in the (unapplied) migration', () => {
  assert.match(MIGRATION, /ADD COLUMN IF NOT EXISTS paid_at\s+TIMESTAMPTZ/);
  assert.match(MIGRATION, /paid_at\s*=\s*NOW\(\)/);
  assert.doesNotMatch(MIGRATION, /received_at|payment_received_at/);
});

test('[6] the RPC result literal \'paid\' is unchanged in the (unapplied) migration and in the frontend\'s own handling of it', () => {
  assert.match(MIGRATION, /RETURN jsonb_build_object\('result', 'paid', 'affected_count', v_count, 'settlement_period', p_settlement_period\);/);
  assert.match(SOURCE, /res\?\.result === 'requested' \|\| res\?\.result === 'paid'/);
  assert.doesNotMatch(SOURCE, /res\?\.result === 'payment_received'/);
});

// ── [7][8] adjacent domains are unaffected ──────────────────────────────

test('[7] Direct Payments terminology is unaffected — neither _DogrudanOdemelerView nor its mobile counterpart gained any "Ödeme Alındı" wording, and the mobile "mark paid" button keeps its original "Ödendi Olarak İşaretle" label', () => {
  const desktop = componentBody('_DogrudanOdemelerView');
  assert.match(desktop, /"Kısmi Ödendi"/, 'desktop direct-payments status tabs/filters are untouched');
  assert.doesNotMatch(desktop, /Ödeme Alındı/);

  const mobileStart = SOURCE.indexOf('function _MobileDogrudanOdemelerView(');
  const mobileEnd = SOURCE.indexOf('\nfunction ', mobileStart + 10);
  const mobile = SOURCE.slice(mobileStart, mobileEnd);
  assert.match(mobile, /"Ödendi Olarak İşaretle"/, 'mobile direct-payments "mark paid" button must keep its original label');
  assert.doesNotMatch(mobile, /Ödeme Alındı/);
});

test('[8] Guide payment terminology is unaffected — _GPS_APP and GuideDetailPage\'s "Toplam Ödenen" KPI still use "Ödendi"/"Ödenen"', () => {
  assert.match(SOURCE, /_GPS_APP\s*=\s*\{'pending':'Bekliyor','paid':'Ödendi','cancelled':'İptal'\}/);
  assert.match(SOURCE, /label:"Toplam Ödenen"/);
  assert.doesNotMatch(SOURCE, /label:"Toplam Ödeme Alındı"/);
});

test('no em or en dash introduced in any of this cleanup\'s new UI copy', () => {
  const newStrings = [
    'Ödeme Alındı', 'Ödeme Alındı Olarak İşaretle',
    'Bu dönem daha önce "Ödeme Alındı" olarak işaretlenmiş.',
    "CRM'de ödeme alındı olarak işaretlenen",
  ];
  for (const s of newStrings) {
    assert.doesNotMatch(s, /[–—]/, `"${s}" must not contain an em/en dash`);
  }
});
