-- ============================================================
-- DESE TOUR OPERATIONS CENTER
-- Migration: WhatsApp Phase 2 — sending queue + inbound messages
-- ============================================================
-- File:     supabase_migration_whatsapp_phase2_sending.sql
-- Rollback: supabase_migration_whatsapp_phase2_sending_ROLLBACK.sql
-- Depends:  supabase_migration_whatsapp_core.sql (applied — the three
--           WhatsApp tables exist in production and are empty, verified
--           read-only 2026-11-16).
--
-- WHAT THIS DOES
--   1. public.whatsapp_claim_due_messages(p_limit, p_ids): atomically
--      claims due 'queued' rows (FOR UPDATE SKIP LOCKED) for the server
--      worker (api/whatsapp.js) and puts rows stuck in 'processing' for
--      more than 10 minutes back in the queue. service_role only.
--   2. public.whatsapp_inbound_messages: messages customers / guides send
--      to the DeseTour number (survey answers, replies). Written only by
--      the server webhook; admin + operations can read.
--   3. Seeds the logical "operations" destination (recipient list, no
--      recipients — they are added in CRM → Ayarlar → WhatsApp).
-- No change to reservations, customers, guides or existing data.
-- ============================================================

BEGIN;

DO $$
BEGIN
  IF to_regclass('public.whatsapp_messages') IS NULL OR to_regclass('public.whatsapp_destinations') IS NULL THEN
    RAISE EXCEPTION 'WHATSAPP PHASE 2 FAILED: apply supabase_migration_whatsapp_core.sql first.';
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.whatsapp_claim_due_messages(p_limit INTEGER DEFAULT 25, p_ids UUID[] DEFAULT NULL)
RETURNS SETOF public.whatsapp_messages
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  UPDATE public.whatsapp_messages SET status = 'queued', next_attempt_at = NOW()
   WHERE status = 'processing' AND last_attempt_at < NOW() - INTERVAL '10 minutes';
  RETURN QUERY
  UPDATE public.whatsapp_messages m
     SET status = 'processing', attempt_count = m.attempt_count + 1, last_attempt_at = NOW()
   WHERE m.id IN (
     SELECT id FROM public.whatsapp_messages
      WHERE status = 'queued'
        AND (next_attempt_at IS NULL OR next_attempt_at <= NOW())
        AND (p_ids IS NULL OR id = ANY (p_ids))
      ORDER BY created_at
      LIMIT GREATEST(1, LEAST(COALESCE(p_limit, 25), 100))
      FOR UPDATE SKIP LOCKED)
  RETURNING m.*;
END $$;

REVOKE ALL ON FUNCTION public.whatsapp_claim_due_messages(INTEGER, UUID[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.whatsapp_claim_due_messages(INTEGER, UUID[]) FROM anon;
REVOKE ALL ON FUNCTION public.whatsapp_claim_due_messages(INTEGER, UUID[]) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.whatsapp_claim_due_messages(INTEGER, UUID[]) TO service_role;

CREATE TABLE IF NOT EXISTS public.whatsapp_inbound_messages (
  id                   UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_message_id  TEXT        NOT NULL UNIQUE,
  from_phone           TEXT        NOT NULL,
  profile_name         TEXT,
  message_type         TEXT,
  text                 TEXT,
  button_payload       TEXT,
  context_message_id   TEXT,
  related_message_id   UUID        REFERENCES public.whatsapp_messages(id) ON DELETE SET NULL,
  received_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
COMMENT ON TABLE public.whatsapp_inbound_messages IS 'Messages received on the DeseTour WhatsApp number (Meta webhook). Written only by the server (service_role); admin + operations read.';
CREATE INDEX IF NOT EXISTS idx_whatsapp_inbound_received ON public.whatsapp_inbound_messages(received_at DESC);
CREATE INDEX IF NOT EXISTS idx_whatsapp_inbound_related ON public.whatsapp_inbound_messages(related_message_id);

ALTER TABLE public.whatsapp_inbound_messages ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "whatsapp_inbound_messages: admin read" ON public.whatsapp_inbound_messages;
CREATE POLICY "whatsapp_inbound_messages: admin read" ON public.whatsapp_inbound_messages FOR SELECT TO authenticated USING ( is_admin() );
DROP POLICY IF EXISTS "whatsapp_inbound_messages: operations read" ON public.whatsapp_inbound_messages;
CREATE POLICY "whatsapp_inbound_messages: operations read" ON public.whatsapp_inbound_messages FOR SELECT TO authenticated USING ( is_operations() );

INSERT INTO public.whatsapp_destinations (destination_key, display_name, transport_mode)
VALUES ('operations', 'DeseTour Operasyon Ekibi', 'recipient_list')
ON CONFLICT (destination_key) DO NOTHING;

DO $$
BEGIN
  IF to_regprocedure('public.whatsapp_claim_due_messages(integer, uuid[])') IS NULL THEN
    RAISE EXCEPTION 'WHATSAPP PHASE 2 POSTFLIGHT FAILED: claim function missing.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.whatsapp_destinations WHERE destination_key = 'operations') THEN
    RAISE EXCEPTION 'WHATSAPP PHASE 2 POSTFLIGHT FAILED: operations destination missing.';
  END IF;
  IF (SELECT COUNT(*) FROM pg_policies WHERE schemaname = 'public' AND tablename = 'whatsapp_inbound_messages') <> 2 THEN
    RAISE EXCEPTION 'WHATSAPP PHASE 2 POSTFLIGHT FAILED: expected 2 read policies on whatsapp_inbound_messages.';
  END IF;
  RAISE NOTICE 'WHATSAPP PHASE 2 POSTFLIGHT PASSED: claim function, inbound table and operations destination ready.';
END $$;

COMMIT;
