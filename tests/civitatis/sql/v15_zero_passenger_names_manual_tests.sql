-- ============================================================
-- MANUAL / STAGING DATABASE TEST PLAN
-- public.ingest_civitatis_booking(...) — V15 zero-passenger-names allowed
-- ============================================================
-- NOT EXECUTED as part of preparing this file. Requires a real
-- PostgreSQL/Supabase database with every dependency
-- supabase_migration_civitatis_write_v12_uuid_recheck_fix.sql itself
-- requires, AND V12 itself already applied, AND
-- supabase_migration_civitatis_write_v15_zero_passenger_names.sql
-- ALREADY APPLIED (these tests exercise V15's live behavior — they are
-- not meaningful against a database still running V12/V11/earlier).
-- Run this file (e.g. via `psql` or the Supabase SQL editor) against a
-- STAGING database only, never production.
--
-- WHY THIS EXISTS AS SQL, NOT A JS TEST — same reasoning as
-- tests/civitatis/sql/ingest_civitatis_booking_manual_tests.sql and
-- tests/civitatis/sql/tour_auto_provisioning_manual_tests.sql: the core
-- claims under test here (a real reservation actually gets created with
-- zero real reservation_guests rows, a real tour/tour_language/
-- tour_channel actually gets auto-provisioned in the SAME call, a real
-- retry of the SAME gmail_message_id is a genuine no-op, a real
-- modification leaves real existing reservation_guests rows untouched)
-- can only be genuinely proven by PostgreSQL itself executing them. See
-- tests/civitatis/v15ZeroPassengerNames.test.js for everything that CAN
-- be proven without a database (the exact SQL text of the guard change,
-- the new activity_logs insert, byte-for-byte isolation from every other
-- part of the function, the rollback).
--
-- EACH TEST BLOCK is wrapped in its own BEGIN ... ROLLBACK, so running
-- this whole file leaves no residue even against a database with real
-- data — but a dedicated staging database is still strongly
-- recommended.
--
-- HOW TO READ A FAILURE: every assertion uses
--   IF NOT (<condition>) THEN RAISE EXCEPTION '<test name>: FAILED — <detail>'; END IF;
-- A silent, error-free run of this whole file means every test passed.
-- ============================================================


-- ══════════════════════════════════════════════════════════════════════════
-- TEST 1 — A42463096-SHAPED FIXTURE: expected=2, usable=0 (Civitatis
-- supplied NO passenger names at all) -> CREATE is now ALLOWED. Reservation
-- created, customer created from the booking contact, pax_adult=2,
-- pax_child=0, reservation_guests has ZERO rows, the booking contact is
-- NOT copied into reservation_guests, and the missing-passenger-names
-- warning activity_logs row is created exactly once.
-- ══════════════════════════════════════════════════════════════════════════
BEGIN;
DO $$
DECLARE
  v_source_id UUID; v_tour_id UUID;
  r JSONB;
  v_guest_count INT;
  v_customer_id UUID;
  v_customer_name TEXT;
  v_warning_count INT;
  v_warning_desc TEXT;
  v_warning_metadata JSONB;
