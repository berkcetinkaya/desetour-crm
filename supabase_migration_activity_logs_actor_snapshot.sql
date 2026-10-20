-- ============================================================
-- DESE TOUR OPERATIONS CENTER
-- Migration: Activity Log Actor Snapshot (Security Foundation Phase 1)
-- ============================================================
-- File:    supabase_migration_activity_logs_actor_snapshot.sql
-- Depends: supabase_schema.sql, supabase_rls_policies.sql (already applied)
-- Version: Security Foundation — October 2026
--
-- WHY THIS EXISTS
-- ─────────────────────────────────────────────────────────────
-- The security audit of this CRM (completed separately, read-only)
-- identified that public.activity_logs.performed_by is a bare FK to
-- staff_users(id), joined LIVE at read time for display. That means a
-- future identity change — Deniz's account being recreated, a role
-- change, any staff_users row ever being deleted — would silently erase
-- WHO a historical action is attributed to, because performed_by's
-- FK is ON DELETE SET NULL (supabase_schema.sql:652) and there is no
-- other readable record of the actor's name/role at the time of the
-- action.
--
-- This migration adds three nullable snapshot columns so every NEW
-- human-created activity log entry can carry its own permanent,
-- read-independent record of who acted and in what role — immune to
-- whatever happens to staff_users afterward. This is a necessary
-- precondition for any later identity-repair work (e.g. Deniz), not a
-- fix for Deniz specifically — nothing about Deniz is touched here.
--
-- WHAT THIS ADDS
-- ─────────────────────────────────────────────────────────────
--   1. activity_logs.actor_name  TEXT — the staff member's full_name
--      AT THE TIME of the action, snapshotted by the application, never
--      recomputed from a join.
--   2. activity_logs.actor_role  TEXT — the staff member's role (the
--      raw staff_users.role value — 'admin'/'sales'/'operations'/
--      'guide' — not the Turkish display label) AT THE TIME of the
--      action, for the same reason.
--   3. activity_logs.source      TEXT — a small controlled vocabulary
--      replacing the informal metadata->>'source' string some write
--      paths (the Civitatis booking-ingestion RPC) already use today.
--      Constrained to exactly: crm_user | civitatis | system | api.
--
-- WHAT THIS DOES NOT DO
-- ─────────────────────────────────────────────────────────────
--   • Does NOT touch any existing row. All three columns are added
--     NULL-by-default with no DEFAULT expression — every row written
--     before this migration keeps actor_name/actor_role/source = NULL,
--     exactly as it is today. No backfill is performed by this file.
--   • Does NOT widen or relax activity_logs' append-only guarantee —
--     the existing activity_logs_no_update / activity_logs_no_delete
--     rules (supabase_schema.sql:669-670) are untouched, still apply to
--     every column including these three, and are re-verified by this
--     migration's own postflight check.
--   • Does NOT change any existing RLS policy on activity_logs. The
--     existing SELECT/INSERT policies (supabase_rls_policies.sql:640-688)
--     already read/write the whole row via SELECT */INSERT ... — no
--     policy enumerates columns, so none needs editing for three new
--     nullable columns to become visible/writable under the exact same
--     existing rules.
--   • Does NOT alter metadata, old_value, new_value, performed_by, or
--     any other existing column.
--   • Does NOT populate old_value/new_value for any write path. That is
--     explicitly a later phase.
--
-- PROPOSED (NOT PERFORMED) BACKFILL — see the implementation report for
-- the exact, narrow, deterministic SQL this could use for the Civitatis-
-- authored rows whose metadata already carries a trustworthy
-- 'source':'civitatis' value. Intentionally NOT included in this file —
-- run it separately, manually, only after reviewing it, if desired.
--
-- SAFETY
-- ─────────────────────────────────────────────────────────────
--   • 100% additive: three new NULLABLE columns on one existing table.
--   • Idempotent: ADD COLUMN IF NOT EXISTS / DROP CONSTRAINT IF EXISTS +
--     ADD CONSTRAINT can be run any number of times without error and
--     without changing the end result.
--   • No DROP, no data migration, no change to any existing column,
--     index, trigger, rule, or RLS policy.
--
-- HOW TO APPLY
-- ─────────────────────────────────────────────────────────────
-- Supabase Dashboard → SQL Editor → paste and run this file.
-- NOT executed as part of this change — review, then apply by hand.
-- ============================================================


