-- ============================================================
-- DESE TOUR OPERATIONS CENTER
-- ROLLBACK: Hagia Sophia Preparation Rule — "Ayasofya Giriş Bileti"
-- ============================================================
-- File:    supabase_migration_hagia_sophia_preparation_rule_ROLLBACK.sql
-- Rolls back: supabase_migration_hagia_sophia_preparation_rule.sql
--
-- WHAT THIS DOES
-- ─────────────────────────────────────────────────────────────
-- Removes ONLY the exact "Ayasofya Giriş Bileti" entrance_ticket rule
-- created by the forward migration, for the exact same deterministically
-- resolved tour ("Bosforo y Barrio Sultanahmet", Portekizce, via the
-- Civitatis source + tour_channels — never tours.name alone) and the
-- exact same Hagia Sophia itinerary stop (resolved by the identical
-- bounded spelling-variant list the forward migration uses). Uses the
-- SAME resolution logic as the forward migration, including the same
-- fail-closed-on-ambiguity behavior — if the tour or the stop cannot be
-- resolved to exactly one row, this rollback aborts without deleting
-- anything.
--
-- WHAT THIS DOES NOT DO
-- ─────────────────────────────────────────────────────────────
--   • Does NOT touch reservation_preparations — not referenced anywhere
--     in this file, in any statement.
--   • Does NOT remove any OTHER tour_preparation_rules row — the DELETE
--     below is scoped to tour_id + itinerary_stop_id +
--     preparation_type='entrance_ticket' + label='Ayasofya Giriş
--     Bileti' together, so an unrelated entrance_ticket rule for a
--     different stop, or a future rule for Topkapı/Blue Mosque/etc.,
--     can never be removed by this file.
--   • Does NOT modify tours, tour_channels, tour_itinerary_stops,
--     reservations, or any Civitatis ingestion code/RPC.
--
-- IDEMPOTENCY
-- ─────────────────────────────────────────────────────────────
-- Safe to run more than once: if the rule was already removed (or never
-- existed), the DELETE affects zero rows and this reports a NOTICE, not
-- an error — the same "a second run no-ops" convention every rollback
-- in this codebase already follows.
--
-- HOW TO APPLY
-- ─────────────────────────────────────────────────────────────
-- Supabase Dashboard → SQL Editor → paste and run this file IN FULL, in
-- a single execution. Wrapped in an explicit BEGIN/COMMIT.
-- ============================================================


BEGIN;

DO $$
DECLARE
  v_civitatis_source_id  UUID;
  v_source_count         INTEGER;
  v_tour_id              UUID;
  v_tour_count           INTEGER;
  v_stop_id              UUID;
  v_stop_count           INTEGER;
  v_deleted_count        INTEGER;
