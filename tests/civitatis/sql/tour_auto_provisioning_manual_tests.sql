-- ============================================================
-- MANUAL / STAGING DATABASE TEST PLAN
-- public.ingest_civitatis_booking(...) — V10 tour auto-provisioning
-- ============================================================
-- NOT EXECUTED as part of preparing this file. Requires a real
-- PostgreSQL/Supabase database with every dependency listed in
-- supabase_migration_civitatis_write_v10_tour_auto_provisioning.sql's
-- own header already applied — including
-- supabase_migration_tour_channels_v2_booking_language.sql (V10's own
-- preflight guard will refuse to install itself at all if this is
-- missing, but these TESTS assume the function is already installed) —
-- AND V10 itself already applied. Run this file (e.g. via `psql` or the
-- Supabase SQL editor) against a STAGING database only, never
-- production.
--
-- WHY THIS EXISTS AS SQL, NOT A JS TEST — same reasoning as
-- tests/civitatis/sql/ingest_civitatis_booking_manual_tests.sql: the
-- core claims under test here (a real tour/tour_language/tour_channel
-- actually gets created inside a real transaction, a real advisory lock
-- actually serializes two callers, a real EXCEPTION actually rolls back
-- a real INSERT) can only be genuinely proven by PostgreSQL itself
-- executing them — a JS test with a fake in-memory repo cannot
-- demonstrate that. See tests/civitatis/tourLanguageMapping.test.js and
-- tests/civitatis/writeAdapter.test.js for everything that CAN be proven
-- without a database (the JS-side eligibility/payload-construction
-- layer, matching.js's `provisionable` classification).
--
-- NAMED-PARAMETER CALLS (a deliberate departure from the positional-call
-- convention ingest_civitatis_booking_manual_tests.sql uses): V10 adds 3
-- new trailing parameters on top of the pre-existing 23, and several
-- tests below specifically exercise combinations of those 3 alongside
-- p_tour_id — writing all 26 positionally would make exactly the
-- parameter being varied illegible at a glance. Postgres's
-- `param_name => value` call syntax is used instead, for these NEW
-- tests only, so each test's actual point is visible without counting
-- commas.
--
-- EACH TEST BLOCK is wrapped in its own BEGIN ... ROLLBACK, so running
-- this whole file leaves no residue even against a database with real
-- data — but a dedicated staging database is still strongly
-- recommended, per the same caveat the sibling file states.
--
-- HOW TO READ A FAILURE: every assertion uses
--   IF NOT (<condition>) THEN RAISE EXCEPTION '<test name>: FAILED — <detail>'; END IF;
-- A silent, error-free run of this whole file means every test passed.
-- ============================================================


-- ──────────────────────────────────────────────────────────────────────────
-- Shared fixture: the real Civitatis source row (or a throwaway one).
-- No pre-existing tour is created here, deliberately — every test below
-- either provisions its own or is explicitly about there being none yet.
-- ──────────────────────────────────────────────────────────────────────────

DO $$
DECLARE
  v_source_id UUID;
BEGIN
  SELECT id INTO v_source_id FROM public.sources WHERE slug ILIKE 'civitatis%' LIMIT 1;
  IF v_source_id IS NULL THEN
    INSERT INTO public.sources (name, slug, is_active) VALUES ('Civitatis (test)', 'civitatis-manual-test', TRUE)
    RETURNING id INTO v_source_id;
  END IF;
  RAISE NOTICE 'Fixture ready: source_id=%. Copy this into TEST AP1-AP11 below before running them (psql does not share variables across DO blocks).', v_source_id;
END $$;


-- ══════════════════════════════════════════════════════════════════════════
-- TEST AP1 — new product + Spanish: one Spanish draft tour, mapping,
-- reservation. The baseline "everything works" case.
-- ══════════════════════════════════════════════════════════════════════════
BEGIN;
DO $$
DECLARE
  v_source_id UUID;
  r JSONB;
  v_tour_id UUID;
  v_tour_count INT;
  v_lang_count INT;
  v_channel_count INT;
BEGIN
  SELECT id INTO v_source_id FROM public.sources WHERE slug ILIKE 'civitatis%' LIMIT 1;

  r := public.ingest_civitatis_booking(
    p_gmail_message_id    => 'gmail-ap1-001',
    p_gmail_thread_id     => 'thread-ap1',
    p_received_at         => NOW(),
    p_raw_subject         => 'New booking A91000001: AP1 Manual Test Tour',
    p_raw_body_snapshot   => 'raw body',
    p_event_type          => 'new_booking',
    p_source_id           => v_source_id,
    p_external_booking_id => '91000001',
    p_tour_id             => NULL,
    p_tour_language       => 'İspanyolca',
    p_check_in            => CURRENT_DATE + 30,
    p_check_in_time       => '09:00',
    p_pax_adult            => 2,
    p_pax_child             => 0,
    p_total_amount           => 3600,
    p_currency                => 'TL',
    p_retail_amount            => 4800,
    p_retail_currency           => 'TL',
    p_customer_id                => NULL,
    p_customer_full_name          => 'AP1 Test Contact',
    p_customer_email               => NULL,
    p_customer_phone                => NULL,
    p_passengers                     => '[{"fullName":"AP1 PASSENGER ONE","sortOrder":0},{"fullName":"AP1 PASSENGER TWO","sortOrder":1}]'::jsonb,
    p_auto_provision_tour             => TRUE,
    p_civitatis_internal_code          => 'AP1 Manual Test Tour',
    p_civitatis_language_code           => 'es'
  );

  IF r->>'result' <> 'created' THEN
    RAISE EXCEPTION 'AP1: FAILED — expected result=created, got % (full response: %)', r->>'result', r;
  END IF;
  IF (r->>'tour_auto_provisioned')::boolean IS NOT TRUE THEN
    RAISE EXCEPTION 'AP1: FAILED — expected tour_auto_provisioned=true, got %', r->>'tour_auto_provisioned';
  END IF;
  v_tour_id := (r->>'tour_id')::uuid;
  IF v_tour_id IS NULL THEN
    RAISE EXCEPTION 'AP1: FAILED — response tour_id is NULL';
  END IF;

  SELECT COUNT(*) INTO v_tour_count FROM public.tours
   WHERE id = v_tour_id AND name = 'AP1 Manual Test Tour' AND category = 'other'
     AND status = 'draft' AND base_price = 0 AND currency = 'EUR';
  IF v_tour_count <> 1 THEN
    RAISE EXCEPTION 'AP1: FAILED — expected exactly 1 tour with name/category/status/base_price/currency exactly as specified, found %', v_tour_count;
  END IF;

  SELECT COUNT(*) INTO v_lang_count FROM public.tour_languages
   WHERE tour_id = v_tour_id AND language_code = 'es' AND language_name = 'İspanyolca';
  IF v_lang_count <> 1 THEN
    RAISE EXCEPTION 'AP1: FAILED — expected exactly 1 tour_languages row (es/İspanyolca), found %', v_lang_count;
  END IF;

  SELECT COUNT(*) INTO v_channel_count FROM public.tour_channels
   WHERE tour_id = v_tour_id AND source_id = v_source_id
     AND external_product_id = 'AP1 Manual Test Tour' AND booking_language = 'İspanyolca'
     AND is_active = TRUE AND price IS NULL AND currency IS NULL;
  IF v_channel_count <> 1 THEN
    RAISE EXCEPTION 'AP1: FAILED — expected exactly 1 tour_channels row with price/currency NULL, found %', v_channel_count;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.reservations WHERE id = (r->>'reservation_id')::uuid AND tour_id = v_tour_id) THEN
    RAISE EXCEPTION 'AP1: FAILED — reservation was not created against the newly-provisioned tour';
  END IF;

  RAISE NOTICE 'AP1: PASSED';