BEGIN
  SELECT id INTO v_source_id FROM public.sources WHERE slug ILIKE 'civitatis%' LIMIT 1;
  INSERT INTO public.tours (name, is_active) VALUES ('TEST-V15-01 Tour', TRUE) RETURNING id INTO v_tour_id;

  -- A42463096's real shape: People: 2 Adultos, Client details: Rafael
  -- Izquierdo Carrasco, NO passenger-name list anywhere in the body.
  r := public.ingest_civitatis_booking(
    'gmail-v15test01', 'thread-v15test01', NOW(), 'New booking A42463096: Test Tour', 'body', 'new_booking',
    v_source_id, '42463096', v_tour_id, 'İspanyolca', CURRENT_DATE + 30, '09:00', 2, 0,
    3600, 'EUR', 4800, 'EUR', NULL, 'Rafael Izquierdo Carrasco', NULL, NULL,
    '[]'::jsonb
  );

  IF r->>'result' <> 'created' THEN
    RAISE EXCEPTION 'TEST 1: FAILED — expected=2/usable=0 (A42463096-shaped) should now be ALLOWED (created), got %', r->>'result';
  END IF;
  IF (r->>'reservation_id') IS NULL THEN
    RAISE EXCEPTION 'TEST 1: FAILED — expected a real reservation_id on success';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.reservations
     WHERE id = (r->>'reservation_id')::uuid AND pax_adult = 2 AND pax_child = 0
  ) THEN
    RAISE EXCEPTION 'TEST 1: FAILED — pax_adult/pax_child must be persisted exactly as supplied (2/0)';
  END IF;

  SELECT customer_id INTO v_customer_id FROM public.reservations WHERE id = (r->>'reservation_id')::uuid;
  SELECT full_name INTO v_customer_name FROM public.customers WHERE id = v_customer_id;
  IF v_customer_name IS DISTINCT FROM 'Rafael Izquierdo Carrasco' THEN
    RAISE EXCEPTION 'TEST 1: FAILED — customer full_name should be the booking contact "Rafael Izquierdo Carrasco", got %', v_customer_name;
  END IF;

  SELECT COUNT(*) INTO v_guest_count FROM public.reservation_guests WHERE reservation_id = (r->>'reservation_id')::uuid;
  IF v_guest_count <> 0 THEN
    RAISE EXCEPTION 'TEST 1: FAILED — expected ZERO reservation_guests rows when Civitatis supplies no names, found %', v_guest_count;
  END IF;

  -- The booking contact must never be found AS a guest row either.
  IF EXISTS (
    SELECT 1 FROM public.reservation_guests
     WHERE reservation_id = (r->>'reservation_id')::uuid AND full_name = 'Rafael Izquierdo Carrasco'
  ) THEN
    RAISE EXCEPTION 'TEST 1: FAILED — the booking contact must never be automatically inserted into reservation_guests';
  END IF;

  -- Exactly one missing-passenger-names warning, correctly shaped.
  SELECT COUNT(*) INTO v_warning_count FROM public.activity_logs
   WHERE entity_type = 'reservation' AND entity_id = (r->>'reservation_id')::uuid
     AND action = 'note_added' AND metadata->>'alert_type' = 'civitatis_missing_passenger_names';
  IF v_warning_count <> 1 THEN
    RAISE EXCEPTION 'TEST 1: FAILED — expected exactly 1 missing-passenger-names warning row, found %', v_warning_count;
  END IF;

  SELECT description, metadata INTO v_warning_desc, v_warning_metadata FROM public.activity_logs
   WHERE entity_type = 'reservation' AND entity_id = (r->>'reservation_id')::uuid
     AND action = 'note_added' AND metadata->>'alert_type' = 'civitatis_missing_passenger_names';
  IF v_warning_desc <> 'Civitatis yolcu isimleri eksik' THEN
    RAISE EXCEPTION 'TEST 1: FAILED — unexpected warning description: %', v_warning_desc;
  END IF;
  IF v_warning_metadata->>'auto_ingested' <> 'true' THEN
    RAISE EXCEPTION 'TEST 1: FAILED — warning metadata.auto_ingested must be true (so it surfaces via getReservationNotifications)';
  END IF;
  IF v_warning_metadata->>'external_booking_id' <> '42463096' THEN
    RAISE EXCEPTION 'TEST 1: FAILED — warning metadata.external_booking_id should be 42463096, got %', v_warning_metadata->>'external_booking_id';
  END IF;
  -- No customer PII in the warning metadata.
  IF v_warning_metadata ? 'customer_email' OR v_warning_metadata ? 'customer_phone' OR v_warning_metadata ? 'customer_full_name' THEN
    RAISE EXCEPTION 'TEST 1: FAILED — the warning must never carry customer email/phone/full name';
  END IF;

  -- The ORIGINAL "Yeni Rezervasyon Geldi" row must still exist, separately.
  IF NOT EXISTS (
    SELECT 1 FROM public.activity_logs
     WHERE entity_type = 'reservation' AND entity_id = (r->>'reservation_id')::uuid AND action = 'created'
  ) THEN
    RAISE EXCEPTION 'TEST 1: FAILED — the original "Yeni Rezervasyon Geldi" activity_logs row must still be created';
  END IF;

  RAISE NOTICE 'TEST 1: PASSED';
END $$;
ROLLBACK;


-- ══════════════════════════════════════════════════════════════════════════
-- TEST 2 — expected=2, usable=2 (COMPLETE passenger list): existing
-- behavior is completely unchanged by V15. No missing-passenger-names
-- warning is ever created for a complete passenger list.
-- ══════════════════════════════════════════════════════════════════════════
BEGIN;
DO $$
DECLARE
  v_source_id UUID; v_tour_id UUID;
  r JSONB;
  v_guest_count INT;
  v_warning_count INT;
