-- ============================================================
-- DESE TOUR OPERATIONS CENTER
-- Migration: WhatsApp Phase 3 — post-tour survey answers
-- ============================================================
-- File:     supabase_migration_whatsapp_phase3_survey.sql
-- Rollback: supabase_migration_whatsapp_phase3_survey_ROLLBACK.sql
-- Depends:  supabase_migration_whatsapp_phase2_sending.sql (applied).
--
-- public.reservation_feedback — one answer per reservation to the
-- WhatsApp post-tour survey: rating (great / good / poor) and, after a
-- "poor" answer, the customer's own comment. Written only by the server
-- webhook (service_role); admin + operations read it in the CRM.
-- The review link sent after a good answer is tour_channels.review_url
-- (column added by the WhatsApp core migration), edited on the tour's
-- channel settings. No change to existing data.
-- ============================================================

BEGIN;

DO $$
BEGIN
  IF to_regclass('public.whatsapp_inbound_messages') IS NULL THEN
    RAISE EXCEPTION 'WHATSAPP PHASE 3 FAILED: apply supabase_migration_whatsapp_phase2_sending.sql first.';
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS public.reservation_feedback (
  id                   UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  reservation_id       UUID        NOT NULL UNIQUE REFERENCES public.reservations(id) ON DELETE CASCADE,
  customer_id          UUID        REFERENCES public.customers(id) ON DELETE SET NULL,
  rating               TEXT        NOT NULL CHECK (rating IN ('great', 'good', 'poor')),
  comment              TEXT,
  source               TEXT        NOT NULL DEFAULT 'whatsapp',
  whatsapp_message_id  UUID        REFERENCES public.whatsapp_messages(id) ON DELETE SET NULL,
  answered_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  comment_at           TIMESTAMPTZ,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
COMMENT ON TABLE public.reservation_feedback IS 'Post-tour survey answer per reservation (WhatsApp buttons: great / good / poor + optional comment). Server-written; admin + operations read.';
CREATE INDEX IF NOT EXISTS idx_reservation_feedback_answered ON public.reservation_feedback(answered_at DESC);

DROP TRIGGER IF EXISTS trg_reservation_feedback_updated_at ON public.reservation_feedback;
CREATE TRIGGER trg_reservation_feedback_updated_at BEFORE UPDATE ON public.reservation_feedback
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.reservation_feedback ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "reservation_feedback: admin read" ON public.reservation_feedback;
CREATE POLICY "reservation_feedback: admin read" ON public.reservation_feedback FOR SELECT TO authenticated USING ( is_admin() );
DROP POLICY IF EXISTS "reservation_feedback: operations read" ON public.reservation_feedback;
CREATE POLICY "reservation_feedback: operations read" ON public.reservation_feedback FOR SELECT TO authenticated USING ( is_operations() );

DO $$
BEGIN
  IF (SELECT COUNT(*) FROM pg_policies WHERE schemaname = 'public' AND tablename = 'reservation_feedback') <> 2 THEN
    RAISE EXCEPTION 'WHATSAPP PHASE 3 POSTFLIGHT FAILED: expected 2 read policies on reservation_feedback.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'tour_channels' AND column_name = 'review_url') THEN
    RAISE EXCEPTION 'WHATSAPP PHASE 3 POSTFLIGHT FAILED: tour_channels.review_url missing (WhatsApp core migration).';
  END IF;
  RAISE NOTICE 'WHATSAPP PHASE 3 POSTFLIGHT PASSED: reservation_feedback ready.';
END $$;

COMMIT;
