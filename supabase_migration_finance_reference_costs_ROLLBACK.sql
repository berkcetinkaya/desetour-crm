-- ============================================================
-- DESE TOUR OPERATIONS CENTER
-- ROLLBACK: Finance reference costs (Topkapı, Ayasofya)
-- ============================================================
-- Removes ONLY the rows supabase_migration_finance_reference_costs.sql can
-- create (matched by rule id + exact label). Expenses that referenced one
-- keep their history (finance_cost_item_id is ON DELETE SET NULL).
-- ============================================================
BEGIN;
DELETE FROM public.finance_cost_items
 WHERE (preparation_rule_id = '4a9e8bc3-bb93-4394-9b40-48695cfb3dfa' AND kind = 'public_reference' AND label = 'Topkapı Palace Combine Ticket (official tariff)')
    OR (preparation_rule_id = '0c888a99-9544-49b8-ac0f-f81008c48fc9' AND kind = 'public_reference' AND label = 'Hagia Sophia Visitor Gallery (public price)')
    OR (preparation_rule_id = '0c888a99-9544-49b8-ac0f-f81008c48fc9' AND kind = 'internal' AND is_provisional AND label = 'Hagia Sophia Visitor Gallery')
    OR (tour_id = '8f308669-2bb6-42ac-9b2f-a07f77e231d4' AND kind = 'public_reference' AND label = 'Şehir Hatları Short Bosphorus Tour (official tariff)')
    OR (tour_id = '8f308669-2bb6-42ac-9b2f-a07f77e231d4' AND kind = 'internal' AND is_provisional AND label = 'Bosphorus Cruise (Şehir Hatları short tour)');
COMMIT;