BEGIN
  SELECT id INTO v_source_id FROM public.sources WHERE slug ILIKE 'civitatis%' LIMIT 1;
  INSERT INTO public.tours (name, is_active) VALUES ('TEST-V15-02 Tour', TRUE) RETURNING id INTO v_tour_id;

  r := public.ingest_civitatis_booking(
    'gmail-v15test02', 'thread-v15test02', NOW(), 'New booking A90000040: Test Tour', 'body', 'new_booking',
    v_source_id, '90000040', v_tour_id, 'İtalyanca', CURRENT_DATE + 30, '09:00', 2, 0,
    3600, 'TL', 4800, 'TL', NULL, 'Test Contact Forty', NULL, NULL,
    '[{"fullName":"PASSENGER FORTY A","sortOrder":0},{"fullName":"PASSENGER FORTY B","sortOrder":1}]'::jsonb
  );
  IF r->>'result' <> 'created' THEN
    RAISE EXCEPTION 'TEST 2: FAILED — expected=2/usable=2 should succeed exactly as before V15, got %', r->>'result';
  END IF;

  SELECT COUNT(*) INTO v_guest_count FROM public.reservation_guests WHERE reservation_id = (r->>'reservation_id')::uuid;
  IF v_guest_count <> 2 THEN
    RAISE EXCEPTION 'TEST 2: FAILED — expected exactly 2 reservation_guests rows, found %', v_guest_count;
  END IF;

  SELECT COUNT(*) INTO v_warning_count FROM public.activity_logs
   WHERE entity_type = 'reservation' AND entity_id = (r->>'reservation_id')::uuid
     AND metadata->>'alert_type' = 'civitatis_missing_passenger_names';
  IF v_warning_count <> 0 THEN
    RAISE EXCEPTION 'TEST 2: FAILED — a COMPLETE passenger list must never produce a missing-passenger-names warning, found %', v_warning_count;
  END IF;

  RAISE NOTICE 'TEST 2: PASSED';
END $$;
ROLLBACK;


-- ══════════════════════════════════════════════════════════════════════════
-- TEST 3 — expected=2, usable=1 (PARTIAL): still manual_review_required,
-- zero business state. Proves V15 does not widen the accepted range to
-- "anything <= expected" — only exactly 0 or exactly expected.
-- ══════════════════════════════════════════════════════════════════════════
BEGIN;
DO $$
DECLARE
  v_source_id UUID; v_tour_id UUID;
  r JSONB;
BEGIN
  SELECT id INTO v_source_id FROM public.sources WHERE slug ILIKE 'civitatis%' LIMIT 1;
  INSERT INTO public.tours (name, is_active) VALUES ('TEST-V15-03 Tour', TRUE) RETURNING id INTO v_tour_id;

  r := public.ingest_civitatis_booking(
    'gmail-v15test03', 'thread-v15test03', NOW(), 'New booking A90000041: Test Tour', 'body', 'new_booking',
    v_source_id, '90000041', v_tour_id, 'İtalyanca', CURRENT_DATE + 30, '09:00', 2, 0,
    3600, 'TL', 4800, 'TL', NULL, 'Test Contact FortyOne', NULL, NULL,
    '[{"fullName":"PASSENGER FORTYONE A","sortOrder":0}]'::jsonb
  );
  IF r->>'result' <> 'manual_review_required' THEN
    RAISE EXCEPTION 'TEST 3: FAILED — expected=2/usable=1 (partial) must still be manual_review_required, got %', r->>'result';
  END IF;
  IF (r->>'usable_passenger_count')::int <> 1 THEN
    RAISE EXCEPTION 'TEST 3: FAILED — usable_passenger_count should be 1, got %', r->>'usable_passenger_count';
  END IF;
  IF EXISTS (SELECT 1 FROM public.reservations WHERE source_id = v_source_id AND external_booking_id = '90000041') THEN
    RAISE EXCEPTION 'TEST 3: FAILED — a reservation must never be created for a partial passenger list';
  END IF;
  IF EXISTS (SELECT 1 FROM public.customers WHERE full_name = 'Test Contact FortyOne') THEN
    RAISE EXCEPTION 'TEST 3: FAILED — a customer must never be created for a partial passenger list';
  END IF;

  RAISE NOTICE 'TEST 3: PASSED';
END $$;
ROLLBACK;


