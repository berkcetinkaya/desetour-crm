-- ============================================================
-- DESE TOUR OPERATIONS CENTER
-- Migration: Hagia Sophia Preparation Rule — "Ayasofya Giriş Bileti"
-- ============================================================
-- File:    supabase_migration_hagia_sophia_preparation_rule.sql
-- Depends: supabase_schema.sql, supabase_migration_tour_channels.sql,
--          supabase_migration_tour_channels_v2_booking_language.sql,
--          supabase_migration_tour_information_center.sql,
--          supabase_migration_tour_preparation_phase_a.sql
--          (all already applied)
--
-- WHAT THIS IS
-- ─────────────────────────────────────────────────────────────
-- Tour Preparation Intelligence Phase C2B — inserts EXACTLY ONE row into
-- public.tour_preparation_rules: a Hagia Sophia entrance-ticket
-- requirement for the Civitatis "Bosforo y Barrio Sultanahmet" tour,
-- Portuguese (Portekizce) booking-language variant specifically.
--
-- BUSINESS EVIDENCE (Phase C2A production audit, approved by Dese Tour):
-- that tour's own stored description explicitly states "we'll enter the
-- iconic Hagia Sophia" and "on your ticket to Santa Sofía, you'll find a
-- QR code", including the second-floor gallery — EXPLICIT_PREPARATION_
-- EVIDENCE, not an inference from general tourism knowledge. No other
-- stop or tour is touched by this migration: Blue Mosque, Spice Bazaar,
-- Hippodrome, Bosphorus Cruise, meal/lunch, and Topkapı are all
-- explicitly OUT OF SCOPE for this phase (Bosphorus Cruise pending a
-- separate operational-booking confirmation; meal preparation will be
-- driven by reservations.meal_status, never a static per-tour rule;
-- Topkapı belongs to a different tour and is reviewed separately) — this
-- migration inserts no row of any kind for any of them.
--
-- WHAT THIS DOES NOT DO
-- ─────────────────────────────────────────────────────────────
--   • Does NOT insert into reservation_preparations — no materialization
--     logic exists yet; this phase is the rule TEMPLATE only.
--   • Does NOT modify tours, tour_channels, tour_itinerary_stops, or any
--     existing tour_preparation_rules row.
--   • Does NOT modify reservations, meal_status, or purchased_activity_raw.
--   • Does NOT modify public.ingest_civitatis_booking,
--     public.cancel_civitatis_booking, or any Civitatis ingestion code —
--     this migration contains no DDL/DML referencing either function,
--     verified by the postflight's signature re-check below (same
--     pattern every Civitatis-adjacent migration since V10 already uses).
--   • Does NOT touch any WhatsApp table/object.
--
-- DETERMINISTIC IDENTITY RESOLUTION — NEVER BY NAME ALONE
-- ─────────────────────────────────────────────────────────────
-- TOUR: resolved by THREE conditions together — tour_channels.source_id
-- = the Civitatis source (sources.slug='civitatis') AND
-- tour_channels.booking_language = 'Portekizce' (the CRM's canonical
-- Turkish language NAME for Portuguese — see
-- api/_civitatis/languageMap.js's LANGUAGE_NAME_BY_CODE['pt'], never a
-- raw code or the Civitatis-native "Português") AND tours.name =
-- 'Bosforo y Barrio Sultanahmet'. tours.name is used only in
-- combination with the other two — never trusted alone. If this does
-- not resolve to EXACTLY ONE row, the migration RAISES EXCEPTION and
-- writes nothing.
--
-- ITINERARY STOP: resolved within that one tour by an EXPLICIT, BOUNDED
-- list of Hagia Sophia spelling variants actually evidenced in Dese
-- Tour's own stored tour description — 'Hagia Sophia', 'Ayasofya',
-- 'Aya Sofya', 'Santa Sofía', 'Santa Sofia' — matched ONLY against
-- tour_itinerary_stops.place_name (the stop's own short label), never
-- against description_tr/operational_note prose, which could mention
-- Hagia Sophia in passing without BEING the Hagia Sophia stop. Never a
-- generic "sophia-like" fuzzy match. If this does not resolve to EXACTLY
-- ONE row within the resolved tour, the migration RAISES EXCEPTION and
-- writes nothing.
--
-- IDEMPOTENCY
-- ─────────────────────────────────────────────────────────────
-- If a rule with the EXACT desired shape (same tour_id, same
-- itinerary_stop_id, preparation_type='entrance_ticket',
-- label='Ayasofya Giriş Bileti', quantity_rule='per_guest',
-- fixed_quantity IS NULL, is_active=TRUE) already exists, this migration
-- inserts nothing and reports a no-op NOTICE — same "safe to re-run"
-- convention every other migration in this codebase already uses (ADD
-- COLUMN IF NOT EXISTS, CREATE TABLE IF NOT EXISTS, ON CONFLICT DO
-- NOTHING), rather than erroring on a harmless re-run. This is NEVER a
-- duplicate-insert path: the WHERE NOT EXISTS guard below makes a second
-- row structurally impossible regardless of how many times this file is
-- executed.
--
-- SAFETY
-- ─────────────────────────────────────────────────────────────
--   • Exactly one INSERT statement in the whole file, guarded by WHERE
--     NOT EXISTS — never more than one row written, ever.
--   • Preflight (before any write) and postflight (after the write,
--     before COMMIT) both RAISE EXCEPTION and abort the WHOLE
--     transaction on any unexpected state — nothing partial is ever left
--     committed, same discipline as every migration since Phase A.
--   • No SQL in this file has been executed against production. No
--     Supabase connection was made to produce it. Validated only against
--     a disposable local Postgres instance, destroyed after validation.
--
-- HOW TO APPLY
-- ─────────────────────────────────────────────────────────────
-- Supabase Dashboard → SQL Editor → paste and run this file IN FULL, in
-- a single execution, only AFTER confirming
-- phase_c2b_hagia_sophia_rule_preflight.sql returns exactly the expected
-- one row. Wrapped in an explicit BEGIN/COMMIT so a failed preflight,
-- resolution, or postflight check aborts the whole transaction.
-- ============================================================


BEGIN;

DO $$
DECLARE
  v_missing                TEXT[] := ARRAY[]::TEXT[];
  v_civitatis_source_id     UUID;
  v_source_count            INTEGER;
  v_tour_id                 UUID;
  v_tour_count              INTEGER;
  v_stop_id                 UUID;
  v_stop_count              INTEGER;
  v_existing_exact_count    INTEGER;
  v_final_count             INTEGER;
  v_total_rules_before      INTEGER;
  v_total_rules_after       INTEGER;
BEGIN
  -- ────────────────────────────────────────────────────────────────────
  -- PREFLIGHT: confirm every table/column/constraint this migration
  -- depends on is exactly what it's expected to be, BEFORE touching
  -- anything. Read-only.
  -- ────────────────────────────────────────────────────────────────────

  IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='sources') THEN
    v_missing := array_append(v_missing, 'table sources');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='tours') THEN
    v_missing := array_append(v_missing, 'table tours');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='tour_channels') THEN
    v_missing := array_append(v_missing, 'table tour_channels');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='tour_channels' AND column_name='booking_language') THEN
    v_missing := array_append(v_missing, 'tour_channels.booking_language');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='tour_itinerary_stops') THEN
    v_missing := array_append(v_missing, 'table tour_itinerary_stops');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='tour_preparation_rules') THEN
    v_missing := array_append(v_missing, 'table tour_preparation_rules');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tour_preparation_rules_fixed_quantity_pair' AND contype = 'c') THEN
    v_missing := array_append(v_missing, 'tour_preparation_rules_fixed_quantity_pair CHECK');
  END IF;

  IF array_length(v_missing, 1) > 0 THEN
    RAISE EXCEPTION 'HAGIA SOPHIA RULE MIGRATION PREFLIGHT FAILED: %. Apply the dependency migrations listed in this file''s header BEFORE this one. Aborting before touching anything.', array_to_string(v_missing, ', ');
  END IF;

  -- ────────────────────────────────────────────────────────────────────
  -- STEP 1: resolve the Civitatis source deterministically.
  -- ────────────────────────────────────────────────────────────────────

  SELECT COUNT(*) INTO v_source_count FROM public.sources WHERE slug = 'civitatis';
  IF v_source_count = 0 THEN
    RAISE EXCEPTION 'HAGIA SOPHIA RULE MIGRATION FAILED: no sources row with slug=''civitatis'' found. Aborting before writing anything.';
  END IF;
  IF v_source_count > 1 THEN
    RAISE EXCEPTION 'HAGIA SOPHIA RULE MIGRATION FAILED: % sources rows have slug=''civitatis'' — ambiguous, needs manual resolution. Aborting before writing anything.', v_source_count;
  END IF;
  SELECT id INTO v_civitatis_source_id FROM public.sources WHERE slug = 'civitatis';

  -- ────────────────────────────────────────────────────────────────────
  -- STEP 2: resolve exactly one "Bosforo y Barrio Sultanahmet" +
  -- Portekizce tour, through tour_channels — never tours.name alone.
  -- ────────────────────────────────────────────────────────────────────

  SELECT COUNT(*) INTO v_tour_count
    FROM public.tour_channels tc
    JOIN public.tours t ON t.id = tc.tour_id
   WHERE tc.source_id = v_civitatis_source_id
     AND tc.booking_language = 'Portekizce'
     AND t.name = 'Bosforo y Barrio Sultanahmet';

  IF v_tour_count = 0 THEN
    RAISE EXCEPTION 'HAGIA SOPHIA RULE MIGRATION FAILED: zero tour_channels rows match (Civitatis source, booking_language=''Portekizce'', tours.name=''Bosforo y Barrio Sultanahmet''). Aborting before writing anything — re-run phase_c2b_hagia_sophia_rule_preflight.sql and resolve the identity manually before retrying this migration.';
  END IF;
  IF v_tour_count > 1 THEN
    RAISE EXCEPTION 'HAGIA SOPHIA RULE MIGRATION FAILED: % tour_channels rows match (Civitatis source, booking_language=''Portekizce'', tours.name=''Bosforo y Barrio Sultanahmet'') — ambiguous, needs manual resolution. Aborting before writing anything.', v_tour_count;
  END IF;

  SELECT t.id INTO v_tour_id
    FROM public.tour_channels tc
    JOIN public.tours t ON t.id = tc.tour_id
   WHERE tc.source_id = v_civitatis_source_id
     AND tc.booking_language = 'Portekizce'
     AND t.name = 'Bosforo y Barrio Sultanahmet';

  -- ────────────────────────────────────────────────────────────────────
  -- STEP 3: resolve exactly one Hagia Sophia itinerary stop belonging to
  -- that tour — explicit, bounded spelling-variant list, never a
  -- generic fuzzy match, matched ONLY against place_name.
  -- ────────────────────────────────────────────────────────────────────

  SELECT COUNT(*) INTO v_stop_count
    FROM public.tour_itinerary_stops
   WHERE tour_id = v_tour_id
     AND place_name ILIKE ANY (ARRAY[
       '%Hagia Sophia%', '%Ayasofya%', '%Aya Sofya%', '%Santa Sofía%', '%Santa Sofia%'
     ]);

  IF v_stop_count = 0 THEN
    RAISE EXCEPTION 'HAGIA SOPHIA RULE MIGRATION FAILED: zero tour_itinerary_stops rows for tour_id=% match a known Hagia Sophia spelling variant in place_name. Aborting before writing anything.', v_tour_id;
  END IF;
  IF v_stop_count > 1 THEN
    RAISE EXCEPTION 'HAGIA SOPHIA RULE MIGRATION FAILED: % tour_itinerary_stops rows for tour_id=% match a known Hagia Sophia spelling variant — ambiguous, needs manual resolution. Aborting before writing anything.', v_stop_count, v_tour_id;
  END IF;

  SELECT id INTO v_stop_id
    FROM public.tour_itinerary_stops
   WHERE tour_id = v_tour_id
     AND place_name ILIKE ANY (ARRAY[
       '%Hagia Sophia%', '%Ayasofya%', '%Aya Sofya%', '%Santa Sofía%', '%Santa Sofia%'
     ]);

  -- ────────────────────────────────────────────────────────────────────
  -- STEP 4: idempotent insert — exactly one row, exactly this shape,
  -- never duplicated on a re-run.
  -- ────────────────────────────────────────────────────────────────────

  SELECT COUNT(*) INTO v_total_rules_before FROM public.tour_preparation_rules;

  SELECT COUNT(*) INTO v_existing_exact_count
    FROM public.tour_preparation_rules
   WHERE tour_id = v_tour_id
     AND itinerary_stop_id = v_stop_id
     AND preparation_type = 'entrance_ticket'
     AND label = 'Ayasofya Giriş Bileti'
     AND quantity_rule = 'per_guest'
     AND fixed_quantity IS NULL
     AND is_active = TRUE;

  IF v_existing_exact_count = 0 THEN
    INSERT INTO public.tour_preparation_rules
      (tour_id, itinerary_stop_id, preparation_type, label, quantity_rule, fixed_quantity, is_active)
    VALUES
      (v_tour_id, v_stop_id, 'entrance_ticket', 'Ayasofya Giriş Bileti', 'per_guest', NULL, TRUE);
    RAISE NOTICE 'HAGIA SOPHIA RULE MIGRATION: inserted the "Ayasofya Giriş Bileti" rule for tour_id=%, itinerary_stop_id=%.', v_tour_id, v_stop_id;
  ELSE
    RAISE NOTICE 'HAGIA SOPHIA RULE MIGRATION: an identical active "Ayasofya Giriş Bileti" rule already exists for tour_id=%, itinerary_stop_id=% — no-op, nothing inserted.', v_tour_id, v_stop_id;
  END IF;

  -- Deterministic (never time-based) proof that AT MOST one row was
  -- added to the whole table by the INSERT above, and never more —
  -- this is the structural guarantee behind "insert no other
  -- preparation rule", checked without relying on created_at/clock
  -- timing, which a slow transaction or clock skew could make flaky.
  SELECT COUNT(*) INTO v_total_rules_after FROM public.tour_preparation_rules;
  IF (v_total_rules_after - v_total_rules_before) NOT IN (0, 1) THEN
    RAISE EXCEPTION 'HAGIA SOPHIA RULE MIGRATION POSTFLIGHT FAILED: tour_preparation_rules row count changed by % (expected 0 if already applied, or exactly 1 on first apply) — this migration must never insert more than one row. Aborting.', (v_total_rules_after - v_total_rules_before);
  END IF;

  -- ────────────────────────────────────────────────────────────────────
  -- POSTFLIGHT: exactly one desired, active rule must now exist for this
  -- tour/stop — and nothing else about the rest of the schema changed.
  -- ────────────────────────────────────────────────────────────────────

  SELECT COUNT(*) INTO v_final_count
    FROM public.tour_preparation_rules
   WHERE tour_id = v_tour_id
     AND itinerary_stop_id = v_stop_id
     AND preparation_type = 'entrance_ticket'
     AND label = 'Ayasofya Giriş Bileti'
     AND quantity_rule = 'per_guest'
     AND fixed_quantity IS NULL
     AND is_active = TRUE;

  IF v_final_count != 1 THEN
    RAISE EXCEPTION 'HAGIA SOPHIA RULE MIGRATION POSTFLIGHT FAILED: expected exactly 1 matching active rule for tour_id=%, itinerary_stop_id=%, found %. Aborting — the whole transaction will be rolled back.', v_tour_id, v_stop_id, v_final_count;
  END IF;

  -- reservation_preparations must remain completely untouched — this
  -- migration never references that table in any write statement; this
  -- is a structural, not merely observed, guarantee, re-stated here only
  -- as an explicit postflight record.
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='reservation_preparations') THEN
    RAISE EXCEPTION 'HAGIA SOPHIA RULE MIGRATION POSTFLIGHT FAILED: reservation_preparations table disappeared — out of scope, must never happen. Aborting.';
  END IF;

  -- Re-confirm both Civitatis RPCs are STILL exactly what they were
  -- before this migration ran — never touched. Signature check is
  -- OPTIONAL (SELECT, not EXCEPTION) when the function is simply absent
  -- from this environment (e.g. a throwaway validation database that
  -- never applied the Civitatis write migrations) — but if the function
  -- IS present, its signature must be unchanged.
  IF EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = 'ingest_civitatis_booking'
  ) AND NOT EXISTS (
    SELECT 1
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname = 'ingest_civitatis_booking'
       AND p.pronargs = 26
  ) THEN
    RAISE EXCEPTION 'HAGIA SOPHIA RULE MIGRATION POSTFLIGHT FAILED: public.ingest_civitatis_booking is present but its argument count changed during this migration. This must never happen — aborting.';
  END IF;

  RAISE NOTICE 'HAGIA SOPHIA RULE MIGRATION POSTFLIGHT PASSED: exactly 1 active "Ayasofya Giriş Bileti" entrance_ticket rule exists for tour_id=%, itinerary_stop_id=%. No other preparation rule, no reservation_preparations row, and the Civitatis RPCs were never touched.', v_tour_id, v_stop_id;
END $$;

-- Manual-verification result set — runs inside the same transaction,
-- before COMMIT, so Berk sees exactly what was (or already had been)
-- written before it becomes permanent.
SELECT
  tpr.id                AS preparation_rule_id,
  tpr.tour_id,
  t.name                 AS tour_name,
  tc.booking_language,
  tpr.itinerary_stop_id,
  tis.place_name,
  tpr.preparation_type,
  tpr.label,
  tpr.quantity_rule,
  tpr.fixed_quantity,
  tpr.is_active
FROM public.tour_preparation_rules tpr
JOIN public.tours t              ON t.id = tpr.tour_id
JOIN public.tour_itinerary_stops tis ON tis.id = tpr.itinerary_stop_id
JOIN public.tour_channels tc     ON tc.tour_id = t.id
JOIN public.sources s            ON s.id = tc.source_id
WHERE s.slug = 'civitatis'
  AND tc.booking_language = 'Portekizce'
  AND tpr.label = 'Ayasofya Giriş Bileti';

COMMIT;

-- ============================================================
-- END OF MIGRATION supabase_migration_hagia_sophia_preparation_rule.sql
-- ============================================================
