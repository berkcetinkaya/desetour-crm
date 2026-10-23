-- ============================================================
-- DESE TOUR OPERATIONS CENTER
-- Rollback: Agency Reply Notification RLS Gap (Operational Notifications)
-- ============================================================
-- File:    supabase_migration_agency_reply_notification_rls_ROLLBACK.sql
-- Rolls back ONLY: supabase_migration_agency_reply_notification_rls.sql
-- NOT executed. Provided for manual review and manual execution only.
--
-- SCOPE — WHAT THIS ROLLS BACK, AND NOTHING ELSE
-- ─────────────────────────────────────────────────────────────
-- Removes EXACTLY the one policy the forward migration created:
--   • "activity_logs: sales read agency_email auto_ingested"
--
-- This reopens the exact gap the forward migration closed: a sales-role
-- user will once again receive zero rows for auto-ingested Agency reply
-- (entity_type='agency_email') activity_logs rows, same as before this
-- migration existed.
--
-- THIS ROLLBACK DOES NOT TOUCH, AND MUST NEVER BE MADE TO TOUCH:
--   • "activity_logs: admin read all" / "activity_logs: sales read own" /
--     "activity_logs: operations read own" / "activity_logs: guide read
--     own" / "activity_logs: all staff insert" — every pre-existing
--     activity_logs policy, never created or touched by the forward
--     migration, never touched here.
--   • activity_log_reads or any of its own RLS policies.
--   • public.activity_logs' own table, columns, data, indexes, or CHECK
--     constraints.
--   • is_admin() / is_sales() / is_operations() / is_guide() / is_staff()
--     — SHARED helper functions this migration's policy CALLED but never
--     created; this rollback never touches them.
--
-- SAFETY
-- ─────────────────────────────────────────────────────────────
-- DROP POLICY IF EXISTS — safe to run even if the forward migration was
-- never applied, and safe to run twice (second run finds nothing left
-- to drop, no error).
--
-- HOW TO APPLY
-- ─────────────────────────────────────────────────────────────
-- Supabase Dashboard → SQL Editor → paste and run this file IN FULL, in
-- a single execution. Wrapped in an explicit BEGIN/COMMIT.
-- ============================================================

BEGIN;

DROP POLICY IF EXISTS "activity_logs: sales read agency_email auto_ingested" ON public.activity_logs;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='activity_logs' AND policyname='activity_logs: sales read agency_email auto_ingested') THEN
    RAISE EXCEPTION 'AGENCY REPLY NOTIFICATION RLS ROLLBACK POSTFLIGHT FAILED: policy still exists after DROP. Aborting.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='activity_logs' AND policyname='activity_logs: admin read all') THEN
    RAISE EXCEPTION 'AGENCY REPLY NOTIFICATION RLS ROLLBACK POSTFLIGHT FAILED: pre-existing admin policy disappeared — out of scope, must never happen. Aborting.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='activity_logs' AND policyname='activity_logs: sales read own') THEN
    RAISE EXCEPTION 'AGENCY REPLY NOTIFICATION RLS ROLLBACK POSTFLIGHT FAILED: pre-existing sales policy disappeared — out of scope, must never happen. Aborting.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='activity_logs' AND policyname='activity_logs: operations read own') THEN
    RAISE EXCEPTION 'AGENCY REPLY NOTIFICATION RLS ROLLBACK POSTFLIGHT FAILED: pre-existing operations policy disappeared — out of scope, must never happen. Aborting.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='activity_logs' AND policyname='activity_logs: guide read own') THEN
    RAISE EXCEPTION 'AGENCY REPLY NOTIFICATION RLS ROLLBACK POSTFLIGHT FAILED: pre-existing guide policy disappeared — out of scope, must never happen. Aborting.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'is_sales') THEN
    RAISE EXCEPTION 'AGENCY REPLY NOTIFICATION RLS ROLLBACK POSTFLIGHT FAILED: shared function is_sales() disappeared — out of scope, must never happen. Aborting.';
  END IF;
  RAISE NOTICE 'AGENCY REPLY NOTIFICATION RLS ROLLBACK POSTFLIGHT PASSED: new sales policy removed; every pre-existing activity_logs policy and shared helper function untouched.';
END $$;

COMMIT;

-- ============================================================
-- END OF ROLLBACK supabase_migration_agency_reply_notification_rls_ROLLBACK.sql
-- ============================================================
