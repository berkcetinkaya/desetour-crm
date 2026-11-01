'use strict';
/**
 * tests/dashboard/civitatisMissingPassengerNamesWarning.test.js
 * ─────────────────────────────────────────────────────────────────────────
 * Regression coverage for the "Yolcu isimleri eksik" reservation-detail
 * notice (V15 — Civitatis booking A42463096's zero-passenger-names fix).
 * The condition is derived purely from the reservation's own already-
 * fetched activity_logs rows (metadata.alert_type ===
 * 'civitatis_missing_passenger_names', written once by
 * ingest_civitatis_booking) — never a generic "pax>0 and zero guests"
 * heuristic, which would risk false positives on legacy/manually-created
 * reservations. No new query, no new table/component redesign — see
 * DeseTourDashboard.jsx's _hasCivitatisMissingPassengerNamesWarning.
 * ─────────────────────────────────────────────────────────────────────────
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { extractTestableFn } = require('./extractTestableFn');

const REPO_ROOT = path.join(__dirname, '..', '..');
const SOURCE = fs.readFileSync(path.join(REPO_ROOT, 'DeseTourDashboard.jsx'), 'utf8');

const _hasCivitatisMissingPassengerNamesWarning = extractTestableFn('_hasCivitatisMissingPassengerNamesWarning');

// ── Pure helper ──────────────────────────────────────────────────────────

test('_hasCivitatisMissingPassengerNamesWarning: true only when a row carries the exact alert_type marker', () => {
  assert.equal(_hasCivitatisMissingPassengerNamesWarning([
    { action: 'created', metadata: { auto_ingested: true } },
    { action: 'note_added', metadata: { alert_type: 'civitatis_missing_passenger_names' } },
  ]), true);
});

test('_hasCivitatisMissingPassengerNamesWarning: false when no row carries the marker', () => {
  assert.equal(_hasCivitatisMissingPassengerNamesWarning([
    { action: 'created', metadata: { auto_ingested: true } },
    { action: 'note_added', metadata: { alert_type: 'some_other_alert' } },
  ]), false);
});

test('_hasCivitatisMissingPassengerNamesWarning: false (never throws) for empty/null/undefined activity, or rows with no metadata at all', () => {
  assert.equal(_hasCivitatisMissingPassengerNamesWarning([]), false);
  assert.equal(_hasCivitatisMissingPassengerNamesWarning(null), false);
  assert.equal(_hasCivitatisMissingPassengerNamesWarning(undefined), false);
  assert.equal(_hasCivitatisMissingPassengerNamesWarning([{ action: 'created' }, { action: 'updated', metadata: null }]), false);
});

// ── Desktop: the existing "Yolcular" card's empty-state branches ────────

test('ReservationDetailPage fetches reservation-scoped activity to drive the notice, reusing the SAME cache entry ResTimeline already uses (no new query)', () => {
  const idx = SOURCE.indexOf('function ReservationDetailPage(');
  const end = SOURCE.indexOf('\nfunction ', idx + 10);
  const body = SOURCE.slice(idx, end);
  assert.match(body, /useRepo\("activity", "getAll", \{ entityType:"reservation", entityId:resId \}\)/);
});

test('the desktop "Yolcular" card shows the Civitatis notice INSTEAD OF the generic empty-state text when the marker is present, and the generic text otherwise', () => {
  const idx = SOURCE.indexOf('function ReservationDetailPage(');
  const end = SOURCE.indexOf('\nfunction ', idx + 10);
  const body = SOURCE.slice(idx, end);

  const yolcularIdx = body.indexOf('title="Yolcular"');
  const yolcularCardBody = body.slice(yolcularIdx, body.indexOf(') : (', yolcularIdx + 400) + 400);

  assert.match(yolcularCardBody, /_hasCivitatisMissingPassengerNamesWarning\(resActivity\)/);
  assert.match(yolcularCardBody, /Yolcu isimleri eksik/);
  assert.match(yolcularCardBody, /Civitatis bu rezervasyon için yolcu isimlerini iletmedi\./);
  assert.match(yolcularCardBody, /Bu rezervasyon için henüz yolcu bilgisi kaydedilmedi\./,
    'the original generic empty-state text must still exist as the non-Civitatis fallback');
});

test('the desktop notice never fabricates a guest card — it still renders inside the existing resGuests.length === 0 branch, never adding a guest row', () => {
  const idx = SOURCE.indexOf('function ReservationDetailPage(');
  const end = SOURCE.indexOf('\nfunction ', idx + 10);
  const body = SOURCE.slice(idx, end);
  const yolcularIdx = body.indexOf('title="Yolcular"');
  const yolcularCardBody = body.slice(yolcularIdx, body.indexOf('</RCard>', yolcularIdx));
  assert.match(yolcularCardBody, /!resGuests \|\| resGuests\.length === 0/);
});

// ── Mobile: reuses the EXISTING "Operasyonel Uyarı" warning-card mechanism ──

test('MobileReservationDetailPage fetches reservation-scoped activity, reusing the same cache entry as any other reservation activity query', () => {
  const idx = SOURCE.indexOf('function MobileReservationDetailPage(');
  const end = SOURCE.indexOf('\nfunction MobileMessagesPage(');
  const body = SOURCE.slice(idx, end);
  assert.match(body, /useRepo\("activity", "getAll", \{ entityType:"reservation", entityId:resId \}\)/);
});

test('mobile reuses the EXISTING warnings[] / "Operasyonel Uyarı" mechanism — no new warning-card component, no redesign', () => {
  const idx = SOURCE.indexOf('function MobileReservationDetailPage(');
  const end = SOURCE.indexOf('\nfunction MobileMessagesPage(');
  const body = SOURCE.slice(idx, end);

  const warningsBlockStart = body.indexOf('const warnings = [];');
  const warningsBlockEnd = body.indexOf('const waHref', warningsBlockStart);
  const warningsBlock = body.slice(warningsBlockStart, warningsBlockEnd);

  assert.match(warningsBlock, /if \(!r\.guide\) warnings\.push\("Rehber atanmadı"\);/, 'the pre-existing guide warning must be untouched');
  assert.match(warningsBlock, /if \(!r\.pickup\) warnings\.push\("Pickup bilgisi eksik"\);/, 'the pre-existing pickup warning must be untouched');
  assert.match(warningsBlock, /warnings\.push\("Ödeme bekliyor"\);/, 'the pre-existing payment warning must be untouched');
  assert.match(warningsBlock, /_hasCivitatisMissingPassengerNamesWarning\(mobResActivity\)/);
  assert.match(warningsBlock, /warnings\.push\("Yolcu isimleri eksik/);
});

test('mobile renders the warnings[] card exactly as before — same "Operasyonel Uyarı" card, no new/duplicate warning surface', () => {
  const idx = SOURCE.indexOf('function MobileReservationDetailPage(');
  const end = SOURCE.indexOf('\nfunction MobileMessagesPage(');
  const body = SOURCE.slice(idx, end);
  const liveBody = body.split('\n').filter(l => !l.trim().startsWith('//')).join('\n');
  const occurrences = (liveBody.match(/Operasyonel Uyarı/g) || []).length;
  assert.equal(occurrences, 1, 'expected exactly one "Operasyonel Uyarı" card — the Civitatis notice must append to it, never duplicate it');
});

// ── No PII, no schema/query redesign ─────────────────────────────────────

test('the frontend notice never reads or displays customer email/phone alongside the marker (PII stays out of the UI copy, same discipline as the RPC metadata)', () => {
  const resIdx = SOURCE.indexOf('function ReservationDetailPage(');
  const resEnd = SOURCE.indexOf('\nfunction ', resIdx + 10);
  const resBody = SOURCE.slice(resIdx, resEnd);
  const yolcularIdx = resBody.indexOf('title="Yolcular"');
  const yolcularCardBody = resBody.slice(yolcularIdx, resBody.indexOf('</RCard>', yolcularIdx));
  assert.doesNotMatch(yolcularCardBody, /resCustomer\?\.(email|phone)/);
});
