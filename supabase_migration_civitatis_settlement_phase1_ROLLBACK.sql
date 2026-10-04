-- ============================================================
-- DESE TOUR OPERATIONS CENTER
-- Rollback: Civitatis Settlement Engine — Phase 1 Foundation
-- ============================================================
-- File:    supabase_migration_civitatis_settlement_phase1_ROLLBACK.sql
-- Rolls back ONLY: supabase_migration_civitatis_settlement_phase1.sql
-- NOT executed. Provided for manual review and manual execution only.
--
-- SCOPE — WHAT THIS ROLLS BACK, AND NOTHING ELSE
-- ─────────────────────────────────────────────────────────────
-- Removes EXACTLY the objects the forward migration created:
--   1. trg_civitatis_settlement_on_reservation_change (trigger ON
--      public.reservations) — dropped first, before its function, so
--      nothing can fire mid-rollback.
--   2. fn_trg_civitatis_settlement_on_reservation_change,
--      fn_ensure_civitatis_settlement_item,
--      fn_cancel_civitatis_settlement_item_if_exists — all three
--      functions dropped.
--   3. public.civitatis_settlement_items — dropped entirely (table, its
--      indexes, trigger, RLS policies, CHECK constraints).
--   4. public.exchange_rates — dropped entirely.
--   5. activity_logs_entity_type_check — reverted to the exact list the
--      PRIOR migration (tour_channels) left it at, removing ONLY the
--      'civitatis_settlement' value this migration added. Every row
--      already logged with entity_type='civitatis_settlement' is left
--      exactly as it is (activity_logs is append-only by design; this
--      rollback never deletes or updates any existing log row) — simply
--      note that re-inserting a new row with that entity_type would fail
--      the constraint again after this rollback, which is correct.
--
-- THIS ROLLBACK DOES NOT TOUCH, AND MUST NEVER BE MADE TO TOUCH:
--   • public.reservations — not one column, row, or constraint. The
--     forward migration's trigger reads reservations but never writes
--     to it (RETURN NEW with no field reassigned); this rollback only
--     removes the trigger/function, never reservations itself.
--   • public.payments, reservations.payment_status — never referenced
--     by the forward migration or here.
--   • public.ingest_civitatis_booking / the Civitatis cancellation RPC
--     — never referenced for modification by the forward migration,
--     never referenced here.
--   • Every existing activity_logs row — append-only; only the
--     CHECK CONSTRAINT's definition changes, never any row's data.
--   • Every other activity_logs.entity_type value already allowed
--     (customer/lead/quote/reservation/payment/task/reminder/tour/
--     message/settings/guide/guide_payment/reservation_review/
--     tour_language/tour_channel) — all remain allowed.
--
-- SAFETY
-- ─────────────────────────────────────────────────────────────
-- DROP TRIGGER/FUNCTION/TABLE IF EXISTS throughout — safe to run even
-- if the forward migration was only partially applied, and safe to run
-- twice (second run finds nothing left to drop, no error).
--
-- HOW TO APPLY
-- ─────────────────────────────────────────────────────────────
-- Supabase Dashboard → SQL Editor → paste and run this file IN FULL, in
-- a single execution. Wrapped in an explicit BEGIN/COMMIT.
-- ============================================================

BEGIN;

DROP TRIGGER IF EXISTS trg_civitatis_settlement_on_reservation_change ON public.reservations;
DROP FUNCTION IF EXISTS public.fn_trg_civitatis_settlement_on_reservation_change();
DROP FUNCTION IF EXISTS public.fn_ensure_civitatis_settlement_item(UUID);
DROP FUNCTION IF EXISTS public.fn_cancel_civitatis_settlement_item_if_exists(UUID);

DROP TABLE IF EXISTS public.civitatis_settlement_items;
DROP TABLE IF EXISTS public.exchange_rates;

-- Revert activity_logs.entity_type to exactly the list the PRIOR
-- migration (tour_channels) left it at — removes ONLY
-- 'civitatis_settlement'. Existing rows already carrying that value are
-- left untouched (append-only); only future inserts with that value
-- would now be rejected again, which is the correct rollback behavior.
--
-- PHASE 1.2A FIX — NOT VALID is required here, not optional. By the time
-- this rollback runs, the forward migration's own backfill has already
-- logged at least one activity_logs row with entity_type =
-- 'civitatis_settlement' for every settlement item it created (this is
-- the normal, expected case, not an edge case). A plain ADD CONSTRAINT
-- re-validates EVERY existing row against the new, narrower CHECK by
-- default, so without NOT VALID this statement itself fails with
-- "check constraint ... is violated by some row" and the whole rollback
-- transaction aborts, achieving nothing. NOT VALID adds the constraint
-- for all future INSERT/UPDATE activity without re-validating rows that
-- already exist, which is exactly the append-only guarantee stated
-- above: old 'civitatis_settlement' rows are left exactly as they are,
-- and the constraint still rejects any new one going forward.
ALTER TABLE public.activity_logs DROP CONSTRAINT IF EXISTS activity_logs_entity_type_check;
ALTER TABLE public.activity_logs ADD CONSTRAINT activity_logs_entity_type_check
  CHECK (entity_type IN (
    'customer','lead','quote','reservation','payment',
    'task','reminder','tour','message','settings',
    'guide','guide_payment','reservation_review',
    'tour_language','tour_channel'
  )) NOT VALID;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='civitatis_settlement_items') THEN
    RAISE EXCEPTION 'CIVITATIS SETTLEMENT PHASE 1 ROLLBACK POSTFLIGHT FAILED: civitatis_settlement_items still exists after DROP. Aborting.';
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='exchange_rates') THEN
    RAISE EXCEPTION 'CIVITATIS SETTLEMENT PHASE 1 ROLLBACK POSTFLIGHT FAILED: exchange_rates still exists after DROP. Aborting.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='reservations') THEN
    RAISE EXCEPTION 'CIVITATIS SETTLEMENT PHASE 1 ROLLBACK POSTFLIGHT FAILED: reservations table disappeared — out of scope, must never happen. Aborting.';
  END IF;
  RAISE NOTICE 'CIVITATIS SETTLEMENT PHASE 1 ROLLBACK POSTFLIGHT PASSED: civitatis_settlement_items and exchange_rates removed; reservations and all other tables untouched.';
END $$;

COMMIT;

-- ============================================================
-- END OF ROLLBACK supabase_migration_civitatis_settlement_phase1_ROLLBACK.sql
-- ============================================================
