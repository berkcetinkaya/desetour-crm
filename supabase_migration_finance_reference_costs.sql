-- ============================================================
-- DESE TOUR OPERATIONS CENTER
-- Migration: Finance reference costs (Topkapı, Ayasofya) — Phase C
-- ============================================================
-- File:    supabase_migration_finance_reference_costs.sql
-- Rollback: supabase_migration_finance_reference_costs_ROLLBACK.sql
-- Depends: supabase_migration_finance_center.sql (finance_cost_items with
--          is_provisional). Binds to EXISTING production preparation rules by
--          explicit id (verified read-only on 2026-11-11) — never by name.
-- Version: Finance Center Phase C — NOT YET APPROVED FOR PRODUCTION.
--
-- WHAT THIS DOES
--   1. Topkapı combined ticket — official public tariff, REFERENCE ONLY:
--        ₺2,750 (foreign visitor, includes Topkapı Palace + Hagia Irene + Harem)
--        https://www.millisaraylar.gov.tr/Lokasyon/2/Topkapi-Sarayi?culture=en
--      bound to rule 4a9e8bc3-… "Topkapı Sarayı + Harem Bileti" (Estambul
--      Histórica · PT). kind='public_reference' → never drives Finance and never
--      touches the internal €40 planning cost. Original currency TRY; no
--      converted EUR amount is stored.
--   2. Ayasofya (Hagia Sophia) VISITOR GALLERY — €25 per foreign visitor:
--        https://istanbul.com/hagia-sophia (price)
--        https://www.vgm.gov.tr/news/with-the-director-general-of-foundations-mr-sinan-aksu
--      This is the paid visitor gallery, NOT the separate "Hagia Sophia History
--      and Experience Museum", and NOT the free worship area.
--      a) Always stored as kind='public_reference' (reference only).
--      b) The INTERNAL provisional €25 planning cost is inserted ONLY when
--         v_confirm_ayasofya_visitor_gallery = TRUE. The current itinerary
--         ("Ayasofya ziyaret edilir" + "öncelikli giriş biletleri" + an active
--         ticket-preparation rule) shows a ticket is bought, but does not say
--         explicitly that it is the visitor-gallery ticket — so it stays FALSE
--         and Finance shows "Maliyet girilmemiş" until the owner confirms.
--         When enabled it is is_provisional=TRUE with its source preserved, to
--         be replaced by a real supplier rate later.
--
-- WHAT THIS DOES NOT DO
--   • No Bosphorus cruise cost: the product says "Boğaz Tekne Turu" from the
--     Eminönü pier but does not identify Şehir Hatları or the route (Short ₺340
--     / Long return ₺640 / Moonlight ₺730 are three different products). Stays
--     unresolved until the operator and route are confirmed.
--   • No Grand Bazaar tea cost: "Bir adet geleneksel Türk çayı" is included,
--     but whether DeseTour pays for it (and how much) is not known.
--   • Never overwrites or deactivates any internal cost row.
-- ============================================================

BEGIN;

DO $$
DECLARE
  v_confirm_ayasofya_visitor_gallery CONSTANT BOOLEAN := FALSE;  -- owner confirmation required
  v_topkapi_rule  CONSTANT UUID := '4a9e8bc3-bb93-4394-9b40-48695cfb3dfa';
  v_topkapi_tour  CONSTANT UUID := 'a4e4bf16-a108-4a45-9418-d849f5bb7917';
  v_ayasofya_rule CONSTANT UUID := '0c888a99-9544-49b8-ac0f-f81008c48fc9';
  v_ayasofya_tour CONSTANT UUID := '8f308669-2bb6-42ac-9b2f-a07f77e231d4';
  v_internal_before NUMERIC;
