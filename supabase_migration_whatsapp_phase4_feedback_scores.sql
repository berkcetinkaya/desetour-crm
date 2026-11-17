-- ═══════════════════════════════════════════════════════════════════════
-- WhatsApp Phase 4 — feedback scores (1–5)
-- Tur sonrası geri bildirim artık iki puan topluyor: tur (1–5) ve rehber
-- (1–5), ardından serbest yorum. Bu migration reservation_feedback
-- tablosuna iki puan sütununu ekler. Mevcut satırlar değişmez.
-- Güvenle tekrar çalıştırılabilir.
-- ═══════════════════════════════════════════════════════════════════════
BEGIN;

DO $$
BEGIN
  IF to_regclass('public.reservation_feedback') IS NULL THEN
    RAISE EXCEPTION 'WHATSAPP PHASE 4 FAILED: apply supabase_migration_whatsapp_phase3_survey.sql first.';
  END IF;
END $$;

ALTER TABLE public.reservation_feedback
  ADD COLUMN IF NOT EXISTS tour_score  SMALLINT CHECK (tour_score  BETWEEN 1 AND 5),
  ADD COLUMN IF NOT EXISTS guide_score SMALLINT CHECK (guide_score BETWEEN 1 AND 5);

COMMENT ON COLUMN public.reservation_feedback.tour_score  IS 'Customer''s score for the tour, 1 (very bad) – 5 (excellent). WhatsApp feedback flow.';
COMMENT ON COLUMN public.reservation_feedback.guide_score IS 'Customer''s score for the guide, 1 – 5. WhatsApp feedback flow.';
COMMENT ON TABLE  public.reservation_feedback IS 'Post-tour feedback per reservation (WhatsApp): tour_score 1–5, guide_score 1–5, optional comment. rating (great/good/poor) is derived from tour_score (5/4/≤3). Server-written; admin + operations read.';

DO $$
BEGIN
  IF (SELECT COUNT(*) FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'reservation_feedback' AND column_name IN ('tour_score', 'guide_score')) <> 2 THEN
    RAISE EXCEPTION 'WHATSAPP PHASE 4 POSTFLIGHT FAILED: score columns missing.';
  END IF;
  RAISE NOTICE 'WHATSAPP PHASE 4 POSTFLIGHT PASSED: reservation_feedback has tour_score and guide_score.';
END $$;

COMMIT;
