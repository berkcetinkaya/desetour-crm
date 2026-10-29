-- ============================================================
-- DESE TOUR OPERATIONS CENTER
-- Rollback: Civitatis Client/Reservation Messages
-- ============================================================
-- File:    supabase_migration_civitatis_client_messages_ROLLBACK.sql
-- Rolls back ONLY: supabase_migration_civitatis_client_messages.sql
-- NOT executed. Provided for manual review and manual execution only.
--
-- SCOPE — WHAT THIS ROLLS BACK, AND NOTHING ELSE
-- ─────────────────────────────────────────────────────────────
-- Removes EXACTLY the two objects the forward migration added, in the
-- required order (the table's 4 RLS policies and 3 indexes are dropped
-- implicitly by DROP TABLE; the function depends on nothing the table
-- doesn't, so either drop order is actually safe, but the table is
-- dropped first here for clarity):
--   1. public.reservation_messages (table, with its indexes/policies)
--   2. public.ingest_civitatis_reservation_message(...) (the function)
--
-- THIS ROLLBACK DOES NOT TOUCH, AND MUST NEVER BE MADE TO TOUCH:
--   • public.reservations — not one column, constraint, index, trigger,
--     or RLS policy. external_booking_id/source_id and
--     reservations_source_id_external_booking_id_key all predate this
--     feature and are never touched here.
--   • public.activity_logs — its CHECK constraints already allowed
--     entity_type='reservation'/action='reply' before the forward
--     migration ever ran; this rollback does not touch that table or
--     any row it holds (any Civitatis-message activity_logs rows
--     already written stay exactly as they are — this is intentional:
--     they are ordinary activity history, not something this feature
--     "owns" the way it owns reservation_messages).
--   • public.ingest_civitatis_booking / public.cancel_civitatis_booking
--     / public.mark_civitatis_email_needs_review — completely separate
--     functions, never referenced by this rollback.
--   • public.agency_emails or any Agency Mailbox object.
--
-- DATA LOSS WARNING
-- ─────────────────────────────────────────────────────────────
-- DROP TABLE public.reservation_messages PERMANENTLY DESTROYS every
-- ingested Civitatis client-message row (the actual communication
-- history this feature exists to preserve). This is the one
-- unavoidable consequence of rolling back a table whose entire purpose
-- is to hold data — there is no column to merely revert here. Export/
-- back up this table first if any row in it has ever been relied on
-- operationally, before running this rollback.
--
-- SAFETY
-- ─────────────────────────────────────────────────────────────
-- DROP TABLE IF EXISTS / DROP FUNCTION IF EXISTS — safe to run even if
-- the forward migration only partially applied (it either fully
-- committed or fully rolled back itself, per its own preflight-free-but-
-- postflight-guarded BEGIN/COMMIT discipline) and safe to run twice
-- (second run finds nothing left to drop, no error).
--
-- HOW TO APPLY
-- ─────────────────────────────────────────────────────────────
-- Supabase Dashboard -> SQL Editor -> paste and run this file IN FULL,
-- in a single execution. Wrapped in an explicit BEGIN/COMMIT.
-- ============================================================

BEGIN;

DROP TABLE IF EXISTS public.reservation_messages;
DROP FUNCTION IF EXISTS public.ingest_civitatis_reservation_message(TEXT, TEXT, TIMESTAMPTZ, TEXT, UUID, TEXT, TEXT, BOOLEAN);

DO $$
DECLARE
  v_policy_count INT;
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='reservation_messages') THEN
    RAISE EXCEPTION 'CIVITATIS CLIENT MESSAGES ROLLBACK POSTFLIGHT FAILED: reservation_messages still exists after DROP. Aborting.';
  END IF;

  IF EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'ingest_civitatis_reservation_message') THEN
    RAISE EXCEPTION 'CIVITATIS CLIENT MESSAGES ROLLBACK POSTFLIGHT FAILED: ingest_civitatis_reservation_message still exists after DROP. Aborting.';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='reservations') THEN
    RAISE EXCEPTION 'CIVITATIS CLIENT MESSAGES ROLLBACK POSTFLIGHT FAILED: reservations table disappeared — out of scope, must never happen. Aborting.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='reservations' AND column_name='external_booking_id') THEN
    RAISE EXCEPTION 'CIVITATIS CLIENT MESSAGES ROLLBACK POSTFLIGHT FAILED: reservations.external_booking_id disappeared — out of scope, must never happen. Aborting.';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'ingest_civitatis_booking') THEN
    RAISE EXCEPTION 'CIVITATIS CLIENT MESSAGES ROLLBACK POSTFLIGHT FAILED: ingest_civitatis_booking disappeared — out of scope, must never happen. Aborting.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'cancel_civitatis_booking') THEN
    RAISE EXCEPTION 'CIVITATIS CLIENT MESSAGES ROLLBACK POSTFLIGHT FAILED: cancel_civitatis_booking disappeared — out of scope, must never happen. Aborting.';
  END IF;

  SELECT COUNT(*) INTO v_policy_count FROM pg_policies WHERE schemaname='public' AND tablename='reservations';
  IF v_policy_count <> 6 THEN
    RAISE EXCEPTION 'CIVITATIS CLIENT MESSAGES ROLLBACK POSTFLIGHT FAILED: reservations RLS policy count changed (expected 6, got %) — must never happen in this rollback. Aborting.', v_policy_count;
  END IF;

  RAISE NOTICE 'CIVITATIS CLIENT MESSAGES ROLLBACK POSTFLIGHT PASSED: reservation_messages and ingest_civitatis_reservation_message() both removed; reservations/activity_logs/the other three Civitatis RPCs are unchanged. All previously ingested Civitatis client messages have been permanently deleted (see this file''s DATA LOSS WARNING).';
END $$;

COMMIT;
