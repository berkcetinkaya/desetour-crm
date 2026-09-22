-- ============================================================
-- DESE TOUR OPERATIONS CENTER
-- Migration: Reference Number Allocation — Guarantee the ON CONFLICT
--            Target's Backing Unique Index Actually Exists
-- ============================================================
-- File:    supabase_migration_ref_number_counters_v2_unique_constraint_guard.sql
-- Depends: supabase_schema.sql (public.next_ref_number(...) already
--          applied), supabase_migration_ref_number_counters.sql
--          (ALREADY APPLIED TO PRODUCTION — per operator confirmation —
--          creates public.ref_number_counters and rewrites
--          next_ref_number(...) to allocate via
--          INSERT ... ON CONFLICT (prefix, table_name, year) DO UPDATE).
--
-- Version: V2 of the ref_number_counters migration lineage — NOT a V9 of
--          the separate public.ingest_civitatis_booking(...) migration
--          chain (V6/V7/V8). This file touches NEITHER
--          ingest_civitatis_booking's function body NOR its REVOKE/GRANT
--          statements AT ALL — every guarantee V6/V7/V8 established
--          (Gmail/booking advisory locks, retry state machine, event
--          matrix, stale handling, passenger-completeness, the V8
--          p_passengers type guard, customer-matching safety, etc.) is
--          completely untouched by construction, since this file never
--          references that function. The only thing this migration
--          changes is a table this OTHER function
--          (public.next_ref_number, called from ingest_civitatis_
--          booking's CREATE branch, and from five other call sites
--          across the manual JS creation paths for leads/quotes/
--          payments/guide_payments) depends on.
--
-- WHY THIS MIGRATION EXISTS
-- ─────────────────────────────────────────────────────────────
-- The second real controlled write smoke test for booking A41629692
-- (gmail_message_id 1a0aedc69a2ef905, event_type new_booking) got past
-- the V8 p_passengers fix, then failed with:
--   "there is no unique or exclusion constraint matching the ON
--   CONFLICT specification"
-- ingestion_id fb7bd246-ab9d-492d-870c-40108d19e54f WAS returned (a
-- normal application-level 'failed' result, not a transport-level RPC
-- error), proving Step 1's email_ingestions UPSERT succeeded and the
-- exception was caught by ingest_civitatis_booking's own nested
-- EXCEPTION WHEN OTHERS handler (Step 8) further downstream — i.e. the
-- email_ingestions ON CONFLICT (gmail_message_id) target is fine.
--
-- Trace of the CREATE branch for a fresh booking (no existing
-- reservation): Step 0 lock -> Step 1 email_ingestions UPSERT
-- (succeeded, proven by the returned ingestion_id) -> Step 2/2b
-- validation (succeeded — V8's p_passengers guard passed, 2 usable
-- passengers matched pax_adult=2) -> nested BEGIN block -> Step 3
-- booking advisory lock -> Step 4 reservation lookup (none found) ->
-- Step 6 CREATE branch -> V7 passenger-completeness guard (passed) ->
-- customer resolution (a plain INSERT INTO public.customers, no ON
-- CONFLICT clause at all — not implicated) -> SELECT
-- public.next_ref_number('R', 'reservations', 'reservation_number').
-- This is the ONLY remaining statement between a successful Step 1 and
-- the reservation INSERT that contains an ON CONFLICT clause anywhere
-- in the CREATE path, and it is also the FIRST TIME this exact RPC has
-- ever reached this statement for real: the first smoke test crashed
-- inside Step 2b, strictly before Step 3, so next_ref_number(...) was
-- never actually invoked by this pipeline until now.
--
-- public.next_ref_number(...) (from supabase_migration_ref_number_
-- counters.sql, unchanged by this file) allocates via:
--   INSERT INTO public.ref_number_counters (prefix, table_name, year, last_value, updated_at)
--   VALUES (prefix, table_name, year_str, v_seed + 1, NOW())
--   ON CONFLICT (prefix, table_name, year) DO UPDATE
--     SET last_value = ref_number_counters.last_value + 1, updated_at = NOW()
--   RETURNING last_value INTO v_next_num;
-- and public.ref_number_counters is declared with
-- CREATE TABLE IF NOT EXISTS ... PRIMARY KEY (prefix, table_name, year)
-- — on paper, an exact column-for-column match for the ON CONFLICT
-- target above. The Postgres error this smoke test hit ("there is no
-- unique or exclusion constraint matching the ON CONFLICT
-- specification") is raised ONLY when NO unique index (backing a
-- PRIMARY KEY, a UNIQUE constraint, or a bare CREATE UNIQUE INDEX) over
-- exactly this column set currently exists on the target table in the
-- database actually being queried — regardless of what the migration
-- FILE says should exist.
--
-- THE EXACT MISMATCH: CREATE TABLE IF NOT EXISTS is idempotent for
-- "does not error if a table by this name already exists" — it is NOT
-- idempotent for "guarantees the resulting table has this structure".
-- If any process ever created a table named public.ref_number_counters
-- before supabase_migration_ref_number_counters.sql's own CREATE TABLE
-- IF NOT EXISTS statement ran against production (a partial/earlier
-- manual application attempt, a hand-created table while iterating on
-- this design, or any other route) — WITHOUT a composite PRIMARY
-- KEY/UNIQUE constraint on (prefix, table_name, year) — that CREATE
-- TABLE IF NOT EXISTS statement silently does nothing at all, including
-- skipping every column and constraint definition in its body, and
-- CREATE OR REPLACE FUNCTION next_ref_number(...) still proceeds to
-- install a function body that assumes the constraint is there. This is
-- a well-known PostgreSQL migration footgun — this migration's own
-- original "HOW TO APPLY" note over-stated CREATE TABLE IF NOT EXISTS
-- as unconditionally "safe to re-run", which is true for avoiding an
-- error but not for guaranteeing the resulting schema. This is schema
-- drift between what the migration file declares and what the database
-- actually contains — see the read-only diagnostic queries below to
-- confirm this exact condition before applying the fix.
--
-- OPERATIONAL IMPACT BEYOND CIVITATIS: public.next_ref_number(...) is
-- also called directly by the manual JS creation paths for leads,
-- quotes, payments, and guide_payments (the other four
-- prefix/table_name/number_col combinations in its own allow-list). If
-- ref_number_counters is genuinely missing this unique index in
-- production, EVERY manual creation of a new lead/quote/payment/
-- guide_payment/reservation through the application UI since
-- supabase_migration_ref_number_counters.sql was applied would hit this
-- exact same error — not just the Civitatis write path. See the
-- diagnostic queries below to check for this before assuming the impact
-- is Civitatis-only.
--
-- THE FIX: add a uniquely-named CREATE UNIQUE INDEX IF NOT EXISTS,
-- separate from (and in addition to) the table's own inline PRIMARY
-- KEY declaration. This is chosen deliberately over
-- ALTER TABLE ... ADD CONSTRAINT for two reasons: (1) CREATE INDEX's
-- IF NOT EXISTS is scoped to the INDEX's own name, so — unlike
-- CREATE TABLE IF NOT EXISTS — it is genuinely idempotent for
-- guaranteeing the index exists, regardless of whatever the table's
-- own history was; (2) it requires no fragile catalog introspection
-- (comparing pg_constraint.conkey column lists/order) to detect an
-- already-correct state — if an index by this exact name already
-- exists (e.g. this file is re-run, or the table's inline PRIMARY KEY
-- already happens to satisfy it under a different name), the statement
-- is a guaranteed no-op; if it does not, the statement unconditionally
-- creates it. A plain unique b-tree index (no WHERE predicate) is a
-- fully valid ON CONFLICT (prefix, table_name, year) arbiter target —
-- Postgres does not require the arbiter to specifically be a PRIMARY
-- KEY or a named UNIQUE CONSTRAINT. This does NOT weaken the ON
-- CONFLICT semantics next_ref_number(...) already relies on in any way
-- — it is the exact same 3-column, non-partial, b-tree uniqueness
-- guarantee the original migration always intended; it is only now
-- GUARANTEED to actually exist. Harmless if the table's own PRIMARY KEY
-- already independently satisfies this (a small amount of redundant
-- index storage on an internal, few-row admin table — an explicitly
-- accepted, deliberate tradeoff for guaranteed correctness).
--
-- NOT changed by this migration: public.next_ref_number(...)'s own
-- function body (unchanged from supabase_migration_ref_number_
-- counters.sql — no CREATE OR REPLACE FUNCTION statement is even
-- included here, since nothing about its logic needs to change once
-- its ON CONFLICT target is actually backed by an index), its atomicity
-- guarantee (this migration REINSTATES that guarantee rather than
-- compromising it — the allocator was never actually able to execute
-- its atomic UPSERT at all if this index was missing), its SECURITY
-- DEFINER/search_path=public/REVOKE-GRANT posture, or any other table.
-- public.ingest_civitatis_booking (V6/V7/V8) is not referenced anywhere
-- in this file.
--
-- STATUS: NOT executed against any database as part of producing this
-- file. Review the diagnostic queries below against production FIRST —
-- they will positively confirm or rule out the missing-index condition
-- this migration exists to fix, with zero risk (pure read-only
-- catalog introspection, no data touched).
--
-- HOW TO APPLY (once reviewed and approved — NOT done as part of
-- producing this file)
-- ─────────────────────────────────────────────────────────────
-- Supabase Dashboard → SQL Editor → paste and run this file. The single
-- CREATE UNIQUE INDEX IF NOT EXISTS statement below is genuinely
-- idempotent — safe to run any number of times, on a fresh install
-- (where the table's own inline PRIMARY KEY already covers this and the
-- new index becomes a small amount of harmless redundancy) or on a
-- production database already exhibiting the exact failure this
-- migration fixes.
-- ============================================================


