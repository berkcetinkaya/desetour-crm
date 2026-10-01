-- ============================================================
-- DESE TOUR OPERATIONS CENTER
-- Migration: Tour Preparation Intelligence — Phase B1
-- Production-evidenced Civitatis Activity modality mappings
-- ============================================================
-- File:    supabase_migration_civitatis_activity_modality_phase_b1.sql
-- NOT YET APPLIED to any database. Provided for manual review only.
--
-- SCOPE — WHAT THIS MIGRATION IS
-- ─────────────────────────────────────────────────────────────
-- Rolls back ONLY: adds exactly TWO new rows to the already-existing,
-- already-production-applied public.civitatis_activity_modality_map
-- table (created by supabase_migration_tour_preparation_phase_a.sql,
-- committed as 81c5d38be4fd62d532e8436845c5c8072686e956, already applied
-- to production). Does NOT alter that table's schema, does NOT touch any
-- other Phase A object (reservations.purchased_activity_raw/meal_status,
-- tour_preparation_rules, reservation_preparations), does NOT create any
-- new table, does NOT modify V12/V13, does NOT touch auth, does NOT
-- touch the uncommitted WhatsApp Phase 1.2 working tree.
--
-- WHY THESE TWO NEW ROWS ARE NEEDED
-- ─────────────────────────────────────────────────────────────
-- A direct, read-only production inventory (run manually, outside this
-- migration) confirmed that for the real production Activity family
-- "Visita guiada pela Istambul imprescindível - Tour com[/sem] almoço",
-- the raw_body_snapshot's actual Activity value — verified NOT to be a
-- SQL display truncation — genuinely ENDS at "Tour com" / "Tour sem",
-- i.e. the word "almoço" itself is absent from the stored Activity text
-- for these real production rows, even though the booking's real-world
-- meaning (separately confirmed by the user from the Civitatis source)
-- is unambiguous: "Tour com" = meal included, "Tour sem" = meal not
-- included. Phase A's own seeded rows (pt/contains/'com almoço'/included
-- and pt/contains/'sem almoço'/not_included) therefore do NOT match
-- these real rows at all — this migration adds the two additional rows
-- that do, evidenced directly from production, not invented.
--
-- WHY suffix_exact, NOT A BROAD "contains 'com'"/"contains 'sem'" RULE
-- ─────────────────────────────────────────────────────────────
-- "com" and "sem" are common, generic Portuguese words (meaning "with"/
-- "without") that could legitimately appear inside unrelated Activity
-- text with no meal-modality meaning at all (e.g. "... com guia local",
-- "Tour sem fila" for "skip-the-line"). A broad contains-rule on either
-- bare word would misclassify such unrelated activities. This migration
-- instead seeds the FULL evidenced Activity string as an exact SUFFIX
-- rule — specific to this one observed Activity family, structurally
-- incapable of matching any other Activity text, including the Spanish
-- Grand Bazaar, Italian Grand Bazaar, and Portuguese Bosphorus families
-- also observed in production, none of which carry any evidenced meal
-- wording and must remain meal_status='unknown' (absence of meal wording
-- is never interpreted as not_included — only an explicit, evidenced
-- phrase ever resolves a status).
--
-- EXACT NEW ROWS SEEDED (and nothing else)
-- ─────────────────────────────────────────────────────────────
--   pt / suffix_exact / 'Visita guiada pela Istambul imprescindível - Tour com' / included
--   pt / suffix_exact / 'Visita guiada pela Istambul imprescindível - Tour sem' / not_included
-- No Spanish/Italian/French/English/Turkish phrase is seeded — none has
-- been evidenced from real production data for ANY meal modality.
--
-- SAFETY
-- ─────────────────────────────────────────────────────────────
-- Wrapped in BEGIN/COMMIT. Preflight verifies civitatis_activity_
-- modality_map exists with its expected shape AND that Phase A's own two
-- original rows (pt/contains/'com almoço'/included,
-- pt/contains/'sem almoço'/not_included) are present and unaltered
-- BEFORE this migration touches anything, and re-verifies the two
-- stable Civitatis RPC signatures (V12/V13.1) are unchanged. The INSERT
-- uses ON CONFLICT on the exact same partial unique index Phase A
-- created (uq_civitatis_activity_modality_map_active_rule) — safe to
-- re-run. Postflight re-verifies both original Phase A rows are STILL
-- present and unaltered, both new rows are present as expected, and both
-- Civitatis RPC signatures remain unchanged, aborting the whole
-- transaction on any discrepancy.
--
-- HOW TO APPLY
-- ─────────────────────────────────────────────────────────────
-- Supabase Dashboard → SQL Editor → paste and run this file IN FULL, in
-- a single execution.
-- ============================================================


