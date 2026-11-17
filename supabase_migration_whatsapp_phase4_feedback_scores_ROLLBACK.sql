-- Rollback of supabase_migration_whatsapp_phase4_feedback_scores.sql
BEGIN;
ALTER TABLE public.reservation_feedback DROP COLUMN IF EXISTS tour_score, DROP COLUMN IF EXISTS guide_score;
COMMIT;