END $$;
ROLLBACK;


-- ══════════════════════════════════════════════════════════════════════════
-- TEST AP2 — SAME product + Italian: a SEPARATE Italian draft tour, never
-- the Spanish one from AP1 (each test block rolls back, so AP1's tour
-- does not actually exist when this runs standalone — this test creates
-- its own Spanish mapping first, in the SAME transaction, specifically to
-- prove Italian resolves independently).
-- ══════════════════════════════════════════════════════════════════════════
BEGIN;
DO $$
DECLARE
  v_source_id UUID;
  r_es JSONB; r_it JSONB;
  v_tour_es UUID; v_tour_it UUID;
BEGIN
  SELECT id INTO v_source_id FROM public.sources WHERE slug ILIKE 'civitatis%' LIMIT 1;

  r_es := public.ingest_civitatis_booking(
    p_gmail_message_id => 'gmail-ap2-es', p_gmail_thread_id => 'thread-ap2-es', p_received_at => NOW(),
    p_raw_subject => 'New booking A91000002: AP2 Manual Test Tour', p_raw_body_snapshot => 'body',
    p_event_type => 'new_booking', p_source_id => v_source_id, p_external_booking_id => '91000002',
    p_tour_id => NULL, p_tour_language => 'İspanyolca', p_check_in => CURRENT_DATE + 30, p_check_in_time => '09:00',
    p_pax_adult => 1, p_pax_child => 0, p_total_amount => 1800, p_currency => 'TL', p_retail_amount => 2400, p_retail_currency => 'TL',
    p_customer_id => NULL, p_customer_full_name => 'AP2 ES Contact', p_customer_email => NULL, p_customer_phone => NULL,
    p_passengers => '[{"fullName":"AP2 ES PASSENGER","sortOrder":0}]'::jsonb,
    p_auto_provision_tour => TRUE, p_civitatis_internal_code => 'AP2 Manual Test Tour', p_civitatis_language_code => 'es'
  );
  IF r_es->>'result' <> 'created' THEN RAISE EXCEPTION 'AP2 (es leg): FAILED — %', r_es; END IF;
  v_tour_es := (r_es->>'tour_id')::uuid;

  r_it := public.ingest_civitatis_booking(
    p_gmail_message_id => 'gmail-ap2-it', p_gmail_thread_id => 'thread-ap2-it', p_received_at => NOW(),
    p_raw_subject => 'New booking A91000003: AP2 Manual Test Tour', p_raw_body_snapshot => 'body',
    p_event_type => 'new_booking', p_source_id => v_source_id, p_external_booking_id => '91000003',
    p_tour_id => NULL, p_tour_language => 'İtalyanca', p_check_in => CURRENT_DATE + 30, p_check_in_time => '09:00',
    p_pax_adult => 1, p_pax_child => 0, p_total_amount => 1800, p_currency => 'TL', p_retail_amount => 2400, p_retail_currency => 'TL',
    p_customer_id => NULL, p_customer_full_name => 'AP2 IT Contact', p_customer_email => NULL, p_customer_phone => NULL,
    p_passengers => '[{"fullName":"AP2 IT PASSENGER","sortOrder":0}]'::jsonb,
    p_auto_provision_tour => TRUE, p_civitatis_internal_code => 'AP2 Manual Test Tour', p_civitatis_language_code => 'it'
  );
  IF r_it->>'result' <> 'created' THEN RAISE EXCEPTION 'AP2 (it leg): FAILED — %', r_it; END IF;
  v_tour_it := (r_it->>'tour_id')::uuid;

  IF v_tour_it IS NULL OR v_tour_it = v_tour_es THEN
    RAISE EXCEPTION 'AP2: FAILED — Italian booking must resolve to a DIFFERENT tour than the Spanish one (es=%, it=%)', v_tour_es, v_tour_it;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.tour_channels WHERE tour_id = v_tour_it AND booking_language = 'İtalyanca' AND external_product_id = 'AP2 Manual Test Tour') THEN
    RAISE EXCEPTION 'AP2: FAILED — Italian tour_channels row missing/incorrect';
  END IF;

  RAISE NOTICE 'AP2: PASSED';
END $$;
ROLLBACK;