-- ──────────────────────────────────────────────────────────────────────────
-- ALTER TABLE: activity_logs — add actor_name, actor_role, source
-- ──────────────────────────────────────────────────────────────────────────

-- Idempotent: IF NOT EXISTS — a second run no-ops if the column already exists.
ALTER TABLE public.activity_logs ADD COLUMN IF NOT EXISTS actor_name TEXT;
ALTER TABLE public.activity_logs ADD COLUMN IF NOT EXISTS actor_role TEXT;
ALTER TABLE public.activity_logs ADD COLUMN IF NOT EXISTS source     TEXT;

COMMENT ON COLUMN public.activity_logs.actor_name IS 'Snapshot of staff_users.full_name at the moment this log row was written. NULL for every row written before this migration, and for any row whose write path does not yet pass it (e.g. autoLog() call sites not yet updated). Never backfilled, never recomputed from a join — exists precisely so a later staff_users identity change can never retroactively erase this.';
COMMENT ON COLUMN public.activity_logs.actor_role IS 'Snapshot of staff_users.role (the raw value: admin | sales | operations | guide — not the Turkish display label) at the moment this log row was written. Same NULL-for-old-rows and never-recomputed guarantees as actor_name.';
COMMENT ON COLUMN public.activity_logs.source      IS 'Controlled replacement for the informal metadata->>''source'' string. NULL for every row written before this migration. See activity_logs_source_check for the exact allowed set.';

-- Idempotency: CREATE CONSTRAINT has no IF NOT EXISTS / OR REPLACE in
-- PostgreSQL, so a second run would fail with "constraint already
-- exists" — guard with DROP CONSTRAINT IF EXISTS first, matching this
-- repo's own established idempotency pattern (see e.g.
-- supabase_migration_civitatis_ingestion.sql's own composite-constraint
-- handling). Written as "source IS NULL OR source IN (...)" rather than
-- a bare IN(...) so the nullability is explicit and self-documenting —
-- functionally identical either way, since PostgreSQL CHECK constraints
-- already treat NULL as satisfying the constraint.
ALTER TABLE public.activity_logs DROP CONSTRAINT IF EXISTS activity_logs_source_check;
ALTER TABLE public.activity_logs ADD CONSTRAINT activity_logs_source_check
  CHECK ( source IS NULL OR source IN ('crm_user','civitatis','system','api') );


-- ──────────────────────────────────────────────────────────────────────────
-- POSTFLIGHT — confirms exactly these three columns were added, the
-- append-only guarantee is untouched, and RLS/policy count is unchanged.
-- Read-only SELECTs only.
-- ──────────────────────────────────────────────────────────────────────────
SELECT
  (SELECT COUNT(*) FROM information_schema.columns
     WHERE table_schema='public' AND table_name='activity_logs' AND column_name='actor_name')  AS actor_name_column_exists,
  (SELECT COUNT(*) FROM information_schema.columns
     WHERE table_schema='public' AND table_name='activity_logs' AND column_name='actor_role')  AS actor_role_column_exists,
  (SELECT COUNT(*) FROM information_schema.columns
     WHERE table_schema='public' AND table_name='activity_logs' AND column_name='source')      AS source_column_exists,
  (SELECT COUNT(*) FROM pg_rules
     WHERE tablename='activity_logs' AND rulename IN ('activity_logs_no_delete','activity_logs_no_update')) AS append_only_rules_intact,
  (SELECT COUNT(*) FROM pg_policies
     WHERE schemaname='public' AND tablename='activity_logs')  AS activity_logs_policy_count_unchanged;
