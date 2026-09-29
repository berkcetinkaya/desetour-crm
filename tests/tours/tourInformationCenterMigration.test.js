'use strict';
/**
 * tests/tours/tourInformationCenterMigration.test.js
 * ─────────────────────────────────────────────────────────────────────────
 * Regression coverage for supabase_migration_tour_information_center.sql
 * and its rollback. NOT YET APPLIED to any database — explicitly withheld
 * pending manual approval, exactly like every prior V-series migration's
 * own test file. Every test here is a pure, static, never-executed text
 * assertion against the prepared .sql files. Nothing in this file connects
 * to a database or runs any SQL.
 * ─────────────────────────────────────────────────────────────────────────
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const FORWARD_PATH  = path.join(ROOT, 'supabase_migration_tour_information_center.sql');
const ROLLBACK_PATH = path.join(ROOT, 'supabase_migration_tour_information_center_ROLLBACK.sql');
const V10_PATH       = path.join(ROOT, 'supabase_migration_civitatis_write_v10_tour_auto_provisioning.sql');

const forward  = fs.readFileSync(FORWARD_PATH, 'utf8');
const rollback = fs.readFileSync(ROLLBACK_PATH, 'utf8');
const v10      = fs.readFileSync(V10_PATH, 'utf8');

const NEW_COLUMNS = [
  'meeting_instructions_tr', 'end_point_tr', 'accessibility_info_tr', 'pets_policy_tr',
  'booking_cutoff_text', 'free_cancellation_text', 'late_cancellation_text',
  'no_show_policy_text', 'other_conditions_tr', 'guide_notes_tr',
];

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

// ── B. New columns: all nullable, correctly named ───────────────────────

test('all ten new tours columns are added via ADD COLUMN IF NOT EXISTS ... TEXT with no NOT NULL/DEFAULT', () => {
  const alterIdx = forward.indexOf('ALTER TABLE public.tours\n  ADD COLUMN IF NOT EXISTS meeting_instructions_tr');
  assert.ok(alterIdx > -1, 'expected the single ALTER TABLE adding all ten columns');
  const stmt = forward.slice(alterIdx, forward.indexOf(';', alterIdx) + 1);
  for (const col of NEW_COLUMNS) {
    const re = new RegExp(`ADD COLUMN IF NOT EXISTS ${col}\\s+TEXT`);
    assert.match(stmt, re, `expected ${col} to be added as a plain nullable TEXT column`);
  }
  assert.doesNotMatch(stmt, /NOT NULL/);
  assert.doesNotMatch(stmt, /DEFAULT/);
});

test('none of the ten new columns ever appear inside a CHECK constraint or a trigger definition', () => {
  for (const col of NEW_COLUMNS) {
    assert.doesNotMatch(forward, new RegExp(`CHECK\\s*\\([^)]*\\b${col}\\b`), `${col} must never be CHECK-constrained`);
    assert.doesNotMatch(forward, new RegExp(`CREATE (OR REPLACE )?(FUNCTION|TRIGGER)[^;]*\\b${col}\\b`, 's'), `${col} must never be referenced by a trigger/function`);
  }
});

test('postflight explicitly re-verifies every new column is nullable (is_nullable check)', () => {
  const postflightIdx = forward.lastIndexOf('DO $$');
  const postflight = forward.slice(postflightIdx);
  assert.match(postflight, /is_nullable = 'NO'/);
  for (const col of NEW_COLUMNS) {
    assert.match(postflight, new RegExp(col));
  }
});

// ── C. summary_tr must NOT exist; description is reused; notes untouched

test('tours.summary_tr is never created anywhere in the forward migration', () => {
  assert.doesNotMatch(forward, /ADD COLUMN IF NOT EXISTS summary_tr/);
  assert.doesNotMatch(forward, /CREATE TABLE[^;]*summary_tr/);
  // The string legitimately appears in explanatory header prose ("NO
  // summary_tr column...") and in the postflight's own negative check —
  // neither is a statement that creates it.
});

test('postflight explicitly asserts tours.summary_tr does NOT exist', () => {
  assert.match(forward, /tours\.summary_tr exists but must not/);
});

test('tours.description is documented as reused (Genel Bakış) and is never ADDed as a new column', () => {
  assert.doesNotMatch(forward, /ADD COLUMN IF NOT EXISTS description\b/);
  assert.match(forward, /COMMENT ON COLUMN public\.tours\.description\s+IS 'Reused as the Turkish "Genel Bakış"/);
});

test('tours.notes is never written to, altered, or backfilled by the forward migration', () => {
  assert.doesNotMatch(forward, /ADD COLUMN IF NOT EXISTS notes\b/);
  assert.doesNotMatch(forward, /UPDATE public\.tours[\s\S]{0,200}\bnotes\b/);
  assert.doesNotMatch(forward, /ALTER TABLE public\.tours ALTER COLUMN notes/);
  // Only mentioned in prose (header/comments) explaining it is deliberately untouched.
  const noteMentions = forward.match(/\bnotes\b/g) || [];
  assert.ok(noteMentions.length > 0, 'sanity: notes should be mentioned in explanatory comments');
});

test('the "Deneme"/"Deneme dener" production test values are never assigned to any column — no live UPDATE/INSERT statement exists in the file at all', () => {
  // "Deneme dener" and the V10 INSERT statement are both legitimately
  // quoted in header prose (every line of which starts with "--") — that
  // is documentation, not a write. The real guarantee is structural:
  // scanning only non-comment lines, this migration contains no
  // UPDATE/INSERT statement whatsoever, so it is physically incapable of
  // writing "Deneme"/"Deneme dener" anywhere.
  const codeLines = forward.split('\n').filter(l => !l.trim().startsWith('--'));
  const code = codeLines.join('\n');
  assert.doesNotMatch(code, /=\s*'Deneme/);
  assert.doesNotMatch(code, /\bUPDATE\s+public\.tours\b/);
  assert.doesNotMatch(code, /\bINSERT\s+INTO\s+public\.tours\b/);
});

test('guide_notes_tr is documented as the one Dese Tour-internal, never-auto-populated field', () => {
  const idx = forward.indexOf("COMMENT ON COLUMN public.tours.guide_notes_tr");
  assert.ok(idx > -1);
  const stmt = forward.slice(idx, forward.indexOf(";\n", idx) + 1);
  assert.match(stmt, /DESE TOUR INTERNAL/);
  assert.match(stmt, /NEVER marketplace-derived/);
  assert.match(stmt, /NEVER auto-populated/);
});

// ── D. tour_itinerary_stops structure ───────────────────────────────────

test('tour_itinerary_stops is created with exactly the required columns', () => {
  const idx = forward.indexOf('CREATE TABLE IF NOT EXISTS public.tour_itinerary_stops');
  const end = forward.indexOf(');', idx) + 2;
  const stmt = forward.slice(idx, end);
  assert.match(stmt, /id\s+UUID\s+PRIMARY KEY DEFAULT gen_random_uuid\(\)/);
  assert.match(stmt, /tour_id\s+UUID\s+NOT NULL REFERENCES public\.tours\(id\) ON DELETE CASCADE/);
  assert.match(stmt, /stop_order\s+INTEGER\s+NOT NULL/);
  assert.match(stmt, /place_name\s+TEXT\s+NOT NULL/);
  assert.match(stmt, /description_tr\s+TEXT,/);
  assert.match(stmt, /operational_note\s+TEXT,/);
  assert.match(stmt, /approx_duration_text\s+TEXT,/);
  assert.match(stmt, /created_at\s+TIMESTAMPTZ\s+NOT NULL DEFAULT NOW\(\)/);
  assert.match(stmt, /updated_at\s+TIMESTAMPTZ\s+NOT NULL DEFAULT NOW\(\)/);
});

test('tour_itinerary_stops.tour_id is NOT NULL with ON DELETE CASCADE to tours', () => {
  assert.match(forward, /tour_id\s+UUID\s+NOT NULL REFERENCES public\.tours\(id\) ON DELETE CASCADE/);
});

test('UNIQUE (tour_id, stop_order) constraint is present', () => {
  assert.match(forward, /CONSTRAINT tour_itinerary_stops_tour_id_stop_order_key UNIQUE \(tour_id, stop_order\)/);
});

test('stop_order > 0 CHECK constraint is present (safe on a brand-new empty table)', () => {
  assert.match(forward, /CONSTRAINT tour_itinerary_stops_stop_order_positive CHECK \(stop_order > 0\)/);
});

test('postflight verifies the table, its NOT NULL tour_id, its CASCADE FK, and its UNIQUE constraint', () => {
  const postflightIdx = forward.lastIndexOf('DO $$');
  const postflight = forward.slice(postflightIdx);
  assert.match(postflight, /table_name='tour_itinerary_stops'/);
  assert.match(postflight, /tour_itinerary_stops\.tour_id NOT NULL/);
  assert.match(postflight, /tour_itinerary_stops\.tour_id FK ON DELETE CASCADE/);
  assert.match(postflight, /tour_itinerary_stops_tour_id_stop_order_key/);
});

// ── E. RLS: enabled, policies match the existing role model ────────────

test('RLS is enabled on tour_itinerary_stops', () => {
  assert.match(forward, /ALTER TABLE public\.tour_itinerary_stops ENABLE ROW LEVEL SECURITY;/);
});

test('postflight verifies RLS is actually enabled (relrowsecurity), not just that the ALTER statement exists in the file', () => {
  const postflightIdx = forward.lastIndexOf('DO $$');
  const postflight = forward.slice(postflightIdx);
  assert.match(postflight, /relrowsecurity = TRUE/);
});

test('admin and operations both get FOR ALL policies using is_admin()/is_operations() — same helper functions as every existing tours/tour_languages/tour_channels policy', () => {
  assert.match(forward, /CREATE POLICY "tour_itinerary_stops: admin full access"\s*\n\s*ON public\.tour_itinerary_stops FOR ALL TO authenticated\s*\n\s*USING\s+\( is_admin\(\) \)\s*\n\s*WITH CHECK \( is_admin\(\) \);/);
  assert.match(forward, /CREATE POLICY "tour_itinerary_stops: operations full access"\s*\n\s*ON public\.tour_itinerary_stops FOR ALL TO authenticated\s*\n\s*USING\s+\( is_operations\(\) \)\s*\n\s*WITH CHECK \( is_operations\(\) \);/);
});

test('sales gets SELECT-only, scoped to active tours — same shape as the existing "tours: sales read active" policy', () => {
  const idx = forward.indexOf('CREATE POLICY "tour_itinerary_stops: sales read active tour"');
  const stmt = forward.slice(idx, forward.indexOf(';', idx) + 1);
  assert.match(stmt, /FOR SELECT TO authenticated/);
  assert.match(stmt, /is_sales\(\)/);
  assert.match(stmt, /t\.is_active = TRUE/);
  assert.doesNotMatch(stmt, /WITH CHECK/, 'a read-only policy must never carry a WITH CHECK clause');
});

test('guide access is scoped EXACTLY to tours with an assigned reservation — never a blanket is_guide() read', () => {
  const idx = forward.indexOf('CREATE POLICY "tour_itinerary_stops: guide reads assigned tour"');
  const stmt = forward.slice(idx, forward.indexOf(';', idx) + 1);
  assert.match(stmt, /FOR SELECT TO authenticated/);
  assert.match(stmt, /is_guide\(\)/);
  assert.match(stmt, /public\.reservations r/);
  assert.match(stmt, /r\.tour_id\s*=\s*tour_itinerary_stops\.tour_id/);
  assert.match(stmt, /r\.assigned_to = auth\.uid\(\)/);
  assert.doesNotMatch(stmt, /WITH CHECK/);
  // The bare, unscoped shape ("USING ( is_guide() )" with nothing else) —
  // the exact broader precedent tour_languages' own guide policy uses —
  // must NOT appear for this new policy.
  assert.doesNotMatch(stmt, /USING \( is_guide\(\) \)\s*;/);
});

test('no guide WRITE policy exists on tour_itinerary_stops (guides are read-only)', () => {
  assert.doesNotMatch(forward, /FOR (ALL|INSERT|UPDATE|DELETE)[^;]*is_guide\(\)/s);
});

test('postflight verifies all four expected policy names exist', () => {
  const postflightIdx = forward.lastIndexOf('DO $$');
  const postflight = forward.slice(postflightIdx);
  assert.match(postflight, /tour_itinerary_stops: admin full access/);
  assert.match(postflight, /tour_itinerary_stops: operations full access/);
  assert.match(postflight, /tour_itinerary_stops: sales read active tour/);
  assert.match(postflight, /tour_itinerary_stops: guide reads assigned tour/);
});

// ── F. Never touches Civitatis ingestion / V10-V13.1 / tour_channels /
// tour_languages ──────────────────────────────────────────────────────

test('the forward migration never CREATEs, REPLACEs, ALTERs, or DROPs ingest_civitatis_booking — only read-only SELECT signature checks', () => {
  assert.doesNotMatch(forward, /CREATE (OR REPLACE )?FUNCTION public\.ingest_civitatis_booking/);
  assert.doesNotMatch(forward, /DROP FUNCTION[^;]*ingest_civitatis_booking/);
  assert.doesNotMatch(forward, /ALTER FUNCTION[^;]*ingest_civitatis_booking/);
  // Every reference must be inside a read-only preflight/postflight SELECT.
  const mentions = [...forward.matchAll(/ingest_civitatis_booking/g)];
  assert.ok(mentions.length >= 2, 'expected at least a preflight AND postflight reference');
});

test('the forward migration verifies (never modifies) the exact same 26-parameter oidvector signature V10/V12/V13/V13.1 already use', () => {
  const sigPattern = /'text', 'text', 'timestamptz', 'text', 'text', 'text', 'uuid', 'text', 'uuid', 'text',\s*\n\s*'date', 'time', 'integer', 'integer', 'numeric', 'text', 'numeric', 'text', 'uuid',\s*\n\s*'text', 'text', 'text', 'jsonb', 'boolean', 'text', 'text'/;
  const matches = forward.match(new RegExp(sigPattern.source, 'g'));
  assert.ok(matches && matches.length === 2, 'expected the signature check to appear exactly twice (preflight + postflight)');
});

test('the forward migration never touches public.tour_channels', () => {
  assert.doesNotMatch(forward, /ALTER TABLE public\.tour_channels/);
  assert.doesNotMatch(forward, /CREATE TABLE[^;]*tour_channels/);
  assert.doesNotMatch(forward, /DROP TABLE[^;]*tour_channels/);
  assert.doesNotMatch(forward, /INSERT INTO public\.tour_channels/);
  assert.doesNotMatch(forward, /UPDATE public\.tour_channels/);
  // Only read-only existence/column checks in the preflight are allowed.
  assert.match(forward, /table_name = 'tour_channels'/);
});

test('the forward migration never touches public.tour_languages', () => {
  assert.doesNotMatch(forward, /ALTER TABLE public\.tour_languages/);
  assert.doesNotMatch(forward, /CREATE TABLE[^;]*tour_languages/);
  assert.doesNotMatch(forward, /DROP TABLE[^;]*tour_languages/);
  assert.doesNotMatch(forward, /INSERT INTO public\.tour_languages/);
  assert.doesNotMatch(forward, /UPDATE public\.tour_languages/);
  assert.match(forward, /table_name = 'tour_languages'/);
});

test('the forward migration never touches reservations, customers, guests, calendar-related tables, reviews, or guides tables', () => {
  for (const t of ['reservations', 'customers', 'reservation_guests', 'guide_payments', 'guides', 'reservation_reviews', 'activity_log_reads']) {
    assert.doesNotMatch(forward, new RegExp(`ALTER TABLE public\\.${t}\\b`));
    assert.doesNotMatch(forward, new RegExp(`INSERT INTO public\\.${t}\\b`));
    assert.doesNotMatch(forward, new RegExp(`UPDATE public\\.${t}\\b`));
  }
  // reservations IS referenced, but only inside a read-only EXISTS
  // subquery for the guide-scoped RLS policy.
  assert.match(forward, /EXISTS\s*\(\s*\n\s*SELECT 1\s*\n\s*FROM public\.reservations r/);
});

test('the forward migration never references activity_logs (no logging behavior added in this schema-only phase)', () => {
  assert.doesNotMatch(forward, /activity_logs/);
});

// ── G. Cross-check against V10's actual committed INSERT statement ─────

test('V10 auto-provisioning INSERT uses an explicit 5-column list that is unaffected by any new nullable tours column', () => {
  const idx = v10.indexOf('INSERT INTO public.tours (name, category, status, base_price, currency)');
  assert.ok(idx > -1, 'expected to find the exact auto-provisioning INSERT in the committed V10 file');
  const stmt = v10.slice(idx, v10.indexOf(';', idx) + 1);
  // None of the ten new columns are named in this INSERT — Postgres fills
  // them with their default (NULL, since none of them has a DEFAULT
  // clause), so this statement's validity is structurally unaffected by
  // this migration.
  for (const col of NEW_COLUMNS) {
    assert.doesNotMatch(stmt, new RegExp(`\\b${col}\\b`));
  }
  assert.match(stmt, /VALUES \(p_civitatis_internal_code, 'other', 'draft', 0, 'EUR'\)/);
});

test('none of the ten new columns has a DEFAULT clause (confirms V10\'s INSERT fills them with NULL, not a fabricated value)', () => {
  const alterIdx = forward.indexOf('ALTER TABLE public.tours\n  ADD COLUMN IF NOT EXISTS meeting_instructions_tr');
  const stmt = forward.slice(alterIdx, forward.indexOf(';', alterIdx) + 1);
  assert.doesNotMatch(stmt, /DEFAULT/);
});

// ── H. Rollback: scope is limited to newly introduced objects only ─────

test('rollback drops tour_itinerary_stops', () => {
  assert.match(rollback, /DROP TABLE IF EXISTS public\.tour_itinerary_stops;/);
});

test('rollback drops EXACTLY the ten new tours columns, via DROP COLUMN IF EXISTS, and no others', () => {
  const idx = rollback.indexOf('ALTER TABLE public.tours\n  DROP COLUMN IF EXISTS meeting_instructions_tr');
  assert.ok(idx > -1);
  const stmt = rollback.slice(idx, rollback.indexOf(';', idx) + 1);
  const dropped = [...stmt.matchAll(/DROP COLUMN IF EXISTS (\w+)/g)].map(m => m[1]);
  assert.deepEqual(dropped.sort(), [...NEW_COLUMNS].sort());
});

test('rollback never drops description, notes, duration_text, meeting_point, included_items, or excluded_items', () => {
  // Scoped to the actual ALTER TABLE ... DROP COLUMN statement only —
  // the header prose legitimately mentions these column names (e.g.
  // "guide notes" in a safety warning sentence) without dropping them.
  const alterIdx = rollback.indexOf('ALTER TABLE public.tours\n  DROP COLUMN IF EXISTS meeting_instructions_tr');
  assert.ok(alterIdx > -1);
  const stmt = rollback.slice(alterIdx, rollback.indexOf(';', alterIdx) + 1);
  for (const col of ['description', 'notes', 'duration_text', 'meeting_point', 'included_items', 'excluded_items']) {
    assert.doesNotMatch(stmt, new RegExp(`DROP COLUMN IF EXISTS ${col}\\b`));
  }
});

test('rollback never touches tour_languages or tour_channels', () => {
  assert.doesNotMatch(rollback, /DROP TABLE[^;]*tour_languages/);
  assert.doesNotMatch(rollback, /DROP TABLE[^;]*tour_channels/);
  assert.doesNotMatch(rollback, /ALTER TABLE public\.tour_languages/);
  assert.doesNotMatch(rollback, /ALTER TABLE public\.tour_channels/);
});

test('rollback never touches ingest_civitatis_booking or any other RPC (no CREATE/ALTER/DROP FUNCTION statement of any kind)', () => {
  // ingest_civitatis_booking is legitimately named once in the header's
  // "THIS ROLLBACK DOES NOT TOUCH" prose list — documentation, not a
  // statement. The real, structural guarantee is that this file contains
  // no function-modifying statement at all.
  assert.doesNotMatch(rollback, /CREATE (OR REPLACE )?FUNCTION/);
  assert.doesNotMatch(rollback, /DROP FUNCTION/);
  assert.doesNotMatch(rollback, /ALTER FUNCTION/);
});

test('rollback postflight explicitly re-confirms the out-of-scope columns/tables are still present after the rollback runs', () => {
  const postflightIdx = rollback.lastIndexOf('DO $$');
  const postflight = rollback.slice(postflightIdx);
  for (const col of ['description', 'notes', 'duration_text', 'meeting_point', 'included_items', 'excluded_items']) {
    assert.match(postflight, new RegExp(`column_name='${col}'`));
  }
  assert.match(postflight, /table_name='tour_languages'/);
  assert.match(postflight, /table_name='tour_channels'/);
});

test('rollback postflight explicitly re-confirms every one of the ten new columns and the new table are actually gone', () => {
  const postflightIdx = rollback.lastIndexOf('DO $$');
  const postflight = rollback.slice(postflightIdx);
  assert.match(postflight, /table_name='tour_itinerary_stops'/);
  for (const col of NEW_COLUMNS) {
    assert.match(postflight, new RegExp(`column_name='${col}'`));
  }
});

test('rollback contains no destructive operation beyond the two explicitly scoped DROPs (no DELETE/UPDATE/TRUNCATE anywhere)', () => {
  const liveDml = rollback.split('\n').filter(line => {
    const trimmed = line.trim();
    if (trimmed.startsWith('--') || trimmed === '') return false;
    return /\bDELETE\s+FROM\b|\bUPDATE\s+public\.|\bTRUNCATE\b|\bINSERT\s+INTO\b/i.test(trimmed);
  });
  assert.deepEqual(liveDml, []);
});