-- ══════════════════════════════════════════════════════════════════════════
-- TEST 4 — expected=2, usable=3 (MORE than expected): still
-- manual_review_required, zero business state, and the payload is NEVER
-- truncated to fit. Proves V15's zero-allowance never widens into "any
-- count is fine" — an over-count is exactly as rejected as before.
-- ══════════════════════════════════════════════════════════════════════════
BEGIN;
DO $$
DECLARE
  v_source_id UUID; v_tour_id UUID;
  r JSONB;
BEGIN
  SELECT id INTO v_source_id FROM public.sources WHERE slug ILIKE 'civitatis%' LIMIT 1;
  INSERT INTO public.tours (name, is_active) VALUES ('TEST-V15-04 Tour', TRUE) RETURNING id INTO v_tour_id;

  r := public.ingest_civitatis_booking(
    'gmail-v15test04', 'thread-v15test04', NOW(), 'New booking A90000042: Test Tour', 'body', 'new_booking',
    v_source_id, '90000042', v_tour_id, 'İtalyanca', CURRENT_DATE + 30, '09:00', 2, 0,
    3600, 'TL', 4800, 'TL', NULL, 'Test Contact FortyTwo', NULL, NULL,
    '[{"fullName":"PASSENGER FORTYTWO A","sortOrder":0},{"fullName":"PASSENGER FORTYTWO B","sortOrder":1},{"fullName":"PASSENGER FORTYTWO C","sortOrder":2}]'::jsonb
  );
  IF r->>'result' <> 'manual_review_required' THEN
    RAISE EXCEPTION 'TEST 4: FAILED — expected=2/usable=3 (over-count) must still be manual_review_required, got %', r->>'result';
  END IF;
  IF (r->>'usable_passenger_count')::int <> 3 THEN
    RAISE EXCEPTION 'TEST 4: FAILED — usable_passenger_count should be 3, got %', r->>'usable_passenger_count';
  END IF;
  IF EXISTS (SELECT 1 FROM public.reservations WHERE source_id = v_source_id AND external_booking_id = '90000042') THEN
    RAISE EXCEPTION 'TEST 4: FAILED — a reservation must never be created for an over-count passenger list';
  END IF;

  RAISE NOTICE 'TEST 4: PASSED';
END $$;
ROLLBACK;


-- ══════════════════════════════════════════════════════════════════════════
-- TEST 5 — END-TO-END A42463096 REPRODUCTION: zero passenger names AND a
-- genuinely new Civitatis product/language (no existing tour_channels row)
-- -> the passenger guard no longer blocks it, so it actually REACHES Step
-- 6a and auto-provisions a new draft tour + tour_language + tour_channel,
-- in the SAME call that creates the reservation with zero guests.
-- ══════════════════════════════════════════════════════════════════════════
BEGIN;
DO $$
DECLARE
  v_source_id UUID;
  r JSONB;
  v_tour_id UUID;
  v_guest_count INT;