-- ──────────────────────────────────────────────────────────────────────────
-- DIAGNOSTIC QUERIES (READ-ONLY — run these FIRST, separately, to
-- confirm the exact condition before applying the fix below; see
-- deliverable item 7 for the full read-only verification set)
-- ──────────────────────────────────────────────────────────────────────────

/*
-- A. Does ANY unique index/constraint currently cover
--    (prefix, table_name, year) on public.ref_number_counters?
SELECT
  ic.relname  AS index_name,
  i.indisunique,
  i.indpred IS NOT NULL AS is_partial,
  (SELECT array_agg(a.attname ORDER BY a.attname)
     FROM pg_attribute a
    WHERE a.attrelid = i.indrelid AND a.attnum = ANY (i.indkey::int2[])
  ) AS indexed_columns
FROM pg_index i
JOIN pg_class t  ON t.oid = i.indrelid
JOIN pg_class ic ON ic.oid = i.indexrelid
JOIN pg_namespace n ON n.oid = t.relnamespace
WHERE n.nspname = 'public' AND t.relname = 'ref_number_counters';
-- If this returns ZERO rows, or no row has indexed_columns exactly
-- {prefix,table_name,year} with indisunique=true and is_partial=false,
-- this migration's diagnosis is confirmed.

-- B. Confirm the table's actual column list matches what every
--    migration file assumes (rules out a totally different kind of
--    drift):
SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'ref_number_counters'
ORDER BY ordinal_position;

-- C. Has this allocator EVER successfully completed for ANY prefix
--    (reservations, leads, quotes, payments, guide_payments)? An empty
--    result here, combined with A above showing no matching index,
--    would mean every manual lead/quote/payment/guide_payment/
--    reservation creation since this table was introduced has also
--    been failing with this exact error — not just Civitatis:
SELECT * FROM public.ref_number_counters ORDER BY prefix, table_name, year;
*/