BEGIN;

-- ──────────────────────────────────────────────────────────────────────────
-- PREFLIGHT: confirm Phase A's civitatis_activity_modality_map exists
-- with its expected shape, and that its two original seed rows are
-- present and unaltered, BEFORE touching anything. Read-only.
-- ──────────────────────────────────────────────────────────────────────────

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
     WHERE table_schema = 'public' AND table_name = 'civitatis_activity_modality_map'
  ) THEN
    RAISE EXCEPTION 'PHASE B1 PREFLIGHT FAILED: public.civitatis_activity_modality_map does not exist. Apply supabase_migration_tour_preparation_phase_a.sql BEFORE this migration. Aborting before touching anything.';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
     WHERE schemaname = 'public' AND tablename = 'civitatis_activity_modality_map'
       AND indexname = 'uq_civitatis_activity_modality_map_active_rule'
  ) THEN
    RAISE EXCEPTION 'PHASE B1 PREFLIGHT FAILED: uq_civitatis_activity_modality_map_active_rule index does not exist. This migration must never be applied against a schema where Phase A''s own uniqueness guarantee is missing/altered. Aborting before touching anything.';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.civitatis_activity_modality_map
     WHERE language_code = 'pt' AND match_type = 'contains' AND match_text = 'com almoço'
       AND meal_status = 'included' AND is_active = TRUE
  ) THEN
    RAISE EXCEPTION 'PHASE B1 PREFLIGHT FAILED: Phase A original seed row pt/contains/''com almoço''/included is missing or altered. Aborting before touching anything.';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.civitatis_activity_modality_map
     WHERE language_code = 'pt' AND match_type = 'contains' AND match_text = 'sem almoço'
       AND meal_status = 'not_included' AND is_active = TRUE
  ) THEN
    RAISE EXCEPTION 'PHASE B1 PREFLIGHT FAILED: Phase A original seed row pt/contains/''sem almoço''/not_included is missing or altered. Aborting before touching anything.';
  END IF;

  -- Read-only confirmation that the two stable Civitatis RPCs this
  -- migration must NEVER affect are present with their known signatures.
  IF NOT EXISTS (
    SELECT 1
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname = 'ingest_civitatis_booking'
       AND p.pronargs = 26
       AND p.proargtypes = array_to_string(
             ARRAY[
               'text', 'text', 'timestamptz', 'text', 'text', 'text', 'uuid', 'text', 'uuid', 'text',
               'date', 'time', 'integer', 'integer', 'numeric', 'text', 'numeric', 'text', 'uuid',
               'text', 'text', 'text', 'jsonb', 'boolean', 'text', 'text'
             ]::regtype[]::oid[],
             ' '
           )::oidvector
  ) THEN
    RAISE EXCEPTION 'PHASE B1 PREFLIGHT FAILED: public.ingest_civitatis_booking with the expected 26-parameter V12 signature was not found. Aborting before touching anything.';
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname = 'cancel_civitatis_booking'
       AND p.pronargs = 7
       AND p.proargtypes = array_to_string(
             ARRAY['text','text','timestamptz','text','text','uuid','text']::regtype[]::oid[],
             ' '
           )::oidvector
  ) THEN
    RAISE EXCEPTION 'PHASE B1 PREFLIGHT FAILED: public.cancel_civitatis_booking with the expected 7-parameter V13.1 signature was not found. Aborting before touching anything.';
  END IF;

  RAISE NOTICE 'PHASE B1 PREFLIGHT PASSED: civitatis_activity_modality_map present with Phase A''s two original rows intact. Proceeding — additive seed rows only.';
END $$;


-- ──────────────────────────────────────────────────────────────────────────
-- STEP 1: seed the two production-evidenced suffix_exact rows. ON
-- CONFLICT targets the exact same partial unique index Phase A created —
-- safe to re-run.
-- ──────────────────────────────────────────────────────────────────────────