-- ══════════════════════════════════════════════════════════════════════════
-- TEST AP3 — SAME product + Portuguese: a THIRD, independent draft tour.
-- ══════════════════════════════════════════════════════════════════════════
BEGIN;
DO $$
DECLARE
  v_source_id UUID;
  r JSONB;
BEGIN
  SELECT id INTO v_source_id FROM public.sources WHERE slug ILIKE 'civitatis%' LIMIT 1;

  r := public.ingest_civitatis_booking(
    p_gmail_message_id => 'gmail-ap3-pt', p_gmail_thread_id => 'thread-ap3-pt', p_received_at => NOW(),
    p_raw_subject => 'New booking A91000004: AP3 Manual Test Tour', p_raw_body_snapshot => 'body',
    p_event_type => 'new_booking', p_source_id => v_source_id, p_external_booking_id => '91000004',
    p_tour_id => NULL, p_tour_language => 'Portekizce', p_check_in => CURRENT_DATE + 30, p_check_in_time => '09:00',
    p_pax_adult => 1, p_pax_child => 0, p_total_amount => 1800, p_currency => 'TL', p_retail_amount => 2400, p_retail_currency => 'TL',
    p_customer_id => NULL, p_customer_full_name => 'AP3 PT Contact', p_customer_email => NULL, p_customer_phone => NULL,
    p_passengers => '[{"fullName":"AP3 PT PASSENGER","sortOrder":0}]'::jsonb,
    p_auto_provision_tour => TRUE, p_civitatis_internal_code => 'AP3 Manual Test Tour', p_civitatis_language_code => 'pt'
  );
  IF r->>'result' <> 'created' THEN RAISE EXCEPTION 'AP3: FAILED — %', r; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.tour_channels
     WHERE tour_id = (r->>'tour_id')::uuid AND booking_language = 'Portekizce' AND external_product_id = 'AP3 Manual Test Tour'
  ) THEN
    RAISE EXCEPTION 'AP3: FAILED — Portuguese tour_channels row missing/incorrect';
  END IF;

  RAISE NOTICE 'AP3: PASSED';
END $$;
ROLLBACK;


-- ══════════════════════════════════════════════════════════════════════════
-- TEST AP4 — SAME product + SAME language, a SECOND booking: reuses the
-- SAME tour, never creates a duplicate.
-- ══════════════════════════════════════════════════════════════════════════
BEGIN;
DO $$
DECLARE
  v_source_id UUID;
  r1 JSONB; r2 JSONB;
  v_tour_count INT; v_channel_count INT;
BEGIN
  SELECT id INTO v_source_id FROM public.sources WHERE slug ILIKE 'civitatis%' LIMIT 1;

  r1 := public.ingest_civitatis_booking(
    p_gmail_message_id => 'gmail-ap4-a', p_gmail_thread_id => 'thread-ap4-a', p_received_at => NOW(),
    p_raw_subject => 'New booking A91000005: AP4 Manual Test Tour', p_raw_body_snapshot => 'body',
    p_event_type => 'new_booking', p_source_id => v_source_id, p_external_booking_id => '91000005',
    p_tour_id => NULL, p_tour_language => 'İtalyanca', p_check_in => CURRENT_DATE + 30, p_check_in_time => '09:00',
    p_pax_adult => 1, p_pax_child => 0, p_total_amount => 1800, p_currency => 'TL', p_retail_amount => 2400, p_retail_currency => 'TL',
    p_customer_id => NULL, p_customer_full_name => 'AP4 Contact A', p_customer_email => NULL, p_customer_phone => NULL,
    p_passengers => '[{"fullName":"AP4 PASSENGER A","sortOrder":0}]'::jsonb,
    p_auto_provision_tour => TRUE, p_civitatis_internal_code => 'AP4 Manual Test Tour', p_civitatis_language_code => 'it'
  );
  IF r1->>'result' <> 'created' THEN RAISE EXCEPTION 'AP4 (first booking): FAILED — %', r1; END IF;

  r2 := public.ingest_civitatis_booking(
    p_gmail_message_id => 'gmail-ap4-b', p_gmail_thread_id => 'thread-ap4-b', p_received_at => NOW(),
    p_raw_subject => 'New booking A91000006: AP4 Manual Test Tour', p_raw_body_snapshot => 'body',
    p_event_type => 'new_booking', p_source_id => v_source_id, p_external_booking_id => '91000006',
    p_tour_id => NULL, p_tour_language => 'İtalyanca', p_check_in => CURRENT_DATE + 31, p_check_in_time => '10:00',
    p_pax_adult => 2, p_pax_child => 0, p_total_amount => 3600, p_currency => 'TL', p_retail_amount => 4800, p_retail_currency => 'TL',
    p_customer_id => NULL, p_customer_full_name => 'AP4 Contact B', p_customer_email => NULL, p_customer_phone => NULL,
    p_passengers => '[{"fullName":"AP4 PASSENGER B1","sortOrder":0},{"fullName":"AP4 PASSENGER B2","sortOrder":1}]'::jsonb,
    p_auto_provision_tour => TRUE, p_civitatis_internal_code => 'AP4 Manual Test Tour', p_civitatis_language_code => 'it'
  );
  IF r2->>'result' <> 'created' THEN RAISE EXCEPTION 'AP4 (second booking): FAILED — %', r2; END IF;

  IF (r1->>'tour_id')::uuid <> (r2->>'tour_id')::uuid THEN
    RAISE EXCEPTION 'AP4: FAILED — second booking resolved to a DIFFERENT tour (first=%, second=%)', r1->>'tour_id', r2->>'tour_id';
  END IF;
  IF (r2->>'tour_auto_provisioned')::boolean IS NOT TRUE THEN
    RAISE EXCEPTION 'AP4: FAILED — second booking should still report tour_auto_provisioned=true (it went through the auto-provisioning path, even though it reused rather than created)';
  END IF;

  SELECT COUNT(*) INTO v_tour_count FROM public.tours WHERE id = (r1->>'tour_id')::uuid;
  IF v_tour_count <> 1 THEN RAISE EXCEPTION 'AP4: FAILED — expected exactly 1 tour row total, found %', v_tour_count; END IF;

  SELECT COUNT(*) INTO v_channel_count FROM public.tour_channels
   WHERE source_id = v_source_id AND external_product_id = 'AP4 Manual Test Tour' AND booking_language = 'İtalyanca';
  IF v_channel_count <> 1 THEN RAISE EXCEPTION 'AP4: FAILED — expected exactly 1 tour_channels row total (no duplicate mapping), found %', v_channel_count; END IF;

  IF NOT EXISTS (SELECT 1 FROM public.reservations WHERE id = (r1->>'reservation_id')::uuid)
     OR NOT EXISTS (SELECT 1 FROM public.reservations WHERE id = (r2->>'reservation_id')::uuid)
     OR (r1->>'reservation_id') = (r2->>'reservation_id') THEN
    RAISE EXCEPTION 'AP4: FAILED — expected two DISTINCT reservations, one per booking, both against the shared tour';
  END IF;

  RAISE NOTICE 'AP4: PASSED';
