'use strict';
/**
 * tests/dashboard/guideReservationUpdateHardeningMigration.test.js
 * ─────────────────────────────────────────────────────────────────────────
 * Regression coverage for
 * supabase_migration_guide_reservation_update_hardening.sql and its
 * rollback (Security Foundation Phase 1). NOT YET APPLIED to any
 * database — explicitly withheld pending manual approval. Every test
 * here is a pure, static, never-executed text assertion against the
 * prepared .sql files (the actual trigger/RLS behavior is separately
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
const FORWARD_PATH  = path.join(ROOT, 'supabase_migration_guide_reservation_update_hardening.sql');
const ROLLBACK_PATH = path.join(ROOT, 'supabase_migration_guide_reservation_update_hardening_ROLLBACK.sql');

const forward  = fs.readFileSync(FORWARD_PATH, 'utf8');
const rollback = fs.readFileSync(ROLLBACK_PATH, 'utf8');

// ── A. The allowed-column set matches exactly what was proven from the
//      current UI — the one thing this migration must never drift from ──

test('the allowed-columns array contains exactly the 7 proven columns, no more, no fewer', () => {
  const idx = forward.indexOf('v_allowed_keys TEXT[] :=');
  assert.ok(idx !== -1);
  const stmt = forward.slice(idx, forward.indexOf(';', idx) + 1);
  for (const col of ['guide_id', 'guide_name', 'pickup_location', 'pickup_time', 'status', 'completed_at', 'updated_at']) {
    assert.match(stmt, new RegExp(`'${col}'`), `missing allowed column: ${col}`);
  }
  const matches = stmt.match(/'[a-z_]+'/g) || [];
  assert.equal(matches.length, 7, `expected exactly 7 allowed columns, found ${matches.length}: ${matches.join(', ')}`);
});

test('financial/administrative columns are explicitly absent from the allowed set', () => {
  const idx = forward.indexOf('v_allowed_keys TEXT[] :=');
  const stmt = forward.slice(idx, forward.indexOf(';', idx) + 1);
  for (const col of ['total_amount', 'deposit_amount', 'currency', 'customer_id', 'payment_status', 'internal_notes', 'cancelled_at', 'cancel_reason']) {
    assert.doesNotMatch(stmt, new RegExp(`'${col}'`), `${col} must NOT be in the guide-allowed set`);
  }
});

// ── B. The guard is guide-role-specific — every other role/service_role
//      falls through untouched ─────────────────────────────────────────

test('the guard function returns immediately (RETURN NEW) for any role other than guide, before any column check', () => {
  const fnIdx = forward.indexOf('CREATE OR REPLACE FUNCTION public.enforce_guide_reservation_update_columns()');
  const fnEnd = forward.indexOf('$$;', fnIdx);
  const fnBody = forward.slice(fnIdx, fnEnd);
  const guardIdx = fnBody.indexOf("IS DISTINCT FROM 'guide'");
  const jsonbIdx = fnBody.indexOf('to_jsonb(OLD)');
  assert.ok(guardIdx !== -1 && jsonbIdx !== -1 && guardIdx < jsonbIdx, 'the guide-role check must come before the column comparison');
  assert.match(fnBody, /IF public\.get_current_staff_role\(\) IS DISTINCT FROM 'guide' THEN\s*\n\s*RETURN NEW;/);
});

test('the function body contains no CALL to is_admin()/is_operations()/is_staff() — it relies solely on one get_current_staff_role() comparison for every non-guide case, including service_role (auth.uid() NULL)', () => {
  const fnIdx = forward.indexOf('CREATE OR REPLACE FUNCTION public.enforce_guide_reservation_update_columns()');
  const fnEnd = forward.indexOf('$$;', fnIdx);
  const fnBody = forward.slice(fnIdx, fnEnd);
  // Exclude comment lines (which legitimately explain the service_role/
  // admin/operations fall-through case in prose) — check only executable
  // PL/pgSQL statements for an actual function call to another role helper.
  const codeOnly = fnBody.split('\n').filter(l => !l.trim().startsWith('--')).join('\n');
  assert.doesNotMatch(codeOnly, /is_admin\(\)|is_operations\(\)|is_staff\(\)/);
  assert.equal((codeOnly.match(/get_current_staff_role\(\)/g) || []).length, 1, 'expected exactly one get_current_staff_role() call in the executable code');
});

// ── C. Column comparison is subtraction-based (fail-closed for future columns) ──

test('the comparison strips the allowed keys from BOTH OLD and NEW via the jsonb - text[] operator and raises if anything else differs', () => {
  const fnIdx = forward.indexOf('CREATE OR REPLACE FUNCTION public.enforce_guide_reservation_update_columns()');
  const fnEnd = forward.indexOf('$$;', fnIdx);
  const fnBody = forward.slice(fnIdx, fnEnd);
  assert.match(fnBody, /\(to_jsonb\(OLD\) - v_allowed_keys\) IS DISTINCT FROM \(to_jsonb\(NEW\) - v_allowed_keys\)/);
  assert.match(fnBody, /RAISE EXCEPTION/);
});

test('the trigger is BEFORE UPDATE only (never INSERT — guides have no INSERT policy on reservations today)', () => {
  assert.match(forward, /BEFORE UPDATE ON public\.reservations/);
  assert.doesNotMatch(forward, /BEFORE INSERT OR UPDATE/);
  assert.doesNotMatch(forward, /BEFORE INSERT ON public\.reservations/);
});

// ── D. Idempotency ───────────────────────────────────────────────────────

test('CREATE OR REPLACE FUNCTION and DROP TRIGGER IF EXISTS + CREATE TRIGGER are both idempotent-safe', () => {
  assert.match(forward, /CREATE OR REPLACE FUNCTION public\.enforce_guide_reservation_update_columns/);
  const dropIdx = forward.indexOf('DROP TRIGGER IF EXISTS trg_reservations_guide_column_guard');
  const createIdx = forward.indexOf('CREATE TRIGGER trg_reservations_guide_column_guard');
  assert.ok(dropIdx !== -1 && createIdx !== -1 && dropIdx < createIdx);
});

// ── E. Never touches existing RLS policies or the pre-existing updated_at trigger ──

test('forward migration never mentions CREATE POLICY, ALTER POLICY, or DROP POLICY — the existing reservations RLS is untouched', () => {
  assert.doesNotMatch(forward, /CREATE POLICY|ALTER POLICY|DROP POLICY/i);
});

test('forward migration never redefines trg_reservations_updated_at or set_updated_at()', () => {
  assert.doesNotMatch(forward, /CREATE (OR REPLACE )?(TRIGGER trg_reservations_updated_at|FUNCTION public\.set_updated_at)/);
});

test('postflight confirms the guard trigger/function exist AND the pre-existing updated_at trigger and policy count are unchanged', () => {
  const postflightIdx = forward.indexOf('-- POSTFLIGHT');
  const postflight = forward.slice(postflightIdx);
  assert.match(postflight, /guard_function_exists/);
  assert.match(postflight, /guard_trigger_exists/);
  assert.match(postflight, /updated_at_trigger_unchanged/);
  assert.match(postflight, /reservations_policy_count_unchanged/);
});

// ── F. Rollback removes exactly the trigger and function it created, in
//      dependency-safe order ────────────────────────────────────────────

test('rollback drops the trigger BEFORE the function (dependency-safe order)', () => {
  const triggerIdx  = rollback.indexOf('DROP TRIGGER IF EXISTS trg_reservations_guide_column_guard');
  const functionIdx = rollback.indexOf('DROP FUNCTION IF EXISTS public.enforce_guide_reservation_update_columns()');
  assert.ok(triggerIdx !== -1 && functionIdx !== -1 && triggerIdx < functionIdx);
});

test('rollback never touches reservations RLS policies, the updated_at trigger, or any shared is_*() helper function — only mentions them in its own postflight verification, never in a DDL statement', () => {
  assert.doesNotMatch(rollback, /CREATE POLICY|ALTER POLICY|DROP POLICY/i);
  assert.doesNotMatch(rollback, /DROP TRIGGER[^\n]*trg_reservations_updated_at/);
  assert.doesNotMatch(rollback, /DROP FUNCTION[^\n]*set_updated_at/);
  assert.doesNotMatch(rollback, /DROP FUNCTION[^\n]*\bis_(admin|sales|operations|guide|staff)\b/);
  // The only DROP TRIGGER / DROP FUNCTION in the whole file are this
  // migration's own two objects — confirm there are exactly two DROPs.
  const drops = rollback.match(/^DROP (TRIGGER|FUNCTION) IF EXISTS/gm) || [];
  assert.equal(drops.length, 2, `expected exactly 2 DROP statements, found ${drops.length}`);
});

test('rollback postflight re-confirms reservations table, updated_at trigger, and is_guide() all still exist', () => {
  assert.match(rollback, /table_name='reservations'/);
  assert.match(rollback, /tgname = 'trg_reservations_updated_at'/);
  assert.match(rollback, /proname = 'is_guide'/);
});

test('rollback is wrapped in exactly one BEGIN;/COMMIT; pair', () => {
  assert.equal((rollback.match(/^BEGIN;\s*$/gm) || []).length, 1);
  assert.equal((rollback.match(/^COMMIT;\s*$/gm) || []).length, 1);
});

// ── G. No secret, no implementation-detail leak ─────────────────────────

test('neither file contains a hardcoded credential or secret-shaped literal', () => {
  const combined = forward + rollback;
  assert.doesNotMatch(combined, /sk-ant-|service_role.{0,20}=.{0,10}['"]ey/i);
});