BEGIN
  SELECT id INTO v_source_id FROM public.sources WHERE slug ILIKE 'civitatis%' LIMIT 1;

  -- Deliberately NO pre-existing tour_channels row for this internal
  -- code — proves this is genuinely the "brand new product" path, not a
  -- pre-matched one.
  IF EXISTS (
    SELECT 1 FROM public.tour_channels WHERE source_id = v_source_id AND external_product_id = 'TESTV15NEWPRODUCT'
  ) THEN
    RAISE EXCEPTION 'TEST 5: SETUP FAILED — external_product_id TESTV15NEWPRODUCT must not already be mapped';
  END IF;

  r := public.ingest_civitatis_booking(
    p_gmail_message_id => 'gmail-v15test05',
    p_gmail_thread_id => 'thread-v15test05',
    p_received_at => NOW(),
    p_raw_subject => 'New booking A42463096: Brand New Tour',
    p_raw_body_snapshot => 'body',
    p_event_type => 'new_booking',
    p_source_id => v_source_id,
    p_external_booking_id => '42463096',
    p_tour_id => NULL,
    p_tour_language => 'İspanyolca',
    p_check_in => CURRENT_DATE + 30,
    p_check_in_time => '09:00',
    p_pax_adult => 2,
    p_pax_child => 0,
    p_total_amount => 3600,
    p_currency => 'EUR',
    p_retail_amount => 4800,
    p_retail_currency => 'EUR',
    p_customer_id => NULL,
    p_customer_full_name => 'Rafael Izquierdo Carrasco',
    p_customer_email => NULL,
    p_customer_phone => NULL,
    p_passengers => '[]'::jsonb,
    p_auto_provision_tour => TRUE,
    p_civitatis_internal_code => 'TESTV15NEWPRODUCT',
    p_civitatis_language_code => 'es'
  );

  IF r->>'result' <> 'created' THEN
    RAISE EXCEPTION 'TEST 5: FAILED — expected the zero-passenger-names new-product booking to be created, got %', r->>'result';
  END IF;
  IF (r->>'tour_auto_provisioned')::boolean IS DISTINCT FROM TRUE THEN
    RAISE EXCEPTION 'TEST 5: FAILED — expected tour_auto_provisioned=true — the passenger guard must not have blocked Step 6a from running';
  END IF;

  v_tour_id := (r->>'tour_id')::uuid;
  IF v_tour_id IS NULL THEN
    RAISE EXCEPTION 'TEST 5: FAILED — expected a real, resolved tour_id';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.tours WHERE id = v_tour_id AND status = 'draft') THEN
    RAISE EXCEPTION 'TEST 5: FAILED — expected a new draft tour to have been auto-provisioned';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.tour_languages WHERE tour_id = v_tour_id AND language_code = 'es') THEN
    RAISE EXCEPTION 'TEST 5: FAILED — expected a tour_languages row for the new tour';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.tour_channels
     WHERE tour_id = v_tour_id AND source_id = v_source_id
       AND external_product_id = 'TESTV15NEWPRODUCT' AND booking_language = 'İspanyolca'
  ) THEN
    RAISE EXCEPTION 'TEST 5: FAILED — expected a tour_channels mapping for the new (source, product, language) identity';
  END IF;

  SELECT COUNT(*) INTO v_guest_count FROM public.reservation_guests WHERE reservation_id = (r->>'reservation_id')::uuid;
  IF v_guest_count <> 0 THEN
    RAISE EXCEPTION 'TEST 5: FAILED — expected ZERO reservation_guests rows, found %', v_guest_count;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.activity_logs
     WHERE entity_type = 'reservation' AND entity_id = (r->>'reservation_id')::uuid
       AND metadata->>'alert_type' = 'civitatis_missing_passenger_names'
  ) THEN
    RAISE EXCEPTION 'TEST 5: FAILED — expected the missing-passenger-names warning even on the auto-provisioning path';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.activity_logs WHERE entity_type = 'tour' AND entity_id = v_tour_id AND action = 'created'
  ) THEN
    RAISE EXCEPTION 'TEST 5: FAILED — expected the existing tour-provisioning activity_logs row, unaffected by V15';
  END IF;

  RAISE NOTICE 'TEST 5: PASSED';
END $$;
ROLLBACK;


-- ══════════════════════════════════════════════════════════════════════════
-- TEST 6 — RETRY of the SAME gmail_message_id: a second call with
-- identical input is a guaranteed no-op (already_processed) — no
-- duplicate reservation, no duplicate missing-passenger-names warning.
-- ══════════════════════════════════════════════════════════════════════════
BEGIN;
DO $$
DECLARE
  v_source_id UUID; v_tour_id UUID;
  r1 JSONB; r2 JSONB;
  v_reservation_count INT; v_warning_count INT;
BEGIN
  SELECT id INTO v_source_id FROM public.sources WHERE slug ILIKE 'civitatis%' LIMIT 1;
  INSERT INTO public.tours (name, is_active) VALUES ('TEST-V15-06 Tour', TRUE) RETURNING id INTO v_tour_id;

  r1 := public.ingest_civitatis_booking(
    'gmail-v15test06', 'thread-v15test06', NOW(), 'New booking A90000043: Test Tour', 'body', 'new_booking',
    v_source_id, '90000043', v_tour_id, 'İtalyanca', CURRENT_DATE + 30, '09:00', 2, 0,
    3600, 'TL', 4800, 'TL', NULL, 'Test Contact FortyThree', NULL, NULL, '[]'::jsonb
  );
  IF r1->>'result' <> 'created' THEN
    RAISE EXCEPTION 'TEST 6: FAILED — first attempt should succeed, got %', r1->>'result';
  END IF;

  -- Exact same gmail_message_id, exact same call, retried.
  r2 := public.ingest_civitatis_booking(
    'gmail-v15test06', 'thread-v15test06', NOW(), 'New booking A90000043: Test Tour', 'body', 'new_booking',
    v_source_id, '90000043', v_tour_id, 'İtalyanca', CURRENT_DATE + 30, '09:00', 2, 0,
    3600, 'TL', 4800, 'TL', NULL, 'Test Contact FortyThree', NULL, NULL, '[]'::jsonb
  );
  IF r2->>'result' <> 'already_processed' THEN
    RAISE EXCEPTION 'TEST 6: FAILED — retry of the same gmail_message_id must be already_processed, got %', r2->>'result';
  END IF;
  IF r2->>'reservation_id' IS DISTINCT FROM r1->>'reservation_id' THEN
    RAISE EXCEPTION 'TEST 6: FAILED — retry must report the SAME reservation_id, never a new one';
  END IF;

  SELECT COUNT(*) INTO v_reservation_count FROM public.reservations WHERE source_id = v_source_id AND external_booking_id = '90000043';
  IF v_reservation_count <> 1 THEN
    RAISE EXCEPTION 'TEST 6: FAILED — expected exactly 1 reservation after a retry, found %', v_reservation_count;
  END IF;

  SELECT COUNT(*) INTO v_warning_count FROM public.activity_logs
   WHERE entity_type = 'reservation' AND entity_id = (r1->>'reservation_id')::uuid
     AND metadata->>'alert_type' = 'civitatis_missing_passenger_names';
  IF v_warning_count <> 1 THEN
    RAISE EXCEPTION 'TEST 6: FAILED — expected exactly 1 missing-passenger-names warning after a retry, found %', v_warning_count;
  END IF;

  RAISE NOTICE 'TEST 6: PASSED';