END $$;
ROLLBACK;


-- ══════════════════════════════════════════════════════════════════════════
-- TEST AP5 — passenger mismatch on a brand-new (never-mapped) product:
-- needs_review, and — the actual point of this test — NO tour created.
-- ══════════════════════════════════════════════════════════════════════════
BEGIN;
DO $$
DECLARE
  v_source_id UUID;
  r JSONB;
  v_tour_count INT;
BEGIN
  SELECT id INTO v_source_id FROM public.sources WHERE slug ILIKE 'civitatis%' LIMIT 1;

  r := public.ingest_civitatis_booking(
    p_gmail_message_id => 'gmail-ap5-001', p_gmail_thread_id => 'thread-ap5', p_received_at => NOW(),
    p_raw_subject => 'New booking A91000007: AP5 Manual Test Tour', p_raw_body_snapshot => 'body',
    p_event_type => 'new_booking', p_source_id => v_source_id, p_external_booking_id => '91000007',
    p_tour_id => NULL, p_tour_language => 'İtalyanca', p_check_in => CURRENT_DATE + 30, p_check_in_time => '09:00',
    -- pax_adult=2, but only ONE passenger supplied -> mismatch.
    p_pax_adult => 2, p_pax_child => 0, p_total_amount => 3600, p_currency => 'TL', p_retail_amount => 4800, p_retail_currency => 'TL',
    p_customer_id => NULL, p_customer_full_name => 'AP5 Contact', p_customer_email => NULL, p_customer_phone => NULL,
    p_passengers => '[{"fullName":"AP5 ONLY PASSENGER","sortOrder":0}]'::jsonb,
    p_auto_provision_tour => TRUE, p_civitatis_internal_code => 'AP5 Manual Test Tour', p_civitatis_language_code => 'it'
  );

  IF r->>'result' <> 'manual_review_required' THEN
    RAISE EXCEPTION 'AP5: FAILED — expected manual_review_required, got % (%)', r->>'result', r;
  END IF;
  IF r->>'reason' <> 'passenger count mismatch' THEN
    RAISE EXCEPTION 'AP5: FAILED — expected reason=passenger count mismatch, got %', r->>'reason';
  END IF;

  SELECT COUNT(*) INTO v_tour_count FROM public.tours WHERE name = 'AP5 Manual Test Tour';
  IF v_tour_count <> 0 THEN
    RAISE EXCEPTION 'AP5: FAILED — THE CORE ASSERTION: expected ZERO tours created (Step 6a must run before the passenger-completeness check in program order... wait, precheck ordering means passenger-completeness runs FIRST — this assertion proves it actually stopped BEFORE Step 6a ever ran), found %', v_tour_count;
  END IF;
  IF EXISTS (SELECT 1 FROM public.tour_channels WHERE external_product_id = 'AP5 Manual Test Tour') THEN
    RAISE EXCEPTION 'AP5: FAILED — expected zero tour_channels rows for this product';
  END IF;

  RAISE NOTICE 'AP5: PASSED';
END $$;
ROLLBACK;


-- ══════════════════════════════════════════════════════════════════════════
-- TEST AP6 — missing booking-contact identity on a brand-new product:
-- needs_review, and NO tour created (proves the hoisted customer-identity
-- precheck runs BEFORE Step 6a, per the corrected placement).
-- ══════════════════════════════════════════════════════════════════════════
BEGIN;
DO $$
DECLARE
  v_source_id UUID;
  r JSONB;
  v_tour_count INT;
BEGIN
  SELECT id INTO v_source_id FROM public.sources WHERE slug ILIKE 'civitatis%' LIMIT 1;

  r := public.ingest_civitatis_booking(
    p_gmail_message_id => 'gmail-ap6-001', p_gmail_thread_id => 'thread-ap6', p_received_at => NOW(),
    p_raw_subject => 'New booking A91000008: AP6 Manual Test Tour', p_raw_body_snapshot => 'body',
    p_event_type => 'new_booking', p_source_id => v_source_id, p_external_booking_id => '91000008',
    p_tour_id => NULL, p_tour_language => 'İtalyanca', p_check_in => CURRENT_DATE + 30, p_check_in_time => '09:00',
    p_pax_adult => 1, p_pax_child => 0, p_total_amount => 1800, p_currency => 'TL', p_retail_amount => 2400, p_retail_currency => 'TL',
    -- Neither a resolved customer_id NOR a full name:
    p_customer_id => NULL, p_customer_full_name => NULL, p_customer_email => NULL, p_customer_phone => NULL,
    p_passengers => '[{"fullName":"AP6 PASSENGER","sortOrder":0}]'::jsonb,
    p_auto_provision_tour => TRUE, p_civitatis_internal_code => 'AP6 Manual Test Tour', p_civitatis_language_code => 'it'
  );

  IF r->>'result' <> 'manual_review_required' THEN
    RAISE EXCEPTION 'AP6: FAILED — expected manual_review_required, got % (%)', r->>'result', r;
  END IF;
  IF r->>'reason' <> 'missing booking-contact identity' THEN
    RAISE EXCEPTION 'AP6: FAILED — expected reason=missing booking-contact identity, got %', r->>'reason';
  END IF;

  SELECT COUNT(*) INTO v_tour_count FROM public.tours WHERE name = 'AP6 Manual Test Tour';
  IF v_tour_count <> 0 THEN
    RAISE EXCEPTION 'AP6: FAILED — THE CORE ASSERTION (this is exactly the ordering the Section 8 review corrected): expected ZERO tours created, found %. If this fails, the customer-identity precheck is NOT running before Step 6a.', v_tour_count;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.customers WHERE full_name IS NULL) THEN
    -- Not a meaningful assertion on its own (customers.full_name is
    -- NOT NULL by schema) — included only to document intent: no
    -- customer row of ANY kind should exist for this call either.
    NULL;
  END IF;
  IF EXISTS (SELECT 1 FROM public.customers WHERE email IS NULL AND phone IS NULL AND import_type = 'civitatis' AND created_at > NOW() - INTERVAL '1 minute' AND full_name = '') THEN
    RAISE EXCEPTION 'AP6: FAILED — an orphaned blank customer row was created';
  END IF;

  RAISE NOTICE 'AP6: PASSED';
