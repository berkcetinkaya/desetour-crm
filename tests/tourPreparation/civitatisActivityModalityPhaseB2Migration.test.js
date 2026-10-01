'use strict';
/**
 * tests/tourPreparation/civitatisActivityModalityPhaseB2Migration.test.js
 * ─────────────────────────────────────────────────────────────────────────
 * Regression coverage for
 * supabase_migration_civitatis_activity_modality_phase_b2.sql and its
 * rollback. NOT YET APPLIED to any database — explicitly withheld pending
 * manual approval. Every test here is a pure, static, never-executed text
 * assertion against the prepared .sql files. Nothing in this file
 * connects to a database or runs any SQL. The forward and rollback
 * migrations were separately validated, live, against a throwaway local
 * PostgreSQL instance with Phase A + B1 already applied — this file is
 * the committed regression suite, not that live validation.
 * ─────────────────────────────────────────────────────────────────────────
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const FORWARD_PATH  = path.join(ROOT, 'supabase_migration_civitatis_activity_modality_phase_b2.sql');
const ROLLBACK_PATH = path.join(ROOT, 'supabase_migration_civitatis_activity_modality_phase_b2_ROLLBACK.sql');

const forward  = fs.readFileSync(FORWARD_PATH, 'utf8');
const rollback = fs.readFileSync(ROLLBACK_PATH, 'utf8');

function codeOnlyLines(source) {
  return source.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');
}

// ── A. File structure: transactional, balanced ──────────────────────────

test('forward migration is wrapped in exactly one BEGIN;/COMMIT; pair, no stray ROLLBACK', () => {
  assert.equal((forward.match(/^BEGIN;\s*$/gm) || []).length, 1);
  assert.equal((forward.match(/^COMMIT;\s*$/gm) || []).length, 1);
  assert.doesNotMatch(forward, /^ROLLBACK/m);
});

test('rollback is wrapped in exactly one BEGIN;/COMMIT; pair', () => {
  assert.equal((rollback.match(/^BEGIN;\s*$/gm) || []).length, 1);
  assert.equal((rollback.match(/^COMMIT;\s*$/gm) || []).length, 1);
});

// ── B. RPC signature and security ────────────────────────────────────────

test('set_reservation_activity_modality has exactly the 5 expected parameters in order', () => {
  assert.match(
    forward,
    /CREATE OR REPLACE FUNCTION public\.set_reservation_activity_modality\(\s*\n\s*p_reservation_id\s+UUID,\s*\n\s*p_source_id\s+UUID,\s*\n\s*p_external_booking_id\s+TEXT,\s*\n\s*p_purchased_activity_raw\s+TEXT,\s*\n\s*p_meal_status\s+TEXT\s*\n\s*\)/
  );
});

test('the function is SECURITY DEFINER with SET search_path = public', () => {
  const idx = forward.indexOf('CREATE OR REPLACE FUNCTION public.set_reservation_activity_modality');
  const bodyStart = forward.indexOf('AS $$', idx);
  const header = forward.slice(idx, bodyStart);
  assert.match(header, /SECURITY DEFINER/);
  assert.match(header, /SET search_path = public/);
});

test('REVOKE ALL from PUBLIC/authenticated/anon and GRANT EXECUTE to service_role only', () => {
  assert.match(forward, /REVOKE ALL ON FUNCTION public\.set_reservation_activity_modality\([^)]*\) FROM PUBLIC;/);
  assert.match(forward, /REVOKE ALL ON FUNCTION public\.set_reservation_activity_modality\([^)]*\) FROM authenticated;/);
  assert.match(forward, /REVOKE ALL ON FUNCTION public\.set_reservation_activity_modality\([^)]*\) FROM anon;/);
  assert.match(forward, /GRANT EXECUTE ON FUNCTION public\.set_reservation_activity_modality\([^)]*\) TO service_role;/);
  // No GRANT to authenticated/anon/PUBLIC anywhere.
  assert.doesNotMatch(forward, /GRANT EXECUTE ON FUNCTION public\.set_reservation_activity_modality\([^)]*\) TO (authenticated|anon|PUBLIC)/);
});

test('postflight structurally re-confirms SECURITY DEFINER and the exact grant/revoke posture via pg_proc/has_function_privilege', () => {
  const postflightIdx = forward.lastIndexOf('DO $$');
  const postflight = forward.slice(postflightIdx);
  assert.match(postflight, /prosecdef = TRUE/);
  assert.match(postflight, /has_function_privilege\('service_role', v_func_oid, 'EXECUTE'\)/);
  assert.match(postflight, /has_function_privilege\('authenticated', v_func_oid, 'EXECUTE'\)/);
  assert.match(postflight, /has_function_privilege\('anon', v_func_oid, 'EXECUTE'\)/);
});

// ── C. The function updates ONLY the two intended columns ───────────────

test('the UPDATE statement inside the function targets ONLY purchased_activity_raw and meal_status', () => {
  const idx = forward.indexOf('UPDATE public.reservations');
  assert.ok(idx > -1);
  const stmt = forward.slice(idx, forward.indexOf('WHERE id = p_reservation_id', idx) + 'WHERE id = p_reservation_id'.length + 1);
  assert.match(stmt, /purchased_activity_raw = p_purchased_activity_raw/);
  assert.match(stmt, /meal_status\s*=\s*p_meal_status/);
  // No other reservations column is ever assigned in this statement.
  for (const forbidden of [
    'tour_id', 'check_in', 'check_out', 'check_in_time', 'pax_adult', 'pax_child',
    'guide_id', 'guide_name', 'payment_status', 'total_amount', 'currency',
    'notes', 'internal_notes', 'retail_amount', 'retail_currency',
  ]) {
    assert.doesNotMatch(stmt, new RegExp(forbidden));
  }
  // reservations.status (the booking lifecycle status) must never be
  // assigned — checked separately from meal_status with a lookbehind so
  // the legitimate "meal_status = ..." assignment isn't a false positive.
  assert.doesNotMatch(stmt, /(?<!meal_)\bstatus\s*=/);
});

test('there is exactly one UPDATE statement in the entire forward migration', () => {
  const code = codeOnlyLines(forward);
  const updates = [...code.matchAll(/\bUPDATE\s+public\./g)];
  assert.equal(updates.length, 1, `expected exactly 1 UPDATE statement, found ${updates.length}`);
});

// ── D. Identity guard and meal_status validation ─────────────────────────

test('an invalid meal_status is rejected before any read/write, returning invalid_meal_status', () => {
  const idx = forward.indexOf("p_meal_status NOT IN ('included', 'not_included', 'unknown')");
  assert.ok(idx > -1);
  const nearby = forward.slice(idx, idx + 300);
  assert.match(nearby, /'invalid_meal_status'/);
});

test('a reservation not found returns not_found without reaching the UPDATE', () => {
  assert.match(forward, /IF NOT FOUND THEN\s*\n\s*RETURN jsonb_build_object\('result', 'not_found'/);
});

test('an identity mismatch (source_id/external_booking_id) returns identity_mismatch without reaching the UPDATE', () => {
  const idx = forward.indexOf('v_existing.source_id IS DISTINCT FROM p_source_id');
  assert.ok(idx > -1);
  const nearby = forward.slice(idx, idx + 300);
  assert.match(nearby, /v_existing\.external_booking_id IS DISTINCT FROM p_external_booking_id/);
  assert.match(nearby, /'identity_mismatch'/);
});

// ── E. Never touches V12/V13, WhatsApp, or any other Phase A/B1 object ──

test('forward migration never CREATEs/ALTERs/DROPs either Civitatis RPC — only read-only signature checks, twice each', () => {
  for (const fn of ['ingest_civitatis_booking', 'cancel_civitatis_booking']) {
    assert.doesNotMatch(forward, new RegExp(`CREATE (OR REPLACE )?FUNCTION public\\.${fn}`));
    assert.doesNotMatch(forward, new RegExp(`DROP FUNCTION[^;]*${fn}`));
    assert.doesNotMatch(forward, new RegExp(`ALTER FUNCTION[^;]*${fn}`));
    const mentions = [...forward.matchAll(new RegExp(fn, 'g'))];
    assert.ok(mentions.length >= 2, `expected at least a preflight AND postflight reference to ${fn}`);
  }
});

test('forward migration never references any WhatsApp Phase 1.2 object in executable code', () => {
  const code = codeOnlyLines(forward);
  for (const name of ['whatsapp_messages', 'whatsapp_destinations', 'whatsapp_destination_recipients', 'claim_whatsapp_outbox_batch', 'review_url']) {
    assert.doesNotMatch(code, new RegExp(name));
  }
});

test('forward migration never ALTERs/CREATEs/DROPs reservations, civitatis_activity_modality_map, tour_preparation_rules, or reservation_preparations', () => {
  const code = codeOnlyLines(forward);
  assert.doesNotMatch(code, /ALTER TABLE public\.reservations/);
  assert.doesNotMatch(code, /CREATE TABLE/);
  assert.doesNotMatch(code, /DROP TABLE/);
  assert.doesNotMatch(code, /INSERT INTO public\.civitatis_activity_modality_map/);
  assert.doesNotMatch(code, /public\.tour_preparation_rules/);
  assert.doesNotMatch(code, /public\.reservation_preparations/);
});

// ── F. Preflight dependency checks ───────────────────────────────────────

test('preflight verifies reservations Phase A columns, civitatis_activity_modality_map, and both RPC signatures before touching anything', () => {
  const preflightIdx = forward.indexOf('DO $$');
  const preflight = forward.slice(preflightIdx, forward.indexOf('END $$;', preflightIdx));
  assert.match(preflight, /column_name='purchased_activity_raw'/);
  assert.match(preflight, /column_name='meal_status'/);
  assert.match(preflight, /table_name='civitatis_activity_modality_map'/);
  assert.match(preflight, /pronargs = 26/);
  assert.match(preflight, /pronargs = 7/);
});

// ── G. Rollback: scope limited to the B2 function only ──────────────────

test('rollback drops exactly set_reservation_activity_modality(UUID, UUID, TEXT, TEXT, TEXT)', () => {
  assert.match(rollback, /DROP FUNCTION IF EXISTS public\.set_reservation_activity_modality\(UUID, UUID, TEXT, TEXT, TEXT\);/);
});

test('rollback contains no DML (no UPDATE/INSERT/DELETE/TRUNCATE) anywhere', () => {
  const code = codeOnlyLines(rollback);
  assert.doesNotMatch(code, /\bUPDATE\s+public\./);
  assert.doesNotMatch(code, /\bINSERT\s+INTO\b/);
  assert.doesNotMatch(code, /\bDELETE\s+FROM\b/);
  assert.doesNotMatch(code, /\bTRUNCATE\b/);
});

test('rollback postflight re-verifies Phase A columns, civitatis_activity_modality_map, and Phase A/B1 seed rows are untouched', () => {
  const postflightIdx = rollback.lastIndexOf('DO $$');
  const postflight = rollback.slice(postflightIdx);
  assert.match(postflight, /purchased_activity_raw/);
  assert.match(postflight, /meal_status/);
  assert.match(postflight, /civitatis_activity_modality_map/);
  assert.match(postflight, /'com almoço'/);
  assert.match(postflight, /'Visita guiada pela Istambul imprescindível - Tour com'/);
});

test('rollback never touches WhatsApp Phase 1.2 objects in executable code', () => {
  const code = codeOnlyLines(rollback);
  for (const name of ['whatsapp_messages', 'whatsapp_destinations', 'whatsapp_destination_recipients', 'claim_whatsapp_outbox_batch', 'review_url']) {
    assert.doesNotMatch(code, new RegExp(name));
  }
});

test('rollback re-verifies both Civitatis RPC signatures unchanged, pronargs 26 and 7', () => {
  assert.match(rollback, /ingest_civitatis_booking/);
  assert.match(rollback, /cancel_civitatis_booking/);
  assert.match(rollback, /pronargs = 26/);
  assert.match(rollback, /pronargs = 7/);
});

// ── H. No production SQL execution anywhere in this test file ──────────

test('this test file never opens a database connection or executes SQL — every assertion is a static text match', () => {
  const selfSource = fs.readFileSync(__filename, 'utf8');
  assert.doesNotMatch(selfSource, /require\(['"]pg['"]\)/);
  assert.doesNotMatch(selfSource, /require\(['"]@supabase\/supabase-js['"]\)/);
  assert.doesNotMatch(selfSource, /\.query\(/);
  assert.doesNotMatch(selfSource, /createClient\(/);
});
