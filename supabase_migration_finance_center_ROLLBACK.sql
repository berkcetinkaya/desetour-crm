-- ============================================================
-- DESE TOUR OPERATIONS CENTER
-- ROLLBACK: Finance Center — Phase C
-- ============================================================
-- Reverses supabase_migration_finance_center.sql. Run
-- supabase_migration_finance_topkapi_rule_ROLLBACK.sql FIRST if that
-- migration was applied (its cost item references this table).
--
-- SAFETY: refuses to run while reservation_expenses holds any row, or while
-- finance_cost_items holds anything other than the two seeded internal
-- defaults — actual expense history and manually entered costs must never
-- be destroyed by a rollback. Export / resolve them first.
-- The activity_logs entity_type CHECK is narrowed back ONLY if no
-- activity_logs row uses one of the two finance entity types.
-- ============================================================

BEGIN;

DO $$
DECLARE v_exp INT := 0; v_items INT := 0; v_logs INT := 0;
BEGIN
  IF to_regclass('public.reservation_expenses') IS NOT NULL THEN
    SELECT COUNT(*) INTO v_exp FROM public.reservation_expenses;
  END IF;
  IF v_exp > 0 THEN
    RAISE EXCEPTION 'FINANCE CENTER ROLLBACK REFUSED: reservation_expenses holds % row(s) of actual expense history. Export and remove them deliberately first.', v_exp;
  END IF;
  IF to_regclass('public.finance_cost_items') IS NOT NULL THEN
    SELECT COUNT(*) INTO v_items FROM public.finance_cost_items
     WHERE NOT (kind = 'internal' AND tour_id IS NULL AND preparation_rule_id IS NULL
                AND label IN ('Guide Service','Included Meal'));
  END IF;
  IF v_items > 0 THEN
    RAISE EXCEPTION 'FINANCE CENTER ROLLBACK REFUSED: finance_cost_items holds % non-seed row(s). Roll back the Topkapı rule migration / remove manual items first.', v_items;
  END IF;
  SELECT COUNT(*) INTO v_logs FROM public.activity_logs WHERE entity_type IN ('finance_cost_item','reservation_expense');
  IF v_logs > 0 THEN
    RAISE NOTICE 'FINANCE CENTER ROLLBACK: % activity_logs row(s) use finance entity types — leaving activity_logs_entity_type_check widened.', v_logs;
  ELSE
    ALTER TABLE public.activity_logs DROP CONSTRAINT IF EXISTS activity_logs_entity_type_check;
    ALTER TABLE public.activity_logs ADD CONSTRAINT activity_logs_entity_type_check
      CHECK (entity_type IN (
        'customer','lead','quote','reservation','payment',
        'task','reminder','tour','message','settings',
        'guide','guide_payment','reservation_review',
        'tour_language','tour_channel',
        'civitatis_settlement',
        'agency','agency_email'
      ));
  END IF;
END $$;

DROP TRIGGER IF EXISTS trg_reservation_expenses_freeze_fx ON public.reservation_expenses;
DROP FUNCTION IF EXISTS public.fn_reservation_expenses_freeze_fx();
DROP TABLE IF EXISTS public.reservation_expenses;
DROP TABLE IF EXISTS public.finance_cost_items;

COMMIT;
