-- ============================================================
-- DESE TOUR OPERATIONS CENTER
-- Rollback: Civitatis Settlement Engine — Phase 2
-- ============================================================
-- File:    supabase_migration_civitatis_settlement_phase2_ROLLBACK.sql
-- Rolls back ONLY: supabase_migration_civitatis_settlement_phase2.sql
-- NOT executed. Provided for manual review and manual execution only.
--
-- SCOPE — WHAT THIS ROLLS BACK, AND NOTHING ELSE
-- ─────────────────────────────────────────────────────────────
-- Removes EXACTLY the objects the forward migration created:
--   1. fn_mark_civitatis_settlement_period_requested(DATE) — dropped.
--   2. fn_mark_civitatis_settlement_period_paid(DATE) — dropped.
--   3. civitatis_settlement_items.requested_at — dropped.
--   4. civitatis_settlement_items.paid_at — dropped.
-- Dropping both columns necessarily discards any requested_at/paid_at
-- values already recorded by staff using Phase 2 — this is an accepted,
-- explicit consequence of rolling back an additive column, the same as
-- every other additive-column rollback in this project. It does NOT
-- revert any item's status/original_amount/original_currency/
-- settlement_period/reservation_id/claimable_at — those were never
-- touched by anything this rollback is undoing.
--
-- THIS ROLLBACK DOES NOT TOUCH, AND MUST NEVER BE MADE TO TOUCH:
--   • civitatis_settlement_items.status, original_amount,
--     original_currency, settlement_period, reservation_id,
--     claimable_at, exchange_rate_used, exchange_rate_date, try_amount,
--     created_at, updated_at — none of these columns exist because of
--     Phase 2 and none are dropped or altered here.
--   • public.civitatis_settlement_items itself, public.exchange_rates,
--     fn_ensure_civitatis_settlement_item, fn_cancel_civitatis_
--     settlement_item_if_exists, or the Phase 1 trigger — all Phase 1
--     objects, entirely out of this rollback's scope.
--   • public.reservations, public.payments, reservations.payment_status
--     — never referenced by the forward migration or here.
--   • activity_logs — no CHECK constraint was added or changed by the
--     forward migration (entity_type 'civitatis_settlement' and action
--     'status_changed' were both already valid before Phase 2), so
--     there is nothing to revert here. Every row Phase 2's functions
--     already logged remains exactly as it is (activity_logs is
--     append-only by design).
--
-- SAFETY
-- ─────────────────────────────────────────────────────────────
-- DROP FUNCTION/COLUMN IF EXISTS throughout — safe to run even if the
-- forward migration was only partially applied, and safe to run twice
-- (second run finds nothing left to drop, no error).
--
-- HOW TO APPLY
-- ─────────────────────────────────────────────────────────────
-- Supabase Dashboard → SQL Editor → paste and run this file IN FULL, in
-- a single execution. Wrapped in an explicit BEGIN/COMMIT.
-- ============================================================

BEGIN;

DROP FUNCTION IF EXISTS public.fn_mark_civitatis_settlement_period_requested(DATE);
DROP FUNCTION IF EXISTS public.fn_mark_civitatis_settlement_period_paid(DATE);

ALTER TABLE public.civitatis_settlement_items
  DROP COLUMN IF EXISTS requested_at,
  DROP COLUMN IF EXISTS paid_at;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='civitatis_settlement_items' AND column_name='requested_at') THEN
    RAISE EXCEPTION 'CIVITATIS SETTLEMENT PHASE 2 ROLLBACK POSTFLIGHT FAILED: requested_at still exists after DROP. Aborting.';
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='civitatis_settlement_items' AND column_name='paid_at') THEN
    RAISE EXCEPTION 'CIVITATIS SETTLEMENT PHASE 2 ROLLBACK POSTFLIGHT FAILED: paid_at still exists after DROP. Aborting.';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='fn_mark_civitatis_settlement_period_requested') THEN
    RAISE EXCEPTION 'CIVITATIS SETTLEMENT PHASE 2 ROLLBACK POSTFLIGHT FAILED: fn_mark_civitatis_settlement_period_requested still exists after DROP. Aborting.';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='fn_mark_civitatis_settlement_period_paid') THEN
    RAISE EXCEPTION 'CIVITATIS SETTLEMENT PHASE 2 ROLLBACK POSTFLIGHT FAILED: fn_mark_civitatis_settlement_period_paid still exists after DROP. Aborting.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='civitatis_settlement_items') THEN
    RAISE EXCEPTION 'CIVITATIS SETTLEMENT PHASE 2 ROLLBACK POSTFLIGHT FAILED: civitatis_settlement_items table disappeared — out of scope, must never happen. Aborting.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='reservations') THEN
    RAISE EXCEPTION 'CIVITATIS SETTLEMENT PHASE 2 ROLLBACK POSTFLIGHT FAILED: reservations table disappeared — out of scope, must never happen. Aborting.';
  END IF;
  RAISE NOTICE 'CIVITATIS SETTLEMENT PHASE 2 ROLLBACK POSTFLIGHT PASSED: requested_at/paid_at and both transition functions removed; civitatis_settlement_items status/amount/currency/period/reservation_id/claimable_at and all other tables untouched.';
END $$;

COMMIT;

-- ============================================================
-- END OF ROLLBACK supabase_migration_civitatis_settlement_phase2_ROLLBACK.sql
-- ============================================================
