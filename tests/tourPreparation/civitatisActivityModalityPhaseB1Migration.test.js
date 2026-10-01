'use strict';
/**
 * tests/tourPreparation/civitatisActivityModalityPhaseB1Migration.test.js
 * ─────────────────────────────────────────────────────────────────────────
 * Regression coverage for
 * supabase_migration_civitatis_activity_modality_phase_b1.sql and its
 * rollback. NOT YET APPLIED to any database — explicitly withheld pending
 * manual approval, exactly like every prior migration's own test file.
 * Every test here is a pure, static, never-executed text assertion
 * against the prepared .sql files. Nothing in this file connects to a
 * database or runs any SQL. The forward and rollback migrations were
 * separately validated, live, against a throwaway local PostgreSQL
 * instance with Phase A already applied — this file is the committed
 * regression suite, not that live validation.
 * ─────────────────────────────────────────────────────────────────────────
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const FORWARD_PATH  = path.join(ROOT, 'supabase_migration_civitatis_activity_modality_phase_b1.sql');
const ROLLBACK_PATH = path.join(ROOT, 'supabase_migration_civitatis_activity_modality_phase_b1_ROLLBACK.sql');
const PHASE_A_PATH  = path.join(ROOT, 'supabase_migration_tour_preparation_phase_a.sql');

const forward  = fs.readFileSync(FORWARD_PATH, 'utf8');
const rollback = fs.readFileSync(ROLLBACK_PATH, 'utf8');
const phaseA   = fs.readFileSync(PHASE_A_PATH, 'utf8');

// ── A. File structure: transactional, balanced ──────────────────────────

test('forward migration is wrapped in exactly one BEGIN;/COMMIT; pair, no stray ROLLBACK', () => {
  assert.equal((forward.match(/^BEGIN;\s*$/gm) || []).length, 1);
  assert.equal((forward.match(/^COMMIT;\s*$/gm) || []).length, 1);
  assert.doesNotMatch(forward, /^ROLLBACK/m);
});

test('forward migration dollar-quoting is balanced (preflight + postflight DO blocks only)', () => {
  const dollarLines = forward.split('\n').filter((l) => l.includes('$$'));
  assert.equal(dollarLines.length, 4, `expected exactly 4 lines containing $$ (2 DO blocks), found ${dollarLines.length}`);
});

test('rollback is wrapped in exactly one BEGIN;/COMMIT; pair, dollar-quoting balanced', () => {
  assert.equal((rollback.match(/^BEGIN;\s*$/gm) || []).length, 1);
  assert.equal((rollback.match(/^COMMIT;\s*$/gm) || []).length, 1);
  const dollarLines = rollback.split('\n').filter((l) => l.includes('$$'));
  assert.equal(dollarLines.length, 2, 'expected exactly 2 lines containing $$ (1 postflight DO block)');
});

// ── B. Forward migration seeds exactly the two newly-evidenced rows ────

test('forward migration INSERTs exactly two new rows, both language pt', () => {
  const idx = forward.indexOf('INSERT INTO public.civitatis_activity_modality_map');
  assert.ok(idx > -1);
  const stmt = forward.slice(idx, forward.indexOf('DO NOTHING;', idx) + 'DO NOTHING;'.length);
  const tuples = stmt.match(/\('pt',/g) || [];
  assert.equal(tuples.length, 2, `expected exactly 2 new seed tuples, found ${tuples.length}`);
});

test('new row 1: pt / suffix_exact / "...Tour com" / included', () => {
  assert.match(
    forward,
    /\('pt', 'suffix_exact', 'Visita guiada pela Istambul imprescindível - Tour com', 'included',\s*TRUE\)/
  );
});

test('new row 2: pt / suffix_exact / "...Tour sem" / not_included', () => {
  assert.match(
    forward,
    /\('pt', 'suffix_exact', 'Visita guiada pela Istambul imprescindível - Tour sem', 'not_included', TRUE\)/
  );
});

test('neither new row uses match_type=contains, and neither uses the bare words "com"/"sem" alone', () => {
  const idx = forward.indexOf('INSERT INTO public.civitatis_activity_modality_map');
  const stmt = forward.slice(idx, forward.indexOf('DO NOTHING;', idx) + 'DO NOTHING;'.length);
  assert.doesNotMatch(stmt, /'contains'/);
  assert.doesNotMatch(stmt, /'com',/);
  assert.doesNotMatch(stmt, /'sem',/);
});

test('no Spanish/Italian/French/English/Turkish language_code appears anywhere in the seed INSERT', () => {
  const idx = forward.indexOf('INSERT INTO public.civitatis_activity_modality_map');
  const stmt = forward.slice(idx, forward.indexOf(';', idx) + 1);
  for (const code of ["'es'", "'it'", "'fr'", "'en'", "'tr'"]) {
    assert.doesNotMatch(stmt, new RegExp(code.replace(/'/g, "\\'")), `unexpected language_code ${code} in seed data`);
  }
});

test('the seed INSERT is idempotent via ON CONFLICT on the exact Phase A active-rule unique index', () => {
  const idx = forward.indexOf('INSERT INTO public.civitatis_activity_modality_map');
  const stmt = forward.slice(idx, forward.indexOf('DO NOTHING;', idx) + 'DO NOTHING;'.length);
  assert.match(stmt, /ON CONFLICT \(language_code, match_type, match_text_normalized\) WHERE is_active\s*\n\s*DO NOTHING;/);
});

// ── C. Forward migration never touches Phase A's original rows/schema ──

test('preflight verifies both Phase A original rows are present before touching anything', () => {
  const preflightIdx = forward.indexOf('DO $$');
  const preflight = forward.slice(preflightIdx, forward.indexOf('END $$;', preflightIdx));
  assert.match(preflight, /match_text = 'com almoço'/);
  assert.match(preflight, /match_text = 'sem almoço'/);
});

test('postflight re-verifies both Phase A original rows are still present and unaltered', () => {
  const postflightIdx = forward.lastIndexOf('DO $$');
  const postflight = forward.slice(postflightIdx);
  assert.match(postflight, /match_text = 'com almoço'/);
  assert.match(postflight, /match_text = 'sem almoço'/);
  assert.match(postflight, /no longer present\/active/);
});

test('forward migration contains no ALTER TABLE, no CREATE TABLE, no DROP — INSERT only (plus read-only checks)', () => {
  const codeLines = forward.split('\n').filter((l) => !l.trim().startsWith('--'));
  const code = codeLines.join('\n');
  assert.doesNotMatch(code, /ALTER TABLE/);
  assert.doesNotMatch(code, /CREATE TABLE/);
  assert.doesNotMatch(code, /DROP TABLE/);
  assert.doesNotMatch(code, /CREATE OR REPLACE FUNCTION/);
  assert.match(code, /INSERT INTO public\.civitatis_activity_modality_map/);
});

test('forward migration never references reservations, tour_preparation_rules, or reservation_preparations in any executable statement', () => {
  const codeLines = forward.split('\n').filter((l) => !l.trim().startsWith('--'));
  const code = codeLines.join('\n');
  // reservations IS legitimately read inside the (unrelated) RPC
  // signature checks' own table aliases — scope this to statements that
  // actually target these tables for a write.
  assert.doesNotMatch(code, /INSERT INTO public\.reservations/);
  assert.doesNotMatch(code, /UPDATE public\.reservations/);
  assert.doesNotMatch(code, /ALTER TABLE public\.reservations/);
  assert.doesNotMatch(code, /public\.tour_preparation_rules/);
  assert.doesNotMatch(code, /public\.reservation_preparations/);
});

test('forward migration never references any WhatsApp Phase 1.2 object in executable code', () => {
  const codeLines = forward.split('\n').filter((l) => !l.trim().startsWith('--'));
  const code = codeLines.join('\n');
  for (const name of ['whatsapp_messages', 'whatsapp_destinations', 'whatsapp_destination_recipients', 'claim_whatsapp_outbox_batch', 'review_url']) {
    assert.doesNotMatch(code, new RegExp(name));
  }
});

test('forward migration never CREATEs/ALTERs/DROPs either Civitatis RPC — only read-only signature checks, twice each', () => {
  for (const fn of ['ingest_civitatis_booking', 'cancel_civitatis_booking']) {
    assert.doesNotMatch(forward, new RegExp(`CREATE (OR REPLACE )?FUNCTION public\\.${fn}`));
    assert.doesNotMatch(forward, new RegExp(`DROP FUNCTION[^;]*${fn}`));
    assert.doesNotMatch(forward, new RegExp(`ALTER FUNCTION[^;]*${fn}`));
    const mentions = [...forward.matchAll(new RegExp(fn, 'g'))];
    assert.ok(mentions.length >= 2, `expected at least a preflight AND postflight reference to ${fn}`);
  }
});

// ── D. Rollback: scope limited to the two B1 rows only ──────────────────

test('rollback DELETEs by the exact (language_code, match_type, match_text) tuple of both B1 rows only', () => {
  const idx = rollback.indexOf('DELETE FROM public.civitatis_activity_modality_map');
  assert.ok(idx > -1);
  const stmt = rollback.slice(idx, rollback.indexOf(';', idx) + 1);
  assert.match(stmt, /language_code = 'pt' AND match_type = 'suffix_exact'/);
  assert.match(stmt, /'Visita guiada pela Istambul imprescindível - Tour com'/);
  assert.match(stmt, /'Visita guiada pela Istambul imprescindível - Tour sem'/);
  assert.doesNotMatch(stmt, /'com almoço'/);
  assert.doesNotMatch(stmt, /'sem almoço'/);
});

test('rollback contains exactly one DELETE statement, no DROP TABLE, no other DML', () => {
  const codeLines = rollback.split('\n').filter((l) => !l.trim().startsWith('--'));
  const code = codeLines.join('\n');
  const deletes = [...code.matchAll(/\bDELETE\s+FROM\b/g)];
  assert.equal(deletes.length, 1, `expected exactly 1 DELETE statement, found ${deletes.length}`);
  assert.doesNotMatch(code, /DROP TABLE/);
  assert.doesNotMatch(code, /\bUPDATE\s+public\./);
  assert.doesNotMatch(code, /\bINSERT\s+INTO\b/);
  assert.doesNotMatch(code, /\bTRUNCATE\b/);
});

test('rollback postflight re-verifies Phase A original rows are still present and unaltered after the DELETE', () => {
  const postflightIdx = rollback.lastIndexOf('DO $$');
  const postflight = rollback.slice(postflightIdx);
  assert.match(postflight, /match_text = 'com almoço'/);
  assert.match(postflight, /match_text = 'sem almoço'/);
  assert.match(postflight, /was removed or altered — out of scope, must never happen/);
});

test('rollback postflight re-verifies both B1 rows are gone and the table itself still exists', () => {
  const postflightIdx = rollback.lastIndexOf('DO $$');
  const postflight = rollback.slice(postflightIdx);
  assert.match(postflight, /at least one B1 row still exists/);
  assert.match(postflight, /table_name='civitatis_activity_modality_map'/);
});

test('rollback never touches reservations, tour_preparation_rules, reservation_preparations, or any WhatsApp object', () => {
  const codeLines = rollback.split('\n').filter((l) => !l.trim().startsWith('--'));
  const code = codeLines.join('\n');
  assert.doesNotMatch(code, /public\.tour_preparation_rules/);
  assert.doesNotMatch(code, /public\.reservation_preparations/);
  assert.doesNotMatch(code, /INSERT INTO public\.reservations/);
  assert.doesNotMatch(code, /UPDATE public\.reservations/);
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

// ── E. Cross-check against the actual Phase A file (not just assumed) ──

test('the two Phase A original match_text values this migration depends on actually exist verbatim in supabase_migration_tour_preparation_phase_a.sql', () => {
  assert.match(phaseA, /'pt', 'contains', 'com almoço', 'included',\s*TRUE/);
  assert.match(phaseA, /'pt', 'contains', 'sem almoço', 'not_included', TRUE/);
});

// ── F. No production SQL execution anywhere in this test file ──────────

test('this test file never opens a database connection or executes SQL — every assertion is a static text match', () => {
  const selfSource = fs.readFileSync(__filename, 'utf8');
  assert.doesNotMatch(selfSource, /require\(['"]pg['"]\)/);
  assert.doesNotMatch(selfSource, /require\(['"]@supabase\/supabase-js['"]\)/);
  assert.doesNotMatch(selfSource, /\.query\(/);
  assert.doesNotMatch(selfSource, /createClient\(/);
});
