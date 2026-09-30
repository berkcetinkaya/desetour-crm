-- ============================================================
-- DESE TOUR OPERATIONS CENTER
-- Rollback: WhatsApp Core — Database Foundation, Phase 1.1
-- ============================================================
-- File:    supabase_migration_whatsapp_core_ROLLBACK.sql
-- Rolls back ONLY: supabase_migration_whatsapp_core.sql
-- NOT executed. Provided for manual review and manual execution only.
--
-- SCOPE — WHAT THIS ROLLS BACK, AND NOTHING ELSE
-- ─────────────────────────────────────────────────────────────
-- Removes EXACTLY the objects the forward migration created:
--   1. public.whatsapp_messages    — dropped entirely (table, its
--      indexes, trigger, RLS policies, and CHECK/UNIQUE constraints all
--      go with it).
--   2. public.whatsapp_destination_recipients — dropped entirely.
--   3. public.whatsapp_destinations — dropped entirely.
--   4. tour_channels.review_url    — the one new nullable column added
--      by the forward migration.
--
-- DROP ORDER MATTERS: whatsapp_messages and whatsapp_destination_
-- recipients each hold a foreign key INTO whatsapp_destinations
-- (destination_id), so both are dropped before whatsapp_destinations
-- itself — otherwise the FK would block the DROP. No CASCADE is used
-- anywhere in this file; every DROP TABLE is unblocked by the ordering
-- alone, so a partial/unexpected cascade onto unrelated objects is
-- structurally impossible.
--
-- THIS ROLLBACK DOES NOT TOUCH, AND MUST NEVER BE MADE TO TOUCH:
--   • tour_channels.listing_url, and every other pre-existing
--     tour_channels column — all pre-existed the forward migration,
--     untouched by it, untouched here.
--   • public.reservations, public.customers, public.guides,
--     public.tours — only ever referenced BY whatsapp_messages' now-
--     dropped foreign keys; nothing in those four tables is altered,
--     and no row in any of them is read, updated, or deleted by this
--     file.
--   • public.activity_logs — never referenced by the forward migration,
--     never referenced here.
--   • public.ingest_civitatis_booking / public.cancel_civitatis_booking
--     — never referenced for modification by the forward migration
--     (only read-only signature checks), never referenced for
--     modification here (this file re-verifies them unchanged in its
--     own postflight, the same discipline as the forward migration).
--   • Every RLS helper function (is_admin/is_sales/is_operations/
--     is_guide) and public.set_updated_at() — reused, never redefined
--     or dropped by either file.
--
-- SAFETY
-- ─────────────────────────────────────────────────────────────
-- DROP TABLE IF EXISTS / DROP COLUMN IF EXISTS throughout — safe to run
-- even if the forward migration was only partially applied, and safe to
-- run twice (second run finds nothing left to drop, no error).
--
-- DATA LOSS WARNING: dropping whatsapp_messages, whatsapp_destination_
-- recipients, and whatsapp_destinations is destructive to any WhatsApp
-- destination configuration or message history that may have accumulated
-- since the forward migration was applied. Dropping
-- tour_channels.review_url is destructive to any review URL a staff
-- member may have manually entered since. Only run this rollback if that
-- loss is acceptable — there is no soft-delete/archive step here,
-- matching the explicit instruction that this file must ONLY remove the
-- objects the forward migration introduced, nothing more, nothing
-- softer.
--
-- No SQL in this file has been executed. No Supabase connection was made
-- to produce it.
--
-- HOW TO APPLY
-- ─────────────────────────────────────────────────────────────
-- Supabase Dashboard → SQL Editor → paste and run this file IN FULL, in
-- a single execution. Wrapped in BEGIN/COMMIT so a failed postflight
-- aborts the whole rollback rather than leaving it partial.
-- ============================================================


BEGIN;

-- ──────────────────────────────────────────────────────────────────────────
-- STEP 1: drop whatsapp_messages entirely — table, indexes, trigger, and
-- every RLS policy/CHECK/UNIQUE constraint on it go with the table
-- (PostgreSQL drops dependents automatically with DROP TABLE; no separate
-- DROP POLICY/DROP INDEX/DROP TRIGGER/DROP CONSTRAINT statements are
-- needed or issued here). Dropped FIRST because it holds a foreign key
-- into whatsapp_destinations (destination_id).
-- ──────────────────────────────────────────────────────────────────────────

DROP TABLE IF EXISTS public.whatsapp_messages;


-- ──────────────────────────────────────────────────────────────────────────
-- STEP 2: drop whatsapp_destination_recipients — also holds a foreign key
-- into whatsapp_destinations, so dropped before it.
-- ──────────────────────────────────────────────────────────────────────────

DROP TABLE IF EXISTS public.whatsapp_destination_recipients;


