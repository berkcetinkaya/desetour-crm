-- ============================================================
-- DESE TOUR OPERATIONS CENTER
-- Migration: Topkapı €40 internal cost → EXISTING production rule
-- ============================================================
-- File:    supabase_migration_finance_topkapi_rule.sql
-- Rollback: supabase_migration_finance_topkapi_rule_ROLLBACK.sql
-- Depends: supabase_migration_finance_center.sql
-- Preflight (read-only): finance_topkapi_rule_preflight.sql
-- Version: Finance Center Phase C — NOT YET APPROVED FOR PRODUCTION.
--
-- OWNER DECISION (2026-11-11): production already has an active Topkapı
-- entrance-ticket rule on "Estambul Histórica" (PT):
--   4a9e8bc3-bb93-4394-9b40-48695cfb3dfa  "Topkapı Sarayı + Harem Bileti"
--   per_guest, with live reservation_preparations (Civitatis ingestion keeps
--   it materialized). The €40 internal planning cost is LINKED TO THAT RULE.
--
-- WHAT THIS DOES
--   • Inserts ONE internal finance_cost_items row "Topkapı Combined Entry",
--     €40 × the rule's materialized required_quantity (basis preparation_rule).
--     The combined ticket includes Topkapı Palace + Hagia Irene + Harem, so
--     there is no separate Harem / Hagia Irene charge.
--
-- WHAT THIS DOES NOT DO
--   • Does NOT create a tour_preparation_rules row and does NOT modify the
--     existing rule (not its label, stop link or quantity rule).
--   • Does NOT write reservation_preparations — no backfill is needed.
--   • The draft Spanish "Topkapi Palace Complete Tour: Harem & Hagia Irene"
--     (3d3a335a-…) is deliberately left alone until it is activated with an
--     itinerary (owner decision).
-- ============================================================

BEGIN;

DO $$
DECLARE
  v_rule CONSTANT UUID := '4a9e8bc3-bb93-4394-9b40-48695cfb3dfa';
  v_tour CONSTANT UUID := 'a4e4bf16-a108-4a45-9418-d849f5bb7917';
  v_rules_before INT;
BEGIN
  IF to_regclass('public.finance_cost_items') IS NULL THEN
    RAISE EXCEPTION 'TOPKAPI COST MIGRATION PREFLIGHT FAILED: apply supabase_migration_finance_center.sql first.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.tour_preparation_rules
                  WHERE id = v_rule AND tour_id = v_tour AND is_active
                    AND preparation_type = 'entrance_ticket' AND quantity_rule = 'per_guest'
                    AND label ILIKE ANY (ARRAY['%Topkapı%', '%Topkapi%'])) THEN
    RAISE EXCEPTION 'TOPKAPI COST MIGRATION FAILED: rule % is not an active per_guest Topkapı entrance-ticket rule on tour %. Aborting before writing anything — re-run the read-only preflight.', v_rule, v_tour;
  END IF;
  -- Exactly ONE active Topkapı ticket rule may exist on this tour, so the
  -- €40 can never be applied twice to the same guests.
  IF (SELECT COUNT(*) FROM public.tour_preparation_rules
       WHERE tour_id = v_tour AND is_active AND preparation_type = 'entrance_ticket'
         AND label ILIKE ANY (ARRAY['%Topkapı%', '%Topkapi%'])) <> 1 THEN
    RAISE EXCEPTION 'TOPKAPI COST MIGRATION FAILED: tour % has more than one active Topkapı entrance-ticket rule — resolve the duplicate first.', v_tour;
  END IF;

  SELECT COUNT(*) INTO v_rules_before FROM public.tour_preparation_rules;

  IF NOT EXISTS (SELECT 1 FROM public.finance_cost_items WHERE preparation_rule_id = v_rule AND kind = 'internal' AND is_active) THEN
    INSERT INTO public.finance_cost_items
      (label, category, basis, amount, currency, tour_id, preparation_rule_id, valid_from, kind, source_note)
    VALUES ('Topkapı Combined Entry', 'ticket', 'preparation_rule', 40, 'EUR', v_tour, v_rule, DATE '2026-01-01', 'internal',
            'Internal DeseTour planning cost per guest for the Topkapı combined entry (Topkapı Palace + Hagia Irene + Harem). Not a public retail price; never overwritten by a public reference.');
  END IF;

  -- POSTFLIGHT
  IF (SELECT COUNT(*) FROM public.finance_cost_items WHERE preparation_rule_id = v_rule AND kind = 'internal' AND is_active) <> 1 THEN
    RAISE EXCEPTION 'TOPKAPI COST POSTFLIGHT FAILED: expected exactly 1 active internal cost item for rule %.', v_rule;
  END IF;
  IF (SELECT COUNT(*) FROM public.tour_preparation_rules) <> v_rules_before THEN
    RAISE EXCEPTION 'TOPKAPI COST POSTFLIGHT FAILED: tour_preparation_rules changed — this migration must never create or delete a rule.';
  END IF;
  RAISE NOTICE 'TOPKAPI COST POSTFLIGHT PASSED: €40 internal cost linked to existing rule %; no rule created, no preparation written.', v_rule;
END $$;

-- Verification result set (before COMMIT).
SELECT r.id AS preparation_rule_id, t.name AS tour_name, r.label, r.quantity_rule,
       f.id AS cost_item_id, f.amount, f.currency, f.basis, f.kind
  FROM public.tour_preparation_rules r
  JOIN public.tours t ON t.id = r.tour_id
  LEFT JOIN public.finance_cost_items f ON f.preparation_rule_id = r.id AND f.kind = 'internal' AND f.is_active
 WHERE r.id = '4a9e8bc3-bb93-4394-9b40-48695cfb3dfa';

COMMIT;
