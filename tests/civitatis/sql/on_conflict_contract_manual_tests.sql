-- ══════════════════════════════════════════════════════════════════════════
-- DESE TOUR OPERATIONS CENTER
-- ON CONFLICT CONTRACT — structural manual test plan
-- ══════════════════════════════════════════════════════════════════════════
-- File: tests/civitatis/sql/on_conflict_contract_manual_tests.sql
-- STATUS: NOT executed as part of producing this file. Pure read-only
-- pg_catalog introspection — no table is written to, no row is
-- inserted/updated/deleted, nothing here requires a BEGIN/ROLLBACK
-- wrapper the way the transactional manual tests in
-- ingest_civitatis_booking_manual_tests.sql do.
--
-- WHY THIS FILE EXISTS
-- ─────────────────────────────────────────────────────────────
-- The second real controlled write smoke test for booking A41629692
-- (gmail_message_id 1a0aedc69a2ef905) failed with "there is no unique
-- or exclusion constraint matching the ON CONFLICT specification" —
-- root cause: public.ref_number_counters was missing a unique index
-- over (prefix, table_name, year), the exact column set
-- public.next_ref_number(...)'s ON CONFLICT clause requires, even
-- though the migration FILE that creates the table declares a matching
-- PRIMARY KEY (CREATE TABLE IF NOT EXISTS silently no-ops the whole
-- table body, constraints included, if a table by that name already
-- existed — see supabase_migration_ref_number_counters_v2_unique_
-- constraint_guard.sql for the full incident writeup and fix). Every
-- existing manual SQL test for ingest_civitatis_booking and
-- next_ref_number exercises them by actually CALLING the function
-- inside a transaction that is always rolled back — none of them ever
-- asked Postgres's own catalog "does the constraint this ON CONFLICT
-- clause needs actually exist right now", which is the one question
-- that would have caught this class of schema-drift bug before a real
-- write attempt did.
--
-- WHAT THIS FILE CHECKS
-- ─────────────────────────────────────────────────────────────
-- For every INSERT ... ON CONFLICT (...) statement reachable from
-- public.ingest_civitatis_booking's NEW_BOOKING (CREATE) path — either
-- directly in its own body, or transitively via a function it calls —
-- this file asserts that a genuine, non-partial, exact-column-set
-- unique index currently backs that exact ON CONFLICT target:
--   1. public.email_ingestions — ON CONFLICT (gmail_message_id)
--      (ingest_civitatis_booking's own Step 1, all of V6/V7/V8)
--   2. public.ref_number_counters — ON CONFLICT (prefix, table_name, year)
--      (public.next_ref_number(...), called from
--      ingest_civitatis_booking's CREATE branch, and from the manual JS
--      creation paths for leads/quotes/payments/guide_payments)
-- Run this file's two DO blocks any time either function's SQL is
-- touched, or as a standing pre-flight check before another real
-- controlled write smoke test, to catch this exact class of bug
-- (missing/mismatched backing index) without ever needing to actually
-- attempt a write.
-- ══════════════════════════════════════════════════════════════════════════


-- ══════════════════════════════════════════════════════════════════════════
-- CONTRACT TEST 1 — public.email_ingestions must have a non-partial
-- unique index over exactly (gmail_message_id), backing
-- ingest_civitatis_booking's Step 1 ON CONFLICT (gmail_message_id).
-- ══════════════════════════════════════════════════════════════════════════
DO $$
DECLARE
  v_found BOOLEAN;
BEGIN
  SELECT EXISTS (
    SELECT 1
      FROM pg_index i
      JOIN pg_class t     ON t.oid = i.indrelid
      JOIN pg_namespace n ON n.oid = t.relnamespace
     WHERE n.nspname = 'public'
       AND t.relname = 'email_ingestions'
       AND i.indisunique
       AND i.indpred IS NULL  -- never a partial index
       AND array_length(i.indkey::int2[], 1) = 1
       AND (
         SELECT a.attname
           FROM pg_attribute a
          WHERE a.attrelid = i.indrelid
            AND a.attnum = ANY (i.indkey::int2[])
       ) = 'gmail_message_id'
  ) INTO v_found;

  IF NOT v_found THEN
    RAISE EXCEPTION 'ON CONFLICT CONTRACT TEST 1: FAILED — public.email_ingestions has no non-partial unique index on exactly (gmail_message_id). ingest_civitatis_booking''s Step 1 "INSERT ... ON CONFLICT (gmail_message_id) DO UPDATE" (V6/V7/V8, unchanged) would fail with "there is no unique or exclusion constraint matching the ON CONFLICT specification" for every call.';
  END IF;

  RAISE NOTICE 'ON CONFLICT CONTRACT TEST 1: PASSED — email_ingestions(gmail_message_id) unique index exists';
END $$;


-- ══════════════════════════════════════════════════════════════════════════
-- CONTRACT TEST 2 — public.ref_number_counters must have a non-partial
-- unique index over exactly (prefix, table_name, year), backing
-- public.next_ref_number(...)'s ON CONFLICT (prefix, table_name, year).
-- This is the EXACT check that would have caught the real production
-- failure on booking A41629692 (ingestion_id
-- fb7bd246-ab9d-492d-870c-40108d19e54f) before another real smoke test
-- ever needed to discover it.
-- ══════════════════════════════════════════════════════════════════════════
DO $$
DECLARE
  v_found BOOLEAN;
BEGIN
  SELECT EXISTS (
    SELECT 1
      FROM pg_index i
      JOIN pg_class t     ON t.oid = i.indrelid
      JOIN pg_namespace n ON n.oid = t.relnamespace
     WHERE n.nspname = 'public'
       AND t.relname = 'ref_number_counters'
       AND i.indisunique
       AND i.indpred IS NULL  -- never a partial index
       AND array_length(i.indkey::int2[], 1) = 3
       AND (
         SELECT array_agg(a.attname ORDER BY a.attname)
           FROM pg_attribute a
          WHERE a.attrelid = i.indrelid
            AND a.attnum = ANY (i.indkey::int2[])
       ) = ARRAY['prefix','table_name','year']::name[]
  ) INTO v_found;

  IF NOT v_found THEN
    RAISE EXCEPTION 'ON CONFLICT CONTRACT TEST 2: FAILED — public.ref_number_counters has no non-partial unique index on exactly (prefix, table_name, year). public.next_ref_number(...)''s "INSERT ... ON CONFLICT (prefix, table_name, year) DO UPDATE" would fail with "there is no unique or exclusion constraint matching the ON CONFLICT specification" for EVERY prefix (reservations, leads, quotes, payments, guide_payments) — not Civitatis-only. Apply supabase_migration_ref_number_counters_v2_unique_constraint_guard.sql.';
  END IF;

  RAISE NOTICE 'ON CONFLICT CONTRACT TEST 2: PASSED — ref_number_counters(prefix, table_name, year) unique index exists';
END $$;


-- ══════════════════════════════════════════════════════════════════════════
-- CROSS-REFERENCE
--   TEST 1 (email_ingestions.gmail_message_id)      -> proven fine by the
--       real smoke test itself (ingestion_id fb7bd246-... was returned,
--       proving Step 1's UPSERT succeeded) — included here so this file
--       is a complete, standalone contract check, not because it was
--       ever observed broken.
--   TEST 2 (ref_number_counters(prefix,table_name,year)) -> the exact
--       real production failure on booking A41629692; see
--       supabase_migration_ref_number_counters_v2_unique_constraint_guard.sql
--       for the fix (NOT executed by this test file or by anything in
--       this repository — apply it manually after reviewing).
-- ══════════════════════════════════════════════════════════════════════════

-- ── END OF MANUAL TEST PLAN ─────────────────────────────────────────────────
