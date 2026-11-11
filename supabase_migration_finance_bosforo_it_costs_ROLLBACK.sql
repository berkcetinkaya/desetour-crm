-- ============================================================
-- DESE TOUR OPERATIONS CENTER
-- ROLLBACK: Italian "Bosforo y Barrio Sultanahmet" costs
-- ============================================================
-- Removes the four cost items supabase_migration_finance_bosforo_it_costs.sql
-- created on the Italian product. The Ayasofya rule is DELETED only if no
-- reservation_preparations row references it; otherwise it is DEACTIVATED so
-- ticket history stays auditable. The PT product is never touched.
-- ============================================================

BEGIN;

DO $$
DECLARE
  v_it CONSTANT UUID := '2ea5551f-f59f-4ba4-976c-0b5c916094a8';
  v_rule RECORD;
BEGIN
  DELETE FROM public.finance_cost_items
   WHERE tour_id = v_it AND category = 'transport'
     AND label IN ('Bosphorus Cruise (Şehir Hatları short tour)', 'Şehir Hatları Short Bosphorus Tour (official tariff)');
  FOR v_rule IN SELECT id FROM public.tour_preparation_rules WHERE tour_id = v_it AND label = 'Ayasofya Giriş Bileti' LOOP
    DELETE FROM public.finance_cost_items WHERE preparation_rule_id = v_rule.id
      AND label IN ('Hagia Sophia Visitor Gallery', 'Hagia Sophia Visitor Gallery (public price)');
    IF EXISTS (SELECT 1 FROM public.reservation_preparations WHERE preparation_rule_id = v_rule.id) THEN
      UPDATE public.tour_preparation_rules SET is_active = FALSE WHERE id = v_rule.id;
      RAISE NOTICE 'BOSFORO IT ROLLBACK: rule % has preparation history — deactivated, not deleted.', v_rule.id;
    ELSE
      DELETE FROM public.tour_preparation_rules WHERE id = v_rule.id;
      RAISE NOTICE 'BOSFORO IT ROLLBACK: rule % deleted.', v_rule.id;
    END IF;
  END LOOP;
END $$;

COMMIT;
