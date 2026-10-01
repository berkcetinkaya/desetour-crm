-- ============================================================
-- DESE TOUR OPERATIONS CENTER
-- Rollback: Tour Preparation Intelligence — Phase B2
-- ============================================================
-- File:    supabase_migration_civitatis_activity_modality_phase_b2_ROLLBACK.sql
-- Rolls back ONLY: supabase_migration_civitatis_activity_modality_phase_b2.sql
-- NOT executed. Provided for manual review and manual execution only.
--
-- SCOPE — WHAT THIS ROLLS BACK, AND NOTHING ELSE
-- ─────────────────────────────────────────────────────────────
-- Removes EXACTLY the one object the forward migration created:
--   public.set_reservation_activity_modality(UUID, UUID, TEXT, TEXT, TEXT)
--
-- THIS ROLLBACK DOES NOT TOUCH, AND MUST NEVER BE MADE TO TOUCH:
--   • reservations.purchased_activity_raw / reservations.meal_status —
--     Phase A columns, never referenced for removal here. Any value
--     this RPC already wrote to them (if it was ever actually called
--     against a real row before this rollback runs) is left exactly as
--     it is — this rollback contains no UPDATE/DELETE on reservations.
--   • public.civitatis_activity_modality_map or any of its rows (Phase
--     A table, Phase A + B1 seed rows) — never referenced here.
--   • public.tour_preparation_rules, public.reservation_preparations —
--     never referenced here.
--   • public.ingest_civitatis_booking / public.cancel_civitatis_booking
--     — never referenced for modification by the forward migration
--     (only read-only signature checks), never referenced for
--     modification here (this file re-verifies them unchanged in its
--     own postflight).
--   • The uncommitted WhatsApp Phase 1.2 working tree — never
--     referenced anywhere in this file.
--
-- SAFETY
-- ─────────────────────────────────────────────────────────────
-- DROP FUNCTION IF EXISTS — safe to run even if the forward migration
-- was only partially applied, and safe to run twice (second run finds
-- nothing left to drop, no error).
--
-- NOTE: dropping this function while any server-side code already
-- expects to call it (api/_civitatis/activityModalityPersistence.js, or
-- any later writeAdapter wiring) would make that specific call fail —
-- that failure is contained to the persistence step itself, exactly
-- like any other missing-dependency error already handled elsewhere in
-- this codebase; it cannot affect ingest_civitatis_booking/
-- cancel_civitatis_booking, which never reference this function.
--
-- HOW TO APPLY
-- ─────────────────────────────────────────────────────────────
-- Supabase Dashboard → SQL Editor → paste and run this file IN FULL, in
-- a single execution. Wrapped in BEGIN/COMMIT so a failed postflight
-- aborts the whole rollback rather than leaving it partial.
-- ============================================================


BEGIN;

-- ──────────────────────────────────────────────────────────────────────────
-- STEP 1: drop the one function the forward migration created.
-- ──────────────────────────────────────────────────────────────────────────

DROP FUNCTION IF EXISTS public.set_reservation_activity_modality(UUID, UUID, TEXT, TEXT, TEXT);


-- ──────────────────────────────────────────────────────────────────────────
-- POSTFLIGHT: confirm the function is gone, and that every object this
-- rollback must NEVER touch is still exactly present. Aborts the whole
-- transaction on any unexpected state.
-- ──────────────────────────────────────────────────────────────────────────

DO $$
DECLARE
  v_problems TEXT[] := '{}';
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = 'set_reservation_activity_modality'
  ) THEN
    v_problems := array_append(v_problems, 'set_reservation_activity_modality still exists');
  END IF;

  -- Out-of-scope objects must remain untouched.
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='reservations' AND column_name='purchased_activity_raw') THEN
    v_problems := array_append(v_problems, 'reservations.purchased_activity_raw was removed — out of scope, must never happen');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='reservations' AND column_name='meal_status') THEN
    v_problems := array_append(v_problems, 'reservations.meal_status was removed — out of scope, must never happen');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='civitatis_activity_modality_map') THEN
    v_problems := array_append(v_problems, 'civitatis_activity_modality_map was removed — out of scope, must never happen');
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.civitatis_activity_modality_map
     WHERE language_code='pt' AND match_type='contains' AND match_text='com almoço' AND meal_status='included'
  ) THEN
    v_problems := array_append(v_problems, 'Phase A original row pt/contains/''com almoço''/included was removed — out of scope, must never happen');
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.civitatis_activity_modality_map
     WHERE language_code='pt' AND match_type='suffix_exact' AND match_text='Visita guiada pela Istambul imprescindível - Tour com' AND meal_status='included'
  ) THEN
    v_problems := array_append(v_problems, 'B1 row pt/suffix_exact/''...Tour com''/included was removed — out of scope, must never happen');
  END IF;

  IF array_length(v_problems, 1) > 0 THEN
    RAISE EXCEPTION 'PHASE B2 ROLLBACK POSTFLIGHT FAILED: %. Aborting — re-run this ENTIRE file in a single execution.', array_to_string(v_problems, ', ');
  END IF;

  -- Re-confirm both Civitatis RPCs are STILL exactly what they were
  -- before this rollback ran.
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
    RAISE EXCEPTION 'PHASE B2 ROLLBACK POSTFLIGHT FAILED: public.ingest_civitatis_booking signature changed or the function disappeared during this rollback. This must never happen — aborting.';
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
    RAISE EXCEPTION 'PHASE B2 ROLLBACK POSTFLIGHT FAILED: public.cancel_civitatis_booking signature changed or the function disappeared during this rollback. This must never happen — aborting.';
  END IF;

  RAISE NOTICE 'PHASE B2 ROLLBACK POSTFLIGHT PASSED: set_reservation_activity_modality confirmed removed; reservations.purchased_activity_raw/meal_status, civitatis_activity_modality_map and its Phase A/B1 rows all confirmed untouched; both Civitatis RPCs unchanged.';
END $$;

COMMIT;

-- ============================================================
-- END OF ROLLBACK supabase_migration_civitatis_activity_modality_phase_b2_ROLLBACK.sql
-- ============================================================
