-- ============================================================
-- DESE TOUR OPERATIONS CENTER
-- ROLLBACK: Topkapı €40 internal cost
-- ============================================================
-- Removes ONLY the internal "Topkapı Combined Entry" cost item linked to the
-- existing production rule. The rule itself and every reservation
-- preparation are untouched (this migration never created or changed them).
-- Expenses that referenced the item keep their history
-- (finance_cost_item_id is ON DELETE SET NULL).
-- ============================================================
BEGIN;
DELETE FROM public.finance_cost_items
 WHERE preparation_rule_id = '4a9e8bc3-bb93-4394-9b40-48695cfb3dfa'
   AND kind = 'internal' AND label = 'Topkapı Combined Entry';
COMMIT;