END $$;
ROLLBACK;


-- ══════════════════════════════════════════════════════════════════════════
-- TEST 7 — PRODUCTION RETRY SCENARIO: a row already stuck at
-- processing_status='needs_review' (exactly the real A42463096 row's
-- current state, reservation_id NULL) is retried with the SAME
-- gmail_message_id after V15 is live — the existing Step 1 reclaim logic
-- picks it up as a fresh attempt and this time succeeds.
-- ══════════════════════════════════════════════════════════════════════════
BEGIN;
DO $$
DECLARE
  v_source_id UUID; v_tour_id UUID;
  r JSONB;
BEGIN
  SELECT id INTO v_source_id FROM public.sources WHERE slug ILIKE 'civitatis%' LIMIT 1;
  INSERT INTO public.tours (name, is_active) VALUES ('TEST-V15-07 Tour', TRUE) RETURNING id INTO v_tour_id;

  -- Simulates the exact real production row left behind by the OLD
  -- (pre-V15) guard: needs_review, reservation_id NULL.
  INSERT INTO public.email_ingestions (
    gmail_message_id, gmail_thread_id, external_booking_id, source_id,
    event_type, processing_status, error_reason, raw_subject, received_at
  ) VALUES (
    'gmail-v15test07-a42463096', 'thread-v15test07', '42463096', v_source_id,
    'new_booking', 'needs_review',
    'passenger count mismatch on create: expected 2 usable passenger(s) (pax_adult=2 + pax_child=0), found 0 usable entries in p_passengers',
    'New booking A42463096: Test Tour', NOW() - INTERVAL '2 days'
  );

  r := public.ingest_civitatis_booking(
    'gmail-v15test07-a42463096', 'thread-v15test07', NOW(), 'New booking A42463096: Test Tour', 'body', 'new_booking',
    v_source_id, '42463096', v_tour_id, 'İspanyolca', CURRENT_DATE + 30, '09:00', 2, 0,
    3600, 'EUR', 4800, 'EUR', NULL, 'Rafael Izquierdo Carrasco', NULL, NULL, '[]'::jsonb
  );

  IF r->>'result' <> 'created' THEN
    RAISE EXCEPTION 'TEST 7: FAILED — the reclaimed needs_review row must succeed under V15''s relaxed guard, got %', r->>'result';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.email_ingestions
     WHERE gmail_message_id = 'gmail-v15test07-a42463096'
       AND processing_status = 'processed' AND reservation_id = (r->>'reservation_id')::uuid
  ) THEN
    RAISE EXCEPTION 'TEST 7: FAILED — the SAME email_ingestions row (reclaimed, not duplicated) must now read processed';
  END IF;
  IF (SELECT COUNT(*) FROM public.email_ingestions WHERE gmail_message_id = 'gmail-v15test07-a42463096') <> 1 THEN
    RAISE EXCEPTION 'TEST 7: FAILED — expected exactly 1 email_ingestions row for this gmail_message_id, never a duplicate';
  END IF;

  RAISE NOTICE 'TEST 7: PASSED';
END $$;
ROLLBACK;


