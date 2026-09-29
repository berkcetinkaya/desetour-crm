-- ============================================================
-- DESE TOUR OPERATIONS CENTER
-- Rollback: Tour Information Center — schema, Phase 1
-- ============================================================
-- File:    supabase_migration_tour_information_center_ROLLBACK.sql
-- Rolls back ONLY: supabase_migration_tour_information_center.sql
-- NOT executed. Provided for manual review and manual execution only.
--
-- SCOPE — WHAT THIS ROLLS BACK, AND NOTHING ELSE
-- ─────────────────────────────────────────────────────────────
-- Removes EXACTLY the two kinds of object the forward migration created:
--   1. public.tour_itinerary_stops — dropped entirely (table, its
--      indexes, trigger, and RLS policies all go with it).
--   2. The ten new nullable tours columns added by the forward migration:
--        meeting_instructions_tr, end_point_tr, accessibility_info_tr,
--        pets_policy_tr, booking_cutoff_text, free_cancellation_text,
--        late_cancellation_text, no_show_policy_text,
--        other_conditions_tr, guide_notes_tr.
--
-- THIS ROLLBACK DOES NOT TOUCH, AND MUST NEVER BE MADE TO TOUCH:
--   • tours.description   — reused, not created, by the forward
--     migration; pre-existed it entirely. Its "Genel Bakış" UI label (if
--     any application code has been changed to show one) is a frontend
--     concern, not reversed by dropping a column that was never added.
--   • tours.notes         — was never written to by the forward
--     migration and is not written to here either. Its one existing
--     "Deneme" test value, and any real value any tour may have by the
--     time this rollback is run, is completely unaffected.
--   • tours.duration_text, tours.meeting_point, tours.included_items,
--     tours.excluded_items — all pre-existed the forward migration,
--     reused as-is, never altered by it, never touched here.
--   • public.tour_languages, public.tour_channels — untouched by the
--     forward migration, untouched here.
--   • public.ingest_civitatis_booking / any V10-V13.1 object — never
--     referenced for modification by the forward migration, never
--     referenced for modification here.
--
-- SAFETY
-- ─────────────────────────────────────────────────────────────
-- DROP TABLE IF EXISTS / DROP COLUMN IF EXISTS throughout — safe to run
-- even if the forward migration was only partially applied, and safe to
-- run twice (second run finds nothing left to drop, no error).
--
-- DATA LOSS WARNING: dropping tour_itinerary_stops and the ten tours
-- columns is destructive to whatever content an editor may have entered
-- into the Tour Information Center since the forward migration was
-- applied (e.g. the Grand Bazaar Spanish itinerary/guide notes, once
-- populated). Only run this rollback if that loss is acceptable —
-- there is no soft-delete/archive step here, matching the explicit
-- instruction that this file must ONLY remove the objects the forward
-- migration introduced, nothing more, nothing softer.
--
-- No SQL in this file has been executed. No Supabase connection was made
-- to produce it.
--
-- HOW TO APPLY
-- ─────────────────────────────────────────────────────────────
-- Supabase Dashboard → SQL Editor → paste and run this file IN FULL, in
-- a single execution. Wrapped in BEGIN/COMMIT so a failed postflight
-- aborts the whole rollback rather than leaving it partial.
-- ============================================================


BEGIN;

-- ──────────────────────────────────────────────────────────────────────────
-- STEP 1: drop tour_itinerary_stops entirely — table, indexes, trigger,
-- and every RLS policy on it go with the table (PostgreSQL drops
-- dependent policies/indexes/triggers automatically with DROP TABLE; no
-- separate DROP POLICY/DROP INDEX/DROP TRIGGER statements are needed or
-- issued here).
-- ──────────────────────────────────────────────────────────────────────────

DROP TABLE IF EXISTS public.tour_itinerary_stops;


-- ──────────────────────────────────────────────────────────────────────────
-- STEP 2: drop ONLY the ten columns the forward migration added to
-- tours. Every other column on tours — including description, notes,
-- duration_text, meeting_point, included_items, excluded_items, and
-- every column that predates this feature entirely — is deliberately
-- absent from this statement.
-- ──────────────────────────────────────────────────────────────────────────

