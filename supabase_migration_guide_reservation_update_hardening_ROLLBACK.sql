-- ============================================================
-- DESE TOUR OPERATIONS CENTER
-- Rollback: Guide Reservation UPDATE Column Hardening (Security Foundation Phase 1)
-- ============================================================
-- File:    supabase_migration_guide_reservation_update_hardening_ROLLBACK.sql
-- Rolls back ONLY: supabase_migration_guide_reservation_update_hardening.sql
-- NOT executed. Provided for manual review and manual execution only.
--
-- SCOPE — WHAT THIS ROLLS BACK, AND NOTHING ELSE
-- ─────────────────────────────────────────────────────────────
-- Removes EXACTLY the two objects the forward migration created:
--   1. trg_reservations_guide_column_guard — dropped FIRST (a trigger
--      must be dropped before the function it depends on, otherwise
--      DROP FUNCTION fails with "cannot drop function ... because other
--      objects depend on it").
--   2. public.enforce_guide_reservation_update_columns() — dropped second.
--
-- This reopens the exact gap the forward migration closed: a guide
-- would once again be able to change any column (not just
-- guide_id/guide_name/pickup_location/pickup_time/status/completed_at)
-- on their own assigned reservation via a direct REST/PATCH call, same
-- as before this migration existed. The existing row-level RLS policy
-- ("reservations: guide update own status") is NOT part of this
-- rollback and is NOT affected — rolling back only returns to the
-- state the audit already found, it does not remove any pre-existing
-- protection.
--
-- THIS ROLLBACK DOES NOT TOUCH, AND MUST NEVER BE MADE TO TOUCH:
--   • public.reservations' own table, its columns, its data, its
--     indexes, its CHECK constraints, or its pre-existing
--     trg_reservations_updated_at trigger / set_updated_at() function —
--     all created elsewhere, never referenced for modification here.
--   • Any existing RLS policy on reservations (supabase_rls_policies.sql:
--     406-456) — never created or touched by the forward migration,
--     never touched here.
--   • public.get_current_staff_role() / is_admin() / is_sales() /
--     is_operations() / is_guide() — SHARED helper functions this
--     migration's trigger CALLED but never created; this rollback drops
--     only the trigger and the ONE function this migration itself
--     created, never these shared helpers.
--   • Any other existing table, function, trigger, or policy.
--
-- SAFETY
-- ─────────────────────────────────────────────────────────────
-- DROP TRIGGER IF EXISTS / DROP FUNCTION IF EXISTS — safe to run even if
-- the forward migration was only partially applied, and safe to run
-- twice (second run finds nothing left to drop, no error).
--
-- HOW TO APPLY
-- ─────────────────────────────────────────────────────────────
-- Supabase Dashboard → SQL Editor → paste and run this file IN FULL, in
-- a single execution. Wrapped in an explicit BEGIN/COMMIT.
-- ============================================================

BEGIN;

DROP TRIGGER IF EXISTS trg_reservations_guide_column_guard ON public.reservations;
DROP FUNCTION IF EXISTS public.enforce_guide_reservation_update_columns();

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_reservations_guide_column_guard' AND NOT tgisinternal) THEN
    RAISE EXCEPTION 'GUIDE RESERVATION HARDENING ROLLBACK POSTFLIGHT FAILED: trg_reservations_guide_column_guard still exists after DROP. Aborting.';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'enforce_guide_reservation_update_columns') THEN
    RAISE EXCEPTION 'GUIDE RESERVATION HARDENING ROLLBACK POSTFLIGHT FAILED: enforce_guide_reservation_update_columns() still exists after DROP. Aborting.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='reservations') THEN
    RAISE EXCEPTION 'GUIDE RESERVATION HARDENING ROLLBACK POSTFLIGHT FAILED: reservations table disappeared — out of scope, must never happen. Aborting.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_reservations_updated_at' AND NOT tgisinternal) THEN
    RAISE EXCEPTION 'GUIDE RESERVATION HARDENING ROLLBACK POSTFLIGHT FAILED: pre-existing trg_reservations_updated_at disappeared — out of scope, must never happen. Aborting.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'is_guide') THEN
    RAISE EXCEPTION 'GUIDE RESERVATION HARDENING ROLLBACK POSTFLIGHT FAILED: shared function is_guide() disappeared — out of scope, must never happen. Aborting.';
  END IF;
  RAISE NOTICE 'GUIDE RESERVATION HARDENING ROLLBACK POSTFLIGHT PASSED: guard trigger and function removed; reservations table, its existing trigger, and all shared helper functions untouched.';
END $$;

COMMIT;

-- ============================================================
-- END OF ROLLBACK supabase_migration_guide_reservation_update_hardening_ROLLBACK.sql
-- ============================================================
