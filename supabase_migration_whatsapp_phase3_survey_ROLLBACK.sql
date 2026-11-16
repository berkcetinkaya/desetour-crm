-- ROLLBACK: WhatsApp Phase 3 — refuses while survey answers exist.
BEGIN;
DO $$
BEGIN
  IF to_regclass('public.reservation_feedback') IS NOT NULL AND EXISTS (SELECT 1 FROM public.reservation_feedback) THEN
    RAISE EXCEPTION 'WHATSAPP PHASE 3 ROLLBACK REFUSED: survey answers exist. Review them first.';
  END IF;
END $$;
DROP TABLE IF EXISTS public.reservation_feedback;
COMMIT;
