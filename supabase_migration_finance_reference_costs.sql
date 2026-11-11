-- ============================================================
-- DESE TOUR OPERATIONS CENTER
-- Migration: Finance reference + provisional costs (Topkapı, Ayasofya, Bosphorus)
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
--      b) INTERNAL provisional €25 planning cost — OWNER CONFIRMED on
--         2026-11-11 that the tour includes the paid visitor gallery.
--         is_provisional=TRUE with its source preserved, to be replaced by a
--         real supplier rate later.
--   3. Bosphorus cruise — OWNER CONFIRMED on 2026-11-11 that "Bosforo y Barrio
--      Sultanahmet" (PT, 8f308669-…) uses the Şehir Hatları SHORT Bosphorus
--      Tour: ₺340 per foreign passenger
--        https://sehirhatlari.istanbul/en/price-list/bosphorus-tours-78
--      Stored as a public_reference row AND as an INTERNAL provisional
--      transport cost, per_guest, in TRY (original currency — no converted EUR
--      amount). Bound to the tour, verified by its "Boğaz Tekne Turu" stop.
--
-- WHAT THIS DOES NOT DO
--   • No Long (₺640) or Moonlight (₺730) Bosphorus price — different products.
--   • The Italian "Bosforo y Barrio Sultanahmet" (2ea5551f-…) has no itinerary
--     or rules in production yet; it gets no cost until its itinerary exists.
--   • No Grand Bazaar tea cost: "Bir adet geleneksel Türk çayı" is included,
--     but whether DeseTour pays for it (and how much) is not known.
--   • Never overwrites or deactivates any internal cost row.
-- ============================================================

BEGIN;

DO $$
DECLARE
  v_confirm_ayasofya_visitor_gallery CONSTANT BOOLEAN := TRUE;   -- owner confirmed 2026-11-11
  v_topkapi_rule  CONSTANT UUID := '4a9e8bc3-bb93-4394-9b40-48695cfb3dfa';
  v_topkapi_tour  CONSTANT UUID := 'a4e4bf16-a108-4a45-9418-d849f5bb7917';
  v_ayasofya_rule CONSTANT UUID := '0c888a99-9544-49b8-ac0f-f81008c48fc9';
  v_ayasofya_tour CONSTANT UUID := '8f308669-2bb6-42ac-9b2f-a07f77e231d4';
  v_bosphorus_tour CONSTANT UUID := '8f308669-2bb6-42ac-9b2f-a07f77e231d4';
  v_internal_fp_before TEXT;
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

  IF NOT EXISTS (SELECT 1 FROM public.tour_itinerary_stops WHERE tour_id = v_bosphorus_tour AND place_name ILIKE '%Boğaz Tekne Turu%') THEN
    RAISE EXCEPTION 'FINANCE REFERENCE COSTS FAILED: tour % has no "Boğaz Tekne Turu" itinerary stop. Aborting before writing anything.', v_bosphorus_tour;
  END IF;

  -- Fingerprint of every PRE-EXISTING internal row: none may change.
  SELECT COALESCE(string_agg(id::text || ':' || amount::text || ':' || currency || ':' || is_active::text, ',' ORDER BY id), '')
    INTO v_internal_fp_before FROM public.finance_cost_items WHERE kind = 'internal';

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

  -- 3. Bosphorus — Şehir Hatları short tour: public reference + internal provisional (TRY).
  IF NOT EXISTS (SELECT 1 FROM public.finance_cost_items WHERE tour_id = v_bosphorus_tour AND category = 'transport' AND kind = 'public_reference' AND is_active) THEN
    INSERT INTO public.finance_cost_items (label, category, basis, amount, currency, tour_id, valid_from, kind,
                                           source_note, source_url, last_verified_date)
    VALUES ('Şehir Hatları Short Bosphorus Tour (official tariff)', 'transport', 'per_guest', 340, 'TRY', v_bosphorus_tour,
            DATE '2026-11-11', 'public_reference',
            'Şehir Hatları official foreign-passenger tariff, Short Bosphorus Tour. Not the Long (₺640) or Moonlight (₺730) tour.',
            'https://sehirhatlari.istanbul/en/price-list/bosphorus-tours-78', DATE '2026-11-11');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.finance_cost_items WHERE tour_id = v_bosphorus_tour AND category = 'transport' AND kind = 'internal' AND is_active) THEN
    INSERT INTO public.finance_cost_items (label, category, basis, amount, currency, tour_id, valid_from, kind, is_provisional,
                                           source_note, source_url, last_verified_date)
    VALUES ('Bosphorus Cruise (Şehir Hatları short tour)', 'transport', 'per_guest', 340, 'TRY', v_bosphorus_tour,
            DATE '2026-01-01', 'internal', TRUE,
            'PROVISIONAL: owner confirmed the product uses the Şehir Hatları Short Bosphorus Tour; current public tariff used until a negotiated rate is known.',
            'https://sehirhatlari.istanbul/en/price-list/bosphorus-tours-78', DATE '2026-11-11');
  END IF;

  -- POSTFLIGHT: no pre-existing internal row changed; new internal rows are
  -- only the two confirmed provisional ones.
  IF (SELECT COALESCE(string_agg(id::text || ':' || amount::text || ':' || currency || ':' || is_active::text, ',' ORDER BY id), '')
        FROM public.finance_cost_items WHERE kind = 'internal' AND created_at < now()) <>
     (SELECT COALESCE(string_agg(x, ',' ORDER BY x), '') FROM unnest(string_to_array(NULLIF(v_internal_fp_before, ''), ',')) AS x
       WHERE split_part(x, ':', 1)::uuid IN (SELECT id FROM public.finance_cost_items WHERE created_at < now())) THEN
    RAISE EXCEPTION 'FINANCE REFERENCE COSTS POSTFLIGHT FAILED: a pre-existing internal cost row changed.';
  END IF;
  IF EXISTS (SELECT 1 FROM public.finance_cost_items WHERE kind = 'internal' AND created_at >= now()
              AND NOT (is_provisional AND label IN ('Hagia Sophia Visitor Gallery', 'Bosphorus Cruise (Şehir Hatları short tour)'))) THEN
    RAISE EXCEPTION 'FINANCE REFERENCE COSTS POSTFLIGHT FAILED: an unexpected internal cost row was created.';
  END IF;
  RAISE NOTICE 'FINANCE REFERENCE COSTS POSTFLIGHT PASSED (Ayasofya internal provisional: %; Bosphorus short tour ₺340 provisional).', CASE WHEN v_confirm_ayasofya_visitor_gallery THEN 'enabled' ELSE 'not created' END;
END $$;

COMMIT;
