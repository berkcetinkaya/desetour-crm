'use strict';
/**
 * tests/dashboard/aal2EnforcementMigration.test.js
 * ─────────────────────────────────────────────────────────────────────────
 * Regression coverage for supabase_migration_aal2_enforcement.sql and its
 * rollback (TOTP MFA follow-up, AAL2 RLS enforcement phase). NOT YET
 * APPLIED to any database — explicitly withheld pending manual approval.
 * Every test here is a pure, static, never-executed text assertion
 * against the prepared .sql files (the actual RLS behavior is separately
 * proven in a disposable local PostgreSQL sandbox — see the
 * implementation report; that exercise is not re-run by this suite,
 * matching the project's standing rule that tests never make a live
 * database connection).
 * ─────────────────────────────────────────────────────────────────────────
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const FORWARD_PATH  = path.join(ROOT, 'supabase_migration_aal2_enforcement.sql');
const ROLLBACK_PATH = path.join(ROOT, 'supabase_migration_aal2_enforcement_ROLLBACK.sql');

const forward  = fs.readFileSync(FORWARD_PATH, 'utf8');
const rollback = fs.readFileSync(ROLLBACK_PATH, 'utf8');

// Every table the forward migration is expected to touch with `AND is_aal2()`
// (everything except staff_users' own-row bootstrap exception and
// ref_number_counters, which is service_role-only by pre-existing design).
const AAL2_TABLES = [
  'sources', 'customers', 'leads', 'tours', 'quotes', 'quote_items',
  'reservations', 'payments', 'tasks', 'reminders', 'activity_logs',
  'settings', 'message_threads', 'messages', 'guides', 'guide_languages',
  'guide_payments', 'agencies', 'agency_emails', 'reservation_guests',
  'email_ingestions', 'activity_log_reads', 'reservation_reviews',
  'tour_languages', 'tour_channels', 'tour_itinerary_stops',
  'civitatis_activity_modality_map', 'tour_preparation_rules',
  'reservation_preparations', 'whatsapp_destinations',
  'whatsapp_destination_recipients', 'whatsapp_messages',
  'civitatis_settlement_items', 'exchange_rates',
];

// get_current_staff_role() is deliberately EXCLUDED from this list: this
// phase's follow-up hardening (STEP 1b) intentionally redefines it to add
// an is_active filter — see section G below, which asserts exactly that
// change (and nothing more) was made.
const ROLE_HELPERS = [
  'is_admin', 'is_sales', 'is_operations', 'is_guide', 'is_staff',
];

// ── A. is_aal2() itself ──────────────────────────────────────────────────

test('is_aal2() is defined, reads auth.jwt() directly, and is not SECURITY DEFINER', () => {
  const idx = forward.indexOf('CREATE OR REPLACE FUNCTION public.is_aal2()');
  assert.ok(idx !== -1, 'is_aal2() must be defined');
  const end = forward.indexOf('$$;', forward.indexOf('$$', idx) + 2) + 3;
  const body = forward.slice(idx, end);
  assert.match(body, /auth\.jwt\(\)/);
  assert.match(body, /->>\s*'aal'/);
  assert.match(body, /=\s*'aal2'/);
  assert.doesNotMatch(body, /SECURITY DEFINER/);
});

test("is_aal2() fails closed: COALESCE guards a missing/null claim to '' before comparing", () => {
  const idx = forward.indexOf('CREATE OR REPLACE FUNCTION public.is_aal2()');
  const end = forward.indexOf('$$;', forward.indexOf('$$', idx) + 2) + 3;
  const body = forward.slice(idx, end);
  assert.match(body, /COALESCE\(\s*auth\.jwt\(\)\s*->>\s*'aal'\s*,\s*''\s*\)/);
});

// ── B. staff_users bootstrap exception ──────────────────────────────────

test('staff_users gets a new unconditional own-row SELECT policy with no role or AAL2 check', () => {
  const stmtStart = forward.indexOf('CREATE POLICY "staff_users: own profile select at aal1"');
  assert.ok(stmtStart !== -1, 'bootstrap policy must exist');
  const stmtEnd = forward.indexOf(';', stmtStart);
  const stmt = forward.slice(stmtStart, stmtEnd);
  assert.match(stmt, /FOR SELECT TO authenticated/);
  assert.match(stmt, /USING\s*\(\s*auth\.uid\(\)\s*=\s*id\s*\)/);
  assert.doesNotMatch(stmt, /is_aal2\(\)/);
  assert.doesNotMatch(stmt, /is_staff\(\)|is_admin\(\)|is_sales\(\)|is_operations\(\)|is_guide\(\)/);
});

test('staff_users "all staff can read" now requires is_staff() AND is_aal2()', () => {
  const idx = forward.lastIndexOf('"staff_users: all staff can read"');
  assert.ok(idx !== -1);
  const stmtStart = forward.lastIndexOf('CREATE POLICY', idx);
  const stmtEnd = forward.indexOf(';', idx);
  const stmt = forward.slice(stmtStart, stmtEnd);
  assert.match(stmt, /is_staff\(\)\s*AND\s*is_aal2\(\)/);
});

test('staff_users admin update-any/insert/delete all require is_admin() AND is_aal2()', () => {
  for (const name of ['staff_users: admin update any', 'staff_users: admin insert', 'staff_users: admin delete']) {
    const idx = forward.lastIndexOf(`"${name}"`);
    assert.ok(idx !== -1, `${name} must exist`);
    const stmtStart = forward.lastIndexOf('CREATE POLICY', idx);
    const stmtEnd = forward.indexOf(';', idx);
    const stmt = forward.slice(stmtStart, stmtEnd);
    assert.match(stmt, /is_admin\(\)\s*AND\s*is_aal2\(\)/, `${name} must gate on is_admin() AND is_aal2()`);
  }
});

test('staff_users "own profile update" is left completely untouched by the forward migration', () => {
  assert.doesNotMatch(forward, /CREATE POLICY "staff_users: own profile update"/);
  assert.doesNotMatch(forward, /DROP POLICY IF EXISTS "staff_users: own profile update"/);
});

// ── C. every other table gets AND is_aal2() on every existing policy ────

for (const table of AAL2_TABLES) {
  test(`every policy on ${table} in the forward migration references is_aal2()`, () => {
    const re = new RegExp(`CREATE POLICY "${table}: [^"]+"[\\s\\S]*?;`, 'g');
    const stmts = forward.match(re) || [];
    assert.ok(stmts.length > 0, `expected at least one CREATE POLICY for ${table}`);
    for (const stmt of stmts) {
      assert.match(stmt, /is_aal2\(\)/, `policy missing is_aal2(): ${stmt.slice(0, 80)}...`);
    }
  });
}

test('exchange_rates read policy replaces the previous unconditional TRUE with is_aal2() alone', () => {
  const idx = forward.lastIndexOf('"exchange_rates: authenticated staff can read"');
  const stmtStart = forward.lastIndexOf('CREATE POLICY', idx);
  const stmtEnd = forward.indexOf(';', idx);
  const stmt = forward.slice(stmtStart, stmtEnd);
  assert.match(stmt, /USING\s*\(\s*is_aal2\(\)\s*\)/);
});

test('ref_number_counters has no policy created or dropped by the forward migration (service_role only, unchanged)', () => {
  assert.doesNotMatch(forward, /CREATE POLICY "ref_number_counters:/i);
  assert.doesNotMatch(forward, /DROP POLICY IF EXISTS "ref_number_counters:/i);
});

// ── D. the shared role helpers themselves are never modified ────────────

for (const fn of ROLE_HELPERS) {
  test(`${fn}() is never redefined by the forward migration`, () => {
    assert.doesNotMatch(forward, new RegExp(`CREATE (OR REPLACE )?FUNCTION public\\.${fn}\\(`));
  });
  test(`${fn}() is never redefined by the rollback`, () => {
    assert.doesNotMatch(rollback, new RegExp(`CREATE (OR REPLACE )?FUNCTION public\\.${fn}\\(`));
  });
}

// ── E. row-scoping conditions are preserved verbatim, only is_aal2() added ──

test('guide-assigned EXISTS subqueries keep their original row-scoping intact alongside is_aal2()', () => {
  const stmtStart = forward.indexOf('CREATE POLICY "customers: guide reads assigned customers"');
  const stmtEnd = forward.indexOf(';', stmtStart);
  const stmt = forward.slice(stmtStart, stmtEnd);
  assert.match(stmt, /EXISTS \(SELECT 1 FROM public\.reservations r WHERE r\.customer_id = customers\.id AND r\.assigned_to = auth\.uid\(\) AND r\.status NOT IN \('cancelled'\)\)/);
  assert.match(stmt, /is_aal2\(\)/);
});

test('leads sales-update-own-or-assigned keeps its original OR condition intact alongside is_aal2()', () => {
  const idx = forward.indexOf('"leads: sales update own or assigned"');
  const stmtStart = forward.lastIndexOf('CREATE POLICY', idx);
  const stmtEnd = forward.indexOf(';', forward.indexOf('WITH CHECK', idx));
  const stmt = forward.slice(stmtStart, stmtEnd);
  assert.match(stmt, /assigned_to = auth\.uid\(\) OR created_by = auth\.uid\(\)/);
  assert.match(stmt, /is_aal2\(\)/);
});

// ── F. rollback reverses every change the forward migration made ────────

test('the rollback drops is_aal2() itself', () => {
  assert.match(rollback, /DROP FUNCTION IF EXISTS public\.is_aal2\(\)/);
});

test('the rollback drops the bootstrap-exception policy and restores "all staff can read" to is_staff() only, no AAL2', () => {
  assert.match(rollback, /DROP POLICY IF EXISTS "staff_users: own profile select at aal1" ON public\.staff_users;/);
  const idx = rollback.lastIndexOf('"staff_users: all staff can read"');
  const stmtStart = rollback.lastIndexOf('CREATE POLICY', idx);
  const stmtEnd = rollback.indexOf(';', idx);
  const stmt = rollback.slice(stmtStart, stmtEnd);
  assert.match(stmt, /USING\s*\(\s*is_staff\(\)\s*\)/);
  assert.doesNotMatch(stmt, /is_aal2/);
});

test('the rollback restores staff_users admin update/insert/delete to no-AAL2', () => {
  for (const name of ['staff_users: admin update any', 'staff_users: admin insert', 'staff_users: admin delete']) {
    const idx = rollback.lastIndexOf(`"${name}"`);
    assert.ok(idx !== -1, `${name} must exist in rollback`);
    const stmtStart = rollback.lastIndexOf('CREATE POLICY', idx);
    const stmtEnd = rollback.indexOf(';', idx);
    const stmt = rollback.slice(stmtStart, stmtEnd);
    assert.doesNotMatch(stmt, /is_aal2/);
    assert.match(stmt, /is_admin\(\)/);
  }
});

test('no CREATE POLICY statement anywhere in the rollback file references is_aal2()', () => {
  const stmts = rollback.match(/CREATE POLICY "[^"]+"[\s\S]*?;/g) || [];
  assert.ok(stmts.length > 0);
  for (const stmt of stmts) {
    assert.doesNotMatch(stmt, /is_aal2\(\)/, `rollback policy still references is_aal2(): ${stmt.slice(0, 80)}...`);
  }
});

for (const table of AAL2_TABLES) {
  test(`${table}'s rollback policies restore the exact pre-migration clauses (no is_aal2())`, () => {
    const re = new RegExp(`CREATE POLICY "${table}: [^"]+"[\\s\\S]*?;`, 'g');
    const stmts = rollback.match(re) || [];
    assert.ok(stmts.length > 0, `expected at least one CREATE POLICY for ${table} in rollback`);
    for (const stmt of stmts) {
      assert.doesNotMatch(stmt, /is_aal2\(\)/, `rollback policy still references is_aal2(): ${stmt.slice(0, 80)}...`);
    }
  });
}

test('the rollback creates the exact same set of pre-existing policy names the forward migration drops', () => {
  // "staff_users: own profile select at aal1" is excluded: it is a brand
  // new policy the forward migration introduces (its own DROP POLICY IF
  // EXISTS is just the standard idempotent-reapply guard, not a
  // pre-existing policy being reversed) — the rollback correctly DROPS
  // it rather than recreating it, since it must never have existed
  // pre-migration.
  const forwardDropped = new Set((forward.match(/DROP POLICY IF EXISTS "([^"]+)"/g) || [])
    .map((s) => s.match(/"([^"]+)"/)[1])
    .filter((name) => name !== 'staff_users: own profile select at aal1'));
  const rollbackCreated = new Set((rollback.match(/CREATE POLICY "([^"]+)"/g) || [])
    .map((s) => s.match(/"([^"]+)"/)[1]));
  for (const name of forwardDropped) {
    assert.ok(rollbackCreated.has(name), `rollback never recreates dropped policy: ${name}`);
  }
});

test('the rollback drops (but never recreates) the bootstrap-only policy that never existed pre-migration', () => {
  assert.match(rollback, /DROP POLICY IF EXISTS "staff_users: own profile select at aal1" ON public\.staff_users;/);
  assert.doesNotMatch(rollback, /CREATE POLICY "staff_users: own profile select at aal1"/);
});

test('the rollback never drops the bootstrap policy\'s own underlying table policy count down to zero for staff_users SELECT', () => {
  // Sanity: staff_users still ends up with exactly one SELECT-granting
  // policy after rollback ("all staff can read"), matching pre-migration.
  const selectPolicies = (rollback.match(/CREATE POLICY "staff_users: [^"]+" ON public\.staff_users FOR SELECT/g) || []);
  assert.equal(selectPolicies.length, 1);
});

// ── G. Follow-up hardening: get_current_staff_role() ignores inactive
//      staff (STEP 1b) ─────────────────────────────────────────────────

test('get_current_staff_role() is redefined in the forward migration to require is_active = TRUE', () => {
  const idx = forward.lastIndexOf('CREATE OR REPLACE FUNCTION public.get_current_staff_role()');
  assert.ok(idx !== -1, 'get_current_staff_role() must be redefined (STEP 1b)');
  const end = forward.indexOf('$$;', forward.indexOf('$$', idx) + 2) + 3;
  const body = forward.slice(idx, end);
  assert.match(body, /WHERE\s+id\s*=\s*auth\.uid\(\)/);
  assert.match(body, /AND\s+is_active\s*=\s*TRUE/);
  assert.match(body, /SECURITY DEFINER/);
});

test('get_current_staff_role() is redefined exactly once in the forward migration (STEP 1b only, not duplicated)', () => {
  const matches = forward.match(/CREATE OR REPLACE FUNCTION public\.get_current_staff_role\(\)/g) || [];
  assert.equal(matches.length, 1);
});

test('is_admin()/is_sales()/is_operations()/is_guide()/is_staff() are NOT redefined even by the follow-up hardening', () => {
  for (const fn of ['is_admin', 'is_sales', 'is_operations', 'is_guide', 'is_staff']) {
    assert.doesNotMatch(forward, new RegExp(`CREATE (OR REPLACE )?FUNCTION public\\.${fn}\\(`));
  }
});

test('the rollback restores get_current_staff_role() to its exact original body, with no is_active filter', () => {
  const idx = rollback.lastIndexOf('CREATE OR REPLACE FUNCTION public.get_current_staff_role()');
  assert.ok(idx !== -1, 'rollback must restore get_current_staff_role()');
  const end = rollback.indexOf('$$;', rollback.indexOf('$$', idx) + 2) + 3;
  const body = rollback.slice(idx, end);
  assert.match(body, /WHERE\s+id\s*=\s*auth\.uid\(\)/);
  assert.doesNotMatch(body, /is_active/);
});

// ── H. Follow-up hardening: staff_users self-update column guard
//      (STEP 2b) ────────────────────────────────────────────────────────

test('enforce_staff_self_update_columns() is defined as a trigger function that exempts service_role and is_admin()', () => {
  const idx = forward.indexOf('CREATE OR REPLACE FUNCTION public.enforce_staff_self_update_columns()');
  assert.ok(idx !== -1);
  const end = forward.indexOf('$$;', forward.indexOf('$$', idx) + 2) + 3;
  const body = forward.slice(idx, end);
  assert.match(body, /RETURNS TRIGGER/);
  assert.match(body, /current_setting\('role', true\)\s*=\s*'service_role'/);
  assert.match(body, /public\.is_admin\(\)/);
});

test('the self-update guard blocks role, is_active, id, and email changes, and nothing else', () => {
  const idx = forward.indexOf('CREATE OR REPLACE FUNCTION public.enforce_staff_self_update_columns()');
  const end = forward.indexOf('$$;', forward.indexOf('$$', idx) + 2) + 3;
  const body = forward.slice(idx, end);
  for (const col of ['role', 'is_active', 'id', 'email']) {
    assert.match(body, new RegExp(`NEW\\.${col} IS DISTINCT FROM OLD\\.${col}`), `guard must check ${col}`);
  }
  for (const safeCol of ['full_name', 'phone', 'avatar_url']) {
    assert.doesNotMatch(body, new RegExp(`NEW\\.${safeCol}\\b`), `guard must NOT restrict ${safeCol}`);
  }
});

test('the guard checks service_role and is_admin() before comparing any OLD/NEW column, so both are fully exempt', () => {
  const idx = forward.indexOf('CREATE OR REPLACE FUNCTION public.enforce_staff_self_update_columns()');
  const end = forward.indexOf('$$;', forward.indexOf('$$', idx) + 2) + 3;
  const body = forward.slice(idx, end);
  const serviceRoleIdx = body.indexOf("current_setting('role', true)");
  const adminIdx = body.indexOf('public.is_admin()');
  const firstDistinctIdx = body.indexOf('IS DISTINCT FROM');
  assert.ok(serviceRoleIdx !== -1 && adminIdx !== -1 && firstDistinctIdx !== -1);
  assert.ok(serviceRoleIdx < firstDistinctIdx, 'service_role check must come before any column comparison');
  assert.ok(adminIdx < firstDistinctIdx, 'is_admin() check must come before any column comparison');
});

test('the guard only applies to the row matching auth.uid() = OLD.id (self-updates), never a third party row', () => {
  const idx = forward.indexOf('CREATE OR REPLACE FUNCTION public.enforce_staff_self_update_columns()');
  const end = forward.indexOf('$$;', forward.indexOf('$$', idx) + 2) + 3;
  const body = forward.slice(idx, end);
  assert.match(body, /IF\s+auth\.uid\(\)\s*=\s*OLD\.id\s+THEN/);
});

test('the trigger is created BEFORE UPDATE FOR EACH ROW on staff_users, bound to the guard function', () => {
  const idx = forward.indexOf('CREATE TRIGGER trg_staff_users_self_update_guard');
  assert.ok(idx !== -1);
  const stmtEnd = forward.indexOf(';', idx);
  const stmt = forward.slice(idx, stmtEnd);
  assert.match(stmt, /BEFORE UPDATE ON public\.staff_users/);
  assert.match(stmt, /FOR EACH ROW/);
  assert.match(stmt, /EXECUTE FUNCTION public\.enforce_staff_self_update_columns\(\)/);
});

test('the forward migration drops any pre-existing guard trigger idempotently before creating it', () => {
  const idx = forward.indexOf('CREATE TRIGGER trg_staff_users_self_update_guard');
  const before = forward.slice(0, idx);
  assert.match(before, /DROP TRIGGER IF EXISTS trg_staff_users_self_update_guard ON public\.staff_users;\s*$/);
});

test('the rollback drops the self-update guard trigger and its function', () => {
  assert.match(rollback, /DROP TRIGGER IF EXISTS trg_staff_users_self_update_guard ON public\.staff_users;/);
  assert.match(rollback, /DROP FUNCTION IF EXISTS public\.enforce_staff_self_update_columns\(\);/);
});

// ── I. Postflight checks updated for the new objects ────────────────────

test('the forward migration postflight verifies get_current_staff_role() checks is_active and the guard trigger/function exist', () => {
  const postflightIdx = forward.lastIndexOf('POSTFLIGHT');
  const tail = forward.slice(postflightIdx);
  assert.match(tail, /get_current_staff_role_checks_is_active/);
  assert.match(tail, /self_update_guard_function_exists/);
  assert.match(tail, /self_update_guard_trigger_exists/);
});

test('the rollback postflight verifies get_current_staff_role() is restored and the guard trigger/function are gone', () => {
  const postflightIdx = rollback.lastIndexOf('POSTFLIGHT');
  const tail = rollback.slice(postflightIdx);
  assert.match(tail, /get_current_staff_role_still_checks_is_active_should_be_0/);
  assert.match(tail, /self_update_guard_function_still_exists_should_be_0/);
  assert.match(tail, /self_update_guard_trigger_still_exists_should_be_0/);
});