BEGIN
  -- Same dependency preflight as the forward migration.
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='sources')
     OR NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='tours')
     OR NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='tour_channels')
     OR NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='tour_itinerary_stops')
     OR NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='tour_preparation_rules')
  THEN
    RAISE EXCEPTION 'HAGIA SOPHIA RULE ROLLBACK FAILED: one or more dependency tables (sources/tours/tour_channels/tour_itinerary_stops/tour_preparation_rules) is missing. Aborting before touching anything.';
  END IF;

  -- Resolve the Civitatis source — fail closed on zero or multiple.
  SELECT COUNT(*) INTO v_source_count FROM public.sources WHERE slug = 'civitatis';
  IF v_source_count = 0 THEN
    RAISE EXCEPTION 'HAGIA SOPHIA RULE ROLLBACK FAILED: no sources row with slug=''civitatis'' found. Aborting before deleting anything.';
  END IF;
  IF v_source_count > 1 THEN
    RAISE EXCEPTION 'HAGIA SOPHIA RULE ROLLBACK FAILED: % sources rows have slug=''civitatis'' — ambiguous. Aborting before deleting anything.', v_source_count;
  END IF;
  SELECT id INTO v_civitatis_source_id FROM public.sources WHERE slug = 'civitatis';

  -- Resolve the same tour identity as the forward migration — fail
  -- closed on zero or multiple. Never tours.name alone.
  SELECT COUNT(*) INTO v_tour_count
    FROM public.tour_channels tc
    JOIN public.tours t ON t.id = tc.tour_id
   WHERE tc.source_id = v_civitatis_source_id
     AND tc.booking_language = 'Portekizce'
     AND t.name = 'Bosforo y Barrio Sultanahmet';

  IF v_tour_count = 0 THEN
    RAISE EXCEPTION 'HAGIA SOPHIA RULE ROLLBACK FAILED: zero tour_channels rows match (Civitatis source, booking_language=''Portekizce'', tours.name=''Bosforo y Barrio Sultanahmet''). Aborting before deleting anything.';
  END IF;
  IF v_tour_count > 1 THEN
    RAISE EXCEPTION 'HAGIA SOPHIA RULE ROLLBACK FAILED: % tour_channels rows match that identity — ambiguous. Aborting before deleting anything.', v_tour_count;
  END IF;

  SELECT t.id INTO v_tour_id
    FROM public.tour_channels tc
    JOIN public.tours t ON t.id = tc.tour_id
   WHERE tc.source_id = v_civitatis_source_id
     AND tc.booking_language = 'Portekizce'
     AND t.name = 'Bosforo y Barrio Sultanahmet';

  -- Resolve the same Hagia Sophia stop as the forward migration — fail
  -- closed on zero or multiple. place_name only, same bounded variant
  -- list, never a generic fuzzy match.
  SELECT COUNT(*) INTO v_stop_count
    FROM public.tour_itinerary_stops
   WHERE tour_id = v_tour_id
     AND place_name ILIKE ANY (ARRAY[
       '%Hagia Sophia%', '%Ayasofya%', '%Aya Sofya%', '%Santa Sofía%', '%Santa Sofia%'
     ]);

  IF v_stop_count = 0 THEN
    RAISE EXCEPTION 'HAGIA SOPHIA RULE ROLLBACK FAILED: zero tour_itinerary_stops rows for tour_id=% match a known Hagia Sophia spelling variant. Aborting before deleting anything.', v_tour_id;
  END IF;
  IF v_stop_count > 1 THEN
    RAISE EXCEPTION 'HAGIA SOPHIA RULE ROLLBACK FAILED: % tour_itinerary_stops rows for tour_id=% match a known Hagia Sophia spelling variant — ambiguous. Aborting before deleting anything.', v_stop_count, v_tour_id;
  END IF;

  SELECT id INTO v_stop_id
    FROM public.tour_itinerary_stops
   WHERE tour_id = v_tour_id
     AND place_name ILIKE ANY (ARRAY[
       '%Hagia Sophia%', '%Ayasofya%', '%Aya Sofya%', '%Santa Sofía%', '%Santa Sofia%'
     ]);

  -- Tightly scoped delete — tour_id + itinerary_stop_id +
  -- preparation_type + label all together, so this can never remove a
  -- different rule, including a different entrance_ticket rule at a
  -- different stop or a future Topkapı/Blue Mosque rule.
  DELETE FROM public.tour_preparation_rules
   WHERE tour_id = v_tour_id
     AND itinerary_stop_id = v_stop_id
     AND preparation_type = 'entrance_ticket'
     AND label = 'Ayasofya Giriş Bileti';

  GET DIAGNOSTICS v_deleted_count = ROW_COUNT;

  IF v_deleted_count > 1 THEN
    RAISE EXCEPTION 'HAGIA SOPHIA RULE ROLLBACK FAILED: deleted % rows, expected at most 1 — the resolved identity matched more rows than this rollback is designed to touch. The transaction will be rolled back; investigate before retrying.', v_deleted_count;
  ELSIF v_deleted_count = 1 THEN
    RAISE NOTICE 'HAGIA SOPHIA RULE ROLLBACK: removed the "Ayasofya Giriş Bileti" rule for tour_id=%, itinerary_stop_id=%.', v_tour_id, v_stop_id;
  ELSE
    RAISE NOTICE 'HAGIA SOPHIA RULE ROLLBACK: no matching rule existed for tour_id=%, itinerary_stop_id=% — no-op (already rolled back, or never applied).', v_tour_id, v_stop_id;
  END IF;

  -- Postflight: the exact rule must be gone; reservation_preparations
  -- must still exist and is never referenced by this file's writes.
  IF EXISTS (
    SELECT 1 FROM public.tour_preparation_rules
     WHERE tour_id = v_tour_id AND itinerary_stop_id = v_stop_id
       AND preparation_type = 'entrance_ticket' AND label = 'Ayasofya Giriş Bileti'
  ) THEN
    RAISE EXCEPTION 'HAGIA SOPHIA RULE ROLLBACK POSTFLIGHT FAILED: the rule still exists after DELETE. Aborting.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='reservation_preparations') THEN
    RAISE EXCEPTION 'HAGIA SOPHIA RULE ROLLBACK POSTFLIGHT FAILED: reservation_preparations table disappeared — out of scope, must never happen. Aborting.';
  END IF;

  RAISE NOTICE 'HAGIA SOPHIA RULE ROLLBACK POSTFLIGHT PASSED: no "Ayasofya Giriş Bileti" rule remains for tour_id=%, itinerary_stop_id=%.', v_tour_id, v_stop_id;
END $$;

COMMIT;

-- ============================================================
-- END OF ROLLBACK supabase_migration_hagia_sophia_preparation_rule_ROLLBACK.sql
-- ============================================================