ALTER TABLE public.tours
  DROP COLUMN IF EXISTS meeting_instructions_tr,
  DROP COLUMN IF EXISTS end_point_tr,
  DROP COLUMN IF EXISTS accessibility_info_tr,
  DROP COLUMN IF EXISTS pets_policy_tr,
  DROP COLUMN IF EXISTS booking_cutoff_text,
  DROP COLUMN IF EXISTS free_cancellation_text,
  DROP COLUMN IF EXISTS late_cancellation_text,
  DROP COLUMN IF EXISTS no_show_policy_text,
  DROP COLUMN IF EXISTS other_conditions_tr,
  DROP COLUMN IF EXISTS guide_notes_tr;


-- ──────────────────────────────────────────────────────────────────────────
-- POSTFLIGHT: confirm every object this rollback was supposed to remove
-- is actually gone, and — just as importantly — confirm every object it
-- must NEVER touch is still exactly present. Aborts the whole
-- transaction on any unexpected state.
-- ──────────────────────────────────────────────────────────────────────────

DO $$
DECLARE
  v_problems TEXT[] := '{}';
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='tour_itinerary_stops') THEN
    v_problems := array_append(v_problems, 'tour_itinerary_stops still exists');
  END IF;

  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='tours' AND column_name='meeting_instructions_tr') THEN v_problems := array_append(v_problems, 'tours.meeting_instructions_tr still exists'); END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='tours' AND column_name='end_point_tr') THEN v_problems := array_append(v_problems, 'tours.end_point_tr still exists'); END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='tours' AND column_name='accessibility_info_tr') THEN v_problems := array_append(v_problems, 'tours.accessibility_info_tr still exists'); END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='tours' AND column_name='pets_policy_tr') THEN v_problems := array_append(v_problems, 'tours.pets_policy_tr still exists'); END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='tours' AND column_name='booking_cutoff_text') THEN v_problems := array_append(v_problems, 'tours.booking_cutoff_text still exists'); END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='tours' AND column_name='free_cancellation_text') THEN v_problems := array_append(v_problems, 'tours.free_cancellation_text still exists'); END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='tours' AND column_name='late_cancellation_text') THEN v_problems := array_append(v_problems, 'tours.late_cancellation_text still exists'); END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='tours' AND column_name='no_show_policy_text') THEN v_problems := array_append(v_problems, 'tours.no_show_policy_text still exists'); END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='tours' AND column_name='other_conditions_tr') THEN v_problems := array_append(v_problems, 'tours.other_conditions_tr still exists'); END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='tours' AND column_name='guide_notes_tr') THEN v_problems := array_append(v_problems, 'tours.guide_notes_tr still exists'); END IF;

  -- Out-of-scope objects must remain untouched.
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='tours' AND column_name='description') THEN v_problems := array_append(v_problems, 'tours.description was removed — out of scope, must never happen'); END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='tours' AND column_name='notes') THEN v_problems := array_append(v_problems, 'tours.notes was removed — out of scope, must never happen'); END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='tours' AND column_name='duration_text') THEN v_problems := array_append(v_problems, 'tours.duration_text was removed — out of scope, must never happen'); END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='tours' AND column_name='meeting_point') THEN v_problems := array_append(v_problems, 'tours.meeting_point was removed — out of scope, must never happen'); END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='tours' AND column_name='included_items') THEN v_problems := array_append(v_problems, 'tours.included_items was removed — out of scope, must never happen'); END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='tours' AND column_name='excluded_items') THEN v_problems := array_append(v_problems, 'tours.excluded_items was removed — out of scope, must never happen'); END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='tour_languages') THEN v_problems := array_append(v_problems, 'tour_languages was removed — out of scope, must never happen'); END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='tour_channels') THEN v_problems := array_append(v_problems, 'tour_channels was removed — out of scope, must never happen'); END IF;

  IF array_length(v_problems, 1) > 0 THEN
    RAISE EXCEPTION 'TOUR INFO CENTER ROLLBACK POSTFLIGHT FAILED: %. Aborting — re-run this ENTIRE file in a single execution.', array_to_string(v_problems, ', ');
  END IF;

  RAISE NOTICE 'TOUR INFO CENTER ROLLBACK POSTFLIGHT PASSED: tour_itinerary_stops and all ten new tours columns removed; description/notes/duration_text/meeting_point/included_items/excluded_items/tour_languages/tour_channels all confirmed untouched.';
END $$;

COMMIT;

-- ============================================================
-- END OF ROLLBACK supabase_migration_tour_information_center_ROLLBACK.sql
-- ============================================================
