-- ============================================================
-- DESE TOUR OPERATIONS CENTER
-- ROLLBACK for: supabase_migration_civitatis_write_v14_mark_needs_review.sql
-- ============================================================
-- File:    supabase_migration_civitatis_write_v14_ROLLBACK_to_v13.sql
-- Restores the database to its exact pre-V14 state by dropping the one
-- function V14 created. V14 touched nothing else (no table, no column,
-- no constraint, no index, no existing function) — so this rollback's
-- entire job is a single DROP FUNCTION, nothing more.
--
-- OPERATIONAL CAVEAT: safe to run at any time, even with existing
-- 'needs_review' email_ingestions rows this function previously wrote —
-- those rows are ordinary data, not tied to the function's existence,
-- and are left exactly as they are. Dropping this function only means
-- no FUTURE Gmail message can be marked needs_review through it; it
-- does not touch any row already written. Rolling this back while
-- api/_civitatis/writeAdapter.js still calls
-- mark_civitatis_email_needs_review would make those call sites error
-- (function does not exist) — rollback this migration only together
-- with reverting the corresponding JS change, never independently in
-- a live-write-enabled environment.
--
-- NOT executed against production by this phase; apply by hand after
-- review, and only ever as a deliberate revert of
-- supabase_migration_civitatis_write_v14_mark_needs_review.sql.
-- ============================================================

BEGIN;

DROP FUNCTION IF EXISTS public.mark_civitatis_email_needs_review(
  TEXT, TEXT, TIMESTAMPTZ, TEXT, TEXT, UUID, TEXT, TEXT, TEXT, TEXT
);

-- ──────────────────────────────────────────────────────────────────────────
-- POSTFLIGHT — read-only verification that the function no longer exists.
-- ──────────────────────────────────────────────────────────────────────────
SELECT NOT EXISTS (
  SELECT 1 FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'mark_civitatis_email_needs_review'
) AS function_successfully_removed;

COMMIT;

-- ── END OF ROLLBACK ─────────────────────────────────────────────────────────
