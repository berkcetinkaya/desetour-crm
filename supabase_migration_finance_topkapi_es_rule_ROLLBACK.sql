-- ============================================================
-- DESE TOUR OPERATIONS CENTER
-- ROLLBACK: Topkapı rule + costs for the Spanish Topkapı product
-- ============================================================
-- Removes the two cost items this migration created. The rule is DELETED
-- only if no reservation_preparations row references it; otherwise it is
-- DEACTIVATED, so completed ticket work stays auditable (the next
-- materialization run moves remaining pending rows to 'superseded').
-- ============================================================
BEGIN;
DO $$
DECLARE v_rule RECORD;
BEGIN
  FOR v_rule IN SELECT id FROM public.tour_preparation_rules
                 WHERE tour_id = '3d3a335a-1320-4277-977d-62a19fa7090a' AND label = 'Topkapı Sarayı + Harem Bileti' LOOP
    DELETE FROM public.finance_cost_items WHERE preparation_rule_id = v_rule.id
      AND label IN ('Topkapı Combined Entry', 'Topkapı Palace Combine Ticket (official tariff)');
    IF EXISTS (SELECT 1 FROM public.reservation_preparations WHERE preparation_rule_id = v_rule.id) THEN
      UPDATE public.tour_preparation_rules SET is_active = FALSE WHERE id = v_rule.id;
      RAISE NOTICE 'TOPKAPI ES ROLLBACK: rule % has preparation history — deactivated, not deleted.', v_rule.id;
    ELSE
      DELETE FROM public.tour_preparation_rules WHERE id = v_rule.id;
      RAISE NOTICE 'TOPKAPI ES ROLLBACK: rule % deleted.', v_rule.id;
    END IF;
  END LOOP;
END $$;
COMMIT;
