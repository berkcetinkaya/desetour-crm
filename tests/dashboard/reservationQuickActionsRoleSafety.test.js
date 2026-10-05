'use strict';
/**
 * tests/dashboard/reservationQuickActionsRoleSafety.test.js
 * ─────────────────────────────────────────────────────────────────────────
 * Role-safety follow-up to reservationQuickActionsCleanup.test.js.
 *
 * ResQuickActions has no role gate of its own — any role that can open
 * Reservation Detail (canAccess(role,"reservations"), which includes
 * "Rehber") sees the whole panel. Before the cleanup, "Hatırlatma Oluştur"
 * and "Ödeme Kaydı Ekle" were dead/misleading, so that absence of gating
 * was harmless. Now that both open real mutation flows (NewReminderModal /
 * NewPaymentModal), the panel would otherwise be a side door into entities
 * (`reminders`, `payments`) that ROLE_PERMISSIONS already deliberately
 * keeps some roles away from — e.g. Rehber has neither, Satış has
 * reminders but not payments.
 *
 * This suite proves the panel now filters those two actions through the
 * SAME existing canAccess()/ROLE_PERMISSIONS helpers the rest of the app
 * already uses for nav/router gating — no new permission framework, no
 * RLS/auth/schema change — while confirming Pickup/Rehber Ata/Tamamlandı
 * (plain reservation-entity writes every role could already reach) stay
 * ungated, exactly as before this phase.
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

const QUICK_ACTIONS_BODY = body('ResQuickActions', '\n// TESTABLE:getMealStatusDisplay:start');

// Pull the REAL ROLE_PERMISSIONS/canAccess implementation out of the
// source and evaluate it, rather than re-typing the permission matrix by
// hand — so this test exercises the app's actual logic, not a copy of it.
const rolePermIdx = SOURCE.indexOf('const ROLE_PERMISSIONS');
const canAccessEnd = SOURCE.indexOf('\n}', SOURCE.indexOf('function canAccess(role, page)', rolePermIdx));
const permissionsAndCanAccessSrc = SOURCE.slice(rolePermIdx, canAccessEnd + 2);
const canAccess = new Function(`${permissionsAndCanAccessSrc}\nreturn canAccess;`)();

const ROLES = { admin: 'Yönetici', sales: 'Satış', operations: 'Operasyon', guide: 'Rehber' };

// ── 1. Effective permission matrix (reminders/payments entities) ────────

test('[matrix] effective canAccess("reminders"/"payments") per role, via the real app helper', () => {
  assert.equal(canAccess(ROLES.admin,      'reminders'), true);
  assert.equal(canAccess(ROLES.sales,      'reminders'), true);
  assert.equal(canAccess(ROLES.operations, 'reminders'), true);
  assert.equal(canAccess(ROLES.guide,      'reminders'), false);

  assert.equal(canAccess(ROLES.admin,      'payments'), true);
  assert.equal(canAccess(ROLES.sales,      'payments'), false);
  assert.equal(canAccess(ROLES.operations, 'payments'), true);
  assert.equal(canAccess(ROLES.guide,      'payments'), false);
});

// ── 2. ResQuickActions filters through the SAME helpers, no new model ───

test('ResQuickActions reads role via the existing useAuthContext() hook and filters through the existing canAccess() helper (no new permission framework)', () => {
  assert.match(QUICK_ACTIONS_BODY, /const \{ role \} = useAuthContext\(\);/);
  assert.match(QUICK_ACTIONS_BODY, /const visibleActions = RES_ACTIONS\.filter\(a => \{/);
  assert.match(QUICK_ACTIONS_BODY, /if \(a\.label === "Hatırlatma Oluştur"\) return canAccess\(role, "reminders"\);/);
  assert.match(QUICK_ACTIONS_BODY, /if \(a\.label === "Ödeme Kaydı Ekle"\)\s*return canAccess\(role, "payments"\);/);
  assert.match(QUICK_ACTIONS_BODY, /visibleActions\.map\(\(a, i\) => \{/);
  // No bespoke role table, no direct auth/staff/RLS reference inside this
  // component — it only ever asks the existing canAccess() helper.
  assert.doesNotMatch(QUICK_ACTIONS_BODY, /ROLE_PERMISSIONS\s*=/);
  assert.doesNotMatch(QUICK_ACTIONS_BODY, /\bRLS\b/i);
  assert.doesNotMatch(QUICK_ACTIONS_BODY, /supabase/i);
});

// ── 3/4. Rehber Ata / Turu Tamamlandı stay ungated (unchanged model) ─────

test('[3] "Rehber Ata" is NOT filtered by the new role check — unchanged from the prior (unrestricted-within-the-page) permission model', () => {
  assert.doesNotMatch(QUICK_ACTIONS_BODY, /if \(a\.label === "Rehber Ata"\)/);
  // It is still present for every role that reaches this panel at all.
  const filterBlock = QUICK_ACTIONS_BODY.slice(
    QUICK_ACTIONS_BODY.indexOf('const visibleActions'),
    QUICK_ACTIONS_BODY.indexOf('});', QUICK_ACTIONS_BODY.indexOf('const visibleActions')) + 3
  );
  assert.doesNotMatch(filterBlock, /Rehber Ata/);
});

test('[4] "Turu Tamamlandı Olarak İşaretle" is NOT filtered by the new role check — unchanged from the prior permission model', () => {
  const filterBlock = QUICK_ACTIONS_BODY.slice(
    QUICK_ACTIONS_BODY.indexOf('const visibleActions'),
    QUICK_ACTIONS_BODY.indexOf('});', QUICK_ACTIONS_BODY.indexOf('const visibleActions')) + 3
  );
  assert.doesNotMatch(filterBlock, /Turu Tamamlandı/);
  // handleTamamlandi itself is untouched by this role-safety pass.
  assert.match(QUICK_ACTIONS_BODY, /repo\.update\(res\.id, \{ opStatus:"Tamamlandı" \}\)/);
});

// ── 5. Payment creation is not unintentionally available to guide users ──

test('[5] a "Rehber" (guide) role never sees "Ödeme Kaydı Ekle" (or "Hatırlatma Oluştur") in the quick-action panel', () => {
  // Simulate the exact filter predicate the component runs, for the guide role.
  const filterFn = new Function('canAccess', 'role', 'RES_ACTIONS', `
    return RES_ACTIONS.filter(a => {
      if (a.label === "Hatırlatma Oluştur") return canAccess(role, "reminders");
      if (a.label === "Ödeme Kaydı Ekle")   return canAccess(role, "payments");
      return true;
    });
  `);
  const RES_ACTIONS = [
    { label: "Rehber Ata" },
    { label: "Pickup Bilgisi Ekle" },
    { label: "Ödeme Kaydı Ekle" },
    { label: "Hatırlatma Oluştur" },
    { label: "Turu Tamamlandı Olarak İşaretle", green: true },
  ];
  const forGuide = filterFn(canAccess, ROLES.guide, RES_ACTIONS).map(a => a.label);
  assert.ok(!forGuide.includes('Ödeme Kaydı Ekle'), 'guide must not see Ödeme Kaydı Ekle');
  assert.ok(!forGuide.includes('Hatırlatma Oluştur'), 'guide must not see Hatırlatma Oluştur');
  assert.deepEqual(forGuide, ['Rehber Ata', 'Pickup Bilgisi Ekle', 'Turu Tamamlandı Olarak İşaretle']);

  const forSales = filterFn(canAccess, ROLES.sales, RES_ACTIONS).map(a => a.label);
  assert.ok(!forSales.includes('Ödeme Kaydı Ekle'), 'Satış must not see Ödeme Kaydı Ekle either — payments is not in its ROLE_PERMISSIONS');
  assert.ok(forSales.includes('Hatırlatma Oluştur'), 'Satış does have reminders access and should still see it');

  const forOps = filterFn(canAccess, ROLES.operations, RES_ACTIONS).map(a => a.label);
  assert.deepEqual(forOps, RES_ACTIONS.map(a => a.label), 'Operasyon has both reminders and payments — sees every action');

  const forAdmin = filterFn(canAccess, ROLES.admin, RES_ACTIONS).map(a => a.label);
  assert.deepEqual(forAdmin, RES_ACTIONS.map(a => a.label), 'Yönetici (null permissions = all) sees every action');
});

// ── No permission model invented; no RLS/schema/auth touched ────────────

test('ROLE_PERMISSIONS itself is untouched by this pass — only ResQuickActions now consults it', () => {
  assert.match(SOURCE, /const ROLE_PERMISSIONS = \{\s*\n\s*"Yönetici": null,/);
  assert.match(SOURCE, /"Satış":\s*\["dashboard","customers","reservations","guides","leads","quotes","reminders","messages","reports","more","changelog"\]/);
  assert.match(SOURCE, /"Operasyon":\s*\["dashboard","reservations","calendar","tours","guides","leads","quotes","reminders","payments","reports","more","changelog"\]/);
  assert.match(SOURCE, /"Rehber":\s*\["dashboard","calendar","reservations","more","changelog"\]/);
});
