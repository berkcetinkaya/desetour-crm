-- ============================================================
-- DESE TOUR OPERATIONS CENTER
-- Migration: Topkapı combined-entry preparation rule + €40 internal cost
-- ============================================================
-- File:    supabase_migration_finance_topkapi_rule.sql
-- Rollback: supabase_migration_finance_topkapi_rule_ROLLBACK.sql
-- Depends: supabase_migration_finance_center.sql,
--          supabase_migration_tour_preparation_phase_a.sql,
--          supabase_migration_tour_information_center.sql (tour_itinerary_stops),
--          supabase_data_historic_istanbul_portuguese_tour_information.sql
-- Preflight (read-only, run first): finance_topkapi_rule_preflight.sql
-- Version: Finance Center Phase C — NOT YET APPROVED FOR PRODUCTION.
--
-- WHAT THIS DOES
--   1. For every tour id in v_tour_ids (explicitly approved tours — never
--      matched by tour display name), inserts ONE active
--      tour_preparation_rules row:
--        preparation_type = 'entrance_ticket'
--        label            = 'Topkapı Sarayı Kombine Giriş Bileti'
--        quantity_rule    = 'per_guest'   (pax_adult + pax_child; no age data
--                                          exists, so no child eligibility is
--                                          invented)
--        itinerary_stop_id = the tour's single "Topkapı Sarayı" stop.
--      The Topkapı combined public ticket includes Topkapı Palace, Hagia
--      Irene and the Harem, so the tour's separate "Topkapı Harem" stop gets
--      NO rule and NO cost — never a second Harem charge.
--   2. Seeds the INTERNAL Finance cost item "Topkapı Combined Entry":
--      €40 × the rule's materialized required_quantity
--      (basis = 'preparation_rule'). Finance never recomputes Topkapı pax.
--
-- WHAT THIS DOES NOT DO
--   • Does NOT write reservation_preparations. Existing reservations get a
--     Topkapı row the next time materialize_reservation_preparations runs for
--     them; finance_topkapi_rule_backfill.sql does that explicitly for
--     upcoming reservations, as a separate, reviewed step. Until then Finance
--     reports those reservations as "hazırlık oluşturulmamış" (unresolved),
--     never as a guessed cost.
--   • Does NOT create a public-reference price (no verified figure supplied)
--     and never lets one drive Finance.
--
-- TO ADD ANOTHER TOPKAPI TOUR (e.g. a Spanish "Estambul Histórica"): run the
-- preflight, confirm its tour id, add it to v_tour_ids, re-run — idempotent.
-- ============================================================

BEGIN;

DO $$
DECLARE
  v_tour_ids UUID[] := ARRAY[
    'a4e4bf16-a108-4a45-9418-d849f5bb7917'::uuid   -- Estambul Histórica · Portekizce (Civitatis)
  ];
  v_tour UUID;
  v_stop_count INT;
  v_stop UUID;
  v_rule UUID;
  v_label CONSTANT TEXT := 'Topkapı Sarayı Kombine Giriş Bileti';
