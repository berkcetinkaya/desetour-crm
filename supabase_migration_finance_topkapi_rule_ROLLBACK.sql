-- ============================================================
-- DESE TOUR OPERATIONS CENTER
-- ROLLBACK: Topkapı combined-entry preparation rule + €40 internal cost
-- ============================================================
-- Reverses supabase_migration_finance_topkapi_rule.sql.
-- SAFETY: never deletes reservation_preparations history. If any
-- reservation_preparations row (pending or completed) references a Topkapı
-- rule, the rule is DEACTIVATED (is_active = FALSE) instead of deleted, so
-- completed ticket work stays auditable; the next materialization run moves
-- remaining pending rows to 'superseded'. Expenses linked to the cost item
-- keep their history (finance_cost_item_id is ON DELETE SET NULL).
-- ============================================================

BEGIN;

DO $$
DECLARE v_rule RECORD;
BEGIN
  FOR v_rule IN SELECT id FROM public.tour_preparation_rules WHERE label = 'Topkapı Sarayı Kombine Giriş Bileti' LOOP
    DELETE FROM public.finance_cost_items WHERE preparation_rule_id = v_rule.id;
    IF EXISTS (SELECT 1 FROM public.reservation_preparations WHERE preparation_rule_id = v_rule.id) THEN
      UPDATE public.tour_preparation_rules SET is_active = FALSE WHERE id = v_rule.id;
      RAISE NOTICE 'TOPKAPI ROLLBACK: rule % has preparation history — deactivated, not deleted.', v_rule.id;
    ELSE
      DELETE FROM public.tour_preparation_rules WHERE id = v_rule.id;
      RAISE NOTICE 'TOPKAPI ROLLBACK: rule % deleted.', v_rule.id;
    END IF;
  END LOOP;
END $$;

COMMIT;