END $$;
ROLLBACK;


-- ══════════════════════════════════════════════════════════════════════════
-- TEST AP7 — a 'modified' event with NO existing reservation, for a
-- brand-new (never-mapped) product, WITH auto_provision_tour=TRUE:
-- needs_review, and — the actual point — NO tour created. Proves Step 6a
-- is structurally unreachable from the modification-no-reservation
-- branch, exactly as the migration header's "MODIFIED EVENTS" section
-- claims.
-- ══════════════════════════════════════════════════════════════════════════
BEGIN;
DO $$
DECLARE
  v_source_id UUID;
  r JSONB;
  v_tour_count INT;
BEGIN
  SELECT id INTO v_source_id FROM public.sources WHERE slug ILIKE 'civitatis%' LIMIT 1;

  r := public.ingest_civitatis_booking(
    p_gmail_message_id => 'gmail-ap7-001', p_gmail_thread_id => 'thread-ap7', p_received_at => NOW(),
    p_raw_subject => 'Booking A91000009 modified: AP7 Manual Test Tour', p_raw_body_snapshot => 'body',
    p_event_type => 'modified', p_source_id => v_source_id, p_external_booking_id => '91000009',
    p_tour_id => NULL, p_tour_language => 'İtalyanca', p_check_in => CURRENT_DATE + 30, p_check_in_time => '09:00',
    p_pax_adult => 1, p_pax_child => 0, p_total_amount => 1800, p_currency => 'TL', p_retail_amount => 2400, p_retail_currency => 'TL',
    p_customer_id => NULL, p_customer_full_name => 'AP7 Contact', p_customer_email => NULL, p_customer_phone => NULL,
    p_passengers => '[{"fullName":"AP7 PASSENGER","sortOrder":0}]'::jsonb,
    -- Deliberately TRUE — proves auto_provision_tour has NO effect here,
    -- because this branch never reaches Step 6a's code at all.
    p_auto_provision_tour => TRUE, p_civitatis_internal_code => 'AP7 Manual Test Tour', p_civitatis_language_code => 'it'
  );

  IF r->>'result' <> 'manual_review_required' THEN
    RAISE EXCEPTION 'AP7: FAILED — expected manual_review_required, got % (%)', r->>'result', r;
  END IF;
  IF r->>'reason' <> 'modification event with no existing reservation' THEN
    RAISE EXCEPTION 'AP7: FAILED — expected reason=modification event with no existing reservation, got %', r->>'reason';
  END IF;

  SELECT COUNT(*) INTO v_tour_count FROM public.tours WHERE name = 'AP7 Manual Test Tour';
  IF v_tour_count <> 0 THEN
    RAISE EXCEPTION 'AP7: FAILED — THE CORE ASSERTION: a modification email must NEVER auto-provision a tour, even with auto_provision_tour=TRUE. Found % tour(s).', v_tour_count;
  END IF;
  IF EXISTS (SELECT 1 FROM public.tour_channels WHERE external_product_id = 'AP7 Manual Test Tour') THEN
    RAISE EXCEPTION 'AP7: FAILED — expected zero tour_channels rows';
  END IF;

  RAISE NOTICE 'AP7: PASSED';
END $$;
ROLLBACK;


-- ══════════════════════════════════════════════════════════════════════════
-- TEST AP8 — ambiguous mapping discovered AT THE LOCK (two pre-existing
-- tour_channels rows for the exact same source+product+language):
-- fail closed, NO new tour created, and existing rows untouched.
-- Exercises Step 6a's own deterministic count>1 branch specifically —
-- independent of whatever the JS caller's own matching.js decided.
-- ══════════════════════════════════════════════════════════════════════════
BEGIN;
DO $$
DECLARE
  v_source_id UUID;
  v_tour_a UUID; v_tour_b UUID;
  r JSONB;
  v_tour_count_before INT;
  v_channel_count_after INT;
