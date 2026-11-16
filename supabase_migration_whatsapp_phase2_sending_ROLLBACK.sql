-- ============================================================
-- ROLLBACK: WhatsApp Phase 2 — sending queue + inbound messages
-- Refuses while inbound messages exist. Keeps whatsapp_messages and the
-- "operations" destination (with its recipients) — they belong to the
-- core migration and may hold message history.
-- ============================================================
BEGIN;
DO $$
BEGIN
  IF to_regclass('public.whatsapp_inbound_messages') IS NOT NULL
     AND EXISTS (SELECT 1 FROM public.whatsapp_inbound_messages) THEN
    RAISE EXCEPTION 'WHATSAPP PHASE 2 ROLLBACK REFUSED: inbound messages exist. Review them first.';
  END IF;
END $$;
DROP TABLE IF EXISTS public.whatsapp_inbound_messages;
DROP FUNCTION IF EXISTS public.whatsapp_claim_due_messages(INTEGER, UUID[]);
COMMIT;