-- ══════════════════════════════════════════════════════════════════════════
-- TEST 8 — MODIFICATION with ZERO usable passenger names on an existing
-- reservation that already has real guest rows: the existing
-- reservation_guests rows are PRESERVED, never deleted/replaced with an
-- empty set. Confirms the invariant explicitly asked for, unaffected by
-- V15 (the modification guard is byte-for-byte unchanged).
-- ══════════════════════════════════════════════════════════════════════════
BEGIN;
DO $$
DECLARE
  v_source_id UUID; v_tour_id UUID;
  r1 JSONB; r2 JSONB;
  v_guest_count_before INT; v_guest_count_after INT;
BEGIN
  SELECT id INTO v_source_id FROM public.sources WHERE slug ILIKE 'civitatis%' LIMIT 1;
  INSERT INTO public.tours (name, is_active) VALUES ('TEST-V15-08 Tour', TRUE) RETURNING id INTO v_tour_id;

  r1 := public.ingest_civitatis_booking(
    'gmail-v15test08-new', 'thread-v15test08', NOW() - INTERVAL '1 hour', 'New booking A90000044: Test Tour', 'body', 'new_booking',
    v_source_id, '90000044', v_tour_id, 'İtalyanca', CURRENT_DATE + 30, '09:00', 2, 0,
    3600, 'TL', 4800, 'TL', NULL, 'Test Contact FortyFour', NULL, NULL,
    '[{"fullName":"REAL GUEST A","sortOrder":0},{"fullName":"REAL GUEST B","sortOrder":1}]'::jsonb
  );
  IF r1->>'result' <> 'created' THEN
    RAISE EXCEPTION 'TEST 8: SETUP FAILED — expected the initial booking to succeed, got %', r1->>'result';
  END IF;

  SELECT COUNT(*) INTO v_guest_count_before FROM public.reservation_guests WHERE reservation_id = (r1->>'reservation_id')::uuid;
  IF v_guest_count_before <> 2 THEN
    RAISE EXCEPTION 'TEST 8: SETUP FAILED — expected 2 guests before modification, found %', v_guest_count_before;
  END IF;

  -- A later "Booking modified" email that supplies ZERO passenger names
  -- (a real, documented Civitatis shape — not every modification repeats
  -- the full original passenger list).
  r2 := public.ingest_civitatis_booking(
    'gmail-v15test08-mod', 'thread-v15test08', NOW(), 'Booking A90000044 modified: Test Tour', 'body', 'modified',
    v_source_id, '90000044', v_tour_id, 'İtalyanca', CURRENT_DATE + 31, '10:00', 2, 0,
    3700, 'TL', 4900, 'TL', NULL, NULL, NULL, NULL, '[]'::jsonb
  );
  IF r2->>'result' <> 'updated' THEN
    RAISE EXCEPTION 'TEST 8: FAILED — a modification with zero usable passenger names must still update the reservation''s other fields, got %', r2->>'result';
  END IF;
  IF (r2->>'passengers_replaced')::boolean IS DISTINCT FROM FALSE THEN
    RAISE EXCEPTION 'TEST 8: FAILED — passengers_replaced should be false when the modification supplies zero usable passenger names';
  END IF;

  SELECT COUNT(*) INTO v_guest_count_after FROM public.reservation_guests WHERE reservation_id = (r1->>'reservation_id')::uuid;
  IF v_guest_count_after <> 2 THEN
    RAISE EXCEPTION 'TEST 8: FAILED — existing reservation_guests must be PRESERVED (expected 2, found %) — never replaced with an empty set', v_guest_count_after;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.reservation_guests WHERE reservation_id = (r1->>'reservation_id')::uuid AND full_name = 'REAL GUEST A') THEN
    RAISE EXCEPTION 'TEST 8: FAILED — REAL GUEST A must still be present after a zero-passenger-names modification';
  END IF;

  RAISE NOTICE 'TEST 8: PASSED';
END $$;
ROLLBACK;


-- ══════════════════════════════════════════════════════════════════════════
-- TEST 9 — MODIFICATION with a COMPLETE passenger list: existing
-- replace-all behavior is completely unchanged by V15.
-- ══════════════════════════════════════════════════════════════════════════
BEGIN;
DO $$
DECLARE
  v_source_id UUID; v_tour_id UUID;
  r1 JSONB; r2 JSONB;
  v_guest_count INT;