BEGIN
  SELECT id INTO v_source_id FROM public.sources WHERE slug ILIKE 'civitatis%' LIMIT 1;

  -- Deliberately misconfigure: two different tours both mapped to the
  -- exact same (source, external_product_id, booking_language) — the
  -- exact scenario the partial UNIQUE index normally prevents; this test
  -- exists specifically to prove Step 6a's OWN deterministic count check
  -- also fails closed if that index were ever somehow bypassed, per the
  -- explicit "application/RPC correctness should not depend solely on
  -- the index" requirement. If uq_tour_channels_source_product_language
  -- is present and enforced, the second INSERT below will itself fail —
  -- which is CORRECT and expected on a database where the dependency
  -- migration is properly applied; this test's real assertions are only
  -- reached if this fixture setup succeeds, and are equally meaningful
  -- either way (either the index caught it, or this test proves Step 6a
  -- would have too).
  INSERT INTO public.tours (name, is_active) VALUES ('AP8 Manual Test Tour (A)', TRUE) RETURNING id INTO v_tour_a;
  INSERT INTO public.tour_channels (tour_id, source_id, external_product_id, booking_language, is_active)
    VALUES (v_tour_a, v_source_id, 'AP8 Manual Test Tour', 'İtalyanca', TRUE);

  BEGIN
    INSERT INTO public.tours (name, is_active) VALUES ('AP8 Manual Test Tour (B)', TRUE) RETURNING id INTO v_tour_b;
    INSERT INTO public.tour_channels (tour_id, source_id, external_product_id, booking_language, is_active)
      VALUES (v_tour_b, v_source_id, 'AP8 Manual Test Tour', 'İtalyanca', TRUE);
  EXCEPTION WHEN unique_violation THEN
    RAISE NOTICE 'AP8: fixture setup itself was blocked by uq_tour_channels_source_product_language — the index is present and enforced. Skipping the RPC-level assertions below (they would require the fixture, which the index correctly refused); this is a PASS for the index''s own guarantee, tested separately by tests/civitatis/sql/on_conflict_contract_manual_tests.sql.';
    RETURN;
  END;

  SELECT COUNT(*) INTO v_tour_count_before FROM public.tours WHERE name LIKE 'AP8 Manual Test Tour%';

  r := public.ingest_civitatis_booking(
    p_gmail_message_id => 'gmail-ap8-001', p_gmail_thread_id => 'thread-ap8', p_received_at => NOW(),
    p_raw_subject => 'New booking A91000010: AP8 Manual Test Tour', p_raw_body_snapshot => 'body',
    p_event_type => 'new_booking', p_source_id => v_source_id, p_external_booking_id => '91000010',
    p_tour_id => NULL, p_tour_language => 'İtalyanca', p_check_in => CURRENT_DATE + 30, p_check_in_time => '09:00',
    p_pax_adult => 1, p_pax_child => 0, p_total_amount => 1800, p_currency => 'TL', p_retail_amount => 2400, p_retail_currency => 'TL',
    p_customer_id => NULL, p_customer_full_name => 'AP8 Contact', p_customer_email => NULL, p_customer_phone => NULL,
    p_passengers => '[{"fullName":"AP8 PASSENGER","sortOrder":0}]'::jsonb,
    p_auto_provision_tour => TRUE, p_civitatis_internal_code => 'AP8 Manual Test Tour', p_civitatis_language_code => 'it'
  );

  IF r->>'result' <> 'manual_review_required' THEN
    RAISE EXCEPTION 'AP8: FAILED — expected manual_review_required (ambiguous, fail closed), got % (%)', r->>'result', r;
  END IF;

  SELECT COUNT(*) INTO v_channel_count_after FROM public.tours WHERE name LIKE 'AP8 Manual Test Tour%';
  IF v_channel_count_after <> v_tour_count_before THEN
    RAISE EXCEPTION 'AP8: FAILED — expected NO new tour created (still %), found %', v_tour_count_before, v_channel_count_after;
  END IF;

  RAISE NOTICE 'AP8: PASSED';
END $$;
ROLLBACK;


-- ══════════════════════════════════════════════════════════════════════════
-- TEST AP9 — simulated failure AFTER provisioning (an invalid
-- p_customer_id, which Step 6a now runs BEFORE): the tour, tour_language,
-- tour_channel, AND its activity_log row must all roll back with the
-- reservation transaction. THE test that directly proves the Section 8
-- fix works.
-- ══════════════════════════════════════════════════════════════════════════
BEGIN;
DO $$
DECLARE
  v_source_id UUID;
  v_fake_customer_id UUID := gen_random_uuid();  -- guaranteed not to exist
  r JSONB;
  v_tour_count INT;
  v_channel_count INT;
  v_activity_count INT;
BEGIN
  SELECT id INTO v_source_id FROM public.sources WHERE slug ILIKE 'civitatis%' LIMIT 1;

  r := public.ingest_civitatis_booking(
    p_gmail_message_id => 'gmail-ap9-001', p_gmail_thread_id => 'thread-ap9', p_received_at => NOW(),
    p_raw_subject => 'New booking A91000011: AP9 Manual Test Tour', p_raw_body_snapshot => 'body',
    p_event_type => 'new_booking', p_source_id => v_source_id, p_external_booking_id => '91000011',
    p_tour_id => NULL, p_tour_language => 'İtalyanca', p_check_in => CURRENT_DATE + 30, p_check_in_time => '09:00',
    p_pax_adult => 1, p_pax_child => 0, p_total_amount => 1800, p_currency => 'TL', p_retail_amount => 2400, p_retail_currency => 'TL',
    -- A syntactically valid but nonexistent customer_id -> customer
    -- resolution's own RAISE EXCEPTION fires AFTER Step 6a has already
    -- run (Step 6a now runs before this check — see the corrected
    -- ordering) — this is exactly the failure mode the Section 8 review
    -- exists to prove is now safe.
    p_customer_id => v_fake_customer_id, p_customer_full_name => NULL, p_customer_email => NULL, p_customer_phone => NULL,
    p_passengers => '[{"fullName":"AP9 PASSENGER","sortOrder":0}]'::jsonb,
    p_auto_provision_tour => TRUE, p_civitatis_internal_code => 'AP9 Manual Test Tour', p_civitatis_language_code => 'it'
  );

  IF r->>'result' <> 'failed' THEN
    RAISE EXCEPTION 'AP9: FAILED — expected result=failed (the invalid customer_id must raise, not manual_review_required), got % (%)', r->>'result', r;
  END IF;
  IF r->>'stage' <> 'customer_resolution' THEN
    RAISE EXCEPTION 'AP9: FAILED — expected the failure to be recorded at stage=customer_resolution (proving it happened AFTER Step 6a''s own stages), got stage=%', r->>'stage';
  END IF;

  SELECT COUNT(*) INTO v_tour_count FROM public.tours WHERE name = 'AP9 Manual Test Tour';
  IF v_tour_count <> 0 THEN
    RAISE EXCEPTION 'AP9: FAILED — THE CORE ASSERTION: a tour was auto-provisioned by this same call (Step 6a ran successfully before the customer_id exception fired) but was NOT rolled back. Found % orphaned tour(s). THIS IS THE EXACT DEFECT THE SECTION 8 REVIEW WAS ABOUT.', v_tour_count;
  END IF;
  SELECT COUNT(*) INTO v_channel_count FROM public.tour_channels WHERE external_product_id = 'AP9 Manual Test Tour';
  IF v_channel_count <> 0 THEN
    RAISE EXCEPTION 'AP9: FAILED — expected zero tour_channels rows (orphaned mapping), found %', v_channel_count;
  END IF;
  SELECT COUNT(*) INTO v_activity_count FROM public.activity_logs
   WHERE entity_type = 'tour' AND description LIKE '%AP9 Manual Test Tour%';
  IF v_activity_count <> 0 THEN
    RAISE EXCEPTION 'AP9: FAILED — expected zero orphaned "tour created" activity_logs rows, found %', v_activity_count;
  END IF;

  -- Also confirm the email_ingestions row itself correctly survived as
  -- 'failed' (not lost, not stuck as 'received') — the ONE thing that
  -- SHOULD persist across this rollback.
  IF NOT EXISTS (SELECT 1 FROM public.email_ingestions WHERE gmail_message_id = 'gmail-ap9-001' AND processing_status = 'failed') THEN
    RAISE EXCEPTION 'AP9: FAILED — expected the email_ingestions row itself to survive as processing_status=failed';
  END IF;

  RAISE NOTICE 'AP9: PASSED — the exact orphaned-tour scenario the Section 8 review found is confirmed FIXED.';
