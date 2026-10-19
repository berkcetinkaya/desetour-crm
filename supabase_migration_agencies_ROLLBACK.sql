-- ============================================================
-- DESE TOUR OPERATIONS CENTER
-- Rollback: Acenteler (B2B Agency Acquisition) — Phase 1 Foundation
-- ============================================================
-- File:    supabase_migration_agencies_ROLLBACK.sql
-- Rolls back ONLY: supabase_migration_agencies.sql
-- NOT executed. Provided for manual review and manual execution only.
--
-- SCOPE — WHAT THIS ROLLS BACK, AND NOTHING ELSE
-- ─────────────────────────────────────────────────────────────
-- Removes EXACTLY the objects the forward migration created:
--   1. public.agency_emails — dropped FIRST (it holds the
--      agency_id FK into agencies), table, its indexes, RLS
--      policies, and CHECK constraints all go with it.
--   2. public.agencies — dropped second (now that nothing
--      references it), table, its indexes, trigger, RLS
--      policies, and CHECK constraint all go with it.
--
-- THIS ROLLBACK DOES NOT TOUCH, AND MUST NEVER BE MADE TO TOUCH:
--   • public.customers, public.reservations, public.payments,
--     public.staff_users — never referenced for modification by
--     the forward migration or here. agencies.created_by /
--     agency_emails.created_by reference staff_users(id), but
--     ON DELETE SET NULL means dropping agencies/agency_emails
--     never cascades into staff_users — staff_users rows and all
--     other tables' created_by columns are completely unaffected.
--   • public.set_updated_at() — a SHARED trigger function used by
--     guides, reservations, and other existing tables. The forward
--     migration only attaches a NEW trigger (trg_agencies_updated_at)
--     to this shared function; it never created it. This rollback
--     drops ONLY that trigger (implicitly, as part of DROP TABLE
--     public.agencies) and never touches the function itself —
--     every other table's updated_at trigger keeps working exactly
--     as it did before.
--   • public.is_admin() / public.is_sales() / public.is_operations() /
--     public.is_guide() / public.get_current_staff_role() — all four
--     SHARED role-helper functions this migration's RLS policies
--     called but never created. Dropping agencies/agency_emails drops
--     only the POLICIES that referenced them (owned by those tables),
--     never the helper functions themselves — every other table's
--     policies that call these same helpers keep working exactly as
--     they did before.
--   • Any other existing table, function, or policy not listed above.
--
-- SAFETY
-- ─────────────────────────────────────────────────────────────
-- DROP TABLE IF EXISTS throughout — safe to run even if the forward
-- migration was only partially applied, and safe to run twice (second
-- run finds nothing left to drop, no error). Child table
-- (agency_emails) is dropped before its parent (agencies) so no
-- CASCADE is ever needed — an explicit, auditable drop order rather
-- than relying on cascade semantics to clean up a dependency.
--
-- HOW TO APPLY
-- ─────────────────────────────────────────────────────────────
-- Supabase Dashboard → SQL Editor → paste and run this file IN FULL, in
-- a single execution. Wrapped in an explicit BEGIN/COMMIT.
-- ============================================================

BEGIN;

DROP TABLE IF EXISTS public.agency_emails;
DROP TABLE IF EXISTS public.agencies;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='agency_emails') THEN
    RAISE EXCEPTION 'ACENTELER PHASE 1 ROLLBACK POSTFLIGHT FAILED: agency_emails still exists after DROP. Aborting.';
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='agencies') THEN
    RAISE EXCEPTION 'ACENTELER PHASE 1 ROLLBACK POSTFLIGHT FAILED: agencies still exists after DROP. Aborting.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='staff_users') THEN
    RAISE EXCEPTION 'ACENTELER PHASE 1 ROLLBACK POSTFLIGHT FAILED: staff_users table disappeared — out of scope, must never happen. Aborting.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'set_updated_at') THEN
    RAISE EXCEPTION 'ACENTELER PHASE 1 ROLLBACK POSTFLIGHT FAILED: shared function set_updated_at() disappeared — out of scope, must never happen. Aborting.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'is_admin') THEN
    RAISE EXCEPTION 'ACENTELER PHASE 1 ROLLBACK POSTFLIGHT FAILED: shared function is_admin() disappeared — out of scope, must never happen. Aborting.';
  END IF;
  RAISE NOTICE 'ACENTELER PHASE 1 ROLLBACK POSTFLIGHT PASSED: agencies and agency_emails removed; staff_users and every shared helper function untouched.';
END $$;

COMMIT;

-- ============================================================
-- END OF ROLLBACK supabase_migration_agencies_ROLLBACK.sql
-- ============================================================