INSERT INTO public.civitatis_activity_modality_map (language_code, match_type, match_text, meal_status, is_active)
VALUES
  ('pt', 'suffix_exact', 'Visita guiada pela Istambul imprescindível - Tour com', 'included',     TRUE),
  ('pt', 'suffix_exact', 'Visita guiada pela Istambul imprescindível - Tour sem', 'not_included', TRUE)
ON CONFLICT (language_code, match_type, match_text_normalized) WHERE is_active
  DO NOTHING;


-- ──────────────────────────────────────────────────────────────────────────
-- POSTFLIGHT: verify both original Phase A rows are STILL present and
-- unaltered, both new rows are present as expected, and both Civitatis
-- RPC signatures remain unchanged. RAISE EXCEPTION aborts the WHOLE
-- transaction if anything is wrong.
-- ──────────────────────────────────────────────────────────────────────────

DO $$
DECLARE
  v_missing TEXT[] := '{}';
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.civitatis_activity_modality_map
     WHERE language_code = 'pt' AND match_type = 'contains' AND match_text = 'com almoço'
       AND meal_status = 'included' AND is_active = TRUE
  ) THEN
    v_missing := array_append(v_missing, 'Phase A original row pt/contains/''com almoço''/included no longer present/active — must never happen');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.civitatis_activity_modality_map
     WHERE language_code = 'pt' AND match_type = 'contains' AND match_text = 'sem almoço'
       AND meal_status = 'not_included' AND is_active = TRUE
  ) THEN
    v_missing := array_append(v_missing, 'Phase A original row pt/contains/''sem almoço''/not_included no longer present/active — must never happen');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.civitatis_activity_modality_map
     WHERE language_code = 'pt' AND match_type = 'suffix_exact'
       AND match_text = 'Visita guiada pela Istambul imprescindível - Tour com'
       AND meal_status = 'included' AND is_active = TRUE
  ) THEN
    v_missing := array_append(v_missing, 'B1 row pt/suffix_exact/''...Tour com''/included missing');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.civitatis_activity_modality_map
     WHERE language_code = 'pt' AND match_type = 'suffix_exact'
       AND match_text = 'Visita guiada pela Istambul imprescindível - Tour sem'
       AND meal_status = 'not_included' AND is_active = TRUE
  ) THEN
    v_missing := array_append(v_missing, 'B1 row pt/suffix_exact/''...Tour sem''/not_included missing');
  END IF;

  IF array_length(v_missing, 1) > 0 THEN
    RAISE EXCEPTION 'PHASE B1 POSTFLIGHT FAILED: %. Aborting — re-run this ENTIRE file in a single execution.', array_to_string(v_missing, ', ');
  END IF;

  -- Re-confirm both Civitatis RPCs are STILL exactly what they were
  -- before this migration ran — never touched.
  IF NOT EXISTS (
    SELECT 1
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname = 'ingest_civitatis_booking'
       AND p.pronargs = 26
       AND p.proargtypes = array_to_string(
             ARRAY[
               'text', 'text', 'timestamptz', 'text', 'text', 'text', 'uuid', 'text', 'uuid', 'text',
               'date', 'time', 'integer', 'integer', 'numeric', 'text', 'numeric', 'text', 'uuid',
               'text', 'text', 'text', 'jsonb', 'boolean', 'text', 'text'
             ]::regtype[]::oid[],
             ' '
           )::oidvector
  ) THEN
    RAISE EXCEPTION 'PHASE B1 POSTFLIGHT FAILED: public.ingest_civitatis_booking signature changed or the function disappeared during this migration. This must never happen — aborting.';
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname = 'cancel_civitatis_booking'
       AND p.pronargs = 7
       AND p.proargtypes = array_to_string(
             ARRAY['text','text','timestamptz','text','text','uuid','text']::regtype[]::oid[],
             ' '
           )::oidvector
  ) THEN
    RAISE EXCEPTION 'PHASE B1 POSTFLIGHT FAILED: public.cancel_civitatis_booking signature changed or the function disappeared during this migration. This must never happen — aborting.';
  END IF;

  RAISE NOTICE 'PHASE B1 POSTFLIGHT PASSED: both Phase A original rows intact; both new production-evidenced suffix_exact rows (pt/''...Tour com''/included, pt/''...Tour sem''/not_included) present and active; both Civitatis RPCs confirmed unchanged.';
END $$;

COMMIT;

-- ============================================================
-- END OF MIGRATION supabase_migration_civitatis_activity_modality_phase_b1.sql
-- ============================================================
