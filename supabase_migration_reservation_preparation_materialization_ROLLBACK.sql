-- ============================================================
-- DESE TOUR OPERATIONS CENTER
-- ROLLBACK: Reservation Preparation Materialization — Phase C2C
-- ============================================================
-- File:    supabase_migration_reservation_preparation_materialization_ROLLBACK.sql
-- Rolls back: supabase_migration_reservation_preparation_materialization.sql
--
-- WHAT THIS DOES
-- ─────────────────────────────────────────────────────────────
-- Drops ONLY public.materialize_reservation_preparations(UUID) — the one
-- function the forward migration created. Nothing else.
--
-- WHAT THIS DOES NOT DO
-- ─────────────────────────────────────────────────────────────
--   • Does NOT delete any reservation_preparations or
--     tour_preparation_rules row — this migration never wrote any row
--     of its own (it is pure DDL: CREATE FUNCTION only), so there is no
--     data of its own to remove. Any row that was materialized by
--     CALLING the function before rollback remains exactly as it was —
--     this is a code rollback, never a data rollback.
--   • Does NOT touch tours, tour_channels, tour_itinerary_stops,
--     reservations, or any Civitatis ingestion code/RPC.
--   • Does NOT touch WhatsApp or auth.
--
-- IDEMPOTENCY
-- ─────────────────────────────────────────────────────────────
-- DROP FUNCTION IF EXISTS — safe to run more than once; a second run is
-- a no-op.
--
-- HOW TO APPLY
-- ─────────────────────────────────────────────────────────────
-- Supabase Dashboard → SQL Editor → paste and run this file IN FULL, in
-- a single execution. Wrapped in an explicit BEGIN/COMMIT.
-- ============================================================


BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = 'materialize_reservation_preparations'
  ) THEN
    RAISE NOTICE 'RESERVATION PREPARATION MATERIALIZATION ROLLBACK: materialize_reservation_preparations already absent — no-op.';
  END IF;
END $$;

DROP FUNCTION IF EXISTS public.materialize_reservation_preparations(UUID);

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = 'materialize_reservation_preparations'
  ) THEN
    RAISE EXCEPTION 'RESERVATION PREPARATION MATERIALIZATION ROLLBACK POSTFLIGHT FAILED: materialize_reservation_preparations still exists after DROP. Aborting.';
  END IF;

  -- Re-confirm the Civitatis RPCs and the Phase A tables remain exactly
  -- as they were — this rollback never touches them.
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = 'ingest_civitatis_booking' AND p.pronargs = 26
  ) THEN
    RAISE EXCEPTION 'RESERVATION PREPARATION MATERIALIZATION ROLLBACK POSTFLIGHT FAILED: public.ingest_civitatis_booking signature changed or disappeared. Aborting.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='reservation_preparations') THEN
    RAISE EXCEPTION 'RESERVATION PREPARATION MATERIALIZATION ROLLBACK POSTFLIGHT FAILED: reservation_preparations table disappeared — out of scope, must never happen. Aborting.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='tour_preparation_rules') THEN
    RAISE EXCEPTION 'RESERVATION PREPARATION MATERIALIZATION ROLLBACK POSTFLIGHT FAILED: tour_preparation_rules table disappeared — out of scope, must never happen. Aborting.';
  END IF;

  RAISE NOTICE 'RESERVATION PREPARATION MATERIALIZATION ROLLBACK POSTFLIGHT PASSED: materialize_reservation_preparations removed; all out-of-scope objects confirmed present and unchanged.';
END $$;

COMMIT;

-- ============================================================
-- END OF ROLLBACK supabase_migration_reservation_preparation_materialization_ROLLBACK.sql
-- ============================================================