BEGIN
  SELECT id INTO v_source_id FROM public.sources WHERE slug ILIKE 'civitatis%' LIMIT 1;
  INSERT INTO public.tours (name, is_active) VALUES ('TEST-V15-09 Tour', TRUE) RETURNING id INTO v_tour_id;

  r1 := public.ingest_civitatis_booking(
    'gmail-v15test09-new', 'thread-v15test09', NOW() - INTERVAL '1 hour', 'New booking A90000045: Test Tour', 'body', 'new_booking',
    v_source_id, '90000045', v_tour_id, 'İtalyanca', CURRENT_DATE + 30, '09:00', 2, 0,
    3600, 'TL', 4800, 'TL', NULL, 'Test Contact FortyFive', NULL, NULL,
    '[{"fullName":"OLD GUEST A","sortOrder":0},{"fullName":"OLD GUEST B","sortOrder":1}]'::jsonb
  );
  IF r1->>'result' <> 'created' THEN
    RAISE EXCEPTION 'TEST 9: SETUP FAILED — expected the initial booking to succeed, got %', r1->>'result';
  END IF;

  r2 := public.ingest_civitatis_booking(
    'gmail-v15test09-mod', 'thread-v15test09', NOW(), 'Booking A90000045 modified: Test Tour', 'body', 'modified',
    v_source_id, '90000045', v_tour_id, 'İtalyanca', CURRENT_DATE + 30, '09:00', 2, 0,
    3600, 'TL', 4800, 'TL', NULL, NULL, NULL, NULL,
    '[{"fullName":"NEW GUEST A","sortOrder":0},{"fullName":"NEW GUEST B","sortOrder":1}]'::jsonb
  );
  IF r2->>'result' <> 'updated' THEN
    RAISE EXCEPTION 'TEST 9: FAILED — expected updated, got %', r2->>'result';
  END IF;
  IF (r2->>'passengers_replaced')::boolean IS DISTINCT FROM TRUE THEN
    RAISE EXCEPTION 'TEST 9: FAILED — passengers_replaced should be true for a complete replacement list';
  END IF;

  SELECT COUNT(*) INTO v_guest_count FROM public.reservation_guests WHERE reservation_id = (r1->>'reservation_id')::uuid;
  IF v_guest_count <> 2 THEN
    RAISE EXCEPTION 'TEST 9: FAILED — expected exactly 2 guests after replacement, found %', v_guest_count;
  END IF;
  IF EXISTS (SELECT 1 FROM public.reservation_guests WHERE reservation_id = (r1->>'reservation_id')::uuid AND full_name LIKE 'OLD GUEST%') THEN
    RAISE EXCEPTION 'TEST 9: FAILED — the OLD guest list must have been fully replaced';
  END IF;

  RAISE NOTICE 'TEST 9: PASSED';
END $$;
ROLLBACK;


-- ══════════════════════════════════════════════════════════════════════════
-- TEST 10 — BEFORE/AFTER COMPARISON: the exact A42463096 predicate
-- (usable=0, expected=2) is evaluated directly against both the OLD
-- (exact-match-only) rule and the NEW (V15) rule, proving precisely what
-- changed and nothing more — a pure boolean check, no function-version
-- switching required.
-- ══════════════════════════════════════════════════════════════════════════
DO $$
DECLARE
  v_usable INT := 0;
  v_expected INT := 2;
  v_old_rule_rejects BOOLEAN;
  v_new_rule_rejects BOOLEAN;
BEGIN
  v_old_rule_rejects := (v_usable <> v_expected);
  v_new_rule_rejects := (v_usable <> v_expected AND v_usable <> 0);

  IF NOT v_old_rule_rejects THEN
    RAISE EXCEPTION 'TEST 10: FAILED — sanity check: the OLD rule must have rejected A42463096''s exact input (usable=0, expected=2)';
  END IF;
  IF v_new_rule_rejects THEN
    RAISE EXCEPTION 'TEST 10: FAILED — the NEW (V15) rule must accept A42463096''s exact input (usable=0, expected=2)';
  END IF;

  -- Partial/over-count are rejected under BOTH rules — nothing widened
  -- beyond the one new zero case.
  IF NOT ((1 <> 2) AND (1 <> 0)) THEN
    RAISE EXCEPTION 'TEST 10: FAILED — sanity check: usable=1/expected=2 must still be rejected under the NEW rule';
  END IF;
  IF NOT ((3 <> 2) AND (3 <> 0)) THEN
    RAISE EXCEPTION 'TEST 10: FAILED — sanity check: usable=3/expected=2 must still be rejected under the NEW rule';
  END IF;

  RAISE NOTICE 'TEST 10: PASSED';
END $$;
