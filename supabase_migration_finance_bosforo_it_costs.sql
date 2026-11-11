-- ============================================================
-- DESE TOUR OPERATIONS CENTER
-- Migration: Italian "Bosforo y Barrio Sultanahmet" — same costs as the PT product
-- ============================================================
-- File:    supabase_migration_finance_bosforo_it_costs.sql
-- Rollback: supabase_migration_finance_bosforo_it_costs_ROLLBACK.sql
-- Backfill (separate step): finance_bosforo_backfill.sql
-- Depends: supabase_migration_finance_center.sql (+ is_provisional),
--          supabase_migration_finance_reference_costs.sql (PT product rows).
--
-- OWNER DECISION (2026-11-11): the Italian product
--   2ea5551f-f59f-4ba4-976c-0b5c916094a8 "Bosforo y Barrio Sultanahmet"
-- has exactly the same content as the Portuguese product
--   8f308669-2bb6-42ac-9b2f-a07f77e231d4 (Ayasofya visitor gallery +
--   Şehir Hatları short Bosphorus tour). Verified read-only on 2026-11-11:
--   the Italian product has NO preparation rule and NO cost item.
--
-- WHAT THIS DOES (mirrors the PT product exactly)
--   1. ONE active tour_preparation_rules row: entrance_ticket ·
--      "Ayasofya Giriş Bileti" · per_guest · no itinerary stop.
--   2. Hagia Sophia visitor gallery: €25 INTERNAL provisional planning cost
--      (basis preparation_rule) + €25 public reference.
--   3. Şehir Hatları short Bosphorus tour: ₺340 per guest INTERNAL
--      provisional transport cost + ₺340 public reference (tour-scoped).
--   Idempotent; refuses if the Italian product already has a DIFFERENT
--   active Ayasofya ticket rule or transport cost.
--
-- WHAT THIS DOES NOT DO
--   • Does NOT write reservation_preparations (see finance_bosforo_backfill.sql).
--   • Does NOT change the PT product or any tour / channel status.
-- ============================================================

BEGIN;

DO $$
DECLARE
  v_it    CONSTANT UUID := '2ea5551f-f59f-4ba4-976c-0b5c916094a8';
  v_pt    CONSTANT UUID := '8f308669-2bb6-42ac-9b2f-a07f77e231d4';
  v_label CONSTANT TEXT := 'Ayasofya Giriş Bileti';
  v_rule  UUID;