-- ──────────────────────────────────────────────────────────────────────────
-- THE FIX: guarantee the ON CONFLICT (prefix, table_name, year) target
-- in public.next_ref_number(...) always has a backing unique index,
-- independent of the table's own creation history.
-- ──────────────────────────────────────────────────────────────────────────

CREATE UNIQUE INDEX IF NOT EXISTS ref_number_counters_prefix_table_name_year_key
  ON public.ref_number_counters (prefix, table_name, year);

COMMENT ON INDEX public.ref_number_counters_prefix_table_name_year_key IS
  'Backs public.next_ref_number(...)''s ON CONFLICT (prefix, table_name, '
  'year) DO UPDATE arbiter. Added as a separately-named, independently '
  'idempotent CREATE UNIQUE INDEX IF NOT EXISTS (rather than relying '
  'solely on ref_number_counters'' inline PRIMARY KEY from '
  'supabase_migration_ref_number_counters.sql) after the real production '
  'failure on booking A41629692 (ingestion_id '
  'fb7bd246-ab9d-492d-870c-40108d19e54f) proved CREATE TABLE IF NOT '
  'EXISTS cannot be relied on to guarantee a constraint on a table that '
  'may have already existed under that name without one. See this file''s '
  'header for the full incident writeup.';


-- ──────────────────────────────────────────────────────────────────────────
-- VERIFICATION QUERIES (for manual review after applying — not executed
-- as part of producing this file)
-- ──────────────────────────────────────────────────────────────────────────

/*
-- 1. Confirm the index now exists and is a genuine, non-partial unique
--    index over exactly the right 3 columns:
SELECT indexname, indexdef
FROM pg_indexes
WHERE schemaname = 'public' AND tablename = 'ref_number_counters'
  AND indexname = 'ref_number_counters_prefix_table_name_year_key';

-- 2. Spot-check allocation now actually completes (only run this AFTER
--    confirming you are comfortable allocating one real reservation
--    number — it durably increments the counter, per this function's
--    own documented, accepted "gaps are harmless" contract):
-- SELECT public.next_ref_number('R', 'reservations', 'reservation_number');
*/

-- ── END OF MIGRATION ────────────────────────────────────────────────────────
