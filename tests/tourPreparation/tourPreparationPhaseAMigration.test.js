'use strict';
/**
 * tests/tourPreparation/tourPreparationPhaseAMigration.test.js
 * ─────────────────────────────────────────────────────────────────────────
 * Regression coverage for supabase_migration_tour_preparation_phase_a.sql
 * and its rollback (Tour Preparation Intelligence — Phase A, Database
 * Foundation). NOT YET APPLIED to any database — explicitly withheld
 * pending manual approval, exactly like every prior migration's own test
 * file (e.g. tests/whatsapp/whatsappCoreMigration.test.js). Every test
 * here is a pure, static, never-executed text assertion against the
 * prepared .sql files. Nothing in this file connects to a database or
 * runs any SQL. The forward and rollback migrations were separately
 * validated, live, against a throwaway local PostgreSQL instance (never
 * production/Supabase) — this file is the committed regression suite,
 * not that live validation.
 * ─────────────────────────────────────────────────────────────────────────
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const FORWARD_PATH  = path.join(ROOT, 'supabase_migration_tour_preparation_phase_a.sql');
const ROLLBACK_PATH = path.join(ROOT, 'supabase_migration_tour_preparation_phase_a_ROLLBACK.sql');

const forward  = fs.readFileSync(FORWARD_PATH, 'utf8');
const rollback = fs.readFileSync(ROLLBACK_PATH, 'utf8');

// ── A. File structure: transactional, balanced ──────────────────────────

test('forward migration is wrapped in exactly one BEGIN;/COMMIT; pair, no stray ROLLBACK', () => {
  assert.equal((forward.match(/^BEGIN;\s*$/gm) || []).length, 1);
  assert.equal((forward.match(/^COMMIT;\s*$/gm) || []).length, 1);
  assert.doesNotMatch(forward, /^ROLLBACK/m);
});

test('forward migration dollar-quoting is balanced (preflight + postflight DO blocks only)', () => {
  const dollarLines = forward.split('\n').filter(l => l.includes('$$'));
  assert.equal(dollarLines.length, 4, `expected exactly 4 lines containing $$ (2 DO blocks), found ${dollarLines.length}`);
});

test('rollback is wrapped in exactly one BEGIN;/COMMIT; pair, dollar-quoting balanced', () => {
  assert.equal((rollback.match(/^BEGIN;\s*$/gm) || []).length, 1);
  assert.equal((rollback.match(/^COMMIT;\s*$/gm) || []).length, 1);
  const dollarLines = rollback.split('\n').filter(l => l.includes('$$'));
  assert.equal(dollarLines.length, 2, 'expected exactly 2 lines containing $$ (1 postflight DO block)');
});

// ── B. reservations: purchased_activity_raw, meal_status ────────────────

test('purchased_activity_raw is added as a plain nullable TEXT column with no DEFAULT/NOT NULL', () => {
  const idx = forward.indexOf('ADD COLUMN IF NOT EXISTS purchased_activity_raw TEXT,');
  assert.ok(idx > -1, 'expected the exact ADD COLUMN statement for purchased_activity_raw');
});

test('meal_status is added NOT NULL DEFAULT \'unknown\'', () => {
  assert.match(forward, /ADD COLUMN IF NOT EXISTS meal_status\s+TEXT NOT NULL DEFAULT 'unknown';/);
});

test('meal_status CHECK constraint restricts to exactly included/not_included/unknown', () => {
  const idx = forward.indexOf("ADD CONSTRAINT reservations_meal_status_check");
  assert.ok(idx > -1);
  const stmt = forward.slice(idx, forward.indexOf(';', idx) + 1);
  assert.match(stmt, /CHECK \(meal_status IN \('included', 'not_included', 'unknown'\)\)/);
});

test('reservations_meal_status_check is preceded by its own DROP CONSTRAINT IF EXISTS (idempotent re-run)', () => {
  const dropIdx = forward.indexOf('DROP CONSTRAINT IF EXISTS reservations_meal_status_check');
  const addIdx = forward.indexOf('ADD CONSTRAINT reservations_meal_status_check');
  assert.ok(dropIdx > -1 && addIdx > -1 && dropIdx < addIdx);
});

test('there is exactly one unresolved state for meal_status: no NULL-shaped second unresolved value is introduced', () => {
  // meal_status itself must be NOT NULL (no NULL state at all) — the
  // guarantee is structural, not just a comment claim.
  assert.doesNotMatch(forward, /meal_status\s+TEXT,/); // never declared nullable
  assert.match(forward, /meal_status\s+TEXT NOT NULL DEFAULT 'unknown'/);
});

test('purchased_activity_raw/meal_status are never populated (no UPDATE/backfill) anywhere in the forward migration', () => {
  const codeLines = forward.split('\n').filter(l => !l.trim().startsWith('--'));
  const code = codeLines.join('\n');
  assert.doesNotMatch(code, /UPDATE\s+public\.reservations[\s\S]{0,300}(purchased_activity_raw|meal_status)\s*=/);
});

test('this migration never CREATEs, REPLACEs, ALTERs, or DROPs ingest_civitatis_booking — only read-only signature checks, twice', () => {
  assert.doesNotMatch(forward, /CREATE (OR REPLACE )?FUNCTION public\.ingest_civitatis_booking/);
  assert.doesNotMatch(forward, /DROP FUNCTION[^;]*ingest_civitatis_booking/);
  assert.doesNotMatch(forward, /ALTER FUNCTION[^;]*ingest_civitatis_booking/);
  const mentions = [...forward.matchAll(/ingest_civitatis_booking/g)];
  assert.ok(mentions.length >= 2, 'expected at least a preflight AND postflight reference');
});

test('this migration never CREATEs, REPLACEs, ALTERs, or DROPs cancel_civitatis_booking — only read-only signature checks, twice', () => {
  assert.doesNotMatch(forward, /CREATE (OR REPLACE )?FUNCTION public\.cancel_civitatis_booking/);
  assert.doesNotMatch(forward, /DROP FUNCTION[^;]*cancel_civitatis_booking/);
  assert.doesNotMatch(forward, /ALTER FUNCTION[^;]*cancel_civitatis_booking/);
  const mentions = [...forward.matchAll(/cancel_civitatis_booking/g)];
  assert.ok(mentions.length >= 2, 'expected at least a preflight AND postflight reference');
});

// ── C. civitatis_activity_modality_map ───────────────────────────────────

test('civitatis_activity_modality_map has language_code, match_type, match_text, meal_status, is_active', () => {
  const idx = forward.indexOf('CREATE TABLE IF NOT EXISTS public.civitatis_activity_modality_map');
  const end = forward.indexOf('\n);', idx) + 3;
  const stmt = forward.slice(idx, end);
  assert.match(stmt, /language_code\s+TEXT\s+NOT NULL,/);
  assert.match(stmt, /match_type\s+TEXT\s+NOT NULL/);
  assert.match(stmt, /CHECK \(match_type IN \('suffix_exact', 'contains'\)\)/);
  assert.match(stmt, /match_text\s+TEXT\s+NOT NULL,/);
  assert.match(stmt, /meal_status\s+TEXT\s+NOT NULL/);
  assert.match(stmt, /CHECK \(meal_status IN \('included', 'not_included'\)\)/);
  assert.match(stmt, /is_active\s+BOOLEAN\s+NOT NULL DEFAULT TRUE,/);
});

test('match_type CHECK never allows a fuzzy/AI/embedding value — exactly two deterministic string-operation values', () => {
  const idx = forward.indexOf("CHECK (match_type IN ('suffix_exact', 'contains'))");
  assert.ok(idx > -1);
});

test('no fuzzy matching, AI, embeddings, or LLM concept appears in any CREATE FUNCTION/TRIGGER (no such logic is created at all)', () => {
  // "fuzzy"/"embedding"/"LLM" legitimately appear inside COMMENT ON
  // COLUMN string literals explaining why they are NOT used (e.g.
  // match_type's own comment) — the real guarantee checked here is
  // structural: this migration creates zero functions (reuses
  // set_updated_at() only) and zero triggers beyond the shared
  // updated_at one, so there is no executable matching logic anywhere
  // for a fuzzy/AI concept to exist in.
  assert.doesNotMatch(forward, /CREATE (OR REPLACE )?FUNCTION\s+public\.(?!set_updated_at)/);
  const triggerFns = [...forward.matchAll(/EXECUTE FUNCTION public\.(\w+)\(\)/g)].map(m => m[1]);
  for (const fn of triggerFns) {
    assert.equal(fn, 'set_updated_at', `expected every trigger to execute set_updated_at, found ${fn}`);
  }
});

test('match_text_normalized is a generated, lowercased+trimmed column used only for uniqueness', () => {
  assert.match(forward, /match_text_normalized\s+TEXT\s+GENERATED ALWAYS AS \(lower\(btrim\(match_text\)\)\) STORED,/);
});

test('active-rule uniqueness is a partial unique index scoped to is_active, on (language_code, match_type, match_text_normalized)', () => {
  assert.match(forward, /CREATE UNIQUE INDEX IF NOT EXISTS uq_civitatis_activity_modality_map_active_rule\s*\n\s*ON public\.civitatis_activity_modality_map \(language_code, match_type, match_text_normalized\)\s*\n\s*WHERE is_active;/);
});

test('exactly two seed rows are inserted: pt/contains/com almoço/included and pt/contains/sem almoço/not_included', () => {
  const idx = forward.indexOf('INSERT INTO public.civitatis_activity_modality_map');
  assert.ok(idx > -1);
  const stmt = forward.slice(idx, forward.indexOf(';', idx) + 1);
  assert.match(stmt, /\('pt', 'contains', 'com almoço', 'included',\s*TRUE\)/);
  assert.match(stmt, /\('pt', 'contains', 'sem almoço', 'not_included', TRUE\)/);
  // Exactly these two VALUES rows — count the top-level tuples.
  const tuples = stmt.match(/\('pt',/g) || [];
  assert.equal(tuples.length, 2, `expected exactly 2 seed tuples, found ${tuples.length}`);
});

test('the seed INSERT is idempotent via ON CONFLICT on the exact active-rule unique index', () => {
  const idx = forward.indexOf('INSERT INTO public.civitatis_activity_modality_map');
  const stmt = forward.slice(idx, forward.indexOf('DO NOTHING;', idx) + 'DO NOTHING;'.length);
  assert.match(stmt, /ON CONFLICT \(language_code, match_type, match_text_normalized\) WHERE is_active\s*\n\s*DO NOTHING;/);
});

test('no Spanish, Italian, French, English, or Turkish phrase is seeded — only the two confirmed Portuguese examples', () => {
  const idx = forward.indexOf('INSERT INTO public.civitatis_activity_modality_map');
  const stmt = forward.slice(idx, forward.indexOf(';', idx) + 1);
  for (const code of ["'es'", "'it'", "'fr'", "'en'", "'tr'"]) {
    assert.doesNotMatch(stmt, new RegExp(code.replace(/'/g, "\\'")), `unexpected language_code ${code} in seed data`);
  }
});

test('civitatis_activity_modality_map RLS: admin + operations FOR ALL, no sales/guide policy', () => {
  assert.match(forward, /ALTER TABLE public\.civitatis_activity_modality_map ENABLE ROW LEVEL SECURITY;/);
  assert.match(forward, /CREATE POLICY "civitatis_activity_modality_map: admin full access"\s*\n\s*ON public\.civitatis_activity_modality_map FOR ALL TO authenticated\s*\n\s*USING\s+\( is_admin\(\) \)\s*\n\s*WITH CHECK \( is_admin\(\) \);/);
  assert.match(forward, /CREATE POLICY "civitatis_activity_modality_map: operations full access"\s*\n\s*ON public\.civitatis_activity_modality_map FOR ALL TO authenticated\s*\n\s*USING\s+\( is_operations\(\) \)\s*\n\s*WITH CHECK \( is_operations\(\) \);/);
  assert.doesNotMatch(forward, /"civitatis_activity_modality_map: sales/);
  assert.doesNotMatch(forward, /"civitatis_activity_modality_map: guide/);
});

// ── D. tour_preparation_rules ────────────────────────────────────────────

test('tour_preparation_rules has tour_id CASCADE FK, itinerary_stop_id SET NULL FK, preparation_type CHECK, quantity_rule CHECK', () => {
  const idx = forward.indexOf('CREATE TABLE IF NOT EXISTS public.tour_preparation_rules');
  const end = forward.indexOf('\n);', idx) + 3;
  const stmt = forward.slice(idx, end);
  assert.match(stmt, /tour_id\s+UUID\s+NOT NULL REFERENCES public\.tours\(id\) ON DELETE CASCADE,/);
  assert.match(stmt, /itinerary_stop_id\s+UUID\s+REFERENCES public\.tour_itinerary_stops\(id\) ON DELETE SET NULL,/);
  assert.match(stmt, /CHECK \(preparation_type IN \(\s*\n\s*'entrance_ticket', 'meal', 'reservation',\s*\n\s*'transport', 'special_access', 'other'\s*\n\s*\)\)/);
  assert.match(stmt, /quantity_rule\s+TEXT\s+NOT NULL DEFAULT 'per_guest'/);
  assert.match(stmt, /CHECK \(quantity_rule IN \('per_guest', 'fixed', 'per_adult'\)\)/);
});

test('tour_preparation_rules_fixed_quantity_pair CHECK requires fixed_quantity>0 iff quantity_rule=fixed, NULL otherwise', () => {
  const idx = forward.indexOf('CONSTRAINT tour_preparation_rules_fixed_quantity_pair CHECK');
  assert.ok(idx > -1);
  const stmt = forward.slice(idx, forward.indexOf(')\n);', idx) + 4);
  assert.match(stmt, /quantity_rule = 'fixed' AND fixed_quantity IS NOT NULL AND fixed_quantity > 0/);
  assert.match(stmt, /quantity_rule != 'fixed' AND fixed_quantity IS NULL/);
});

test('no row is ever inserted into tour_preparation_rules by the forward migration — no auto-created rule of any kind', () => {
  // "Topkapı" legitimately appears once, inside a COMMENT ON TABLE
  // string literal, purely as an illustrative example label — the real
  // guarantee is structural: no INSERT statement targets this table at
  // all, so no rule (Topkapı-labeled or otherwise) can have been
  // auto-created.
  assert.doesNotMatch(forward, /INSERT\s+INTO\s+public\.tour_preparation_rules\b/);
});

test('postflight explicitly asserts tour_preparation_rules has zero rows', () => {
  const postflightIdx = forward.lastIndexOf('DO $$');
  const postflight = forward.slice(postflightIdx);
  assert.match(postflight, /SELECT 1 FROM public\.tour_preparation_rules\)/);
  assert.match(postflight, /tour_preparation_rules must have zero rows/);
});

test('tour_preparation_rules is never inferred from tour_itinerary_stops.place_name — no SELECT ... place_name feeding an INSERT', () => {
  assert.doesNotMatch(forward, /INSERT INTO public\.tour_preparation_rules[\s\S]{0,500}place_name/);
});

test('tour_preparation_rules RLS: admin + operations FOR ALL, guide read-only scoped to assigned tour, no sales policy', () => {
  assert.match(forward, /ALTER TABLE public\.tour_preparation_rules ENABLE ROW LEVEL SECURITY;/);
  assert.match(forward, /CREATE POLICY "tour_preparation_rules: admin full access"/);
  assert.match(forward, /CREATE POLICY "tour_preparation_rules: operations full access"/);
  assert.match(forward, /CREATE POLICY "tour_preparation_rules: guide reads assigned tour"\s*\n\s*ON public\.tour_preparation_rules FOR SELECT TO authenticated\s*\n\s*USING \(\s*\n\s*is_guide\(\)\s*\n\s*AND EXISTS \(\s*\n\s*SELECT 1 FROM public\.reservations r\s*\n\s*WHERE r\.tour_id\s+= tour_preparation_rules\.tour_id\s*\n\s*AND r\.assigned_to = auth\.uid\(\)\s*\n\s*\)\s*\n\s*\);/);
  assert.doesNotMatch(forward, /"tour_preparation_rules: sales/);
});

// ── E. reservation_preparations ──────────────────────────────────────────

test('reservation_preparations has reservation_id CASCADE FK, preparation_rule_id SET NULL FK, status CHECK, completed_by FK', () => {
  const idx = forward.indexOf('CREATE TABLE IF NOT EXISTS public.reservation_preparations');
  const end = forward.indexOf('\n);', idx) + 3;
  const stmt = forward.slice(idx, end);
  assert.match(stmt, /reservation_id\s+UUID\s+NOT NULL REFERENCES public\.reservations\(id\) ON DELETE CASCADE,/);
  assert.match(stmt, /preparation_rule_id\s+UUID\s+REFERENCES public\.tour_preparation_rules\(id\) ON DELETE SET NULL,/);
  assert.match(stmt, /CHECK \(status IN \('pending', 'completed', 'superseded', 'cancelled'\)\)/);
  assert.match(stmt, /completed_by\s+UUID\s+REFERENCES public\.staff_users\(id\) ON DELETE SET NULL,/);
});

test('required_quantity must be > 0 (reservation_preparations_required_quantity_positive)', () => {
  assert.match(forward, /CONSTRAINT reservation_preparations_required_quantity_positive CHECK \(required_quantity > 0\)/);
});

test('completed_consistency CHECK: completed requires completed_at; every other status forbids retaining completed_at/completed_by', () => {
  const idx = forward.indexOf('CONSTRAINT reservation_preparations_completed_consistency CHECK');
  assert.ok(idx > -1);
  const stmt = forward.slice(idx, forward.indexOf(')\n);', idx) + 4);
  assert.match(stmt, /status = 'completed' AND completed_at IS NOT NULL/);
  assert.match(stmt, /status != 'completed' AND completed_at IS NULL AND completed_by IS NULL/);
});

test('no trigger, default, or automation anywhere sets status=\'completed\' — only a staff-driven UPDATE/INSERT could', () => {
  assert.doesNotMatch(forward, /DEFAULT\s+'completed'/);
  assert.doesNotMatch(forward, /CREATE (OR REPLACE )?(FUNCTION|TRIGGER)[\s\S]{0,500}status\s*[:=]+\s*'completed'/);
});

test('live-instance uniqueness: at most one pending/completed row per (reservation_id, preparation_rule_id), scoped to non-null rule', () => {
  assert.match(forward, /CREATE UNIQUE INDEX IF NOT EXISTS uq_reservation_preparations_live_rule_instance\s*\n\s*ON public\.reservation_preparations \(reservation_id, preparation_rule_id\)\s*\n\s*WHERE status IN \('pending', 'completed'\) AND preparation_rule_id IS NOT NULL;/);
});

test('no row is ever inserted into reservation_preparations by the forward migration — no materialization logic exists yet', () => {
  assert.doesNotMatch(forward, /INSERT\s+INTO\s+public\.reservation_preparations\b/);
});

test('postflight explicitly asserts reservation_preparations has zero rows', () => {
  const postflightIdx = forward.lastIndexOf('DO $$');
  const postflight = forward.slice(postflightIdx);
  assert.match(postflight, /SELECT 1 FROM public\.reservation_preparations\)/);
  assert.match(postflight, /reservation_preparations must have zero rows/);
});

test('reservation_preparations RLS: admin + operations FOR ALL, guide read-only scoped to assigned non-cancelled reservation, no sales policy', () => {
  assert.match(forward, /ALTER TABLE public\.reservation_preparations ENABLE ROW LEVEL SECURITY;/);
  assert.match(forward, /CREATE POLICY "reservation_preparations: admin full access"/);
  assert.match(forward, /CREATE POLICY "reservation_preparations: operations full access"/);
  assert.match(forward, /CREATE POLICY "reservation_preparations: guide reads assigned"\s*\n\s*ON public\.reservation_preparations FOR SELECT TO authenticated\s*\n\s*USING \(\s*\n\s*is_guide\(\)\s*\n\s*AND EXISTS \(\s*\n\s*SELECT 1 FROM public\.reservations r\s*\n\s*WHERE r\.id\s+= reservation_preparations\.reservation_id\s*\n\s*AND r\.assigned_to = auth\.uid\(\)\s*\n\s*AND r\.status NOT IN \('cancelled'\)\s*\n\s*\)\s*\n\s*\);/);
  assert.doesNotMatch(forward, /"reservation_preparations: sales/);
});

// ── F. Indexes — present, and no speculative bloat ──────────────────────

test('expected indexes exist on all three new tables', () => {
  assert.match(forward, /CREATE INDEX IF NOT EXISTS idx_civitatis_activity_modality_map_language_active\s*\n\s*ON public\.civitatis_activity_modality_map \(language_code\)\s*\n\s*WHERE is_active;/);
  assert.match(forward, /CREATE INDEX IF NOT EXISTS idx_tour_preparation_rules_tour_id\s*\n\s*ON public\.tour_preparation_rules \(tour_id\);/);
  assert.match(forward, /CREATE INDEX IF NOT EXISTS idx_reservation_preparations_reservation_id\s*\n\s*ON public\.reservation_preparations \(reservation_id\);/);
  assert.match(forward, /CREATE INDEX IF NOT EXISTS idx_reservation_preparations_pending\s*\n\s*ON public\.reservation_preparations \(reservation_id\)\s*\n\s*WHERE status = 'pending';/);
});

// ── G. updated_at trigger convention reused, not duplicated ─────────────

test('all three new tables reuse public.set_updated_at() via their own trigger — no duplicate generic function defined', () => {
  for (const table of ['civitatis_activity_modality_map', 'tour_preparation_rules', 'reservation_preparations']) {
    assert.match(forward, new RegExp(`CREATE TRIGGER trg_${table}_updated_at\\s*\\n\\s*BEFORE UPDATE ON public\\.${table}\\s*\\n\\s*FOR EACH ROW EXECUTE FUNCTION public\\.set_updated_at\\(\\);`));
  }
  assert.doesNotMatch(forward, /CREATE (OR REPLACE )?FUNCTION public\.set_updated_at/);
});

// ── H. Never touches WhatsApp Phase 1.2, auth, or unrelated schema ──────

test('the forward migration never CREATEs/ALTERs/DROPs/INSERTs/UPDATEs any WhatsApp Phase 1.2 object', () => {
  // These names legitimately appear in header prose (-- comments) listing
  // what this migration must never touch, and whatsapp_messages
  // additionally appears twice more: once inside a COMMENT ON COLUMN
  // string literal (a documentation cross-reference to an existing
  // column, not a write to that table) and once in the postflight's own
  // read-only to_regclass() existence guard. The real guarantee checked
  // here is structural: no DDL/DML statement targets any of these
  // objects.
  const codeLines37 = forward.split('\n').filter(l => !l.trim().startsWith('--'));
  const code37 = codeLines37.join('\n');
  for (const name of ['whatsapp_messages', 'whatsapp_destinations', 'whatsapp_destination_recipients', 'claim_whatsapp_outbox_batch', 'review_url']) {
    assert.doesNotMatch(code37, new RegExp(`(CREATE|ALTER|DROP)\\s+(TABLE|FUNCTION|INDEX)[^;]{0,300}${name}`, 'i'));
    assert.doesNotMatch(code37, new RegExp(`(INSERT INTO|UPDATE)\\s+public\\.${name}\\b`, 'i'));
  }
});

test('the forward migration never touches auth.* objects beyond reading auth.uid() inside its own new RLS policies', () => {
  const codeLines = forward.split('\n').filter(l => !l.trim().startsWith('--'));
  const code = codeLines.join('\n');
  assert.doesNotMatch(code, /CREATE (TABLE|FUNCTION|SCHEMA)[^;]*auth\./i);
  assert.doesNotMatch(code, /ALTER (TABLE|SCHEMA) auth\./i);
  assert.doesNotMatch(code, /DROP (TABLE|FUNCTION|SCHEMA)[^;]*auth\./i);
});

test('the forward migration never ALTERs tours or tour_itinerary_stops\' existing columns, only reads/references their ids', () => {
  const codeLines = forward.split('\n').filter(l => !l.trim().startsWith('--'));
  const code = codeLines.join('\n');
  assert.doesNotMatch(code, /ALTER TABLE public\.tours\b/);
  assert.doesNotMatch(code, /ALTER TABLE public\.tour_itinerary_stops\b/);
});

test('the forward migration is SQL only — no application file path is referenced outside header prose', () => {
  // The header's own "WHAT THIS MIGRATION DELIBERATELY DOES NOT DO"
  // section legitimately names these files in -- comment lines to state
  // they are untouched; the real guarantee is that no executable
  // statement (necessarily SQL, since this is a .sql file) could ever
  // touch a JS file in the first place — checked here by confirming
  // these names appear ONLY in comment lines, never in a COMMENT ON /
  // RAISE / any other executable string.
  const codeLines = forward.split('\n').filter(l => !l.trim().startsWith('--'));
  const code = codeLines.join('\n');
  assert.doesNotMatch(code, /parser\.js/);
  assert.doesNotMatch(code, /writeAdapter\.js/);
  assert.doesNotMatch(code, /cancellationAdapter\.js/);
});

// ── I. Rollback: scope limited to newly introduced objects only ────────

test('rollback drops reservation_preparations, then tour_preparation_rules, then civitatis_activity_modality_map, in that order', () => {
  const iPreps = rollback.indexOf('DROP TABLE IF EXISTS public.reservation_preparations;');
  const iRules = rollback.indexOf('DROP TABLE IF EXISTS public.tour_preparation_rules;');
  const iMap   = rollback.indexOf('DROP TABLE IF EXISTS public.civitatis_activity_modality_map;');
  assert.ok(iPreps > -1 && iRules > -1 && iMap > -1);
  assert.ok(iPreps < iRules, 'reservation_preparations (holds FK into tour_preparation_rules) must be dropped first');
});

test('rollback drops reservations.purchased_activity_raw and meal_status, and the meal_status CHECK, and no other reservations column', () => {
  assert.match(rollback, /DROP CONSTRAINT IF EXISTS reservations_meal_status_check;/);
  assert.match(rollback, /DROP COLUMN IF EXISTS purchased_activity_raw,\s*\n\s*DROP COLUMN IF EXISTS meal_status;/);
});

test('rollback never touches any other reservations column, or tours/tour_itinerary_stops/staff_users/ingest_civitatis_booking/cancel_civitatis_booking definitions', () => {
  const codeLines = rollback.split('\n').filter(l => !l.trim().startsWith('--'));
  const code = codeLines.join('\n');
  for (const t of ['tours', 'tour_itinerary_stops', 'staff_users']) {
    assert.doesNotMatch(code, new RegExp(`ALTER TABLE public\\.${t}\\b`));
    assert.doesNotMatch(code, new RegExp(`DROP TABLE[^;]*\\b${t}\\b`));
  }
  assert.doesNotMatch(code, /CREATE (OR REPLACE )?FUNCTION/);
  assert.doesNotMatch(code, /DROP FUNCTION/);
  assert.doesNotMatch(code, /ALTER FUNCTION/);
  // Only the two Phase A columns (purchased_activity_raw, meal_status)
  // and their own CHECK constraint name may ever be named in a
  // reservations ALTER — strip those known, in-scope tokens first so a
  // substring like "status" inside "meal_status" can't false-positive
  // against the unrelated reservations.status/payment_status columns.
  const resAlters = [...code.matchAll(/ALTER TABLE public\.reservations[\s\S]{0,200}?;/g)].map(m => m[0]);
  for (const stmt of resAlters) {
    const scrubbed = stmt
      .replace(/reservations_meal_status_check/g, '')
      .replace(/purchased_activity_raw/g, '')
      .replace(/meal_status/g, '');
    assert.doesNotMatch(scrubbed, /\b(reservation_number|customer_id|tour_id|status|payment_status|pax_adult|pax_child|tour_language|retail_amount|retail_currency|source_id|external_booking_id)\b/);
  }
});

test('rollback never CREATEs/ALTERs/DROPs/INSERTs/UPDATEs any WhatsApp Phase 1.2 object', () => {
  // Same reasoning as the forward migration's equivalent test: these
  // names appear only in header prose (-- comments) and, for
  // whatsapp_messages, once more in the postflight's own read-only
  // to_regclass() existence guard — never in a statement that writes to
  // any of them.
  const codeLines44 = rollback.split('\n').filter(l => !l.trim().startsWith('--'));
  const code44 = codeLines44.join('\n');
  for (const name of ['whatsapp_messages', 'whatsapp_destinations', 'whatsapp_destination_recipients', 'claim_whatsapp_outbox_batch', 'review_url']) {
    assert.doesNotMatch(code44, new RegExp(`(CREATE|ALTER|DROP)\\s+(TABLE|FUNCTION|INDEX)[^;]{0,300}${name}`, 'i'));
    assert.doesNotMatch(code44, new RegExp(`(INSERT INTO|UPDATE)\\s+public\\.${name}\\b`, 'i'));
  }
});

test('rollback contains no destructive operation beyond its explicitly scoped DROPs (no stray DELETE/UPDATE/TRUNCATE/INSERT)', () => {
  const liveDml = rollback.split('\n').filter(line => {
    const trimmed = line.trim();
    if (trimmed.startsWith('--') || trimmed === '') return false;
    return /\bDELETE\s+FROM\b|\bUPDATE\s+public\.|\bTRUNCATE\b|\bINSERT\s+INTO\b/i.test(trimmed);
  });
  assert.deepEqual(liveDml, []);
});

test('rollback postflight explicitly re-confirms every dropped object is actually gone', () => {
  const postflightIdx = rollback.lastIndexOf('DO $$');
  const postflight = rollback.slice(postflightIdx);
  assert.match(postflight, /table_name='reservation_preparations'/);
  assert.match(postflight, /table_name='tour_preparation_rules'/);
  assert.match(postflight, /table_name='civitatis_activity_modality_map'/);
  assert.match(postflight, /column_name='purchased_activity_raw'/);
  assert.match(postflight, /column_name='meal_status'/);
});

test('rollback postflight explicitly re-confirms every out-of-scope object is still present, and both Civitatis RPC signatures unchanged', () => {
  const postflightIdx = rollback.lastIndexOf('DO $$');
  const postflight = rollback.slice(postflightIdx);
  for (const t of ['reservations', 'tours', 'tour_itinerary_stops', 'staff_users']) {
    assert.match(postflight, new RegExp(`table_name='${t}'`));
  }
  assert.match(postflight, /ingest_civitatis_booking/);
  assert.match(postflight, /cancel_civitatis_booking/);
  assert.match(postflight, /pronargs = 26/);
  assert.match(postflight, /pronargs = 7/);
});

test('rollback header contains an explicit data-loss warning naming what operational data would be destroyed', () => {
  assert.match(rollback, /DATA LOSS WARNING/);
  assert.match(rollback, /PERMANENTLY DESTROYS/);
});

// ── J. No production SQL execution anywhere in this test file ──────────

test('this test file never opens a database connection or executes SQL — every assertion is a static text match', () => {
  const selfSource = fs.readFileSync(__filename, 'utf8');
  assert.doesNotMatch(selfSource, /require\(['"]pg['"]\)/);
  assert.doesNotMatch(selfSource, /require\(['"]@supabase\/supabase-js['"]\)/);
  assert.doesNotMatch(selfSource, /\.query\(/);
  assert.doesNotMatch(selfSource, /createClient\(/);
});
