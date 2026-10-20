-- ============================================================
-- DESE TOUR OPERATIONS CENTER
-- Rollback: Activity Log Actor Snapshot (Security Foundation Phase 1)
-- ============================================================
-- File:    supabase_migration_activity_logs_actor_snapshot_ROLLBACK.sql
-- Rolls back ONLY: supabase_migration_activity_logs_actor_snapshot.sql
-- NOT executed. Provided for manual review and manual execution only.
--
-- SCOPE — WHAT THIS ROLLS BACK, AND NOTHING ELSE
-- ─────────────────────────────────────────────────────────────
-- Removes EXACTLY the three columns the forward migration added to the
-- EXISTING public.activity_logs table:
--   1. actor_name
--   2. actor_role
--   3. source (dropping the column also drops activity_logs_source_check,
--      which exists only on this column — no separate DROP CONSTRAINT
--      is needed or issued).
--
-- THIS ROLLBACK DOES NOT TOUCH, AND MUST NEVER BE MADE TO TOUCH:
--   • public.activity_logs' own table, its other columns (id,
--     entity_type, entity_id, action, description, old_value, new_value,
--     metadata, performed_by, created_at), its indexes, or any row's
--     data in those columns.
--   • The append-only rules activity_logs_no_delete / activity_logs_no_update
--     (supabase_schema.sql:669-670) — never created or touched by the
--     forward migration, never touched here.
--   • Any existing RLS policy on activity_logs (supabase_rls_policies.sql:
--     640-688) — never created or touched by the forward migration,
--     never touched here.
--   • Any other existing table, function, trigger, or policy.
--
-- SAFETY
-- ─────────────────────────────────────────────────────────────
-- DROP COLUMN IF EXISTS — safe to run even if the forward migration was
-- only partially applied, and safe to run twice (second run finds
-- nothing left to drop, no error). Dropping three nullable columns with
-- no dependent view/index is a simple, non-destructive-to-other-data
-- operation — every other column and every row's other data is
-- completely unaffected.
--
-- HOW TO APPLY
-- ─────────────────────────────────────────────────────────────
-- Supabase Dashboard → SQL Editor → paste and run this file IN FULL, in
-- a single execution. Wrapped in an explicit BEGIN/COMMIT.
-- ============================================================

BEGIN;

ALTER TABLE public.activity_logs DROP COLUMN IF EXISTS actor_name;
ALTER TABLE public.activity_logs DROP COLUMN IF EXISTS actor_role;
ALTER TABLE public.activity_logs DROP COLUMN IF EXISTS source;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='activity_logs' AND column_name='actor_name') THEN
    RAISE EXCEPTION 'ACTIVITY LOG ACTOR SNAPSHOT ROLLBACK POSTFLIGHT FAILED: actor_name still exists after DROP. Aborting.';
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='activity_logs' AND column_name='actor_role') THEN
    RAISE EXCEPTION 'ACTIVITY LOG ACTOR SNAPSHOT ROLLBACK POSTFLIGHT FAILED: actor_role still exists after DROP. Aborting.';
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='activity_logs' AND column_name='source') THEN
    RAISE EXCEPTION 'ACTIVITY LOG ACTOR SNAPSHOT ROLLBACK POSTFLIGHT FAILED: source still exists after DROP. Aborting.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='activity_logs') THEN
    RAISE EXCEPTION 'ACTIVITY LOG ACTOR SNAPSHOT ROLLBACK POSTFLIGHT FAILED: activity_logs table disappeared — out of scope, must never happen. Aborting.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='activity_logs' AND column_name='performed_by') THEN
    RAISE EXCEPTION 'ACTIVITY LOG ACTOR SNAPSHOT ROLLBACK POSTFLIGHT FAILED: activity_logs.performed_by disappeared — out of scope, must never happen. Aborting.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_rules WHERE tablename = 'activity_logs' AND rulename = 'activity_logs_no_delete') THEN
    RAISE EXCEPTION 'ACTIVITY LOG ACTOR SNAPSHOT ROLLBACK POSTFLIGHT FAILED: activity_logs_no_delete rule disappeared — out of scope, must never happen. Aborting.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_rules WHERE tablename = 'activity_logs' AND rulename = 'activity_logs_no_update') THEN
    RAISE EXCEPTION 'ACTIVITY LOG ACTOR SNAPSHOT ROLLBACK POSTFLIGHT FAILED: activity_logs_no_update rule disappeared — out of scope, must never happen. Aborting.';
  END IF;
  RAISE NOTICE 'ACTIVITY LOG ACTOR SNAPSHOT ROLLBACK POSTFLIGHT PASSED: actor_name, actor_role, and source removed; activity_logs table, its other columns, its append-only rules, and its RLS policies all untouched.';
END $$;

COMMIT;

-- ============================================================
-- END OF ROLLBACK supabase_migration_activity_logs_actor_snapshot_ROLLBACK.sql
-- ============================================================