END $$;
ROLLBACK;


-- ══════════════════════════════════════════════════════════════════════════
-- TEST AP10 — activity log: exactly one "tour auto-provisioned" activity
-- for the genuine first provisioning; NONE for a subsequent reuse.
-- (Complements AP1/AP4 — isolated here as its own explicit assertion.)
-- ══════════════════════════════════════════════════════════════════════════
BEGIN;
DO $$
DECLARE
  v_source_id UUID;
  r1 JSONB; r2 JSONB;
  v_tour_activity_count INT;
  v_reservation_activity_count INT;
BEGIN
  SELECT id INTO v_source_id FROM public.sources WHERE slug ILIKE 'civitatis%' LIMIT 1;

  r1 := public.ingest_civitatis_booking(
    p_gmail_message_id => 'gmail-ap10-a', p_gmail_thread_id => 'thread-ap10-a', p_received_at => NOW(),
    p_raw_subject => 'New booking A91000012: AP10 Manual Test Tour', p_raw_body_snapshot => 'body',
    p_event_type => 'new_booking', p_source_id => v_source_id, p_external_booking_id => '91000012',
    p_tour_id => NULL, p_tour_language => 'İtalyanca', p_check_in => CURRENT_DATE + 30, p_check_in_time => '09:00',
    p_pax_adult => 1, p_pax_child => 0, p_total_amount => 1800, p_currency => 'TL', p_retail_amount => 2400, p_retail_currency => 'TL',
    p_customer_id => NULL, p_customer_full_name => 'AP10 Contact A', p_customer_email => NULL, p_customer_phone => NULL,
    p_passengers => '[{"fullName":"AP10 PASSENGER A","sortOrder":0}]'::jsonb,
    p_auto_provision_tour => TRUE, p_civitatis_internal_code => 'AP10 Manual Test Tour', p_civitatis_language_code => 'it'
  );
  IF r1->>'result' <> 'created' THEN RAISE EXCEPTION 'AP10 (first): FAILED — %', r1; END IF;

  r2 := public.ingest_civitatis_booking(
    p_gmail_message_id => 'gmail-ap10-b', p_gmail_thread_id => 'thread-ap10-b', p_received_at => NOW(),
    p_raw_subject => 'New booking A91000013: AP10 Manual Test Tour', p_raw_body_snapshot => 'body',
    p_event_type => 'new_booking', p_source_id => v_source_id, p_external_booking_id => '91000013',
    p_tour_id => NULL, p_tour_language => 'İtalyanca', p_check_in => CURRENT_DATE + 31, p_check_in_time => '10:00',
    p_pax_adult => 1, p_pax_child => 0, p_total_amount => 1800, p_currency => 'TL', p_retail_amount => 2400, p_retail_currency => 'TL',
    p_customer_id => NULL, p_customer_full_name => 'AP10 Contact B', p_customer_email => NULL, p_customer_phone => NULL,
    p_passengers => '[{"fullName":"AP10 PASSENGER B","sortOrder":0}]'::jsonb,
    p_auto_provision_tour => TRUE, p_civitatis_internal_code => 'AP10 Manual Test Tour', p_civitatis_language_code => 'it'
  );
  IF r2->>'result' <> 'created' THEN RAISE EXCEPTION 'AP10 (second): FAILED — %', r2; END IF;

  SELECT COUNT(*) INTO v_tour_activity_count FROM public.activity_logs
   WHERE entity_type = 'tour' AND entity_id = (r1->>'tour_id')::uuid AND action = 'created';
  IF v_tour_activity_count <> 1 THEN
    RAISE EXCEPTION 'AP10: FAILED — expected exactly 1 "tour created" activity_logs row across BOTH bookings, found %', v_tour_activity_count;
  END IF;

  SELECT COUNT(*) INTO v_reservation_activity_count FROM public.activity_logs
   WHERE entity_type = 'reservation' AND entity_id IN ((r1->>'reservation_id')::uuid, (r2->>'reservation_id')::uuid);
  IF v_reservation_activity_count <> 2 THEN
    RAISE EXCEPTION 'AP10: FAILED — expected exactly 2 "reservation created" activity_logs rows (one per booking), found %', v_reservation_activity_count;
  END IF;

  RAISE NOTICE 'AP10: PASSED';