BEGIN
  IF to_regclass('public.finance_cost_items') IS NULL THEN
    RAISE EXCEPTION 'TOPKAPI RULE MIGRATION PREFLIGHT FAILED: apply supabase_migration_finance_center.sql first.';
  END IF;

  FOREACH v_tour IN ARRAY v_tour_ids LOOP
    IF NOT EXISTS (SELECT 1 FROM public.tours WHERE id = v_tour) THEN
      RAISE EXCEPTION 'TOPKAPI RULE MIGRATION FAILED: tour % does not exist. Aborting before writing anything.', v_tour;
    END IF;

    -- Exactly one Topkapı PALACE stop (never the Harem stop).
    SELECT COUNT(*) INTO v_stop_count FROM public.tour_itinerary_stops
     WHERE tour_id = v_tour
       AND place_name ILIKE ANY (ARRAY['%Topkapı%', '%Topkapi%'])
       AND place_name NOT ILIKE '%harem%';
    IF v_stop_count <> 1 THEN
      RAISE EXCEPTION 'TOPKAPI RULE MIGRATION FAILED: tour % has % non-Harem Topkapı itinerary stop(s); expected exactly 1. Aborting — resolve manually.', v_tour, v_stop_count;
    END IF;
    SELECT id INTO v_stop FROM public.tour_itinerary_stops
     WHERE tour_id = v_tour
       AND place_name ILIKE ANY (ARRAY['%Topkapı%', '%Topkapi%'])
       AND place_name NOT ILIKE '%harem%';

    -- DUPLICATE GUARD: a tour may already carry its own active Topkapı ticket
    -- rule under a different label (production does: "Topkapı Sarayı + Harem
    -- Bileti", created outside this repo, with live preparations). Creating a
    -- second rule would double every ticket preparation and every Finance
    -- ticket cost — abort and reuse the existing rule instead.
    IF EXISTS (SELECT 1 FROM public.tour_preparation_rules
                WHERE tour_id = v_tour AND is_active AND preparation_type = 'entrance_ticket'
                  AND label <> v_label AND label ILIKE ANY (ARRAY['%Topkapı%', '%Topkapi%'])) THEN
      RAISE EXCEPTION 'TOPKAPI RULE MIGRATION FAILED: tour % already has another active Topkapı entrance-ticket rule (%). Refusing to create a duplicate — link the €40 internal cost to that existing rule instead.',
        v_tour, (SELECT string_agg(id::text || ' "' || label || '"', ', ') FROM public.tour_preparation_rules
                  WHERE tour_id = v_tour AND is_active AND preparation_type = 'entrance_ticket' AND label <> v_label
                    AND label ILIKE ANY (ARRAY['%Topkapı%', '%Topkapi%']));
    END IF;

    -- Idempotent rule insert.
    SELECT id INTO v_rule FROM public.tour_preparation_rules
     WHERE tour_id = v_tour AND itinerary_stop_id = v_stop
       AND preparation_type = 'entrance_ticket' AND label = v_label
       AND quantity_rule = 'per_guest' AND fixed_quantity IS NULL AND is_active;
    IF v_rule IS NULL THEN
      INSERT INTO public.tour_preparation_rules
        (tour_id, itinerary_stop_id, preparation_type, label, quantity_rule, fixed_quantity, is_active)
      VALUES (v_tour, v_stop, 'entrance_ticket', v_label, 'per_guest', NULL, TRUE)
      RETURNING id INTO v_rule;
      RAISE NOTICE 'TOPKAPI RULE MIGRATION: inserted rule % for tour %.', v_rule, v_tour;
    ELSE
      RAISE NOTICE 'TOPKAPI RULE MIGRATION: rule % already exists for tour % — no-op.', v_rule, v_tour;
    END IF;

    -- Idempotent INTERNAL cost item bound to that rule.
    IF NOT EXISTS (SELECT 1 FROM public.finance_cost_items
                    WHERE preparation_rule_id = v_rule AND kind = 'internal' AND is_active) THEN
      INSERT INTO public.finance_cost_items
        (label, category, basis, amount, currency, tour_id, preparation_rule_id, valid_from, kind, source_note)
      VALUES ('Topkapı Combined Entry', 'ticket', 'preparation_rule', 40, 'EUR', v_tour, v_rule, DATE '2026-01-01', 'internal',
              'Internal DeseTour planning cost per guest for the Topkapı combined entry (Topkapı Palace + Hagia Irene + Harem). Not a public retail price; never overwritten by a public reference.');
    END IF;

    -- Postflight per tour: exactly one active rule + one active internal item, and no Harem rule.
    IF (SELECT COUNT(*) FROM public.tour_preparation_rules WHERE tour_id = v_tour AND label = v_label AND is_active) <> 1 THEN
      RAISE EXCEPTION 'TOPKAPI RULE POSTFLIGHT FAILED: expected exactly 1 active Topkapı rule for tour %.', v_tour;
    END IF;
    IF (SELECT COUNT(*) FROM public.finance_cost_items WHERE preparation_rule_id = v_rule AND kind = 'internal' AND is_active) <> 1 THEN
      RAISE EXCEPTION 'TOPKAPI RULE POSTFLIGHT FAILED: expected exactly 1 active internal cost item for rule %.', v_rule;
    END IF;
    IF EXISTS (SELECT 1 FROM public.tour_preparation_rules r JOIN public.tour_itinerary_stops s ON s.id = r.itinerary_stop_id
                WHERE r.tour_id = v_tour AND r.is_active AND s.place_name ILIKE '%harem%') THEN
      RAISE EXCEPTION 'TOPKAPI RULE POSTFLIGHT FAILED: an active rule is attached to a Harem stop on tour % — the combined ticket already includes the Harem.', v_tour;
    END IF;
  END LOOP;
END $$;

-- Verification result set (before COMMIT).
SELECT r.id AS preparation_rule_id, t.name AS tour_name, s.place_name, r.label, r.quantity_rule,
       f.id AS cost_item_id, f.amount, f.currency, f.basis, f.kind
  FROM public.tour_preparation_rules r
  JOIN public.tours t ON t.id = r.tour_id
  JOIN public.tour_itinerary_stops s ON s.id = r.itinerary_stop_id
  LEFT JOIN public.finance_cost_items f ON f.preparation_rule_id = r.id AND f.kind = 'internal' AND f.is_active
 WHERE r.label = 'Topkapı Sarayı Kombine Giriş Bileti';

COMMIT;
