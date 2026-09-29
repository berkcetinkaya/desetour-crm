-- ============================================================
-- DESE TOUR OPERATIONS CENTER
-- ROLLBACK: V13 (Civitatis cancellation ingestion) -> V12
-- ============================================================
-- File:    supabase_migration_civitatis_write_v13_ROLLBACK_to_v12.sql
--
-- WHAT THIS FILE IS
-- ─────────────────────────────────────────────────────────────
-- A safety rollback, prepared for review ONLY — NOT executed, and not
-- intended to be executed unless V13
-- (supabase_migration_civitatis_write_v13_cancellation.sql) has already
-- been applied and needs to be undone. V13 added exactly ONE new
-- function (public.cancel_civitatis_booking) and widened exactly ONE
-- CHECK constraint (email_ingestions.event_type, to permit 'cancelled')
-- — it never touched public.ingest_civitatis_booking or any other
-- existing object. This rollback is correspondingly small: it removes
-- the new function and stops there.
--
-- WHY THE event_type CHECK WIDEN IS DELIBERATELY *NOT* ROLLED BACK
-- ─────────────────────────────────────────────────────────────
-- email_ingestions.event_type's own comment already states this
-- column's established philosophy: allowed values are only ever
-- WIDENED, never narrowed — the exact same "never narrowed" discipline
-- email_ingestions.provider's comment states explicitly, and the same
-- pattern activity_logs.entity_type/action and tours.status/category/
-- tour_type already follow throughout this schema. Narrowing the CHECK
-- back to exclude 'cancelled' is also not merely a style question here:
-- if V13 was live for any length of time, ONE OR MORE email_ingestions
-- rows may already have event_type='cancelled' committed (any
-- cancellation email the scheduler processed, successfully or not,
-- always writes such a row in Step 1). A narrowing ALTER TABLE ... ADD
-- CONSTRAINT would FAIL outright against any such existing row (a CHECK
-- constraint is validated against all existing data when added), so
-- attempting it here would make this rollback non-deterministic —
-- succeeding on a database where no cancellation was ever processed,
-- failing on one where even one was. Leaving the CHECK exactly as V13
-- left it avoids that failure mode entirely, matches this column's own
-- stated philosophy, and is harmless: a permitted-but-now-unreachable
-- value ('cancelled', once cancel_civitatis_booking no longer exists to
-- write it) creates no correctness risk of any kind — nothing will ever
-- write a NEW 'cancelled' row once this rollback removes the only
-- function that ever did, and every EXISTING 'cancelled' row remains
-- exactly as accurate and readable as it already was, an honest
-- historical record of a cancellation this system processed while V13
-- was live.
--
-- WHAT THIS FILE DOES NOT DO
-- ─────────────────────────────────────────────────────────────
-- This is a function-removal rollback ONLY. It contains no DELETE, no
-- UPDATE, and no TRUNCATE of any kind — it cannot touch a single row in
-- reservations, activity_logs, or email_ingestions. Any reservation V13
-- successfully cancelled before this rollback runs remains cancelled;
-- reverting the write path does not retroactively "uncancel" a
-- reservation V13 already committed a status change for. Any
-- email_ingestions row V13 wrote remains exactly as it was written —
-- this rollback removes the ABILITY to process a FUTURE cancellation
-- email, nothing about the past.
--
-- HOW TO APPLY (once reviewed and approved — NOT done as part of
-- producing this file; only run this if a rollback from V13 is actually
-- needed)
-- ─────────────────────────────────────────────────────────────
-- Supabase Dashboard → SQL Editor → paste and run this file. Wrapped in
-- an explicit BEGIN/COMMIT so it either fully applies or not at all.
-- Idempotent: DROP FUNCTION IF EXISTS is safe to re-run any number of
-- times.
-- ============================================================


BEGIN;

DROP FUNCTION IF EXISTS public.cancel_civitatis_booking(
  TEXT, TEXT, TIMESTAMPTZ, TEXT, TEXT, UUID, TEXT
);

COMMIT;

-- ── END OF MIGRATION ────────────────────────────────────────────────────────