END $$;
ROLLBACK;


-- ══════════════════════════════════════════════════════════════════════════
-- TEST AP11 — retry of a needs_review row (ambiguous-tour-matching case,
-- auto_provision_tour=FALSE) can later succeed safely once the caller
-- resolves p_tour_id itself (simulating: an operator fixed the mapping,
-- JS's matchTourChannel now resolves it, a later call carries a real
-- p_tour_id) — proves the V10 Step 1 reclaim (needs_review -> retryable)
-- and does not create a duplicate reservation or a duplicate
-- email_ingestions row for the SAME gmail_message_id.
-- ══════════════════════════════════════════════════════════════════════════
BEGIN;
DO $$
DECLARE
  v_source_id UUID;
  v_real_tour_id UUID;
  r1 JSONB; r2 JSONB;
  v_ingestion_count INT;
  v_reservation_count INT;
BEGIN
  SELECT id INTO v_source_id FROM public.sources WHERE slug ILIKE 'civitatis%' LIMIT 1;

  -- First attempt: genuinely unresolved (auto_provision_tour=FALSE, as a
  -- caller would send for e.g. an ambiguous or unrecognized-language
  -- case) -> needs_review, persisted.
  r1 := public.ingest_civitatis_booking(
    p_gmail_message_id => 'gmail-ap11-001', p_gmail_thread_id => 'thread-ap11', p_received_at => NOW(),
    p_raw_subject => 'New booking A91000014: AP11 Manual Test Tour', p_raw_body_snapshot => 'body',
    p_event_type => 'new_booking', p_source_id => v_source_id, p_external_booking_id => '91000014',
    p_tour_id => NULL, p_tour_language => 'İtalyanca', p_check_in => CURRENT_DATE + 30, p_check_in_time => '09:00',
    p_pax_adult => 1, p_pax_child => 0, p_total_amount => 1800, p_currency => 'TL', p_retail_amount => 2400, p_retail_currency => 'TL',
    p_customer_id => NULL, p_customer_full_name => 'AP11 Contact', p_customer_email => NULL, p_customer_phone => NULL,
    p_passengers => '[{"fullName":"AP11 PASSENGER","sortOrder":0}]'::jsonb,
    p_auto_provision_tour => FALSE, p_civitatis_internal_code => 'AP11 Manual Test Tour', p_civitatis_language_code => 'it'
  );
  IF r1->>'result' <> 'manual_review_required' THEN
    RAISE EXCEPTION 'AP11 (first attempt): FAILED — expected manual_review_required, got % (%)', r1->>'result', r1;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.email_ingestions WHERE gmail_message_id = 'gmail-ap11-001' AND processing_status = 'needs_review') THEN
    RAISE EXCEPTION 'AP11: FAILED — expected a persisted needs_review email_ingestions row after the first attempt';
  END IF;

  -- Simulate an operator having since mapped the product (creating a
  -- real tour by hand, exactly like the pre-V10 manual-mapping
  -- workflow), and a later call now carrying a resolved p_tour_id.
  INSERT INTO public.tours (name, is_active) VALUES ('AP11 Manually Mapped Tour', TRUE) RETURNING id INTO v_real_tour_id;

  -- Retry: SAME gmail_message_id, now with p_tour_id resolved.
  r2 := public.ingest_civitatis_booking(
    p_gmail_message_id => 'gmail-ap11-001', p_gmail_thread_id => 'thread-ap11', p_received_at => NOW(),
    p_raw_subject => 'New booking A91000014: AP11 Manual Test Tour', p_raw_body_snapshot => 'body',
    p_event_type => 'new_booking', p_source_id => v_source_id, p_external_booking_id => '91000014',
    p_tour_id => v_real_tour_id, p_tour_language => 'İtalyanca', p_check_in => CURRENT_DATE + 30, p_check_in_time => '09:00',
    p_pax_adult => 1, p_pax_child => 0, p_total_amount => 1800, p_currency => 'TL', p_retail_amount => 2400, p_retail_currency => 'TL',
    p_customer_id => NULL, p_customer_full_name => 'AP11 Contact', p_customer_email => NULL, p_customer_phone => NULL,
    p_passengers => '[{"fullName":"AP11 PASSENGER","sortOrder":0}]'::jsonb,
    p_auto_provision_tour => FALSE, p_civitatis_internal_code => 'AP11 Manual Test Tour', p_civitatis_language_code => 'it'
  );
  IF r2->>'result' <> 'created' THEN
    RAISE EXCEPTION 'AP11 (retry): FAILED — THE CORE ASSERTION (V10 changelog point 15 — needs_review is now retryable): expected result=created once p_tour_id was resolved, got % (%)', r2->>'result', r2;
  END IF;

  SELECT COUNT(*) INTO v_ingestion_count FROM public.email_ingestions WHERE gmail_message_id = 'gmail-ap11-001';
  IF v_ingestion_count <> 1 THEN
    RAISE EXCEPTION 'AP11: FAILED — expected exactly 1 email_ingestions row total (the SAME row reclaimed, never a second one), found %', v_ingestion_count;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.email_ingestions WHERE gmail_message_id = 'gmail-ap11-001' AND processing_status = 'processed' AND reservation_id = (r2->>'reservation_id')::uuid) THEN
    RAISE EXCEPTION 'AP11: FAILED — expected the SAME row to now be processing_status=processed, pointing at the new reservation';
  END IF;

  SELECT COUNT(*) INTO v_reservation_count FROM public.reservations WHERE source_id = v_source_id AND external_booking_id = '91000014';
  IF v_reservation_count <> 1 THEN
    RAISE EXCEPTION 'AP11: FAILED — expected exactly 1 reservation for this booking (never duplicated), found %', v_reservation_count;
  END IF;

  RAISE NOTICE 'AP11: PASSED';
END $$;
ROLLBACK;

-- ── END OF MANUAL TEST PLAN ─────────────────────────────────────────────────
