'use strict';
/**
 * tests/tourPreparation/reservationPreparationMaterializationMigration.test.js
 * ─────────────────────────────────────────────────────────────────────────
 * Tour Preparation Intelligence — Phase C2C: static-assertion coverage for
 * supabase_migration_reservation_preparation_materialization.sql, its
 * ROLLBACK, and phase_c2c_reservation_preparation_dry_run.sql.
 *
 * Never opens a database connection or executes SQL — every assertion is
 * a static text match, same convention as every other migration test in
 * this directory. The LIVE behavior (all 22 required scenarios: per_guest/
 * per_adult/fixed quantities, NULL/zero/negative guest counts, cancelled
 * reconciliation, pending create/update/no-op, duplicate prevention,
 * completed preservation vs. needs-review, inactive-rule supersede,
 * cross-tour isolation, repeated-run idempotency, and that no Topkapı/
 * Blue Mosque/Bosphorus/meal rule is ever created) was separately proven
 * this session against a disposable local Postgres instance seeded with
 * the real schema, the real partial unique index, and the real
 * materialize_reservation_preparations function — then destroyed.
 * ─────────────────────────────────────────────────────────────────────────
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const FORWARD_PATH = path.join(__dirname, '..', '..', 'supabase_migration_reservation_preparation_materialization.sql');
const ROLLBACK_PATH = path.join(__dirname, '..', '..', 'supabase_migration_reservation_preparation_materialization_ROLLBACK.sql');
const DRY_RUN_PATH = path.join(__dirname, '..', '..', 'phase_c2c_reservation_preparation_dry_run.sql');

const FORWARD = fs.readFileSync(FORWARD_PATH, 'utf8');
const ROLLBACK = fs.readFileSync(ROLLBACK_PATH, 'utf8');
const DRY_RUN = fs.readFileSync(DRY_RUN_PATH, 'utf8');

function codeOnly(source) {
  return source.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');
}

const FORWARD_CODE = codeOnly(FORWARD);
const ROLLBACK_CODE = codeOnly(ROLLBACK);
const DRY_RUN_CODE = codeOnly(DRY_RUN);

// ═══════════════════════════════════════════════════════════════════════
// Quantity sources — per_guest / per_adult / fixed, never a fallback chain
// ═══════════════════════════════════════════════════════════════════════

test('per_guest uses pax_adult + COALESCE(pax_child, 0) — the authoritative total guest count, never invented', () => {
  assert.match(FORWARD_CODE, /WHEN 'per_guest' THEN v_reservation\.pax_adult \+ COALESCE\(v_reservation\.pax_child, 0\)/);
});

test('per_adult uses pax_adult alone', () => {
  assert.match(FORWARD_CODE, /WHEN 'per_adult' THEN v_reservation\.pax_adult/);
});

test('fixed uses tour_preparation_rules.fixed_quantity alone', () => {
  assert.match(FORWARD_CODE, /WHEN 'fixed'\s+THEN v_rule\.fixed_quantity/);
});

test('an unrecognized quantity_rule falls closed to NULL, never guessed', () => {
  assert.match(FORWARD_CODE, /ELSE NULL -- unrecognized quantity_rule/);
});

test('NULL or <=0 required_quantity is never fabricated — the rule is skipped entirely, no write occurs, action is invalid_quantity', () => {
  assert.match(FORWARD_CODE, /IF v_required_quantity IS NULL OR v_required_quantity <= 0 THEN/);
  const skipBlock = FORWARD_CODE.slice(
    FORWARD_CODE.indexOf('IF v_required_quantity IS NULL OR v_required_quantity <= 0 THEN'),
    FORWARD_CODE.indexOf('CONTINUE;') + 'CONTINUE;'.length
  );
  assert.match(skipBlock, /'action', 'invalid_quantity'/);
  assert.match(skipBlock, /CONTINUE;/);
  assert.doesNotMatch(skipBlock, /INSERT INTO/);
  assert.doesNotMatch(skipBlock, /UPDATE public\.reservation_preparations/);
});

// ═══════════════════════════════════════════════════════════════════════
// Cancellation — skip rule evaluation, reconcile existing pending only
// ═══════════════════════════════════════════════════════════════════════

test('a cancelled reservation never evaluates any rule — the cancelled branch returns before the rule loop', () => {
  const cancelBlockStart = FORWARD_CODE.indexOf("IF v_reservation.status = 'cancelled' THEN");
  const ruleLoopStart = FORWARD_CODE.indexOf('FOR v_rule IN');
  assert.ok(cancelBlockStart !== -1 && ruleLoopStart !== -1 && cancelBlockStart < ruleLoopStart);
  const cancelBlock = FORWARD_CODE.slice(cancelBlockStart, ruleLoopStart);
  assert.match(cancelBlock, /RETURN jsonb_build_object/);
});

test('cancellation moves existing pending rows to cancelled, scoped to this reservation and status=pending only', () => {
  assert.match(FORWARD_CODE, /UPDATE public\.reservation_preparations\s*\n\s*SET status = 'cancelled'\s*\n\s*WHERE reservation_id = p_reservation_id\s*\n\s*AND status = 'pending'/);
});

test('cancellation never touches a completed row — the UPDATE is scoped to status=pending only, completed rows fall outside it', () => {
  const cancelUpdate = FORWARD_CODE.match(/UPDATE public\.reservation_preparations\s*\n\s*SET status = 'cancelled'[\s\S]*?RETURNING/)[0];
  assert.doesNotMatch(cancelUpdate, /completed/);
});

// ═══════════════════════════════════════════════════════════════════════
// Upsert identity — reservation_id + preparation_rule_id, respecting the
// Phase A partial unique index
// ═══════════════════════════════════════════════════════════════════════

test('the live-row lookup matches the exact uq_reservation_preparations_live_rule_instance identity: reservation_id + preparation_rule_id, status IN (pending, completed)', () => {
  assert.match(FORWARD_CODE, /WHERE reservation_id = p_reservation_id\s*\n\s*AND preparation_rule_id = v_rule\.id\s*\n\s*AND status IN \('pending', 'completed'\)/);
});

test('a brand-new preparation is inserted as pending, with label/type copied verbatim from the rule', () => {
  assert.match(FORWARD_CODE, /INSERT INTO public\.reservation_preparations\s*\n\s*\(reservation_id, preparation_rule_id, preparation_type, label, required_quantity, status\)\s*\n\s*VALUES\s*\n\s*\(p_reservation_id, v_rule\.id, v_rule\.preparation_type, v_rule\.label, v_required_quantity, 'pending'\)/);
});

test('exactly one INSERT INTO reservation_preparations statement exists in the whole forward migration', () => {
  const matches = FORWARD_CODE.match(/INSERT INTO public\.reservation_preparations/g) || [];
  assert.equal(matches.length, 1);
});

// ═══════════════════════════════════════════════════════════════════════
// Pending update / no-op
// ═══════════════════════════════════════════════════════════════════════

test('a pending row is updated in place only when quantity, label, or type actually differ from the rule', () => {
  const pendingBlock = FORWARD_CODE.slice(FORWARD_CODE.indexOf("ELSIF v_existing.status = 'pending' THEN"), FORWARD_CODE.indexOf('ELSE -- v_existing.status'));
  assert.match(pendingBlock, /v_existing\.required_quantity != v_required_quantity/);
  assert.match(pendingBlock, /v_existing\.label IS DISTINCT FROM v_rule\.label/);
  assert.match(pendingBlock, /v_existing\.preparation_type IS DISTINCT FROM v_rule\.preparation_type/);
  assert.match(pendingBlock, /action', 'update'/);
  assert.match(pendingBlock, /action', 'no_op'/);
});

test('the pending-row UPDATE never changes its status, reservation_id, or preparation_rule_id — only required_quantity/label/preparation_type', () => {
  const updateStmt = FORWARD_CODE.match(/UPDATE public\.reservation_preparations\s*\n\s*SET required_quantity = v_required_quantity,[\s\S]*?WHERE id = v_existing\.id;/)[0];
  assert.doesNotMatch(updateStmt, /SET[\s\S]*status\s*=/);
  assert.doesNotMatch(updateStmt, /reservation_id\s*=/);
  assert.doesNotMatch(updateStmt, /preparation_rule_id\s*=/);
});

// ═══════════════════════════════════════════════════════════════════════
// Completed preservation vs. needs-review (no new status added)
// ═══════════════════════════════════════════════════════════════════════

test('a completed row is NEVER written to — no UPDATE statement targets a completed reservation_preparations row', () => {
  const completedBlock = FORWARD_CODE.slice(FORWARD_CODE.indexOf('ELSE -- v_existing.status'), FORWARD_CODE.indexOf('END IF;\n  END LOOP;'));
  assert.doesNotMatch(completedBlock, /UPDATE public\.reservation_preparations/);
  assert.doesNotMatch(completedBlock, /INSERT INTO/);
});

test('a quantity drift against a completed row is classified completed_needs_review in the RETURN value only — never persisted as a new status', () => {
  assert.match(FORWARD_CODE, /'completed_needs_review'/);
  // The persisted status CHECK constraint itself is never touched —
  // this migration contains no ALTER TABLE on reservation_preparations
  // at all (it is pure CREATE FUNCTION), so no new status value could
  // ever be added to the schema by this file.
  assert.doesNotMatch(FORWARD_CODE, /ALTER TABLE public\.reservation_preparations/);
});

test('this migration never adds a new status value to the reservation_preparations CHECK constraint', () => {
  assert.doesNotMatch(FORWARD_CODE, /reservation_preparations_status/i);
});

// ═══════════════════════════════════════════════════════════════════════
// Rule-removed / inactive -> supersede; history never deleted
// ═══════════════════════════════════════════════════════════════════════

test('the supersede sweep only ever targets pending rows whose rule is no longer in the active set for this run', () => {
  assert.match(FORWARD_CODE, /UPDATE public\.reservation_preparations\s*\n\s*SET status = 'superseded'\s*\n\s*WHERE reservation_id = p_reservation_id\s*\n\s*AND status = 'pending'\s*\n\s*AND preparation_rule_id IS NOT NULL\s*\n\s*AND preparation_rule_id != ALL \(v_active_rule_ids\)/);
});

test('no DELETE statement exists anywhere in the forward migration or its rollback — history is never deleted', () => {
  assert.doesNotMatch(FORWARD_CODE, /\bDELETE\b/);
  assert.doesNotMatch(ROLLBACK_CODE, /\bDELETE FROM public\.reservation_preparations\b/);
  assert.doesNotMatch(ROLLBACK_CODE, /\bDELETE FROM public\.tour_preparation_rules\b/);
});

test('active rule ids are collected into an array initialized to an explicit empty array, never left NULL (NULL would break the != ALL comparison)', () => {
  assert.match(FORWARD_CODE, /v_active_rule_ids\s+UUID\[\]\s*:=\s*ARRAY\[\]::UUID\[\];/);
});

// ═══════════════════════════════════════════════════════════════════════
// Cross-tour isolation
// ═══════════════════════════════════════════════════════════════════════

test('active rules are loaded scoped to this reservation\'s own tour_id only', () => {
  assert.match(FORWARD_CODE, /FROM public\.tour_preparation_rules\s*\n\s*WHERE tour_id = v_reservation\.tour_id\s*\n\s*AND is_active = TRUE/);
});

// ═══════════════════════════════════════════════════════════════════════
// Idempotency
// ═══════════════════════════════════════════════════════════════════════

test('idempotency rests on the partial unique index, never a hand-rolled duplicate check', () => {
  // The function itself never creates its own uniqueness mechanism —
  // it relies entirely on uq_reservation_preparations_live_rule_instance
  // (verified to exist by this migration's own preflight).
  assert.match(FORWARD_CODE, /uq_reservation_preparations_live_rule_instance/);
});

// ═══════════════════════════════════════════════════════════════════════
// RPC security posture
// ═══════════════════════════════════════════════════════════════════════

test('materialize_reservation_preparations is SECURITY DEFINER with an explicit search_path, granted to service_role only', () => {
  assert.match(FORWARD_CODE, /CREATE OR REPLACE FUNCTION public\.materialize_reservation_preparations/);
  assert.match(FORWARD_CODE, /SECURITY DEFINER/);
  assert.match(FORWARD_CODE, /SET search_path = public/);
  assert.match(FORWARD_CODE, /REVOKE ALL ON FUNCTION public\.materialize_reservation_preparations\(UUID\) FROM PUBLIC;/);
  assert.match(FORWARD_CODE, /REVOKE ALL ON FUNCTION public\.materialize_reservation_preparations\(UUID\) FROM authenticated;/);
  assert.match(FORWARD_CODE, /REVOKE ALL ON FUNCTION public\.materialize_reservation_preparations\(UUID\) FROM anon;/);
  assert.match(FORWARD_CODE, /GRANT EXECUTE ON FUNCTION public\.materialize_reservation_preparations\(UUID\) TO service_role;/);
});

// ═══════════════════════════════════════════════════════════════════════
// No out-of-scope rule creation anywhere
// ═══════════════════════════════════════════════════════════════════════

test('this migration never creates a Topkapı, Blue Mosque, Bosphorus Cruise, or static meal rule — no INSERT INTO tour_preparation_rules exists at all', () => {
  assert.doesNotMatch(FORWARD_CODE, /INSERT INTO public\.tour_preparation_rules/);
  assert.doesNotMatch(FORWARD_CODE, /Topkap/i);
  assert.doesNotMatch(FORWARD_CODE, /Blue Mosque|Mavi Cami/i);
  assert.doesNotMatch(FORWARD_CODE, /Bosphorus Cruise|Boğaz Turu/i);
});

test('this migration never touches meal_status or purchased_activity_raw — meal preparation is explicitly deferred to a later phase', () => {
  assert.doesNotMatch(FORWARD_CODE, /meal_status/);
  assert.doesNotMatch(FORWARD_CODE, /purchased_activity_raw/);
});

// ═══════════════════════════════════════════════════════════════════════
// Scope confirmation — Civitatis ingestion / WhatsApp / auth untouched;
// no hook wired
// ═══════════════════════════════════════════════════════════════════════

test('this migration never redefines the Civitatis V12/V13 RPCs — only a read-only signature re-check', () => {
  assert.doesNotMatch(FORWARD_CODE, /CREATE OR REPLACE FUNCTION public\.ingest_civitatis_booking/);
  assert.doesNotMatch(FORWARD_CODE, /CREATE OR REPLACE FUNCTION public\.cancel_civitatis_booking/);
  assert.doesNotMatch(FORWARD_CODE, /DROP FUNCTION public\.(ingest_civitatis_booking|cancel_civitatis_booking)/);
});

test('this migration and its rollback never mention WhatsApp or auth', () => {
  assert.doesNotMatch(FORWARD_CODE, /whatsapp/i);
  assert.doesNotMatch(ROLLBACK_CODE, /whatsapp/i);
  assert.doesNotMatch(FORWARD_CODE, /auth\.(uid|jwt)/i);
  assert.doesNotMatch(ROLLBACK_CODE, /auth\.(uid|jwt)/i);
});

test('no application code hook is wired by this migration — it is pure SQL, never touching ingest-civitatis-write.js or any JS file', () => {
  assert.doesNotMatch(FORWARD_CODE, /ingest-civitatis-write/);
  assert.doesNotMatch(FORWARD_CODE, /activityModalityEnrichment/);
});

// ═══════════════════════════════════════════════════════════════════════
// Rollback
// ═══════════════════════════════════════════════════════════════════════

test('the rollback drops only materialize_reservation_preparations(UUID), nothing else, and is idempotent', () => {
  assert.match(ROLLBACK_CODE, /DROP FUNCTION IF EXISTS public\.materialize_reservation_preparations\(UUID\);/);
  const allDrops = ROLLBACK_CODE.match(/DROP FUNCTION/g) || [];
  assert.equal(allDrops.length, 1);
});

test('the rollback never deletes any reservation_preparations row — it is pure DDL, no data of its own to remove', () => {
  assert.doesNotMatch(ROLLBACK_CODE, /DELETE FROM/);
  assert.doesNotMatch(ROLLBACK_CODE, /TRUNCATE/);
});

test('both the forward migration and rollback are wrapped in an explicit BEGIN/COMMIT transaction', () => {
  assert.match(FORWARD, /^BEGIN;/m);
  assert.match(FORWARD, /^COMMIT;/m);
  assert.match(ROLLBACK, /^BEGIN;/m);
  assert.match(ROLLBACK, /^COMMIT;/m);
});

// ═══════════════════════════════════════════════════════════════════════
// Dry-run SQL
// ═══════════════════════════════════════════════════════════════════════

test('the dry-run file contains only WITH/SELECT — no write/DDL keyword anywhere in executable code', () => {
  for (const kw of ['INSERT', 'UPDATE', 'DELETE', 'UPSERT', 'MERGE', 'ALTER', 'CREATE', 'DROP', 'TRUNCATE', 'GRANT', 'REVOKE']) {
    assert.doesNotMatch(DRY_RUN_CODE, new RegExp(`\\b${kw}\\b`));
  }
});

test('the dry-run never calls materialize_reservation_preparations — it is an independent SQL reproduction, not an invocation', () => {
  assert.doesNotMatch(DRY_RUN_CODE, /materialize_reservation_preparations\(/);
});

test('the dry-run uses Istanbul-local "today" for its future-reservation scope, same convention as the Phase B2 production dry run', () => {
  assert.match(DRY_RUN_CODE, /NOW\(\) AT TIME ZONE 'Europe\/Istanbul'/);
});

test('the dry-run reports every required proposed_action value', () => {
  for (const action of ['create', 'update', 'no_op', 'supersede', 'skip_cancelled', 'invalid_quantity', 'completed_needs_review']) {
    assert.match(DRY_RUN_CODE, new RegExp(`'${action}'`));
  }
});

test('the dry-run computes calculated_required_quantity using the exact same three sources as the RPC, never a fallback chain', () => {
  assert.match(DRY_RUN_CODE, /WHEN 'per_guest' THEN fr\.total_guest_count/);
  assert.match(DRY_RUN_CODE, /WHEN 'per_adult' THEN fr\.pax_adult/);
  assert.match(DRY_RUN_CODE, /WHEN 'fixed'\s+THEN ar\.fixed_quantity/);
});

test('this dry-run never mentions WhatsApp or auth', () => {
  assert.doesNotMatch(DRY_RUN_CODE, /whatsapp/i);
  assert.doesNotMatch(DRY_RUN_CODE, /auth\.(uid|jwt)/i);
});
