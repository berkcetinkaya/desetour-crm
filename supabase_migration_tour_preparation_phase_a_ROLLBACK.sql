-- ============================================================
-- DESE TOUR OPERATIONS CENTER
-- Rollback: Tour Preparation Intelligence — Phase A, Database Foundation
-- ============================================================
-- File:    supabase_migration_tour_preparation_phase_a_ROLLBACK.sql
-- Rolls back ONLY: supabase_migration_tour_preparation_phase_a.sql
-- NOT executed. Provided for manual review and manual execution only.
--
-- SCOPE — WHAT THIS ROLLS BACK, AND NOTHING ELSE
-- ─────────────────────────────────────────────────────────────
-- Removes EXACTLY the objects the forward migration created:
--   1. public.reservation_preparations — dropped entirely (table, its
--      indexes, trigger, RLS policies, and CHECK constraints all go
--      with it).
--   2. public.tour_preparation_rules    — dropped entirely.
--   3. public.civitatis_activity_modality_map — dropped entirely
--      (including its 2 seed rows).
--   4. reservations.purchased_activity_raw, reservations.meal_status —
--      the two new columns, and reservations_meal_status_check.
--
-- DROP ORDER MATTERS: reservation_preparations holds a foreign key INTO
-- tour_preparation_rules (preparation_rule_id), so it is dropped first.
-- No CASCADE is used anywhere in this file; every DROP TABLE is
-- unblocked by ordering alone, so a partial/unexpected cascade onto
-- unrelated objects is structurally impossible.
--
-- THIS ROLLBACK DOES NOT TOUCH, AND MUST NEVER BE MADE TO TOUCH:
--   • Every other reservations column (reservation_number, status,
--     payment_status, pax_adult/pax_child, tour_language, retail_amount/
--     retail_currency, source_id/external_booking_id, etc.) — only
--     purchased_activity_raw/meal_status/reservations_meal_status_check
--     are ever referenced for removal here.
--   • public.tours, public.tour_itinerary_stops, and every one of the
--     ten Tour Information Center columns — only ever referenced BY
--     tour_preparation_rules' now-dropped foreign keys; nothing in
--     tours/tour_itinerary_stops is altered, and no row in either is
--     read, updated, or deleted by this file.
--   • public.staff_users — only ever referenced BY reservation_
--     preparations.completed_by's now-dropped foreign key.
--   • public.ingest_civitatis_booking / public.cancel_civitatis_booking
--     — never referenced for modification by the forward migration
--     (only read-only signature checks), never referenced for
--     modification here (this file re-verifies them unchanged in its
--     own postflight, the same discipline as every prior rollback).
--   • Every WhatsApp Phase 1.2 object (whatsapp_messages,
--     whatsapp_destinations, whatsapp_destination_recipients,
--     tour_channels.review_url, claim_whatsapp_outbox_batch) — never
--     referenced anywhere in the forward migration, never referenced
--     here.
--   • Every RLS helper function (is_admin/is_operations/is_guide) and
--     public.set_updated_at() — reused, never redefined or dropped by
--     either file.
--
-- SAFETY
-- ─────────────────────────────────────────────────────────────
-- DROP TABLE IF EXISTS / DROP COLUMN IF EXISTS / DROP CONSTRAINT IF
-- EXISTS throughout — safe to run even if the forward migration was
-- only partially applied, and safe to run twice (second run finds
-- nothing left to drop, no error).
--
-- DATA LOSS WARNING — READ BEFORE RUNNING
-- ─────────────────────────────────────────────────────────────
-- If any operational data has been entered since the forward migration
-- was applied — any tour_preparation_rules row configured by staff, any
-- reservation_preparations row materialized/completed by a later phase,
-- any additional civitatis_activity_modality_map rule added beyond the
-- two seed rows, or any reservations.purchased_activity_raw/meal_status
-- value resolved by a later phase — THIS ROLLBACK PERMANENTLY DESTROYS
-- IT. There is no soft-delete/archive step here, matching every prior
-- rollback's own convention (e.g. supabase_migration_whatsapp_core_
-- ROLLBACK.sql, supabase_migration_whatsapp_outbox_claim_ROLLBACK.sql).
-- Only run this rollback if that loss is acceptable. If Phase A has been
-- applied for any length of time in an environment where staff may have
-- started configuring rules or completing preparations, confirm with
-- operations before running this.
--
-- HOW TO APPLY
-- ─────────────────────────────────────────────────────────────
-- Supabase Dashboard → SQL Editor → paste and run this file IN FULL, in
-- a single execution. Wrapped in BEGIN/COMMIT so a failed postflight
-- aborts the whole rollback rather than leaving it partial.
-- ============================================================


BEGIN;

