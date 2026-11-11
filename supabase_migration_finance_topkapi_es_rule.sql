-- ============================================================
-- DESE TOUR OPERATIONS CENTER
-- Migration: Topkapı ticket rule + costs for the Spanish Topkapı product
-- ============================================================
-- File:    supabase_migration_finance_topkapi_es_rule.sql
-- Rollback: supabase_migration_finance_topkapi_es_rule_ROLLBACK.sql
-- Depends: supabase_migration_finance_center.sql (+ is_provisional)
-- Backfill (separate, reviewed step): finance_topkapi_es_backfill.sql
--
-- OWNER DECISION (2026-11-11): add the Topkapı combined-entry rule to
--   3d3a335a-1320-4277-977d-62a19fa7090a
--   "Topkapi Palace Complete Tour: Harem & Hagia Irene" · Civitatis · İspanyolca
-- Verified read-only on 2026-11-11: tour status 'draft' but its Civitatis
-- channel is active and it carries 8 reservations (6 upcoming), with NO
-- preparation rule — so no Topkapı ticket task was ever created for them.
--
-- WHAT THIS DOES
--   1. Inserts ONE active tour_preparation_rules row, same shape as the
--      existing production Topkapı rule on Estambul Histórica:
--        entrance_ticket · "Topkapı Sarayı + Harem Bileti" · per_guest ·
--        itinerary_stop_id NULL (this product has no itinerary stops).
--   2. Links the INTERNAL €40 planning cost to it (basis preparation_rule).
--   3. Stores the official ₺2,750 combined ticket as a public_reference.
--   The combined ticket includes Topkapı Palace + Hagia Irene + Harem — no
--   separate Harem / Hagia Irene rule or charge.
--
-- WHAT THIS DOES NOT DO
--   • Does NOT write reservation_preparations. New Civitatis bookings are
--     materialized by ingestion automatically; existing UPCOMING reservations
--     need finance_topkapi_es_backfill.sql, run separately.
--   • Does NOT change the tour's draft / inactive status.
-- ============================================================

BEGIN;

DO $$
DECLARE
  v_tour  CONSTANT UUID := '3d3a335a-1320-4277-977d-62a19fa7090a';
  v_label CONSTANT TEXT := 'Topkapı Sarayı + Harem Bileti';
  v_rule  UUID;
BEGIN
  IF to_regclass('public.finance_cost_items') IS NULL THEN
    RAISE EXCEPTION 'TOPKAPI ES MIGRATION PREFLIGHT FAILED: apply supabase_migration_finance_center.sql first.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.tours WHERE id = v_tour AND name ILIKE '%Topkapi%') THEN
    RAISE EXCEPTION 'TOPKAPI ES MIGRATION FAILED: tour % not found as a Topkapı product. Aborting before writing anything.', v_tour;
  END IF;

  -- Reuse an identical rule if this file was already applied; refuse if any
  -- OTHER active Topkapı ticket rule exists (never two rules for one product).
  SELECT id INTO v_rule FROM public.tour_preparation_rules
   WHERE tour_id = v_tour AND is_active AND preparation_type = 'entrance_ticket'
     AND label = v_label AND quantity_rule = 'per_guest' AND fixed_quantity IS NULL;
  IF v_rule IS NULL AND EXISTS (SELECT 1 FROM public.tour_preparation_rules
       WHERE tour_id = v_tour AND is_active AND preparation_type = 'entrance_ticket'
         AND label ILIKE ANY (ARRAY['%Topkapı%', '%Topkapi%'])) THEN
    RAISE EXCEPTION 'TOPKAPI ES MIGRATION FAILED: tour % already has a different active Topkapı ticket rule — resolve manually.', v_tour;
  END IF;
  IF v_rule IS NULL THEN
    INSERT INTO public.tour_preparation_rules
      (tour_id, itinerary_stop_id, preparation_type, label, quantity_rule, fixed_quantity, is_active)
    VALUES (v_tour, NULL, 'entrance_ticket', v_label, 'per_guest', NULL, TRUE)
    RETURNING id INTO v_rule;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.finance_cost_items WHERE preparation_rule_id = v_rule AND kind = 'internal' AND is_active) THEN
    INSERT INTO public.finance_cost_items
      (label, category, basis, amount, currency, tour_id, preparation_rule_id, valid_from, kind, source_note)
    VALUES ('Topkapı Combined Entry', 'ticket', 'preparation_rule', 40, 'EUR', v_tour, v_rule, DATE '2026-01-01', 'internal',
            'Internal DeseTour planning cost per guest for the Topkapı combined entry (Topkapı Palace + Hagia Irene + Harem). Not a public retail price; never overwritten by a public reference.');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.finance_cost_items WHERE preparation_rule_id = v_rule AND kind = 'public_reference' AND is_active) THEN
    INSERT INTO public.finance_cost_items
      (label, category, basis, amount, currency, tour_id, preparation_rule_id, valid_from, kind, source_note, source_url, last_verified_date)
    VALUES ('Topkapı Palace Combine Ticket (official tariff)', 'ticket', 'preparation_rule', 2750, 'TRY', v_tour, v_rule,
            DATE '2026-11-11', 'public_reference',
            'National Palaces official foreign-visitor combined ticket: Topkapı Palace + Hagia Irene + Harem. Public reference only — never DeseTour''s internal planning cost.',
            'https://www.millisaraylar.gov.tr/Lokasyon/2/Topkapi-Sarayi?culture=en', DATE '2026-11-11');
  END IF;

  -- POSTFLIGHT
  IF (SELECT COUNT(*) FROM public.tour_preparation_rules WHERE tour_id = v_tour AND is_active AND preparation_type = 'entrance_ticket'
        AND label ILIKE ANY (ARRAY['%Topkapı%', '%Topkapi%'])) <> 1 THEN
    RAISE EXCEPTION 'TOPKAPI ES POSTFLIGHT FAILED: expected exactly one active Topkapı ticket rule on tour %.', v_tour;
  END IF;
  IF (SELECT COUNT(*) FROM public.finance_cost_items WHERE preparation_rule_id = v_rule AND kind = 'internal' AND is_active) <> 1 THEN
    RAISE EXCEPTION 'TOPKAPI ES POSTFLIGHT FAILED: expected exactly one active internal cost item for rule %.', v_rule;
  END IF;
  RAISE NOTICE 'TOPKAPI ES POSTFLIGHT PASSED: rule % with €40 internal cost and ₺2,750 public reference on tour %. No preparation written — run finance_topkapi_es_backfill.sql for upcoming reservations.', v_rule, v_tour;
END $$;

SELECT r.id AS preparation_rule_id, t.name AS tour_name, r.label, r.quantity_rule,
       f.kind, f.amount, f.currency
  FROM public.tour_preparation_rules r
  JOIN public.tours t ON t.id = r.tour_id
  LEFT JOIN public.finance_cost_items f ON f.preparation_rule_id = r.id AND f.is_active
 WHERE r.tour_id = '3d3a335a-1320-4277-977d-62a19fa7090a'
 ORDER BY f.kind;

COMMIT;
