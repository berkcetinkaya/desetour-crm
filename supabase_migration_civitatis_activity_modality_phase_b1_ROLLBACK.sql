-- ============================================================
-- DESE TOUR OPERATIONS CENTER
-- Rollback: Tour Preparation Intelligence — Phase B1
-- ============================================================
-- File:    supabase_migration_civitatis_activity_modality_phase_b1_ROLLBACK.sql
-- Rolls back ONLY: supabase_migration_civitatis_activity_modality_phase_b1.sql
-- NOT executed. Provided for manual review and manual execution only.
--
-- SCOPE — WHAT THIS ROLLS BACK, AND NOTHING ELSE
-- ─────────────────────────────────────────────────────────────
-- Removes EXACTLY the two rows the forward migration inserted:
--   pt / suffix_exact / 'Visita guiada pela Istambul imprescindível - Tour com' / included
--   pt / suffix_exact / 'Visita guiada pela Istambul imprescindível - Tour sem' / not_included
--
-- THIS ROLLBACK DOES NOT TOUCH, AND MUST NEVER BE MADE TO TOUCH:
--   • Phase A's two ORIGINAL seed rows
--     (pt/contains/'com almoço'/included, pt/contains/'sem almoço'/
--     not_included) — this file's own postflight re-verifies both are
--     still present and unaltered after the DELETE below runs.
--   • The civitatis_activity_modality_map TABLE itself, or any of its
--     columns/constraints/indexes/RLS policies — only two specific rows
--     are deleted, nothing structural.
--   • public.tour_preparation_rules, public.reservation_preparations,
--     reservations.purchased_activity_raw/meal_status — no other Phase A
--     object is referenced for modification anywhere in this file.
--   • public.ingest_civitatis_booking / public.cancel_civitatis_booking
--     — never referenced for modification by the forward migration (only
--     read-only signature checks), never referenced for modification
--     here (this file re-verifies them unchanged in its own postflight).
--
-- SAFETY
-- ─────────────────────────────────────────────────────────────
-- DELETE targets the exact (language_code, match_type, match_text) tuple
-- of each B1 row — safe to run even if the forward migration was only
-- partially applied (zero matching rows is a no-op, not an error), and
-- safe to run twice.
--
-- DATA LOSS WARNING: if any later phase's code has already started
-- relying on these two rows to classify new/modified Civitatis bookings,
-- removing them will cause the Istanbul Portuguese "Tour com"/"Tour sem"
-- Activity family to classify as meal_status='unknown' again going
-- forward. It does NOT retroactively change any reservation's already-
-- persisted meal_status — that would require a separate, explicit
-- re-classification pass, never performed implicitly by this rollback.
--
-- HOW TO APPLY
-- ─────────────────────────────────────────────────────────────
-- Supabase Dashboard → SQL Editor → paste and run this file IN FULL, in
-- a single execution. Wrapped in BEGIN/COMMIT so a failed postflight
-- aborts the whole rollback rather than leaving it partial.
-- ============================================================


BEGIN;

-- ──────────────────────────────────────────────────────────────────────────
-- STEP 1: delete exactly the two B1 rows, by their full identifying tuple.
-- ──────────────────────────────────────────────────────────────────────────

DELETE FROM public.civitatis_activity_modality_map
 WHERE language_code = 'pt' AND match_type = 'suffix_exact'
   AND match_text IN (
     'Visita guiada pela Istambul imprescindível - Tour com',
     'Visita guiada pela Istambul imprescindível - Tour sem'
   );


-- ──────────────────────────────────────────────────────────────────────────
-- POSTFLIGHT: confirm both B1 rows are gone, Phase A's two original rows
-- are STILL present and unaltered, the table itself still exists, and
-- both Civitatis RPC signatures remain unchanged. Aborts the whole
-- transaction on any unexpected state.
-- ──────────────────────────────────────────────────────────────────────────

DO $$
DECLARE
  v_problems TEXT[] := '{}';
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.civitatis_activity_modality_map
     WHERE language_code = 'pt' AND match_type = 'suffix_exact'
       AND match_text IN (
         'Visita guiada pela Istambul imprescindível - Tour com',
         'Visita guiada pela Istambul imprescindível - Tour sem'
       )
  ) THEN
    v_problems := array_append(v_problems, 'at least one B1 row still exists');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='civitatis_activity_modality_map') THEN
    v_problems := array_append(v_problems, 'civitatis_activity_modality_map table was removed — out of scope, must never happen');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.civitatis_activity_modality_map
     WHERE language_code = 'pt' AND match_type = 'contains' AND match_text = 'com almoço'
       AND meal_status = 'included' AND is_active = TRUE
  ) THEN
    v_problems := array_append(v_problems, 'Phase A original row pt/contains/''com almoço''/included was removed or altered — out of scope, must never happen');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.civitatis_activity_modality_map
     WHERE language_code = 'pt' AND match_type = 'contains' AND match_text = 'sem almoço'
       AND meal_status = 'not_included' AND is_active = TRUE
  ) THEN
    v_problems := array_append(v_problems, 'Phase A original row pt/contains/''sem almoço''/not_included was removed or altered — out of scope, must never happen');
  END IF;

  IF array_length(v_problems, 1) > 0 THEN
    RAISE EXCEPTION 'PHASE B1 ROLLBACK POSTFLIGHT FAILED: %. Aborting — re-run this ENTIRE file in a single execution.', array_to_string(v_problems, ', ');
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
    RAISE EXCEPTION 'PHASE B1 ROLLBACK POSTFLIGHT FAILED: public.ingest_civitatis_booking signature changed or the function disappeared during this rollback. This must never happen — aborting.';
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
    RAISE EXCEPTION 'PHASE B1 ROLLBACK POSTFLIGHT FAILED: public.cancel_civitatis_booking signature changed or the function disappeared during this rollback. This must never happen — aborting.';
  END IF;

  RAISE NOTICE 'PHASE B1 ROLLBACK POSTFLIGHT PASSED: both B1 rows confirmed removed; Phase A''s two original rows confirmed intact; civitatis_activity_modality_map table confirmed untouched structurally; both Civitatis RPCs unchanged.';
END $$;

COMMIT;

-- ============================================================
-- END OF ROLLBACK supabase_migration_civitatis_activity_modality_phase_b1_ROLLBACK.sql
-- ============================================================