BEGIN
  IF to_regclass('public.finance_cost_items') IS NULL THEN
    RAISE EXCEPTION 'BOSFORO IT PREFLIGHT FAILED: apply supabase_migration_finance_center.sql first.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.tours WHERE id = v_it AND name ILIKE '%Bosforo%') THEN
    RAISE EXCEPTION 'BOSFORO IT FAILED: tour % not found as the Bosforo product. Nothing written.', v_it;
  END IF;
  -- The PT product must carry the reference setup we mirror.
  IF NOT EXISTS (SELECT 1 FROM public.tour_preparation_rules WHERE tour_id = v_pt AND is_active AND preparation_type = 'entrance_ticket' AND label = v_label)
     OR NOT EXISTS (SELECT 1 FROM public.finance_cost_items WHERE tour_id = v_pt AND category = 'transport' AND kind = 'internal' AND is_active) THEN
    RAISE EXCEPTION 'BOSFORO IT FAILED: the PT product % does not have the Ayasofya rule / Bosphorus cost to mirror. Nothing written.', v_pt;
  END IF;

  -- 1. Ayasofya rule (reuse if this file already ran; refuse a different one).
  SELECT id INTO v_rule FROM public.tour_preparation_rules
   WHERE tour_id = v_it AND is_active AND preparation_type = 'entrance_ticket'
     AND label = v_label AND quantity_rule = 'per_guest' AND fixed_quantity IS NULL;
  IF v_rule IS NULL AND EXISTS (SELECT 1 FROM public.tour_preparation_rules
       WHERE tour_id = v_it AND is_active AND preparation_type = 'entrance_ticket'
         AND label ILIKE ANY (ARRAY['%Ayasofya%', '%Hagia Sophia%'])) THEN
    RAISE EXCEPTION 'BOSFORO IT FAILED: tour % already has a different active Ayasofya rule — resolve manually.', v_it;
  END IF;
  IF v_rule IS NULL THEN
    INSERT INTO public.tour_preparation_rules
      (tour_id, itinerary_stop_id, preparation_type, label, quantity_rule, fixed_quantity, is_active)
    VALUES (v_it, NULL, 'entrance_ticket', v_label, 'per_guest', NULL, TRUE)
    RETURNING id INTO v_rule;
  END IF;

  -- 2. Hagia Sophia costs on that rule.
  IF NOT EXISTS (SELECT 1 FROM public.finance_cost_items WHERE preparation_rule_id = v_rule AND kind = 'internal' AND is_active) THEN
    INSERT INTO public.finance_cost_items (label, category, basis, amount, currency, tour_id, preparation_rule_id, valid_from, kind, is_provisional,
                                           source_note, source_url, last_verified_date)
    VALUES ('Hagia Sophia Visitor Gallery', 'ticket', 'preparation_rule', 25, 'EUR', v_it, v_rule,
            DATE '2026-01-01', 'internal', TRUE,
            'PROVISIONAL: same as the PT product — current public visitor-gallery price used as the planning amount until a supplier/negotiated rate is known.',
            'https://istanbul.com/hagia-sophia', DATE '2026-11-11');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.finance_cost_items WHERE preparation_rule_id = v_rule AND kind = 'public_reference' AND is_active) THEN
    INSERT INTO public.finance_cost_items (label, category, basis, amount, currency, tour_id, preparation_rule_id, valid_from, kind,
                                           source_note, source_url, last_verified_date)
    VALUES ('Hagia Sophia Visitor Gallery (public price)', 'ticket', 'preparation_rule', 25, 'EUR', v_it, v_rule,
            DATE '2026-11-11', 'public_reference',
            'Paid visitor gallery for foreign visitors (not the separate History and Experience Museum, not the free worship area).',
            'https://istanbul.com/hagia-sophia', DATE '2026-11-11');
  END IF;

  -- 3. Bosphorus cruise, per guest (tour-scoped).
  IF NOT EXISTS (SELECT 1 FROM public.finance_cost_items WHERE tour_id = v_it AND category = 'transport' AND kind = 'internal' AND is_active) THEN
    INSERT INTO public.finance_cost_items (label, category, basis, amount, currency, tour_id, valid_from, kind, is_provisional,
                                           source_note, source_url, last_verified_date)
    VALUES ('Bosphorus Cruise (Şehir Hatları short tour)', 'transport', 'per_guest', 340, 'TRY', v_it,
            DATE '2026-01-01', 'internal', TRUE,
            'PROVISIONAL: same as the PT product — Şehir Hatları Short Bosphorus Tour public tariff until a negotiated rate is known.',
            'https://sehirhatlari.istanbul/en/price-list/bosphorus-tours-78', DATE '2026-11-11');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.finance_cost_items WHERE tour_id = v_it AND category = 'transport' AND kind = 'public_reference' AND is_active) THEN
    INSERT INTO public.finance_cost_items (label, category, basis, amount, currency, tour_id, valid_from, kind,
                                           source_note, source_url, last_verified_date)
    VALUES ('Şehir Hatları Short Bosphorus Tour (official tariff)', 'transport', 'per_guest', 340, 'TRY', v_it,
            DATE '2026-11-11', 'public_reference',
            'Şehir Hatları official foreign-passenger tariff, Short Bosphorus Tour.',
            'https://sehirhatlari.istanbul/en/price-list/bosphorus-tours-78', DATE '2026-11-11');
  END IF;

  -- POSTFLIGHT
  IF (SELECT COUNT(*) FROM public.tour_preparation_rules WHERE tour_id = v_it AND is_active AND preparation_type = 'entrance_ticket'
        AND label ILIKE ANY (ARRAY['%Ayasofya%', '%Hagia Sophia%'])) <> 1 THEN
    RAISE EXCEPTION 'BOSFORO IT POSTFLIGHT FAILED: expected exactly one active Ayasofya rule on tour %.', v_it;
  END IF;
  IF (SELECT COUNT(*) FROM public.finance_cost_items WHERE preparation_rule_id = v_rule AND kind = 'internal' AND is_active) <> 1
     OR (SELECT COUNT(*) FROM public.finance_cost_items WHERE tour_id = v_it AND category = 'transport' AND kind = 'internal' AND is_active) <> 1 THEN
    RAISE EXCEPTION 'BOSFORO IT POSTFLIGHT FAILED: expected exactly one internal Ayasofya cost and one internal Bosphorus cost.';
  END IF;
  RAISE NOTICE 'BOSFORO IT POSTFLIGHT PASSED: rule % (€25 Ayasofya) and ₺340 Bosphorus cruise on tour % — same as the PT product. Run finance_bosforo_backfill.sql next.', v_rule, v_it;
END $$;

SELECT t.name, t.id AS tour_id, f.label, f.category, f.basis, f.amount, f.currency, f.kind
  FROM public.finance_cost_items f JOIN public.tours t ON t.id = f.tour_id
 WHERE f.tour_id IN ('2ea5551f-f59f-4ba4-976c-0b5c916094a8', '8f308669-2bb6-42ac-9b2f-a07f77e231d4') AND f.is_active
 ORDER BY t.id, f.category, f.kind;

COMMIT;