-- ──────────────────────────────────────────────────────────────────────────
-- STEP 1: drop reservation_preparations first (holds an FK into
-- tour_preparation_rules).
-- ──────────────────────────────────────────────────────────────────────────

DROP TABLE IF EXISTS public.reservation_preparations;

-- ──────────────────────────────────────────────────────────────────────────
-- STEP 2: drop tour_preparation_rules.
-- ──────────────────────────────────────────────────────────────────────────

DROP TABLE IF EXISTS public.tour_preparation_rules;

-- ──────────────────────────────────────────────────────────────────────────
-- STEP 3: drop civitatis_activity_modality_map (including its seed rows).
-- ──────────────────────────────────────────────────────────────────────────

DROP TABLE IF EXISTS public.civitatis_activity_modality_map;

-- ──────────────────────────────────────────────────────────────────────────
-- STEP 4: drop the reservations.meal_status CHECK, then both columns.
-- ──────────────────────────────────────────────────────────────────────────

ALTER TABLE public.reservations DROP CONSTRAINT IF EXISTS reservations_meal_status_check;

ALTER TABLE public.reservations
  DROP COLUMN IF EXISTS purchased_activity_raw,
  DROP COLUMN IF EXISTS meal_status;


-- ──────────────────────────────────────────────────────────────────────────
-- POSTFLIGHT: confirm every object this rollback was supposed to remove
-- is actually gone, and — just as importantly — confirm every object
-- this rollback must NEVER touch is still exactly present. Aborts the
-- whole transaction on any unexpected state.
-- ──────────────────────────────────────────────────────────────────────────

DO $$
DECLARE
  v_problems TEXT[] := '{}';
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='reservation_preparations') THEN
    v_problems := array_append(v_problems, 'reservation_preparations still exists');
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='tour_preparation_rules') THEN
    v_problems := array_append(v_problems, 'tour_preparation_rules still exists');
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='civitatis_activity_modality_map') THEN
    v_problems := array_append(v_problems, 'civitatis_activity_modality_map still exists');
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='reservations' AND column_name='purchased_activity_raw') THEN
    v_problems := array_append(v_problems, 'reservations.purchased_activity_raw still exists');
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='reservations' AND column_name='meal_status') THEN
    v_problems := array_append(v_problems, 'reservations.meal_status still exists');
  END IF;
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'reservations_meal_status_check') THEN
    v_problems := array_append(v_problems, 'reservations_meal_status_check still exists');
  END IF;

  -- Out-of-scope objects must remain untouched.
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='reservations') THEN v_problems := array_append(v_problems, 'reservations table was removed — out of scope, must never happen'); END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='tours') THEN v_problems := array_append(v_problems, 'tours table was removed — out of scope, must never happen'); END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='tour_itinerary_stops') THEN v_problems := array_append(v_problems, 'tour_itinerary_stops table was removed — out of scope, must never happen'); END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='tour_itinerary_stops' AND column_name='place_name') THEN v_problems := array_append(v_problems, 'tour_itinerary_stops.place_name was removed — out of scope, must never happen'); END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='staff_users') THEN v_problems := array_append(v_problems, 'staff_users table was removed — out of scope, must never happen'); END IF;
  -- WhatsApp Phase 1.2 objects (if present in this environment) must be untouched.
  IF to_regclass('public.whatsapp_messages') IS NOT NULL AND NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='whatsapp_messages') THEN v_problems := array_append(v_problems, 'whatsapp_messages was removed — out of scope, must never happen'); END IF;

  IF array_length(v_problems, 1) > 0 THEN
    RAISE EXCEPTION 'TOUR PREPARATION PHASE A ROLLBACK POSTFLIGHT FAILED: %. Aborting — re-run this ENTIRE file in a single execution.', array_to_string(v_problems, ', ');
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
    RAISE EXCEPTION 'TOUR PREPARATION PHASE A ROLLBACK POSTFLIGHT FAILED: public.ingest_civitatis_booking signature changed or the function disappeared during this rollback. This must never happen — aborting.';
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
    RAISE EXCEPTION 'TOUR PREPARATION PHASE A ROLLBACK POSTFLIGHT FAILED: public.cancel_civitatis_booking signature changed or the function disappeared during this rollback. This must never happen — aborting.';
  END IF;

  RAISE NOTICE 'TOUR PREPARATION PHASE A ROLLBACK POSTFLIGHT PASSED: reservation_preparations/tour_preparation_rules/civitatis_activity_modality_map confirmed removed; reservations.purchased_activity_raw/meal_status confirmed removed; reservations/tours/tour_itinerary_stops/staff_users all confirmed untouched; both Civitatis RPCs unchanged.';
END $$;

COMMIT;

-- ============================================================
-- END OF ROLLBACK supabase_migration_tour_preparation_phase_a_ROLLBACK.sql
-- ============================================================
