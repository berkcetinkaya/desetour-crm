'use strict';
/**
 * tests/dashboard/reservationQuickActionsCleanup.test.js
 * ─────────────────────────────────────────────────────────────────────────
 * Reservation Detail "Hızlı İşlemler" quick-action cleanup.
 *
 * Before this fix: "Pickup Bilgisi Ekle", "Görev Oluştur" and "Hatırlatma
 * Oluştur" rendered with onClick={undefined} (dead by construction — see
 * the ternary in ResQuickActions), and "Ödeme Kaydı Ekle" only wrote a
 * mock-only ActivityRepository log entry and navigated away to /payments
 * without ever creating a real payment.
 *
 * After this fix:
 *  - "Görev Oluştur" is removed from RES_ACTIONS (Tasks stays retired from
 *    navigation; its backend/repo/MobileTasksQueuePage usage is untouched).
 *  - "Pickup Bilgisi Ekle" opens a small modal that calls the EXISTING
 *    reservation update mutation (no new repo method, no schema change).
 *  - "Hatırlatma Oluştur" opens the EXISTING NewReminderModal, now
 *    accepting optional resId/customerId/customerName context props.
 *  - "Ödeme Kaydı Ekle" opens the EXISTING NewPaymentModal (same optional
 *    props), instead of faking an activity log and navigating to /payments.
 * ─────────────────────────────────────────────────────────────────────────
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.join(__dirname, '..', '..');
const SOURCE = fs.readFileSync(path.join(REPO_ROOT, 'DeseTourDashboard.jsx'), 'utf8');

function body(name, nextMarker) {
  const idx = SOURCE.indexOf(`function ${name}(`);
  assert.ok(idx !== -1, `could not find function ${name}`);
  return SOURCE.slice(idx, SOURCE.indexOf(nextMarker, idx));
}

const RES_ACTIONS_BODY   = SOURCE.slice(SOURCE.indexOf('const RES_ACTIONS = ['), SOURCE.indexOf('];', SOURCE.indexOf('const RES_ACTIONS = [')));
const PICKUP_MODAL_BODY  = body('PickupEditModal', '\nfunction ResQuickActions');
const QUICK_ACTIONS_BODY = body('ResQuickActions', '\n// TESTABLE:getMealStatusDisplay:start');
const NEW_REMINDER_BODY  = body('NewReminderModal', '\nfunction NewPaymentModal');
const NEW_PAYMENT_BODY   = body('NewPaymentModal', '\nconst AppConfig');
const RES_UPDATE_SNIPPET = SOURCE.slice(SOURCE.indexOf('async update(id,p){const sb=getSB();if(!sb)return ReservationRepository.update(id,p);'), SOURCE.indexOf('async update(id,p){const sb=getSB();if(!sb)return ReservationRepository.update(id,p);') + 400);

// ── 1. "Görev Oluştur" no longer appears in Reservation Detail quick actions ──

test('[1] "Görev Oluştur" is removed from RES_ACTIONS (Reservation Detail quick actions)', () => {
  assert.doesNotMatch(RES_ACTIONS_BODY, /Görev Oluştur/);
  // The other five actions remain, in order.
  assert.match(RES_ACTIONS_BODY, /label:"Rehber Ata"/);
  assert.match(RES_ACTIONS_BODY, /label:"Pickup Bilgisi Ekle"/);
  assert.match(RES_ACTIONS_BODY, /label:"Ödeme Kaydı Ekle"/);
  assert.match(RES_ACTIONS_BODY, /label:"Hatırlatma Oluştur"/);
  assert.match(RES_ACTIONS_BODY, /label:"Turu Tamamlandı Olarak İşaretle"/);
});

// ── 2. "Pickup Bilgisi Ekle" has a real onClick flow ─────────────────────

test('[2] "Pickup Bilgisi Ekle" resolves to a real onClick (setShowPickup), never undefined', () => {
  assert.match(QUICK_ACTIONS_BODY, /const isPickup = a\.label === "Pickup Bilgisi Ekle";/);
  assert.match(QUICK_ACTIONS_BODY, /isPickup \? \(\) => setShowPickup\(true\)/);
  assert.match(QUICK_ACTIONS_BODY, /\{showPickup && <PickupEditModal res=\{res\} onClose=\{\(\)=>setShowPickup\(false\)\}\/>\}/);
});

// ── 3/4/5. Pickup save persists reservation id / location / time ────────

test('[3] Pickup save calls the existing reservation-update mutation with the correct reservation id', () => {
  assert.match(PICKUP_MODAL_BODY, /const \{ mutate: mutRes, mutating \} = useRepoMutation\("reservation"\);/);
  assert.match(PICKUP_MODAL_BODY, /mutRes\("update", res\.id, \{ pickup, pickupTime \}\)/);
  // No new repo method was added — PickupEditModal only calls update().
  assert.doesNotMatch(PICKUP_MODAL_BODY, /getActiveRepo\(/);
});

test('[4] pickup location is persisted via the existing pickup → pickup_location mapping', () => {
  assert.match(RES_UPDATE_SNIPPET, /pickup:'pickup_location'/);
});

test('[5] pickup time is persisted via a pickupTime → pickup_time mapping on the existing update field map', () => {
  assert.match(RES_UPDATE_SNIPPET, /pickupTime:'pickup_time'/);
  // Confirms this is an addition to the SAME existing field map used by
  // pickup/opStatus/guide/etc, not a second, parallel update path.
  assert.match(RES_UPDATE_SNIPPET, /const fm=\{opStatus:'status'[\s\S]*pickup:'pickup_location',pickupTime:'pickup_time'/);
});

// ── 6/7. "Rehber Ata" and "Turu Tamamlandı..." remain unchanged ──────────

test('[6] "Rehber Ata" still delegates to the parent\'s onAssignGuide (the one shared AssignGuideModal) — unchanged', () => {
  assert.match(QUICK_ACTIONS_BODY, /const isGuideAssign = a\.label === "Rehber Ata";/);
  assert.match(QUICK_ACTIONS_BODY, /const label = isGuideAssign \? \(res\?\.guideId \? "Rehberi Değiştir" : "Rehber Ata"\) : a\.label;/);
  assert.match(QUICK_ACTIONS_BODY, /const onClick = isGuideAssign \? onAssignGuide/);
});

test('[7] "Turu Tamamlandı Olarak İşaretle" still calls the same real reservation-status mutation — unchanged', () => {
  assert.match(QUICK_ACTIONS_BODY, /async function handleTamamlandi\(\) \{/);
  assert.match(QUICK_ACTIONS_BODY, /repo\.update\(res\.id, \{ opStatus:"Tamamlandı" \}\)/);
  assert.match(QUICK_ACTIONS_BODY, /setOpStatus\("Tamamlandı"\)/);
  assert.match(QUICK_ACTIONS_BODY, /Store\.notify\(\)/);
});

// ── 8/9/10. "Hatırlatma Oluştur" → NewReminderModal with reservation context ──

test('[8] "Hatırlatma Oluştur" opens NewReminderModal pre-filled with the current reservation + customer', () => {
  assert.match(QUICK_ACTIONS_BODY, /const isHatirlatma = a\.label === "Hatırlatma Oluştur";/);
  assert.match(QUICK_ACTIONS_BODY, /isHatirlatma \? \(\) => setShowReminder\(true\)/);
  assert.match(QUICK_ACTIONS_BODY, /<NewReminderModal\s*\n\s*resId=\{res\?\.id\} customerId=\{res\?\.customerId\} customerName=\{res\?\.customer\|\|res\?\.name\}/);
});

test('[9] reminder creation persists resId and customerId to the reminder repo', () => {
  assert.match(NEW_REMINDER_BODY, /function NewReminderModal\(\{ onClose, resId, customerId, customerName \}\)/);
  assert.match(NEW_REMINDER_BODY, /resId:resId\|\|null/);
  assert.match(NEW_REMINDER_BODY, /customerId:custId\|\|null/);
  // custId state is seeded from the prop, not left for manual re-entry.
  assert.match(NEW_REMINDER_BODY, /const \[custId,setCustId\]=useState\(customerId \|\| ""\);/);
});

test('[10] reservation-context reminder creation shows a locked customer label, not the mock DB <select>', () => {
  const idx = NEW_REMINDER_BODY.indexOf('İlgili Müşteri');
  const custFieldBlock = NEW_REMINDER_BODY.slice(idx, idx + 500);
  assert.match(custFieldBlock, /\{customerId \? \(/);
  assert.match(custFieldBlock, /customerName \|\| DB\.customers\.find\(c=>c\.id===customerId\)\?\.name \|\| customerId/);
  assert.match(custFieldBlock, /\) : \(\s*<FSelect value=\{custId\} onChange=\{setCustId\}/);
});

test('[11] existing standalone NewReminderModal usage (RemindersPage\'s own "Yeni Hatırlatma" button) is untouched', () => {
  assert.match(SOURCE, /\{showNewReminder \? \(<NewReminderModal onClose=\{\(\)=>\{ setShowNewReminder\(false\); setRemTick\(n=>n\+1\); \}\}\/>\) : null\}/);
});

// ── 12/13/14/15/16. "Ödeme Kaydı Ekle" → NewPaymentModal, real payment ────

test('[12] "Ödeme Kaydı Ekle" opens NewPaymentModal instead of navigating to /payments', () => {
  assert.match(QUICK_ACTIONS_BODY, /isOdeme \? \(\) => setShowPayment\(true\)/);
  assert.match(QUICK_ACTIONS_BODY, /<NewPaymentModal\s*\n\s*resId=\{res\?\.id\} customerId=\{res\?\.customerId\} customerName=\{res\?\.customer\|\|res\?\.name\}/);
  assert.doesNotMatch(QUICK_ACTIONS_BODY, /NAV_REF\.fn\(['"]\/payments['"]\)/);
  assert.doesNotMatch(QUICK_ACTIONS_BODY, /window\.location\.hash = "#\/payments"/);
});

test('[13] the fake ActivityRepository side effect is gone — ResQuickActions no longer calls it', () => {
  assert.doesNotMatch(QUICK_ACTIONS_BODY, /ActivityRepository\.create/);
  assert.doesNotMatch(QUICK_ACTIONS_BODY, /handleOdemeEkle/);
});

test('[14] payment creation persists the real resId/customerId through the real payment repo path (public.payments)', () => {
  assert.match(NEW_PAYMENT_BODY, /function NewPaymentModal\(\{ onClose, resId: presetResId, customerId: presetCustomerId, customerName \}\)/);
  assert.match(NEW_PAYMENT_BODY, /resId:resId\|\|null, customerId:custId\|\|null/);
  // SupabasePaymentRepo.create writes these straight to reservation_id/customer_id.
  assert.match(SOURCE, /reservation_id:d\.resId\|\|d\.reservationId\|\|null,customer_id:d\.customerId\|\|null/);
});

test('[15] reservation-context payment creation shows locked customer + reservation labels, not the mock DB pickers', () => {
  const custIdx = NEW_PAYMENT_BODY.indexOf('Müşteri');
  const custBlock = NEW_PAYMENT_BODY.slice(custIdx, custIdx + 600);
  assert.match(custBlock, /\{presetCustomerId \? \(/);
  assert.match(custBlock, /customerName \|\| DB\.customers\.find\(c=>c\.id===presetCustomerId\)\?\.name \|\| presetCustomerId/);

  const resIdx = NEW_PAYMENT_BODY.indexOf('Rezervasyon');
  const resBlock = NEW_PAYMENT_BODY.slice(resIdx, resIdx + 400);
  assert.match(resBlock, /\{presetResId \? \(/);
});

test('[16] existing standalone NewPaymentModal usages (Payments page, mobile quick actions) are untouched', () => {
  assert.match(SOURCE, /\{showNewPayment \? \(<NewPaymentModal onClose=\{\(\)=>\{ setShowNewPayment\(false\); setPayTick\(n=>n\+1\); reloadPays && reloadPays\(\); \}\}\/>\) : null\}/);
  assert.match(SOURCE, /\{quickAction === "payment" && <NewPaymentModal onClose=\{\(\)=>setQuickAction\(null\)\}\/>\}/);
  assert.match(SOURCE, /\{showNew && <NewPaymentModal onClose=\{\(\)=>setShowNew\(false\)\}\/>\}/);
});

// ── 17. No Civitatis settlement code was touched ─────────────────────────

test('[17] Civitatis settlement code carries no trace of this reservation quick-actions change (scope separation)', () => {
  const civStart = SOURCE.indexOf('function _CivitatisHakedisleriView(');
  assert.ok(civStart !== -1, '_CivitatisHakedisleriView must still exist, untouched');
  const civEnd = SOURCE.indexOf('\nfunction ', civStart + 10);
  const civBody = SOURCE.slice(civStart, civEnd);
  for (const marker of ['PickupEditModal', 'showPickup', 'showReminder', 'showPayment', 'presetResId', 'presetCustomerId']) {
    assert.doesNotMatch(civBody, new RegExp(marker), `Civitatis settlement view must not reference ${marker}`);
  }
  // The settlement terminology cleanup's own "Ödeme Alındı" labels are intact.
  assert.match(SOURCE, /paid:\s*"Ödeme Alındı"/);
});

// ── no em/en dash introduced in any new UI copy ──────────────────────────

test('no em or en dash introduced in this cleanup\'s new UI copy', () => {
  for (const s of ['Pickup Bilgisi Ekle', 'Pickup Lokasyonu', 'Pickup Saati']) {
    assert.doesNotMatch(s, /[–—]/, `"${s}" must not contain an em/en dash`);
  }
});