BEGIN
  IF to_regclass('public.finance_cost_items') IS NULL
     OR NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='finance_cost_items' AND column_name='is_provisional') THEN
    RAISE EXCEPTION 'FINANCE REFERENCE COSTS PREFLIGHT FAILED: apply supabase_migration_finance_center.sql first.';
  END IF;
  -- Verify the exact rule identities this file binds to.
  IF NOT EXISTS (SELECT 1 FROM public.tour_preparation_rules WHERE id = v_topkapi_rule AND tour_id = v_topkapi_tour
                  AND is_active AND preparation_type = 'entrance_ticket' AND label ILIKE '%Topkap%') THEN
    RAISE EXCEPTION 'FINANCE REFERENCE COSTS FAILED: Topkapı rule % on tour % not found as an active entrance_ticket rule. Aborting before writing anything.', v_topkapi_rule, v_topkapi_tour;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.tour_preparation_rules WHERE id = v_ayasofya_rule AND tour_id = v_ayasofya_tour
                  AND is_active AND preparation_type = 'entrance_ticket' AND label ILIKE '%Ayasofya%') THEN
    RAISE EXCEPTION 'FINANCE REFERENCE COSTS FAILED: Ayasofya rule % on tour % not found as an active entrance_ticket rule. Aborting before writing anything.', v_ayasofya_rule, v_ayasofya_tour;
  END IF;

  SELECT COALESCE(SUM(amount), 0) INTO v_internal_before FROM public.finance_cost_items WHERE kind = 'internal';

  -- 1. Topkapı public reference (TRY, reference only).
  IF NOT EXISTS (SELECT 1 FROM public.finance_cost_items WHERE preparation_rule_id = v_topkapi_rule AND kind = 'public_reference' AND is_active) THEN
    INSERT INTO public.finance_cost_items (label, category, basis, amount, currency, tour_id, preparation_rule_id, valid_from, kind,
                                           source_note, source_url, last_verified_date)
    VALUES ('Topkapı Palace Combine Ticket (official tariff)', 'ticket', 'preparation_rule', 2750, 'TRY', v_topkapi_tour, v_topkapi_rule,
            DATE '2026-11-11', 'public_reference',
            'National Palaces official foreign-visitor combined ticket: Topkapı Palace + Hagia Irene + Harem. Public reference only — never DeseTour''s internal planning cost.',
            'https://www.millisaraylar.gov.tr/Lokasyon/2/Topkapi-Sarayi?culture=en', DATE '2026-11-11');
  END IF;

  -- 2a. Ayasofya visitor gallery public reference (EUR, reference only).
  IF NOT EXISTS (SELECT 1 FROM public.finance_cost_items WHERE preparation_rule_id = v_ayasofya_rule AND kind = 'public_reference' AND is_active) THEN
    INSERT INTO public.finance_cost_items (label, category, basis, amount, currency, tour_id, preparation_rule_id, valid_from, kind,
                                           source_note, source_url, last_verified_date)
    VALUES ('Hagia Sophia Visitor Gallery (public price)', 'ticket', 'preparation_rule', 25, 'EUR', v_ayasofya_tour, v_ayasofya_rule,
            DATE '2026-11-11', 'public_reference',
            'Paid visitor gallery for foreign visitors (not the separate History and Experience Museum, not the free worship area). Explanation: https://www.vgm.gov.tr/news/with-the-director-general-of-foundations-mr-sinan-aksu',
            'https://istanbul.com/hagia-sophia', DATE '2026-11-11');
  END IF;

  -- 2b. Ayasofya INTERNAL provisional planning cost — only on explicit confirmation.
  IF v_confirm_ayasofya_visitor_gallery
     AND NOT EXISTS (SELECT 1 FROM public.finance_cost_items WHERE preparation_rule_id = v_ayasofya_rule AND kind = 'internal' AND is_active) THEN
    INSERT INTO public.finance_cost_items (label, category, basis, amount, currency, tour_id, preparation_rule_id, valid_from, kind, is_provisional,
                                           source_note, source_url, last_verified_date)
    VALUES ('Hagia Sophia Visitor Gallery', 'ticket', 'preparation_rule', 25, 'EUR', v_ayasofya_tour, v_ayasofya_rule,
            DATE '2026-01-01', 'internal', TRUE,
            'PROVISIONAL: current public visitor-gallery price used as the planning amount until a supplier/negotiated rate is known.',
            'https://istanbul.com/hagia-sophia', DATE '2026-11-11');
  END IF;

  -- POSTFLIGHT: no public reference may have changed any internal amount.
  IF (SELECT COALESCE(SUM(amount), 0) FROM public.finance_cost_items WHERE kind = 'internal') - v_internal_before
     NOT IN (0, CASE WHEN v_confirm_ayasofya_visitor_gallery THEN 25 ELSE 0 END) THEN
    RAISE EXCEPTION 'FINANCE REFERENCE COSTS POSTFLIGHT FAILED: internal cost totals changed unexpectedly.';
  END IF;
  RAISE NOTICE 'FINANCE REFERENCE COSTS POSTFLIGHT PASSED (Ayasofya internal provisional cost: %).', CASE WHEN v_confirm_ayasofya_visitor_gallery THEN 'enabled' ELSE 'NOT created — awaiting confirmation' END;
END $$;

COMMIT;