-- ──────────────────────────────────────────────────────────────────────────
-- STEP 3: drop whatsapp_destinations — now unblocked, since both tables
-- that referenced it were dropped in Steps 1-2.
-- ──────────────────────────────────────────────────────────────────────────

DROP TABLE IF EXISTS public.whatsapp_destinations;


-- ──────────────────────────────────────────────────────────────────────────
-- STEP 4: drop ONLY the one column the forward migration added to
-- tour_channels. Every other column — including listing_url and every
-- column that predates this feature entirely — is deliberately absent
-- from this statement.
-- ──────────────────────────────────────────────────────────────────────────

ALTER TABLE public.tour_channels
  DROP COLUMN IF EXISTS review_url;


-- ──────────────────────────────────────────────────────────────────────────
-- POSTFLIGHT: confirm every object this rollback was supposed to remove
-- is actually gone, and — just as importantly — confirm every object it
-- must NEVER touch is still exactly present. Aborts the whole
-- transaction on any unexpected state.
-- ──────────────────────────────────────────────────────────────────────────

DO $$
DECLARE
  v_problems TEXT[] := '{}';
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='whatsapp_messages') THEN
    v_problems := array_append(v_problems, 'whatsapp_messages still exists');
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='whatsapp_destination_recipients') THEN
    v_problems := array_append(v_problems, 'whatsapp_destination_recipients still exists');
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='whatsapp_destinations') THEN
    v_problems := array_append(v_problems, 'whatsapp_destinations still exists');
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='tour_channels' AND column_name='review_url') THEN
    v_problems := array_append(v_problems, 'tour_channels.review_url still exists');
  END IF;

  -- Out-of-scope objects must remain untouched.
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='tour_channels') THEN v_problems := array_append(v_problems, 'tour_channels table was removed — out of scope, must never happen'); END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='tour_channels' AND column_name='listing_url') THEN v_problems := array_append(v_problems, 'tour_channels.listing_url was removed — out of scope, must never happen'); END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='reservations') THEN v_problems := array_append(v_problems, 'reservations table was removed — out of scope, must never happen'); END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='customers') THEN v_problems := array_append(v_problems, 'customers table was removed — out of scope, must never happen'); END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='guides') THEN v_problems := array_append(v_problems, 'guides table was removed — out of scope, must never happen'); END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='tours') THEN v_problems := array_append(v_problems, 'tours table was removed — out of scope, must never happen'); END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='activity_logs') THEN v_problems := array_append(v_problems, 'activity_logs table was removed — out of scope, must never happen'); END IF;

  IF array_length(v_problems, 1) > 0 THEN
    RAISE EXCEPTION 'WHATSAPP CORE ROLLBACK POSTFLIGHT FAILED: %. Aborting — re-run this ENTIRE file in a single execution.', array_to_string(v_problems, ', ');
  END IF;

  -- Re-confirm both Civitatis RPCs are STILL exactly what they were
  -- before this rollback ran — same discipline as the forward migration.
  IF NOT EXISTS (
    SELECT 1
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname = 'ingest_civitatis_booking'
       AND p.pronargs = 26
       AND p.proargtypes = array_to_string(
             ARRAY[
               'text', 'text', 'timestamptz', 'text', 'text', 'text', 'uuid', 'text', 'uuid', 'text',
               'date', 'time', 'integer', 'integer', 'numeric', 'text', 'numeric', 'text', 'uuid',
               'text', 'text', 'text', 'jsonb', 'boolean', 'text', 'text'
             ]::regtype[]::oid[],
             ' '
           )::oidvector
  ) THEN
    RAISE EXCEPTION 'WHATSAPP CORE ROLLBACK POSTFLIGHT FAILED: public.ingest_civitatis_booking signature changed or the function disappeared during this rollback. This must never happen — aborting.';
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname = 'cancel_civitatis_booking'
       AND p.pronargs = 7
       AND p.proargtypes = array_to_string(
             ARRAY['text','text','timestamptz','text','text','uuid','text']::regtype[]::oid[],
             ' '
           )::oidvector
  ) THEN
    RAISE EXCEPTION 'WHATSAPP CORE ROLLBACK POSTFLIGHT FAILED: public.cancel_civitatis_booking signature changed or the function disappeared during this rollback. This must never happen — aborting.';
  END IF;

  RAISE NOTICE 'WHATSAPP CORE ROLLBACK POSTFLIGHT PASSED: whatsapp_messages, whatsapp_destination_recipients, whatsapp_destinations, and tour_channels.review_url all confirmed removed; tour_channels/listing_url/reservations/customers/guides/tours/activity_logs all confirmed untouched; ingest_civitatis_booking and cancel_civitatis_booking unchanged.';
END $$;

COMMIT;

-- ============================================================
-- END OF ROLLBACK supabase_migration_whatsapp_core_ROLLBACK.sql
-- ============================================================
