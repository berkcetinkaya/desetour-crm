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
-- or exclusion constraint matching the ON CONFLICT specification".
--
-- *** RETRACTION: this file's ORIGINAL diagnosis — that
-- public.ref_number_counters was missing its unique index over
-- (prefix, table_name, year) — was PROVEN WRONG by live Supabase
-- catalog evidence: ref_number_counters_pkey, a genuine non-partial
-- unique btree index over exactly those three columns, has existed all
-- along. supabase_migration_ref_number_counters_v2_unique_constraint_
-- guard.sql (the migration that diagnosis proposed) was NEVER applied
-- and has been REMOVED from this repository. The REAL root cause,
-- proven via V9 diagnostic instrumentation and an isolated PostgreSQL
-- reproduction, was next_ref_number(...)'s own
-- #variable_conflict use_variable pragma silently resolving its ON
-- CONFLICT (prefix, table_name, year) arbiter's bare column names as
-- PL/pgSQL PARAMETERS (identically named) rather than table columns —
-- a PL/pgSQL variable-shadowing bug, not a schema-drift/missing-index
-- bug. See
-- supabase_migration_ref_number_counters_v3_on_conflict_arbiter_fix.sql
-- for the full incident writeup and the actual fix (ON CONFLICT ON
-- CONSTRAINT ref_number_counters_pkey), and
-- tests/civitatis/sql/next_ref_number_on_conflict_ambiguity_manual_tests.sql
-- for the reproduction. ***
--
-- CONTRACT TEST 2 below (does a matching unique index exist?) remains a
-- valid, independently useful check — a genuinely missing/mismatched
-- index is still a real class of bug this file can catch — but it is
-- NOT, and was never, sufficient on its own: an index can exist and
-- STILL fail ON CONFLICT inference if the SQL referencing it resolves
-- the wrong identifiers, exactly as happened here. Every existing
-- manual SQL test for ingest_civitatis_booking and next_ref_number
-- exercises them by actually CALLING the function inside a transaction
-- that is always rolled back — none of them, including this file,
-- catches a PL/pgSQL variable-shadowing bug like this one without
-- actually invoking the function and observing the SQLSTATE, which is
-- exactly what next_ref_number_on_conflict_ambiguity_manual_tests.sql
-- (Part A) now does in isolation.
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
    RAISE EXCEPTION 'ON CONFLICT CONTRACT TEST 2: FAILED — public.ref_number_counters has no non-partial unique index on exactly (prefix, table_name, year). NOTE: this specific check was NOT the real A41629692 failure (that index has always existed) — a passing TEST 2 does not by itself prove next_ref_number''s ON CONFLICT works; see next_ref_number_on_conflict_ambiguity_manual_tests.sql for the check that actually caught the real bug (a PL/pgSQL parameter/column name collision, not a missing index).';
  END IF;

  RAISE NOTICE 'ON CONFLICT CONTRACT TEST 2: PASSED — ref_number_counters(prefix, table_name, year) unique index exists (this alone does NOT prove next_ref_number''s ON CONFLICT can infer it — see next_ref_number_on_conflict_ambiguity_manual_tests.sql)';
END $$;


-- ══════════════════════════════════════════════════════════════════════════
-- CROSS-REFERENCE
--   TEST 1 (email_ingestions.gmail_message_id)      -> proven fine by the
--       real smoke test itself (ingestion_id fb7bd246-... was returned,
--       proving Step 1's UPSERT succeeded) — included here so this file
--       is a complete, standalone contract check, not because it was
--       ever observed broken.
--   TEST 2 (ref_number_counters(prefix,table_name,year) index exists) ->
--       PASSES both before and after the real fix — this file's own
--       original diagnosis (missing index) was WRONG, disproven by live
--       catalog evidence; the index existed all along. The REAL A41629692
--       failure was a PL/pgSQL variable-shadowing bug in next_ref_number's
--       ON CONFLICT clause itself (#variable_conflict use_variable
--       resolving the arbiter's bare prefix/table_name column names as
--       the function's own same-named PARAMETERS), which an
--       index-existence check can never catch by construction — see
--       supabase_migration_ref_number_counters_v3_on_conflict_arbiter_fix.sql
--       for the proven root cause and the actual fix (ON CONFLICT ON
--       CONSTRAINT ref_number_counters_pkey), and
--       next_ref_number_on_conflict_ambiguity_manual_tests.sql for the
--       regression test that actually reproduces and proves it.
-- ══════════════════════════════════════════════════════════════════════════

-- ── END OF MANUAL TEST PLAN ─────────────────────────────────────────────────
