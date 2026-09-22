-- ============================================================
-- MANUAL / STAGING DATABASE TEST PLAN
-- public.ingest_civitatis_booking(...)
-- ============================================================
-- NOT EXECUTED as part of preparing this task. These tests require a
-- real PostgreSQL/Supabase database with supabase_schema.sql,
-- supabase_rls_policies.sql, supabase_migration_guides.sql,
-- supabase_migration_reviews.sql, supabase_migration_tour_channels.sql,
-- supabase_migration_civitatis_ingestion.sql, AND
-- supabase_migration_civitatis_write.sql (V5 — includes the safe-retry
-- revision) already applied — none of which this task applies. Run this
-- file (e.g. via `psql` or the Supabase SQL editor) against a STAGING
-- database only, never production, after the write migration has been
-- reviewed and applied there. TESTS 1-16 cover the V2/V3/V4-reviewed
-- architecture and event matrix (unchanged by V5); TESTS 17-21 cover the
-- V5 retry state machine specifically.
--
-- WHY THIS EXISTS AS SQL, NOT A JS TEST
-- The write architecture's core claims — atomic rollback, idempotency
-- under a real UNIQUE-constraint conflict, advisory-lock serialization
-- — can only be genuinely proven by PostgreSQL itself executing them.
-- A JS test with a mocked/fake repo cannot demonstrate that a real
-- transaction actually rolled back or that a real UNIQUE constraint
-- actually blocked a second insert. See tests/civitatis/writeAdapter.
-- test.js for everything that CAN be proven without a database (payload
-- construction and write-eligibility gating), and treat this file as
-- the separate, deliberately NOT-run counterpart for what cannot.
--
-- EACH TEST BLOCK is wrapped in its own BEGIN ... ROLLBACK, so running
-- this whole file leaves no residue even against a database with real
-- data — but a dedicated staging database is still strongly
-- recommended, since a bug in the function under test could in
-- principle still be exposed by a test that doesn't behave as this file
-- assumes.
--
-- HOW TO READ A FAILURE: every assertion uses
--   IF NOT (<condition>) THEN RAISE EXCEPTION '<test name>: FAILED — <detail>'; END IF;
-- A silent, error-free run of this whole file means every test passed.
-- ============================================================


-- ──────────────────────────────────────────────────────────────────────────
-- Shared fixture setup used by multiple tests below. Run once per session
-- before the numbered tests (each numbered test still wraps its OWN
-- reservation-affecting work in BEGIN/ROLLBACK, but reads this fixture data).
-- ──────────────────────────────────────────────────────────────────────────

DO $$
DECLARE
  v_source_id UUID;
  v_tour_id   UUID;
BEGIN
  -- Reuse the real seeded Civitatis source row if present; otherwise
  -- create a throwaway test one (never assume seed data exists on a
  -- fresh staging DB).
  SELECT id INTO v_source_id FROM public.sources WHERE slug = 'civitatis' LIMIT 1;
  IF v_source_id IS NULL THEN
    INSERT INTO public.sources (name, slug, is_active) VALUES ('Civitatis (test)', 'civitatis-manual-test', TRUE)
    RETURNING id INTO v_source_id;
  END IF;

  INSERT INTO public.tours (name, category, is_active)
  VALUES ('MANUAL TEST — Grand Bazaar Experience', 'cultural', TRUE)
  RETURNING id INTO v_tour_id;

  RAISE NOTICE 'Fixture ready: source_id=%, tour_id=%. Copy these into TEST 1-9 below before running them (psql does not share variables across DO blocks).', v_source_id, v_tour_id;
END $$;

-- Replace :source_id / :tour_id below with the values NOTICE printed above
-- (or wrap the whole file in a single DO block with shared DECLAREs if
-- running via a tool that supports it — kept as separate blocks here for
-- readability, matching this repo's own migration file style).


-- ══════════════════════════════════════════════════════════════════════════
-- TEST 1 — same gmail_message_id retried -> already_processed, no duplicate
-- reservation/customer/passenger/notification (test plan item #4)
-- ══════════════════════════════════════════════════════════════════════════
BEGIN;
DO $$
DECLARE
  v_source_id UUID; v_tour_id UUID;
  r1 JSONB; r2 JSONB;
  v_res_count INT; v_cust_count INT; v_activity_count INT;
BEGIN
  SELECT id INTO v_source_id FROM public.sources WHERE slug ILIKE 'civitatis%' LIMIT 1;
  INSERT INTO public.tours (name, is_active) VALUES ('TEST1 Tour', TRUE) RETURNING id INTO v_tour_id;

  r1 := public.ingest_civitatis_booking(
    'gmail-test1-001', 'thread-test1', NOW(), 'New booking A90000001: Test Tour', 'raw body', 'new_booking',
    v_source_id, '90000001', v_tour_id, 'İtalyanca', CURRENT_DATE + 30, '09:00', 2, 0,
    3600, 'TL', 4800, 'TL', NULL, 'Test Contact One', NULL, NULL,
    '[{"fullName":"PASSENGER ONE","sortOrder":0},{"fullName":"PASSENGER TWO","sortOrder":1}]'::jsonb
  );
  IF r1->>'result' <> 'created' THEN
    RAISE EXCEPTION 'TEST 1: FAILED — first call expected result=created, got %', r1->>'result';
  END IF;

  -- Retry: exact same gmail_message_id.
  r2 := public.ingest_civitatis_booking(
    'gmail-test1-001', 'thread-test1', NOW(), 'New booking A90000001: Test Tour', 'raw body', 'new_booking',
    v_source_id, '90000001', v_tour_id, 'İtalyanca', CURRENT_DATE + 30, '09:00', 2, 0,
    3600, 'TL', 4800, 'TL', NULL, 'Test Contact One', NULL, NULL,
    '[{"fullName":"PASSENGER ONE","sortOrder":0},{"fullName":"PASSENGER TWO","sortOrder":1}]'::jsonb
  );
  IF r2->>'result' <> 'already_processed' THEN
    RAISE EXCEPTION 'TEST 1: FAILED — retry expected result=already_processed, got %', r2->>'result';
  END IF;

  SELECT COUNT(*) INTO v_res_count FROM public.reservations WHERE source_id = v_source_id AND external_booking_id = '90000001';
  IF v_res_count <> 1 THEN RAISE EXCEPTION 'TEST 1: FAILED — expected exactly 1 reservation, found %', v_res_count; END IF;

  SELECT COUNT(*) INTO v_activity_count FROM public.activity_logs
   WHERE entity_type='reservation' AND entity_id = (r1->>'reservation_id')::uuid;
  IF v_activity_count <> 1 THEN RAISE EXCEPTION 'TEST 1: FAILED — expected exactly 1 activity_logs row, found %', v_activity_count; END IF;

  RAISE NOTICE 'TEST 1: PASSED';
END $$;
ROLLBACK;


-- ══════════════════════════════════════════════════════════════════════════
-- TEST 2 — new_booking + modified for the SAME external_booking_id use the
-- SAME reservation (test plan item #6), never a second reservation (#5)
-- ══════════════════════════════════════════════════════════════════════════
BEGIN;
DO $$
DECLARE
  v_source_id UUID; v_tour_id UUID;
  r1 JSONB; r2 JSONB;
  v_res_count INT;
  v_res RECORD;
BEGIN
  SELECT id INTO v_source_id FROM public.sources WHERE slug ILIKE 'civitatis%' LIMIT 1;
  INSERT INTO public.tours (name, is_active) VALUES ('TEST2 Tour', TRUE) RETURNING id INTO v_tour_id;

  r1 := public.ingest_civitatis_booking(
    'gmail-test2-new', 'thread-test2', NOW() - INTERVAL '1 day', 'New booking A90000002: Test Tour', 'body', 'new_booking',
    v_source_id, '90000002', v_tour_id, 'İtalyanca', CURRENT_DATE + 30, '09:00', 2, 0,
    3600, 'TL', 4800, 'TL', NULL, 'Test Contact Two', NULL, NULL,
    '[{"fullName":"PASSENGER A","sortOrder":0}]'::jsonb
  );

  r2 := public.ingest_civitatis_booking(
    'gmail-test2-mod', 'thread-test2', NOW(), 'Booking A90000002 modified: Test Tour', 'body', 'modified',
    v_source_id, '90000002', v_tour_id, 'İtalyanca', CURRENT_DATE + 31, '10:00', 3, 1,
    5400, 'TL', 7200, 'TL', NULL, 'Test Contact Two', NULL, NULL,
    '[{"fullName":"PASSENGER A","sortOrder":0},{"fullName":"PASSENGER B","sortOrder":1},{"fullName":"PASSENGER C","sortOrder":2},{"fullName":"PASSENGER D","sortOrder":3}]'::jsonb
  );

  IF r1->>'result' <> 'created' THEN RAISE EXCEPTION 'TEST 2: FAILED — first call expected created, got %', r1->>'result'; END IF;
  IF r2->>'result' <> 'updated' THEN RAISE EXCEPTION 'TEST 2: FAILED — second call expected updated, got %', r2->>'result'; END IF;
  IF r1->>'reservation_id' <> r2->>'reservation_id' THEN
    RAISE EXCEPTION 'TEST 2: FAILED — new_booking and modified resolved to DIFFERENT reservations: % vs %', r1->>'reservation_id', r2->>'reservation_id';
  END IF;

  SELECT COUNT(*) INTO v_res_count FROM public.reservations WHERE source_id=v_source_id AND external_booking_id='90000002';
  IF v_res_count <> 1 THEN RAISE EXCEPTION 'TEST 2: FAILED — expected exactly 1 reservation, found %', v_res_count; END IF;

  SELECT * INTO v_res FROM public.reservations WHERE id = (r2->>'reservation_id')::uuid;
  IF v_res.check_in <> CURRENT_DATE + 31 THEN RAISE EXCEPTION 'TEST 2: FAILED — modification did not apply new check_in'; END IF;
  IF v_res.pax_adult <> 3 THEN RAISE EXCEPTION 'TEST 2: FAILED — modification did not apply new pax_adult'; END IF;

  -- Passenger replacement is atomic, not additive:
  IF (SELECT COUNT(*) FROM public.reservation_guests WHERE reservation_id = v_res.id) <> 4 THEN
    RAISE EXCEPTION 'TEST 2: FAILED — expected exactly 4 passengers after modification (replace-all), found %',
      (SELECT COUNT(*) FROM public.reservation_guests WHERE reservation_id = v_res.id);
  END IF;

  -- Exactly one "new reservation" activity, never a second one for the modification:
  IF (SELECT COUNT(*) FROM public.activity_logs WHERE entity_type='reservation' AND entity_id=v_res.id) <> 1 THEN
    RAISE EXCEPTION 'TEST 2: FAILED — modification must not create a second new-reservation activity row';
  END IF;

  RAISE NOTICE 'TEST 2: PASSED';
END $$;
ROLLBACK;


-- ══════════════════════════════════════════════════════════════════════════
-- TEST 3 — modification only updates the allow-listed fields; guide_id,
-- internal_notes, and any manually-set payment/operational field survive
-- unchanged (test plan items #7, #8, #9, #10)
-- ══════════════════════════════════════════════════════════════════════════
BEGIN;
DO $$
DECLARE
  v_source_id UUID; v_tour_id UUID; v_guide_id UUID; v_customer_id UUID;
  r1 JSONB; r2 JSONB;
  v_res RECORD;
  v_payment_count INT;
BEGIN
  SELECT id INTO v_source_id FROM public.sources WHERE slug ILIKE 'civitatis%' LIMIT 1;
  INSERT INTO public.tours (name, is_active) VALUES ('TEST3 Tour', TRUE) RETURNING id INTO v_tour_id;

  r1 := public.ingest_civitatis_booking(
    'gmail-test3-new', 'thread-test3', NOW() - INTERVAL '1 day', 'New booking A90000003: Test Tour', 'body', 'new_booking',
    v_source_id, '90000003', v_tour_id, 'İtalyanca', CURRENT_DATE + 30, '09:00', 2, 0,
    3600, 'TL', 4800, 'TL', NULL, 'Test Contact Three', NULL, NULL, '[]'::jsonb
  );
  v_customer_id := (r1->>'customer_id')::uuid;

  -- Simulate normal staff operational work on this reservation BEFORE the
  -- modification email arrives: assign a guide, add internal notes, and
  -- record a manual payment.
  IF EXISTS (SELECT 1 FROM public.guides LIMIT 1) THEN
    SELECT id INTO v_guide_id FROM public.guides LIMIT 1;
    UPDATE public.reservations SET guide_id = v_guide_id, guide_name = 'Manual Test Guide',
      internal_notes = 'VIP — handle with care', status = 'confirmed'
      WHERE id = (r1->>'reservation_id')::uuid;
  ELSE
    UPDATE public.reservations SET guide_name = 'Manual Test Guide',
      internal_notes = 'VIP — handle with care', status = 'confirmed'
      WHERE id = (r1->>'reservation_id')::uuid;
  END IF;

  INSERT INTO public.payments (payment_number, reservation_id, customer_id, payment_type, status, amount, currency)
  VALUES ('PAY-TEST3-0001', (r1->>'reservation_id')::uuid, v_customer_id, 'deposit', 'paid', 500, 'EUR');

  r2 := public.ingest_civitatis_booking(
    'gmail-test3-mod', 'thread-test3', NOW(), 'Booking A90000003 modified: Test Tour', 'body', 'modified',
    v_source_id, '90000003', v_tour_id, 'Español', CURRENT_DATE + 31, '11:00', 4, 0,
    6000, 'TL', 8000, 'TL', NULL, 'Test Contact Three', NULL, NULL, '[]'::jsonb
  );
  IF r2->>'result' <> 'updated' THEN RAISE EXCEPTION 'TEST 3: FAILED — expected updated, got %', r2->>'result'; END IF;

  SELECT * INTO v_res FROM public.reservations WHERE id = (r2->>'reservation_id')::uuid;

  -- Allowed fields DID change:
  IF v_res.tour_language <> 'Español' THEN RAISE EXCEPTION 'TEST 3: FAILED — tour_language should have been updated'; END IF;
  IF v_res.pax_adult <> 4 THEN RAISE EXCEPTION 'TEST 3: FAILED — pax_adult should have been updated'; END IF;

  -- Disallowed / CRM-managed fields did NOT change:
  IF v_res.guide_name IS DISTINCT FROM 'Manual Test Guide' THEN
    RAISE EXCEPTION 'TEST 3: FAILED — guide_name was overwritten by a modification email';
  END IF;
  IF v_guide_id IS NOT NULL AND v_res.guide_id IS DISTINCT FROM v_guide_id THEN
    RAISE EXCEPTION 'TEST 3: FAILED — guide_id was overwritten by a modification email';
  END IF;
  IF v_res.internal_notes IS DISTINCT FROM 'VIP — handle with care' THEN
    RAISE EXCEPTION 'TEST 3: FAILED — internal_notes was overwritten by a modification email';
  END IF;
  IF v_res.status IS DISTINCT FROM 'confirmed' THEN
    RAISE EXCEPTION 'TEST 3: FAILED — status was overwritten by a modification email';
  END IF;

  SELECT COUNT(*) INTO v_payment_count FROM public.payments WHERE reservation_id = v_res.id;
  IF v_payment_count <> 1 THEN RAISE EXCEPTION 'TEST 3: FAILED — modification must never create/remove a payment row, found % rows', v_payment_count; END IF;

  RAISE NOTICE 'TEST 3: PASSED';
END $$;
ROLLBACK;


-- ══════════════════════════════════════════════════════════════════════════
-- TEST 4 — a failure mid-write rolls EVERYTHING back for that call, but the
-- email_ingestions audit row survives as 'failed' (test plan item #20)
-- ══════════════════════════════════════════════════════════════════════════
BEGIN;
DO $$
DECLARE
  v_source_id UUID; v_tour_id UUID;
  r1 JSONB;
  v_bogus_customer_id UUID := gen_random_uuid(); -- guaranteed not to exist
  v_res_count INT; v_ingestion RECORD;
BEGIN
  SELECT id INTO v_source_id FROM public.sources WHERE slug ILIKE 'civitatis%' LIMIT 1;
  INSERT INTO public.tours (name, is_active) VALUES ('TEST4 Tour', TRUE) RETURNING id INTO v_tour_id;

  r1 := public.ingest_civitatis_booking(
    'gmail-test4-001', 'thread-test4', NOW(), 'New booking A90000004: Test Tour', 'body', 'new_booking',
    v_source_id, '90000004', v_tour_id, 'İtalyanca', CURRENT_DATE + 30, '09:00', 2, 0,
    3600, 'TL', 4800, 'TL',
    v_bogus_customer_id, -- a customer_id that does not exist -> RAISE EXCEPTION inside the function
    NULL, NULL, NULL, '[{"fullName":"SHOULD NOT PERSIST","sortOrder":0}]'::jsonb
  );

  IF r1->>'result' <> 'failed' THEN RAISE EXCEPTION 'TEST 4: FAILED — expected result=failed, got %', r1->>'result'; END IF;

  SELECT COUNT(*) INTO v_res_count FROM public.reservations WHERE source_id=v_source_id AND external_booking_id='90000004';
  IF v_res_count <> 0 THEN RAISE EXCEPTION 'TEST 4: FAILED — a reservation was left behind despite the failure, count=%', v_res_count; END IF;

  IF EXISTS (SELECT 1 FROM public.reservation_guests WHERE full_name = 'SHOULD NOT PERSIST') THEN
    RAISE EXCEPTION 'TEST 4: FAILED — a passenger row was left behind despite the failure';
  END IF;

  SELECT * INTO v_ingestion FROM public.email_ingestions WHERE gmail_message_id = 'gmail-test4-001';
  IF v_ingestion.processing_status <> 'failed' THEN
    RAISE EXCEPTION 'TEST 4: FAILED — email_ingestions row should be failed, got %', v_ingestion.processing_status;
  END IF;
  IF v_ingestion.error_reason IS NULL THEN
    RAISE EXCEPTION 'TEST 4: FAILED — failed row must record an error_reason';
  END IF;

  RAISE NOTICE 'TEST 4: PASSED';
END $$;
ROLLBACK;


-- ══════════════════════════════════════════════════════════════════════════
-- TEST 5 — missing source_id/external_booking_id/tour_id -> manual_review_
-- required, no write attempted at all (companion to test plan items #15-17,
-- which are enforced at the writeAdapter.js gating layer — this confirms
-- the RPC itself is a second line of defense, not just the caller)
-- ══════════════════════════════════════════════════════════════════════════
BEGIN;
DO $$
DECLARE
  v_source_id UUID;
  r1 JSONB;
BEGIN
  SELECT id INTO v_source_id FROM public.sources WHERE slug ILIKE 'civitatis%' LIMIT 1;

  r1 := public.ingest_civitatis_booking(
    'gmail-test5-001', 'thread-test5', NOW(), 'New booking A90000005: Test Tour', 'body', 'new_booking',
    v_source_id, '90000005',
    NULL, -- no matched tour_id
    'İtalyanca', CURRENT_DATE + 30, '09:00', 2, 0, 3600, 'TL', 4800, 'TL',
    NULL, 'Test Contact Five', NULL, NULL, '[]'::jsonb
  );
  IF r1->>'result' <> 'manual_review_required' THEN
    RAISE EXCEPTION 'TEST 5: FAILED — missing tour_id expected manual_review_required, got %', r1->>'result';
  END IF;
  IF EXISTS (SELECT 1 FROM public.reservations WHERE source_id=v_source_id AND external_booking_id='90000005') THEN
    RAISE EXCEPTION 'TEST 5: FAILED — a reservation was written despite missing tour_id';
  END IF;

  RAISE NOTICE 'TEST 5: PASSED';
END $$;
ROLLBACK;


-- ══════════════════════════════════════════════════════════════════════════
-- TEST 6 — an authoritative existing customer_id is reused, never re-created
-- (test plan item #18)
-- ══════════════════════════════════════════════════════════════════════════
BEGIN;
DO $$
DECLARE
  v_source_id UUID; v_tour_id UUID; v_existing_customer_id UUID;
  r1 JSONB;
  v_cust_count INT;
BEGIN
  SELECT id INTO v_source_id FROM public.sources WHERE slug ILIKE 'civitatis%' LIMIT 1;
  INSERT INTO public.tours (name, is_active) VALUES ('TEST6 Tour', TRUE) RETURNING id INTO v_tour_id;
  INSERT INTO public.customers (full_name, email) VALUES ('Existing Customer Six', 'six@example.com') RETURNING id INTO v_existing_customer_id;

  r1 := public.ingest_civitatis_booking(
    'gmail-test6-001', 'thread-test6', NOW(), 'New booking A90000006: Test Tour', 'body', 'new_booking',
    v_source_id, '90000006', v_tour_id, 'İtalyanca', CURRENT_DATE + 30, '09:00', 2, 0,
    3600, 'TL', 4800, 'TL',
    v_existing_customer_id, -- pre-resolved by the JS matching layer
    'A Name The Email Body Happened To Show', 'six@example.com', NULL, '[]'::jsonb
  );

  IF (r1->>'customer_id')::uuid <> v_existing_customer_id THEN
    RAISE EXCEPTION 'TEST 6: FAILED — a NEW customer was created instead of reusing the resolved one';
  END IF;

  SELECT COUNT(*) INTO v_cust_count FROM public.customers WHERE email = 'six@example.com';
  IF v_cust_count <> 1 THEN RAISE EXCEPTION 'TEST 6: FAILED — expected exactly 1 customer with this email, found %', v_cust_count; END IF;

  RAISE NOTICE 'TEST 6: PASSED';
END $$;
ROLLBACK;


-- ══════════════════════════════════════════════════════════════════════════
-- TEST 7 — no resolvable customer -> exactly one new customer created, using
-- only the booking-contact fields given (test plan items #1, #19)
-- ══════════════════════════════════════════════════════════════════════════
BEGIN;
DO $$
DECLARE
  v_source_id UUID; v_tour_id UUID;
  r1 JSONB;
  v_cust RECORD;
BEGIN
  SELECT id INTO v_source_id FROM public.sources WHERE slug ILIKE 'civitatis%' LIMIT 1;
  INSERT INTO public.tours (name, is_active) VALUES ('TEST7 Tour', TRUE) RETURNING id INTO v_tour_id;

  r1 := public.ingest_civitatis_booking(
    'gmail-test7-001', 'thread-test7', NOW(), 'New booking A90000007: Test Tour', 'body', 'new_booking',
    v_source_id, '90000007', v_tour_id, 'İtalyanca', CURRENT_DATE + 30, '09:00', 2, 0,
    3600, 'TL', 4800, 'TL',
    NULL, -- no resolved customer -> create
    'Brand New Contact Seven', NULL, NULL, '[]'::jsonb
  );
  IF r1->>'result' <> 'created' THEN RAISE EXCEPTION 'TEST 7: FAILED — expected created, got %', r1->>'result'; END IF;

  SELECT * INTO v_cust FROM public.customers WHERE id = (r1->>'customer_id')::uuid;
  IF v_cust.full_name <> 'Brand New Contact Seven' THEN RAISE EXCEPTION 'TEST 7: FAILED — full_name mismatch'; END IF;
  IF v_cust.email IS NOT NULL THEN RAISE EXCEPTION 'TEST 7: FAILED — email must be NULL, never invented'; END IF;
  IF v_cust.phone IS NOT NULL THEN RAISE EXCEPTION 'TEST 7: FAILED — phone must be NULL, never invented'; END IF;
  IF v_cust.nationality IS NOT NULL THEN RAISE EXCEPTION 'TEST 7: FAILED — nationality must be NULL, never invented'; END IF;
  IF v_cust.import_type <> 'civitatis' THEN RAISE EXCEPTION 'TEST 7: FAILED — import_type should be civitatis'; END IF;

  RAISE NOTICE 'TEST 7: PASSED';
END $$;
ROLLBACK;


-- ══════════════════════════════════════════════════════════════════════════
-- TEST 8 — a STALE MODIFICATION event never regresses already-applied
-- newer data AND has ZERO business-state side effects — no customer
-- created/changed, no reservation field changed, no passengers replaced —
-- beyond its own email_ingestions audit row (V3: test plan items "stale
-- event does not create customer", "stale event does not modify customer",
-- "stale event does not update reservation", "stale event does not replace
-- passengers", "stale event returns explicit stale result"). A reservation
-- UPDATE (and therefore staleness) is only ever reachable for
-- event_type='modified' (V4) — this test uses new_booking to CREATE and a
-- second, out-of-order 'modified' event to exercise the stale path; see
-- TEST 16 for the separate "second new_booking for an existing
-- reservation" case, which is never staleness at all.
-- ══════════════════════════════════════════════════════════════════════════
BEGIN;
DO $$
DECLARE
  v_source_id UUID; v_tour_id UUID;
  r1 JSONB; r2 JSONB;
  v_res RECORD;
  v_cust_count_before INT; v_cust_count_after INT;
  v_guest_count_before INT; v_guest_count_after INT;
BEGIN
  SELECT id INTO v_source_id FROM public.sources WHERE slug ILIKE 'civitatis%' LIMIT 1;
  INSERT INTO public.tours (name, is_active) VALUES ('TEST8 Tour', TRUE) RETURNING id INTO v_tour_id;

  -- Create the reservation via a genuine new_booking event first.
  r1 := public.ingest_civitatis_booking(
    'gmail-test8-new', 'thread-test8', NOW() - INTERVAL '1 day', 'New booking A90000008: Test Tour', 'body', 'new_booking',
    v_source_id, '90000008', v_tour_id, 'İtalyanca', CURRENT_DATE + 30, '09:00', 2, 0,
    3600, 'TL', 4800, 'TL', NULL, 'Test Contact Eight', NULL, NULL, '[]'::jsonb
  );
  IF r1->>'result' <> 'created' THEN RAISE EXCEPTION 'TEST 8: FAILED — new_booking with no existing reservation should create, got %', r1->>'result'; END IF;

  -- Apply a NEWER modification with two named passengers.
  PERFORM public.ingest_civitatis_booking(
    'gmail-test8-mod-new', 'thread-test8', NOW(), 'Booking A90000008 modified: Test Tour', 'body', 'modified',
    v_source_id, '90000008', v_tour_id, 'Español', CURRENT_DATE + 40, '14:00', 5, 0,
    9000, 'TL', 12000, 'TL', NULL, 'Test Contact Eight', NULL, NULL,
    '[{"fullName":"REAL PASSENGER ONE","sortOrder":0},{"fullName":"REAL PASSENGER TWO","sortOrder":1}]'::jsonb
  );

  SELECT COUNT(*) INTO v_cust_count_before FROM public.customers;
  SELECT COUNT(*) INTO v_guest_count_before FROM public.reservation_guests WHERE reservation_id = (r1->>'reservation_id')::uuid;

  -- ...then an OLDER modification arrives late (e.g. a backfill re-run,
  -- or genuinely out-of-order Gmail delivery), with DIFFERENT (wrong,
  -- stale) field values, a different contact name, and a different
  -- (single, stale) passenger — none of which must ever be applied.
  r2 := public.ingest_civitatis_booking(
    'gmail-test8-mod-old', 'thread-test8', NOW() - INTERVAL '2 days', 'Booking A90000008 modified: Test Tour', 'body', 'modified',
    v_source_id, '90000008', v_tour_id, 'İtalyanca', CURRENT_DATE + 31, '10:00', 3, 0,
    3600, 'TL', 4800, 'TL', NULL, 'A DIFFERENT STALE CONTACT NAME', NULL, NULL,
    '[{"fullName":"STALE PASSENGER SHOULD NOT APPEAR","sortOrder":0}]'::jsonb
  );

  IF r2->>'result' <> 'stale_ignored' THEN
    RAISE EXCEPTION 'TEST 8: FAILED — the older/stale modification call expected result=stale_ignored, got %', r2->>'result';
  END IF;
  IF (r2->>'reservation_id')::uuid <> (r1->>'reservation_id')::uuid THEN
    RAISE EXCEPTION 'TEST 8: FAILED — stale_ignored result did not resolve to the correct existing reservation';
  END IF;

  SELECT * INTO v_res FROM public.reservations WHERE id = (r1->>'reservation_id')::uuid;
  IF v_res.check_in <> CURRENT_DATE + 40 THEN
    RAISE EXCEPTION 'TEST 8: FAILED — the stale older event regressed check_in back to its own (wrong) value';
  END IF;
  IF v_res.pax_adult <> 5 THEN
    RAISE EXCEPTION 'TEST 8: FAILED — the stale older event regressed pax_adult back to its own (wrong) value';
  END IF;

  -- Zero new customers created by the stale event, and the reservation's
  -- customer_id is completely untouched by it:
  SELECT COUNT(*) INTO v_cust_count_after FROM public.customers;
  IF v_cust_count_after <> v_cust_count_before THEN
    RAISE EXCEPTION 'TEST 8: FAILED — a stale event created a customer row (before=%, after=%)', v_cust_count_before, v_cust_count_after;
  END IF;
  IF EXISTS (SELECT 1 FROM public.customers WHERE full_name = 'A DIFFERENT STALE CONTACT NAME') THEN
    RAISE EXCEPTION 'TEST 8: FAILED — a stale event''s contact name leaked into a new customer row';
  END IF;

  -- Passengers completely untouched by the stale event:
  SELECT COUNT(*) INTO v_guest_count_after FROM public.reservation_guests WHERE reservation_id = v_res.id;
  IF v_guest_count_after <> v_guest_count_before THEN
    RAISE EXCEPTION 'TEST 8: FAILED — a stale event changed the passenger count (before=%, after=%)', v_guest_count_before, v_guest_count_after;
  END IF;
  IF EXISTS (SELECT 1 FROM public.reservation_guests WHERE reservation_id = v_res.id AND full_name = 'STALE PASSENGER SHOULD NOT APPEAR') THEN
    RAISE EXCEPTION 'TEST 8: FAILED — a stale event''s passenger payload was applied';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.reservation_guests WHERE reservation_id = v_res.id AND full_name = 'REAL PASSENGER ONE') THEN
    RAISE EXCEPTION 'TEST 8: FAILED — the real (newer) passenger list was lost';
  END IF;

  -- All three Gmail messages still each have their own permanent audit
  -- row, and the stale one is 'processed' (understood correctly, not a
  -- failure):
  IF (SELECT COUNT(*) FROM public.email_ingestions WHERE source_id=v_source_id AND external_booking_id='90000008') <> 3 THEN
    RAISE EXCEPTION 'TEST 8: FAILED — expected 3 separate email_ingestions rows';
  END IF;
  IF (SELECT processing_status FROM public.email_ingestions WHERE gmail_message_id='gmail-test8-mod-old') <> 'processed' THEN
    RAISE EXCEPTION 'TEST 8: FAILED — the stale event''s own email_ingestions row should be processing_status=processed';
  END IF;

  RAISE NOTICE 'TEST 8: PASSED';
END $$;
ROLLBACK;


-- ══════════════════════════════════════════════════════════════════════════
-- TEST 10 — an invalid/missing event_type writes NO business state (V3
-- item "invalid event type writes no business state")
-- ══════════════════════════════════════════════════════════════════════════
BEGIN;
DO $$
DECLARE
  v_source_id UUID; v_tour_id UUID;
  r1 JSONB; r2 JSONB;
BEGIN
  SELECT id INTO v_source_id FROM public.sources WHERE slug ILIKE 'civitatis%' LIMIT 1;
  INSERT INTO public.tours (name, is_active) VALUES ('TEST10 Tour', TRUE) RETURNING id INTO v_tour_id;

  -- NULL event_type:
  r1 := public.ingest_civitatis_booking(
    'gmail-test10-null', 'thread-test10', NOW(), 'New booking A90000010: Test Tour', 'body', NULL,
    v_source_id, '90000010', v_tour_id, 'İtalyanca', CURRENT_DATE + 30, '09:00', 2, 0,
    3600, 'TL', 4800, 'TL', NULL, 'Test Contact Ten', NULL, NULL, '[]'::jsonb
  );
  IF r1->>'result' <> 'manual_review_required' THEN
    RAISE EXCEPTION 'TEST 10: FAILED — NULL event_type expected manual_review_required, got %', r1->>'result';
  END IF;

  -- Garbage/arbitrary event_type:
  r2 := public.ingest_civitatis_booking(
    'gmail-test10-bogus', 'thread-test10b', NOW(), 'New booking A90000011: Test Tour', 'body', 'cancelled_or_whatever',
    v_source_id, '90000011', v_tour_id, 'İtalyanca', CURRENT_DATE + 30, '09:00', 2, 0,
    3600, 'TL', 4800, 'TL', NULL, 'Test Contact Eleven', NULL, NULL, '[]'::jsonb
  );
  IF r2->>'result' <> 'manual_review_required' THEN
    RAISE EXCEPTION 'TEST 10: FAILED — bogus event_type expected manual_review_required, got %', r2->>'result';
  END IF;

  IF EXISTS (SELECT 1 FROM public.reservations WHERE source_id=v_source_id AND external_booking_id IN ('90000010','90000011')) THEN
    RAISE EXCEPTION 'TEST 10: FAILED — a reservation was written despite an invalid event_type';
  END IF;
  IF EXISTS (SELECT 1 FROM public.customers WHERE full_name IN ('Test Contact Ten','Test Contact Eleven')) THEN
    RAISE EXCEPTION 'TEST 10: FAILED — a customer was written despite an invalid event_type';
  END IF;

  -- Each still gets its own permanent, honest audit row (event_type
  -- recorded as 'unknown' since neither was a valid label):
  IF (SELECT processing_status FROM public.email_ingestions WHERE gmail_message_id='gmail-test10-null') <> 'needs_review' THEN
    RAISE EXCEPTION 'TEST 10: FAILED — expected needs_review audit status for NULL event_type';
  END IF;
  IF (SELECT event_type FROM public.email_ingestions WHERE gmail_message_id='gmail-test10-bogus') <> 'unknown' THEN
    RAISE EXCEPTION 'TEST 10: FAILED — a bogus event_type should be recorded as unknown in the audit row, never accepted verbatim';
  END IF;

  RAISE NOTICE 'TEST 10: PASSED';
END $$;
ROLLBACK;


-- ══════════════════════════════════════════════════════════════════════════
-- TEST 11 — a 'modified' event with NO existing reservation is never
-- silently treated as a new booking (V3 item "modified-first event creates
-- no reservation")
-- ══════════════════════════════════════════════════════════════════════════
BEGIN;
DO $$
DECLARE
  v_source_id UUID; v_tour_id UUID;
  r1 JSONB;
BEGIN
  SELECT id INTO v_source_id FROM public.sources WHERE slug ILIKE 'civitatis%' LIMIT 1;
  INSERT INTO public.tours (name, is_active) VALUES ('TEST11 Tour', TRUE) RETURNING id INTO v_tour_id;

  r1 := public.ingest_civitatis_booking(
    'gmail-test11-mod-only', 'thread-test11', NOW(), 'Booking A90000012 modified: Test Tour', 'body', 'modified',
    v_source_id, '90000012', v_tour_id, 'İtalyanca', CURRENT_DATE + 30, '09:00', 2, 0,
    3600, 'TL', 4800, 'TL', NULL, 'Test Contact Twelve', NULL, NULL,
    '[{"fullName":"SHOULD NOT PERSIST","sortOrder":0}]'::jsonb
  );

  IF r1->>'result' <> 'manual_review_required' THEN
    RAISE EXCEPTION 'TEST 11: FAILED — modified-first with no existing reservation expected manual_review_required, got %', r1->>'result';
  END IF;
  IF EXISTS (SELECT 1 FROM public.reservations WHERE source_id=v_source_id AND external_booking_id='90000012') THEN
    RAISE EXCEPTION 'TEST 11: FAILED — a reservation was created from a modified-only event chain';
  END IF;
  IF EXISTS (SELECT 1 FROM public.customers WHERE full_name = 'Test Contact Twelve') THEN
    RAISE EXCEPTION 'TEST 11: FAILED — a customer was created from a modified-only event chain';
  END IF;
  IF EXISTS (SELECT 1 FROM public.reservation_guests WHERE full_name = 'SHOULD NOT PERSIST') THEN
    RAISE EXCEPTION 'TEST 11: FAILED — a passenger row was created from a modified-only event chain';
  END IF;

  RAISE NOTICE 'TEST 11: PASSED';
END $$;
ROLLBACK;


-- ══════════════════════════════════════════════════════════════════════════
-- TEST 12 — a modification NEVER creates a second customer and NEVER
-- changes reservation.customer_id, even when p_customer_id differs or is
-- NULL, even when the modification carries new contact info (V3 items
-- "modification never creates a second customer", "modification never
-- changes reservation.customer_id", "modification contact data does not
-- mutate customer")
-- ══════════════════════════════════════════════════════════════════════════
BEGIN;
DO $$
DECLARE
  v_source_id UUID; v_tour_id UUID;
  r1 JSONB; r2 JSONB;
  v_cust_count_before INT; v_cust_count_after INT;
  v_original_customer RECORD;
BEGIN
  SELECT id INTO v_source_id FROM public.sources WHERE slug ILIKE 'civitatis%' LIMIT 1;
  INSERT INTO public.tours (name, is_active) VALUES ('TEST12 Tour', TRUE) RETURNING id INTO v_tour_id;

  r1 := public.ingest_civitatis_booking(
    'gmail-test12-new', 'thread-test12', NOW() - INTERVAL '1 day', 'New booking A90000013: Test Tour', 'body', 'new_booking',
    v_source_id, '90000013', v_tour_id, 'İtalyanca', CURRENT_DATE + 30, '09:00', 2, 0,
    3600, 'TL', 4800, 'TL', NULL, 'Original Contact Thirteen', NULL, NULL, '[]'::jsonb
  );
  SELECT * INTO v_original_customer FROM public.customers WHERE id = (r1->>'customer_id')::uuid;
  SELECT COUNT(*) INTO v_cust_count_before FROM public.customers;

  -- Modification: p_customer_id is NULL (this event's own matching found
  -- nothing) and it carries a phone number that appears for the first
  -- time — a real Civitatis pattern (phone only shown on the
  -- modification email). Also pass an explicit but DIFFERENT customer_id
  -- to prove it is never used to redirect the reservation either.
  r2 := public.ingest_civitatis_booking(
    'gmail-test12-mod', 'thread-test12', NOW(), 'Booking A90000013 modified: Test Tour', 'body', 'modified',
    v_source_id, '90000013', v_tour_id, 'İtalyanca', CURRENT_DATE + 30, '09:00', 2, 0,
    3600, 'TL', 4800, 'TL', NULL, 'A Totally Different Name', '999@example.com', '5559998888', '[]'::jsonb
  );

  IF r2->>'result' <> 'updated' THEN RAISE EXCEPTION 'TEST 12: FAILED — expected updated, got %', r2->>'result'; END IF;
  IF (r2->>'customer_id')::uuid <> v_original_customer.id THEN
    RAISE EXCEPTION 'TEST 12: FAILED — reservation.customer_id changed on a modification';
  END IF;

  SELECT COUNT(*) INTO v_cust_count_after FROM public.customers;
  IF v_cust_count_after <> v_cust_count_before THEN
    RAISE EXCEPTION 'TEST 12: FAILED — a modification created a second customer (before=%, after=%)', v_cust_count_before, v_cust_count_after;
  END IF;

  -- The original customer's own profile fields must be untouched — a
  -- modification's contact info is NOT applied to the existing customer:
  IF (SELECT phone FROM public.customers WHERE id = v_original_customer.id) IS DISTINCT FROM v_original_customer.phone THEN
    RAISE EXCEPTION 'TEST 12: FAILED — the existing customer''s phone was mutated by a modification email';
  END IF;
  IF (SELECT email FROM public.customers WHERE id = v_original_customer.id) IS DISTINCT FROM v_original_customer.email THEN
    RAISE EXCEPTION 'TEST 12: FAILED — the existing customer''s email was mutated by a modification email';
  END IF;
  IF (SELECT full_name FROM public.customers WHERE id = v_original_customer.id) <> 'Original Contact Thirteen' THEN
    RAISE EXCEPTION 'TEST 12: FAILED — the existing customer''s full_name was mutated by a modification email';
  END IF;
  IF EXISTS (SELECT 1 FROM public.customers WHERE full_name = 'A Totally Different Name') THEN
    RAISE EXCEPTION 'TEST 12: FAILED — the modification''s contact name leaked into a new customer row';
  END IF;

  RAISE NOTICE 'TEST 12: PASSED';
END $$;
ROLLBACK;


-- ══════════════════════════════════════════════════════════════════════════
-- TEST 13 — missing financial data (total_amount/currency/retail_amount/
-- retail_currency) never defaults to 0/EUR; missing check_in/check_in_time/
-- tour_language/pax_adult are equally rejected (V3 item "missing financial
-- data does not default to 0/EUR")
-- ══════════════════════════════════════════════════════════════════════════
BEGIN;
DO $$
DECLARE
  v_source_id UUID; v_tour_id UUID;
  r JSONB;
BEGIN
  SELECT id INTO v_source_id FROM public.sources WHERE slug ILIKE 'civitatis%' LIMIT 1;
  INSERT INTO public.tours (name, is_active) VALUES ('TEST13 Tour', TRUE) RETURNING id INTO v_tour_id;

  -- Missing total_amount (Civitatis Net price):
  r := public.ingest_civitatis_booking(
    'gmail-test13-a', 'thread-test13a', NOW(), 'New booking A90000014: Test Tour', 'body', 'new_booking',
    v_source_id, '90000014', v_tour_id, 'İtalyanca', CURRENT_DATE + 30, '09:00', 2, 0,
    NULL, 'TL', 4800, 'TL', NULL, 'Test Contact Fourteen', NULL, NULL, '[]'::jsonb
  );
  IF r->>'result' <> 'manual_review_required' THEN RAISE EXCEPTION 'TEST 13a: FAILED — missing total_amount should be manual_review_required, got %', r->>'result'; END IF;
  IF NOT (r->'missing_fields' @> '["total_amount (Civitatis Net price)"]'::jsonb) THEN
    RAISE EXCEPTION 'TEST 13a: FAILED — missing_fields did not name total_amount';
  END IF;

  -- Missing currency:
  r := public.ingest_civitatis_booking(
    'gmail-test13-b', 'thread-test13b', NOW(), 'New booking A90000015: Test Tour', 'body', 'new_booking',
    v_source_id, '90000015', v_tour_id, 'İtalyanca', CURRENT_DATE + 30, '09:00', 2, 0,
    3600, NULL, 4800, 'TL', NULL, 'Test Contact Fifteen', NULL, NULL, '[]'::jsonb
  );
  IF r->>'result' <> 'manual_review_required' THEN RAISE EXCEPTION 'TEST 13b: FAILED — missing currency should be manual_review_required, got %', r->>'result'; END IF;

  -- Missing retail_amount:
  r := public.ingest_civitatis_booking(
    'gmail-test13-c', 'thread-test13c', NOW(), 'New booking A90000016: Test Tour', 'body', 'new_booking',
    v_source_id, '90000016', v_tour_id, 'İtalyanca', CURRENT_DATE + 30, '09:00', 2, 0,
    3600, 'TL', NULL, 'TL', NULL, 'Test Contact Sixteen', NULL, NULL, '[]'::jsonb
  );
  IF r->>'result' <> 'manual_review_required' THEN RAISE EXCEPTION 'TEST 13c: FAILED — missing retail_amount should be manual_review_required, got %', r->>'result'; END IF;

  -- Missing pax_adult:
  r := public.ingest_civitatis_booking(
    'gmail-test13-d', 'thread-test13d', NOW(), 'New booking A90000017: Test Tour', 'body', 'new_booking',
    v_source_id, '90000017', v_tour_id, 'İtalyanca', CURRENT_DATE + 30, '09:00', NULL, 0,
    3600, 'TL', 4800, 'TL', NULL, 'Test Contact Seventeen', NULL, NULL, '[]'::jsonb
  );
  IF r->>'result' <> 'manual_review_required' THEN RAISE EXCEPTION 'TEST 13d: FAILED — missing pax_adult should be manual_review_required, got %', r->>'result'; END IF;

  -- Missing tour_language:
  r := public.ingest_civitatis_booking(
    'gmail-test13-e', 'thread-test13e', NOW(), 'New booking A90000018: Test Tour', 'body', 'new_booking',
    v_source_id, '90000018', v_tour_id, NULL, CURRENT_DATE + 30, '09:00', 2, 0,
    3600, 'TL', 4800, 'TL', NULL, 'Test Contact Eighteen', NULL, NULL, '[]'::jsonb
  );
  IF r->>'result' <> 'manual_review_required' THEN RAISE EXCEPTION 'TEST 13e: FAILED — missing tour_language should be manual_review_required, got %', r->>'result'; END IF;

  -- Confirm NONE of the above five wrote a reservation with a fabricated
  -- default (0, 'EUR', 1, etc.) — no reservation should exist at all:
  IF EXISTS (
    SELECT 1 FROM public.reservations
     WHERE source_id = v_source_id
       AND external_booking_id IN ('90000014','90000015','90000016','90000017','90000018')
  ) THEN
    RAISE EXCEPTION 'TEST 13: FAILED — a reservation was written with fabricated/default values despite missing required data';
  END IF;

  -- pax_child, by contrast, legitimately defaults to 0 (parser contract,
  -- not fabrication) and must NOT block a write on its own:
  r := public.ingest_civitatis_booking(
    'gmail-test13-f', 'thread-test13f', NOW(), 'New booking A90000019: Test Tour', 'body', 'new_booking',
    v_source_id, '90000019', v_tour_id, 'İtalyanca', CURRENT_DATE + 30, '09:00', 2, NULL,
    3600, 'TL', 4800, 'TL', NULL, 'Test Contact Nineteen', NULL, NULL, '[]'::jsonb
  );
  IF r->>'result' <> 'created' THEN RAISE EXCEPTION 'TEST 13f: FAILED — a NULL pax_child should NOT block a write (should default to 0), got %', r->>'result'; END IF;
  IF (SELECT pax_child FROM public.reservations WHERE id = (r->>'reservation_id')::uuid) <> 0 THEN
    RAISE EXCEPTION 'TEST 13f: FAILED — NULL pax_child should have been written as 0';
  END IF;

  RAISE NOTICE 'TEST 13: PASSED';
END $$;
ROLLBACK;


-- ══════════════════════════════════════════════════════════════════════════
-- TEST 14 — a modification with a missing/empty passenger payload NEVER
-- erases a valid existing passenger list (V3 item "missing passenger
-- payload cannot erase existing guests")
-- ══════════════════════════════════════════════════════════════════════════
BEGIN;
DO $$
DECLARE
  v_source_id UUID; v_tour_id UUID;
  r1 JSONB; r2 JSONB; r3 JSONB;
  v_guest_count INT;
BEGIN
  SELECT id INTO v_source_id FROM public.sources WHERE slug ILIKE 'civitatis%' LIMIT 1;
  INSERT INTO public.tours (name, is_active) VALUES ('TEST14 Tour', TRUE) RETURNING id INTO v_tour_id;

  r1 := public.ingest_civitatis_booking(
    'gmail-test14-new', 'thread-test14', NOW() - INTERVAL '1 day', 'New booking A90000020: Test Tour', 'body', 'new_booking',
    v_source_id, '90000020', v_tour_id, 'İtalyanca', CURRENT_DATE + 30, '09:00', 2, 0,
    3600, 'TL', 4800, 'TL', NULL, 'Test Contact Twenty', NULL, NULL,
    '[{"fullName":"REAL GUEST A","sortOrder":0},{"fullName":"REAL GUEST B","sortOrder":1}]'::jsonb
  );
  IF r1->>'result' <> 'created' THEN RAISE EXCEPTION 'TEST 14: FAILED — setup create failed'; END IF;

  -- Modification with a genuinely EMPTY passengers array:
  r2 := public.ingest_civitatis_booking(
    'gmail-test14-mod-empty', 'thread-test14', NOW(), 'Booking A90000020 modified: Test Tour', 'body', 'modified',
    v_source_id, '90000020', v_tour_id, 'İtalyanca', CURRENT_DATE + 31, '10:00', 2, 0,
    3600, 'TL', 4800, 'TL', NULL, 'Test Contact Twenty', NULL, NULL, '[]'::jsonb
  );
  IF r2->>'result' <> 'updated' THEN RAISE EXCEPTION 'TEST 14: FAILED — expected updated for the empty-passengers modification, got %', r2->>'result'; END IF;
  IF (r2->>'passengers_replaced')::boolean IS DISTINCT FROM FALSE THEN
    RAISE EXCEPTION 'TEST 14: FAILED — passengers_replaced should be false for an empty passenger payload';
  END IF;

  SELECT COUNT(*) INTO v_guest_count FROM public.reservation_guests WHERE reservation_id = (r1->>'reservation_id')::uuid;
  IF v_guest_count <> 2 THEN
    RAISE EXCEPTION 'TEST 14: FAILED — the real passenger list was erased by an empty-passengers modification (found % rows)', v_guest_count;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.reservation_guests WHERE reservation_id = (r1->>'reservation_id')::uuid AND full_name = 'REAL GUEST A') THEN
    RAISE EXCEPTION 'TEST 14: FAILED — REAL GUEST A is missing after an empty-passengers modification';
  END IF;

  -- Modification with NULL passengers entirely:
  r3 := public.ingest_civitatis_booking(
    'gmail-test14-mod-null', 'thread-test14', NOW() + INTERVAL '1 hour', 'Booking A90000020 modified: Test Tour', 'body', 'modified',
    v_source_id, '90000020', v_tour_id, 'İtalyanca', CURRENT_DATE + 32, '11:00', 2, 0,
    3600, 'TL', 4800, 'TL', NULL, 'Test Contact Twenty', NULL, NULL, NULL
  );
  IF r3->>'result' <> 'updated' THEN RAISE EXCEPTION 'TEST 14: FAILED — expected updated for the NULL-passengers modification, got %', r3->>'result'; END IF;

  SELECT COUNT(*) INTO v_guest_count FROM public.reservation_guests WHERE reservation_id = (r1->>'reservation_id')::uuid;
  IF v_guest_count <> 2 THEN
    RAISE EXCEPTION 'TEST 14: FAILED — the real passenger list was erased by a NULL-passengers modification (found % rows)', v_guest_count;
  END IF;

  -- A modification WITH a real (non-empty) passenger list still replaces
  -- correctly (confirms the guard doesn't over-protect):
  PERFORM public.ingest_civitatis_booking(
    'gmail-test14-mod-real', 'thread-test14', NOW() + INTERVAL '2 hours', 'Booking A90000020 modified: Test Tour', 'body', 'modified',
    v_source_id, '90000020', v_tour_id, 'İtalyanca', CURRENT_DATE + 33, '12:00', 3, 0,
    3600, 'TL', 4800, 'TL', NULL, 'Test Contact Twenty', NULL, NULL,
    '[{"fullName":"REPLACED GUEST","sortOrder":0}]'::jsonb
  );
  SELECT COUNT(*) INTO v_guest_count FROM public.reservation_guests WHERE reservation_id = (r1->>'reservation_id')::uuid;
  IF v_guest_count <> 1 THEN
    RAISE EXCEPTION 'TEST 14: FAILED — a modification WITH real passengers should still replace the list (found % rows, expected 1)', v_guest_count;
  END IF;

  RAISE NOTICE 'TEST 14: PASSED';
END $$;
ROLLBACK;


-- ══════════════════════════════════════════════════════════════════════════
-- TEST 15 — concurrent duplicate attempts remain idempotent under real
-- concurrency (test plan item #21, concurrency half; also covers "same-
-- booking concurrency remains intact" for V3's restructured control flow).
-- THIS TEST CANNOT RUN INSIDE A SINGLE SQL SCRIPT/SESSION — advisory locks
-- and true concurrent transactions require two separate database sessions
-- racing each other. Documented here as an exact manual procedure instead:
--
--   1. Open two separate `psql` (or two Supabase SQL editor tabs) sessions
--      against the same staging database.
--   2. In session A, run:
--        BEGIN;
--        SELECT public.ingest_civitatis_booking(
--          'gmail-test15-a', 'thread-test15', NOW(),
--          'New booking A90000021: Test Tour', 'body', 'new_booking',
--          '<a real civitatis source_id>', '90000021', '<a real tour_id>',
--          'İtalyanca', CURRENT_DATE + 30, '09:00', 2, 0, 3600, 'TL', 4800, 'TL',
--          NULL, 'Concurrent Test Contact', NULL, NULL, '[]'::jsonb
--        );
--      but do NOT COMMIT yet — leave the transaction open.
--   3. In session B, run the SAME call with a DIFFERENT gmail_message_id
--      ('gmail-test15-b') but the SAME external_booking_id ('90000021').
--      Session B should BLOCK (visibly hang) at the
--      pg_advisory_xact_lock call inside the function (V3: still the
--      first statement inside the nested transactional block, executed
--      before the reservation lookup) — this in itself confirms the lock
--      is serializing the two sessions.
--   4. COMMIT session A. Session B should then unblock, see the
--      reservation A already created, and return result: "updated" (or
--      "created" only if it somehow ran first — either way, never a
--      SECOND reservation, and never a second customer either — see
--      TEST 12's single-session confirmation of the same customer-
--      identity guarantee this restructuring exists to provide).
--   5. Verify: SELECT COUNT(*) FROM reservations WHERE external_booking_id
--      = '90000021'; must be exactly 1. SELECT COUNT(*) FROM customers
--      WHERE full_name = 'Concurrent Test Contact'; must be exactly 1.
--   6. Clean up: DELETE the test rows created (reservations cascades to
--      reservation_guests; delete the customers/email_ingestions/
--      activity_logs rows manually, or run inside a wrapping transaction
--      you roll back instead of committing in step 4, then repeat the
--      procedure understanding the final commit is what step 4 needs).
-- ══════════════════════════════════════════════════════════════════════════


-- ══════════════════════════════════════════════════════════════════════════
-- TEST 16 — a SECOND, genuinely distinct 'new_booking' Gmail message for a
-- booking that ALREADY has a reservation is never treated as a
-- modification: result:"booking_already_exists", with the exact same
-- zero-business-state-side-effects guarantee as a stale event (V4 items
-- "new_booking + no reservation => created", "new_booking + existing
-- reservation => booking_already_exists and zero business-state changes",
-- "second new_booking with different gmail_message_id cannot modify
-- reservation fields", "second new_booking cannot replace passengers",
-- "second new_booking cannot create another customer", "second new_booking
-- cannot create another activity notification")
-- ══════════════════════════════════════════════════════════════════════════
BEGIN;
DO $$
DECLARE
  v_source_id UUID; v_tour_id UUID;
  r1 JSONB; r2 JSONB;
  v_res RECORD;
  v_cust_count_before INT; v_cust_count_after INT;
  v_guest_count_before INT; v_guest_count_after INT;
  v_activity_count_before INT; v_activity_count_after INT;
BEGIN
  SELECT id INTO v_source_id FROM public.sources WHERE slug ILIKE 'civitatis%' LIMIT 1;
  INSERT INTO public.tours (name, is_active) VALUES ('TEST16 Tour', TRUE) RETURNING id INTO v_tour_id;

  -- 1. new_booking + no reservation => created.
  r1 := public.ingest_civitatis_booking(
    'gmail-test16-new-1', 'thread-test16', NOW() - INTERVAL '1 day', 'New booking A90000022: Test Tour', 'body', 'new_booking',
    v_source_id, '90000022', v_tour_id, 'İtalyanca', CURRENT_DATE + 30, '09:00', 2, 0,
    3600, 'TL', 4800, 'TL', NULL, 'Test Contact TwentyTwo', NULL, NULL,
    '[{"fullName":"ORIGINAL PASSENGER","sortOrder":0}]'::jsonb
  );
  IF r1->>'result' <> 'created' THEN RAISE EXCEPTION 'TEST 16: FAILED — first new_booking with no existing reservation should create, got %', r1->>'result'; END IF;

  SELECT COUNT(*) INTO v_cust_count_before FROM public.customers;
  SELECT COUNT(*) INTO v_guest_count_before FROM public.reservation_guests WHERE reservation_id = (r1->>'reservation_id')::uuid;
  SELECT COUNT(*) INTO v_activity_count_before FROM public.activity_logs WHERE entity_type='reservation' AND entity_id=(r1->>'reservation_id')::uuid;

  -- 2. A SECOND, genuinely distinct Gmail message, ALSO classified by
  -- Civitatis as "New booking A########:" (not a modification), for the
  -- SAME external_booking_id — carries DIFFERENT (would-be-wrong-if-
  -- applied) field values, a different contact name, and a different
  -- passenger, all of which must never be applied.
  r2 := public.ingest_civitatis_booking(
    'gmail-test16-new-2', 'thread-test16', NOW(), 'New booking A90000022: Test Tour', 'body', 'new_booking',
    v_source_id, '90000022', v_tour_id, 'Español', CURRENT_DATE + 99, '18:00', 9, 3,
    9999, 'EUR', 8888, 'EUR', NULL, 'A DIFFERENT NAME FROM THE SECOND MESSAGE', NULL, NULL,
    '[{"fullName":"SHOULD NOT APPEAR","sortOrder":0}]'::jsonb
  );

  -- new_booking + existing reservation => booking_already_exists.
  IF r2->>'result' <> 'booking_already_exists' THEN
    RAISE EXCEPTION 'TEST 16: FAILED — a second new_booking for an already-existing reservation expected result=booking_already_exists, got %', r2->>'result';
  END IF;
  IF (r2->>'reservation_id')::uuid <> (r1->>'reservation_id')::uuid THEN
    RAISE EXCEPTION 'TEST 16: FAILED — booking_already_exists result did not resolve to the correct existing reservation';
  END IF;

  -- Second new_booking cannot modify reservation fields:
  SELECT * INTO v_res FROM public.reservations WHERE id = (r1->>'reservation_id')::uuid;
  IF v_res.check_in <> CURRENT_DATE + 30 THEN
    RAISE EXCEPTION 'TEST 16: FAILED — the second new_booking event changed check_in';
  END IF;
  IF v_res.pax_adult <> 2 THEN
    RAISE EXCEPTION 'TEST 16: FAILED — the second new_booking event changed pax_adult';
  END IF;
  IF v_res.total_amount <> 3600 THEN
    RAISE EXCEPTION 'TEST 16: FAILED — the second new_booking event changed total_amount';
  END IF;
  IF v_res.tour_language <> 'İtalyanca' THEN
    RAISE EXCEPTION 'TEST 16: FAILED — the second new_booking event changed tour_language';
  END IF;

  -- Second new_booking cannot replace passengers:
  SELECT COUNT(*) INTO v_guest_count_after FROM public.reservation_guests WHERE reservation_id = v_res.id;
  IF v_guest_count_after <> v_guest_count_before THEN
    RAISE EXCEPTION 'TEST 16: FAILED — the second new_booking event changed the passenger count (before=%, after=%)', v_guest_count_before, v_guest_count_after;
  END IF;
  IF EXISTS (SELECT 1 FROM public.reservation_guests WHERE reservation_id = v_res.id AND full_name = 'SHOULD NOT APPEAR') THEN
    RAISE EXCEPTION 'TEST 16: FAILED — the second new_booking event''s passenger payload was applied';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.reservation_guests WHERE reservation_id = v_res.id AND full_name = 'ORIGINAL PASSENGER') THEN
    RAISE EXCEPTION 'TEST 16: FAILED — the original passenger list was lost';
  END IF;

  -- Second new_booking cannot create another customer:
  SELECT COUNT(*) INTO v_cust_count_after FROM public.customers;
  IF v_cust_count_after <> v_cust_count_before THEN
    RAISE EXCEPTION 'TEST 16: FAILED — the second new_booking event created a customer row (before=%, after=%)', v_cust_count_before, v_cust_count_after;
  END IF;
  IF EXISTS (SELECT 1 FROM public.customers WHERE full_name = 'A DIFFERENT NAME FROM THE SECOND MESSAGE') THEN
    RAISE EXCEPTION 'TEST 16: FAILED — the second new_booking event''s contact name leaked into a new customer row';
  END IF;
  IF v_res.customer_id::text <> (r1->>'customer_id') THEN
    RAISE EXCEPTION 'TEST 16: FAILED — reservation.customer_id changed as a result of the second new_booking event';
  END IF;

  -- Second new_booking cannot create another activity notification:
  SELECT COUNT(*) INTO v_activity_count_after FROM public.activity_logs WHERE entity_type='reservation' AND entity_id=v_res.id;
  IF v_activity_count_after <> v_activity_count_before THEN
    RAISE EXCEPTION 'TEST 16: FAILED — the second new_booking event created another activity row (before=%, after=%)', v_activity_count_before, v_activity_count_after;
  END IF;
  IF v_activity_count_after <> 1 THEN
    RAISE EXCEPTION 'TEST 16: FAILED — expected exactly 1 activity row total, found %', v_activity_count_after;
  END IF;

  -- Both Gmail messages still each have their own permanent audit row,
  -- and the second one is 'processed' (understood correctly, not a
  -- failure) and correctly linked to the existing reservation:
  IF (SELECT COUNT(*) FROM public.email_ingestions WHERE source_id=v_source_id AND external_booking_id='90000022') <> 2 THEN
    RAISE EXCEPTION 'TEST 16: FAILED — expected 2 separate email_ingestions rows';
  END IF;
  IF (SELECT processing_status FROM public.email_ingestions WHERE gmail_message_id='gmail-test16-new-2') <> 'processed' THEN
    RAISE EXCEPTION 'TEST 16: FAILED — the second new_booking event''s own email_ingestions row should be processing_status=processed';
  END IF;
  IF (SELECT reservation_id FROM public.email_ingestions WHERE gmail_message_id='gmail-test16-new-2') <> v_res.id THEN
    RAISE EXCEPTION 'TEST 16: FAILED — the second new_booking event''s email_ingestions row should be linked to the existing reservation';
  END IF;

  RAISE NOTICE 'TEST 16: PASSED';
END $$;
ROLLBACK;


-- ══════════════════════════════════════════════════════════════════════════
-- V5 — RETRY STATE MACHINE FOR A PREVIOUSLY 'failed' GMAIL MESSAGE
-- ══════════════════════════════════════════════════════════════════════════
-- TESTS 17-21 below prove the V5 revision: 'processed'/'received'/
-- 'needs_review' never automatically retry; a genuinely 'failed' row is
-- atomically reclaimed under the SAME email_ingestions row/id and
-- reprocessed exactly like a fresh attempt, with no duplicate business
-- state and no possibility of two concurrent retries both writing.
-- TESTS 1-16 above are UNCHANGED and still pass unmodified against V5
-- (the event/reservation-state matrix — Step 6 — was not touched), which
-- is itself the proof for state-machine item #12 ("all V4 event-matrix
-- behavior remains unchanged").


-- ══════════════════════════════════════════════════════════════════════════
-- TEST 17 — a 'processed' Gmail message is NEVER retried, even when
-- re-invoked with entirely different (would-be-wrong-if-applied) business
-- data; a 'needs_review' Gmail message is NEVER automatically retried,
-- even when re-invoked with data that would now be perfectly valid
-- (V5 state-machine items #1 and #2)
-- ══════════════════════════════════════════════════════════════════════════
BEGIN;
DO $$
DECLARE
  v_source_id UUID; v_tour_id UUID;
  r1 JSONB; r2 JSONB; r3 JSONB; r4 JSONB;
  v_res RECORD;
BEGIN
  SELECT id INTO v_source_id FROM public.sources WHERE slug ILIKE 'civitatis%' LIMIT 1;
  INSERT INTO public.tours (name, is_active) VALUES ('TEST17 Tour', TRUE) RETURNING id INTO v_tour_id;

  -- Part A: 'processed' never retries -----------------------------------
  r1 := public.ingest_civitatis_booking(
    'gmail-test17-processed', 'thread-test17a', NOW(), 'New booking A90000023: Test Tour', 'body', 'new_booking',
    v_source_id, '90000023', v_tour_id, 'İtalyanca', CURRENT_DATE + 30, '09:00', 2, 0,
    3600, 'TL', 4800, 'TL', NULL, 'Test Contact TwentyThree', NULL, NULL, '[]'::jsonb
  );
  IF r1->>'result' <> 'created' THEN RAISE EXCEPTION 'TEST 17a: FAILED — setup create failed, got %', r1->>'result'; END IF;

  -- Re-invoke the SAME gmail_message_id with entirely different (would be
  -- wrong if applied) business data — a real retry from the application
  -- layer never does this (it resends the SAME parsed email), but using
  -- different values here proves conclusively that NOTHING was
  -- reprocessed, not merely that the numbers happened to match already.
  r2 := public.ingest_civitatis_booking(
    'gmail-test17-processed', 'thread-test17a-DIFFERENT', NOW(), 'New booking A90000023: Test Tour', 'body', 'new_booking',
    v_source_id, '90000023', v_tour_id, 'Español', CURRENT_DATE + 99, '18:00', 9, 3,
    9999, 'EUR', 8888, 'EUR', NULL, 'A DIFFERENT NAME', NULL, NULL, '[]'::jsonb
  );
  IF r2->>'result' <> 'already_processed' THEN
    RAISE EXCEPTION 'TEST 17a: FAILED — retrying a processed message expected already_processed, got %', r2->>'result';
  END IF;
  IF r2->>'processing_status' <> 'processed' THEN
    RAISE EXCEPTION 'TEST 17a: FAILED — expected processing_status=processed in the already_processed payload, got %', r2->>'processing_status';
  END IF;

  SELECT * INTO v_res FROM public.reservations WHERE id = (r1->>'reservation_id')::uuid;
  IF v_res.check_in <> CURRENT_DATE + 30 OR v_res.pax_adult <> 2 THEN
    RAISE EXCEPTION 'TEST 17a: FAILED — a processed message was silently reprocessed with new field values';
  END IF;
  IF EXISTS (SELECT 1 FROM public.customers WHERE full_name = 'A DIFFERENT NAME') THEN
    RAISE EXCEPTION 'TEST 17a: FAILED — a processed message''s retry created a stray customer';
  END IF;
  IF (SELECT COUNT(*) FROM public.reservations WHERE source_id=v_source_id AND external_booking_id='90000023') <> 1 THEN
    RAISE EXCEPTION 'TEST 17a: FAILED — a processed message''s retry created a second reservation';
  END IF;

  -- Part B: 'needs_review' is NEVER automatically retried, even with
  -- now-fully-valid data --------------------------------------------------
  r3 := public.ingest_civitatis_booking(
    'gmail-test17-needsreview', 'thread-test17b', NOW(), 'New booking A90000024: Test Tour', 'body', 'new_booking',
    v_source_id,
    '90000024',
    NULL, -- no matched tour_id -> needs_review, exactly like TEST 5
    'İtalyanca', CURRENT_DATE + 30, '09:00', 2, 0, 3600, 'TL', 4800, 'TL',
    NULL, 'Test Contact TwentyFour', NULL, NULL, '[]'::jsonb
  );
  IF r3->>'result' <> 'manual_review_required' THEN
    RAISE EXCEPTION 'TEST 17b: FAILED — setup expected manual_review_required, got %', r3->>'result';
  END IF;
  IF (SELECT processing_status FROM public.email_ingestions WHERE gmail_message_id='gmail-test17-needsreview') <> 'needs_review' THEN
    RAISE EXCEPTION 'TEST 17b: FAILED — expected the audit row itself to be processing_status=needs_review';
  END IF;

  -- Re-invoke the SAME gmail_message_id — this time with a genuinely
  -- valid tour_id and otherwise fully valid data, simulating "the tour
  -- channel mapping was fixed later and the scheduler saw this Gmail
  -- message again." It must STILL be blocked automatically.
  r4 := public.ingest_civitatis_booking(
    'gmail-test17-needsreview', 'thread-test17b', NOW(), 'New booking A90000024: Test Tour', 'body', 'new_booking',
    v_source_id, '90000024', v_tour_id, -- now valid
    'İtalyanca', CURRENT_DATE + 30, '09:00', 2, 0, 3600, 'TL', 4800, 'TL',
    NULL, 'Test Contact TwentyFour', NULL, NULL, '[]'::jsonb
  );
  IF r4->>'result' <> 'already_processed' THEN
    RAISE EXCEPTION 'TEST 17b: FAILED — retrying a needs_review message with now-valid data expected already_processed, got %', r4->>'result';
  END IF;
  IF r4->>'processing_status' <> 'needs_review' THEN
    RAISE EXCEPTION 'TEST 17b: FAILED — expected processing_status=needs_review in the already_processed payload (must never silently flip to processed), got %', r4->>'processing_status';
  END IF;
  IF EXISTS (SELECT 1 FROM public.reservations WHERE source_id=v_source_id AND external_booking_id='90000024') THEN
    RAISE EXCEPTION 'TEST 17b: FAILED — a needs_review message was automatically retried and wrote a reservation despite now-valid data';
  END IF;
  IF EXISTS (SELECT 1 FROM public.customers WHERE full_name = 'Test Contact TwentyFour') THEN
    RAISE EXCEPTION 'TEST 17b: FAILED — a needs_review message was automatically retried and wrote a customer despite now-valid data';
  END IF;

  RAISE NOTICE 'TEST 17: PASSED';
END $$;
ROLLBACK;


-- ══════════════════════════════════════════════════════════════════════════
-- TEST 18 — a 'received' Gmail message is never given a second
-- concurrent/automatic processing attempt (V5 state-machine item #3).
-- Under this function's single-transaction design, processing_status=
-- 'received' can never actually persist past a COMMIT in normal operation
-- (every code path finalizes the row to processed/needs_review/failed
-- before returning — see the migration header) — a row can only ever be
-- OBSERVED as 'received' by another session WHILE a call is still
-- in-flight, at which point that other session simply blocks on the row
-- lock (see TEST 21) rather than reading a stale 'received' value at all.
-- To still directly exercise the defensive code path itself (belt and
-- suspenders — e.g. protecting against any future change that might let
-- 'received' persist, or an operator/tooling row edit), this test
-- manually forces a row into 'received' via a raw UPDATE, simulating an
-- abnormally stuck/crashed attempt, and confirms the RPC still refuses to
-- touch it.
-- ══════════════════════════════════════════════════════════════════════════
BEGIN;
DO $$
DECLARE
  v_source_id UUID; v_tour_id UUID;
  r1 JSONB; r2 JSONB;
BEGIN
  SELECT id INTO v_source_id FROM public.sources WHERE slug ILIKE 'civitatis%' LIMIT 1;
  INSERT INTO public.tours (name, is_active) VALUES ('TEST18 Tour', TRUE) RETURNING id INTO v_tour_id;

  r1 := public.ingest_civitatis_booking(
    'gmail-test18-received', 'thread-test18', NOW(), 'New booking A90000025: Test Tour', 'body', 'new_booking',
    v_source_id, '90000025', v_tour_id, 'İtalyanca', CURRENT_DATE + 30, '09:00', 2, 0,
    3600, 'TL', 4800, 'TL', NULL, 'Test Contact TwentyFive', NULL, NULL, '[]'::jsonb
  );
  IF r1->>'result' <> 'created' THEN RAISE EXCEPTION 'TEST 18: FAILED — setup create failed, got %', r1->>'result'; END IF;

  -- Manually force the row back to 'received', simulating an
  -- abnormally-stuck/crashed attempt (never produced by the function
  -- itself in normal operation — see comment above).
  UPDATE public.email_ingestions
     SET processing_status = 'received', error_reason = NULL, processed_at = NULL
   WHERE gmail_message_id = 'gmail-test18-received';

  r2 := public.ingest_civitatis_booking(
    'gmail-test18-received', 'thread-test18-DIFFERENT', NOW(), 'New booking A90000025: Test Tour', 'body', 'new_booking',
    v_source_id, '90000025', v_tour_id, 'Español', CURRENT_DATE + 99, '18:00', 9, 3,
    9999, 'EUR', 8888, 'EUR', NULL, 'SHOULD NOT BE CREATED', NULL, NULL, '[]'::jsonb
  );
  IF r2->>'result' <> 'already_processed' THEN
    RAISE EXCEPTION 'TEST 18: FAILED — a received message expected already_processed (no second attempt), got %', r2->>'result';
  END IF;
  IF r2->>'processing_status' <> 'received' THEN
    RAISE EXCEPTION 'TEST 18: FAILED — expected processing_status=received in the already_processed payload, got %', r2->>'processing_status';
  END IF;
  IF EXISTS (SELECT 1 FROM public.customers WHERE full_name = 'SHOULD NOT BE CREATED') THEN
    RAISE EXCEPTION 'TEST 18: FAILED — a received message was given a second processing attempt';
  END IF;
  IF (SELECT COUNT(*) FROM public.reservations WHERE source_id=v_source_id AND external_booking_id='90000025') <> 1 THEN
    RAISE EXCEPTION 'TEST 18: FAILED — a received message''s second attempt wrote/duplicated a reservation';
  END IF;

  RAISE NOTICE 'TEST 18: PASSED';
END $$;
ROLLBACK;


-- ══════════════════════════════════════════════════════════════════════════
-- TEST 19 — a genuinely 'failed' Gmail message safely retries under the
-- SAME email_ingestions row/id: failed -> received -> processed, using the
-- SAME row throughout (never a second audit row), preserving the original
-- Gmail identity/raw audit fields while clearing stale failure metadata,
-- and creating EXACTLY ONE reservation/customer/passenger-set/activity
-- notification total, never a duplicate from either attempt
-- (V5 state-machine items #4, #5, #8, #9, #10, #11)
-- ══════════════════════════════════════════════════════════════════════════
BEGIN;
DO $$
DECLARE
  v_source_id UUID; v_tour_id UUID;
  r1 JSONB; r2 JSONB;
  v_bogus_customer_id UUID := gen_random_uuid(); -- guaranteed not to exist -> forces Step 8's EXCEPTION
  v_ingestion_id_1 UUID; v_ingestion_id_2 UUID;
  v_ingestion RECORD;
  v_res_count INT; v_cust_count INT; v_guest_count INT; v_activity_count INT;
BEGIN
  SELECT id INTO v_source_id FROM public.sources WHERE slug ILIKE 'civitatis%' LIMIT 1;
  INSERT INTO public.tours (name, is_active) VALUES ('TEST19 Tour', TRUE) RETURNING id INTO v_tour_id;

  -- Attempt 1: deliberately fails (same bogus-customer-id trick as TEST 4).
  r1 := public.ingest_civitatis_booking(
    'gmail-test19-retry', 'thread-test19-ORIGINAL', NOW(), 'New booking A90000026: Test Tour', 'ORIGINAL raw body', 'new_booking',
    v_source_id, '90000026', v_tour_id, 'İtalyanca', CURRENT_DATE + 30, '09:00', 2, 0,
    3600, 'TL', 4800, 'TL',
    v_bogus_customer_id, -- does not exist -> RAISE EXCEPTION -> failed
    NULL, NULL, NULL, '[{"fullName":"REAL PASSENGER ONE","sortOrder":0},{"fullName":"REAL PASSENGER TWO","sortOrder":1}]'::jsonb
  );
  IF r1->>'result' <> 'failed' THEN RAISE EXCEPTION 'TEST 19: FAILED — attempt 1 expected result=failed, got %', r1->>'result'; END IF;
  v_ingestion_id_1 := (r1->>'ingestion_id')::uuid;

  SELECT * INTO v_ingestion FROM public.email_ingestions WHERE id = v_ingestion_id_1;
  IF v_ingestion.processing_status <> 'failed' THEN RAISE EXCEPTION 'TEST 19: FAILED — expected processing_status=failed after attempt 1'; END IF;
  IF v_ingestion.error_reason IS NULL THEN RAISE EXCEPTION 'TEST 19: FAILED — attempt 1 must record an error_reason'; END IF;

  -- Confirm attempt 1 left ZERO business state behind (same guarantee TEST 4 proves).
  IF EXISTS (SELECT 1 FROM public.reservations WHERE source_id=v_source_id AND external_booking_id='90000026') THEN
    RAISE EXCEPTION 'TEST 19: FAILED — attempt 1''s failure left a reservation behind';
  END IF;
  IF EXISTS (SELECT 1 FROM public.reservation_guests WHERE full_name IN ('REAL PASSENGER ONE','REAL PASSENGER TWO')) THEN
    RAISE EXCEPTION 'TEST 19: FAILED — attempt 1''s failure left passenger rows behind';
  END IF;

  -- Attempt 2 (retry): SAME gmail_message_id, this time with a resolvable
  -- customer (NULL + a real booking-contact name -> CREATE path). Also
  -- deliberately passes a DIFFERENT gmail_thread_id/raw_subject/raw_body
  -- to prove the claim does NOT refresh the message's original identity/
  -- raw audit content — a real retry resends the SAME email, so this is
  -- an adversarial check, not a realistic caller pattern.
  r2 := public.ingest_civitatis_booking(
    'gmail-test19-retry', 'thread-test19-RETRY-SHOULD-NOT-STICK', NOW() + INTERVAL '5 minutes',
    'RETRY SHOULD NOT STICK EITHER', 'RETRY BODY SHOULD NOT STICK', 'new_booking',
    v_source_id, '90000026', v_tour_id, 'İtalyanca', CURRENT_DATE + 30, '09:00', 2, 0,
    3600, 'TL', 4800, 'TL',
    NULL, 'Test Contact TwentySix', NULL, NULL,
    '[{"fullName":"REAL PASSENGER ONE","sortOrder":0},{"fullName":"REAL PASSENGER TWO","sortOrder":1}]'::jsonb
  );
  IF r2->>'result' <> 'created' THEN RAISE EXCEPTION 'TEST 19: FAILED — retry expected result=created, got %', r2->>'result'; END IF;
  v_ingestion_id_2 := (r2->>'ingestion_id')::uuid;

  -- SAME row/id reused — never a second audit row for this Gmail message.
  IF v_ingestion_id_2 <> v_ingestion_id_1 THEN
    RAISE EXCEPTION 'TEST 19: FAILED — retry used a DIFFERENT email_ingestions row/id (original=%, retry=%)', v_ingestion_id_1, v_ingestion_id_2;
  END IF;
  IF (SELECT COUNT(*) FROM public.email_ingestions WHERE gmail_message_id = 'gmail-test19-retry') <> 1 THEN
    RAISE EXCEPTION 'TEST 19: FAILED — expected exactly 1 email_ingestions row for this gmail_message_id after retry, found %',
      (SELECT COUNT(*) FROM public.email_ingestions WHERE gmail_message_id = 'gmail-test19-retry');
  END IF;

  -- failed -> received -> processed: final state is processed, stale
  -- failure metadata cleared.
  SELECT * INTO v_ingestion FROM public.email_ingestions WHERE id = v_ingestion_id_1;
  IF v_ingestion.processing_status <> 'processed' THEN
    RAISE EXCEPTION 'TEST 19: FAILED — expected final processing_status=processed after a successful retry, got %', v_ingestion.processing_status;
  END IF;
  IF v_ingestion.error_reason IS NOT NULL THEN
    RAISE EXCEPTION 'TEST 19: FAILED — a successful retry must clear error_reason, found %', v_ingestion.error_reason;
  END IF;

  -- Original Gmail identity / raw audit content preserved from ATTEMPT 1,
  -- NOT overwritten by attempt 2's (deliberately different) values:
  IF v_ingestion.gmail_thread_id <> 'thread-test19-ORIGINAL' THEN
    RAISE EXCEPTION 'TEST 19: FAILED — gmail_thread_id was refreshed by the retry (found %), must preserve the original', v_ingestion.gmail_thread_id;
  END IF;
  IF v_ingestion.raw_subject <> 'New booking A90000026: Test Tour' THEN
    RAISE EXCEPTION 'TEST 19: FAILED — raw_subject was refreshed by the retry, must preserve the original';
  END IF;
  IF v_ingestion.raw_body_snapshot <> 'ORIGINAL raw body' THEN
    RAISE EXCEPTION 'TEST 19: FAILED — raw_body_snapshot was refreshed by the retry, must preserve the original';
  END IF;

  -- Exactly one reservation/customer/passenger-set/activity notification
  -- total — the failed first attempt contributed nothing to duplicate:
  SELECT COUNT(*) INTO v_res_count FROM public.reservations WHERE source_id=v_source_id AND external_booking_id='90000026';
  IF v_res_count <> 1 THEN RAISE EXCEPTION 'TEST 19: FAILED — expected exactly 1 reservation after retry, found %', v_res_count; END IF;

  SELECT COUNT(*) INTO v_cust_count FROM public.customers WHERE full_name = 'Test Contact TwentySix';
  IF v_cust_count <> 1 THEN RAISE EXCEPTION 'TEST 19: FAILED — expected exactly 1 customer after retry, found %', v_cust_count; END IF;

  SELECT COUNT(*) INTO v_guest_count FROM public.reservation_guests WHERE reservation_id = (r2->>'reservation_id')::uuid;
  IF v_guest_count <> 2 THEN RAISE EXCEPTION 'TEST 19: FAILED — expected exactly 2 passenger rows after retry, found %', v_guest_count; END IF;

  SELECT COUNT(*) INTO v_activity_count FROM public.activity_logs
   WHERE entity_type='reservation' AND entity_id = (r2->>'reservation_id')::uuid;
  IF v_activity_count <> 1 THEN RAISE EXCEPTION 'TEST 19: FAILED — expected exactly 1 activity_logs row after retry, found %', v_activity_count; END IF;

  RAISE NOTICE 'TEST 19: PASSED';
END $$;
ROLLBACK;


-- ══════════════════════════════════════════════════════════════════════════
-- TEST 20 — a retry that fails AGAIN returns processing_status to 'failed'
-- with a fresh error_reason, under the SAME row/id, still with zero
-- business state left behind from either attempt (V5 state-machine item #6,
-- and confirms the "retry always resumes from a clean business state"
-- reasoning holds even across two consecutive failures)
-- ══════════════════════════════════════════════════════════════════════════
BEGIN;
DO $$
DECLARE
  v_source_id UUID; v_tour_id UUID;
  r1 JSONB; r2 JSONB;
  v_bogus_customer_id_1 UUID := gen_random_uuid();
  v_bogus_customer_id_2 UUID := gen_random_uuid();
  v_ingestion_id_1 UUID; v_ingestion_id_2 UUID;
  v_error_1 TEXT; v_error_2 TEXT;
BEGIN
  SELECT id INTO v_source_id FROM public.sources WHERE slug ILIKE 'civitatis%' LIMIT 1;
  INSERT INTO public.tours (name, is_active) VALUES ('TEST20 Tour', TRUE) RETURNING id INTO v_tour_id;

  r1 := public.ingest_civitatis_booking(
    'gmail-test20-retry-fails-again', 'thread-test20', NOW(), 'New booking A90000027: Test Tour', 'body', 'new_booking',
    v_source_id, '90000027', v_tour_id, 'İtalyanca', CURRENT_DATE + 30, '09:00', 2, 0,
    3600, 'TL', 4800, 'TL', v_bogus_customer_id_1, NULL, NULL, NULL, '[]'::jsonb
  );
  IF r1->>'result' <> 'failed' THEN RAISE EXCEPTION 'TEST 20: FAILED — attempt 1 expected result=failed, got %', r1->>'result'; END IF;
  v_ingestion_id_1 := (r1->>'ingestion_id')::uuid;
  SELECT error_reason INTO v_error_1 FROM public.email_ingestions WHERE id = v_ingestion_id_1;

  -- Retry with ANOTHER bogus (but different) customer_id — fails again.
  r2 := public.ingest_civitatis_booking(
    'gmail-test20-retry-fails-again', 'thread-test20', NOW() + INTERVAL '5 minutes', 'New booking A90000027: Test Tour', 'body', 'new_booking',
    v_source_id, '90000027', v_tour_id, 'İtalyanca', CURRENT_DATE + 30, '09:00', 2, 0,
    3600, 'TL', 4800, 'TL', v_bogus_customer_id_2, NULL, NULL, NULL, '[]'::jsonb
  );
  IF r2->>'result' <> 'failed' THEN RAISE EXCEPTION 'TEST 20: FAILED — retry expected result=failed again, got %', r2->>'result'; END IF;
  v_ingestion_id_2 := (r2->>'ingestion_id')::uuid;
  SELECT error_reason INTO v_error_2 FROM public.email_ingestions WHERE id = v_ingestion_id_2;

  IF v_ingestion_id_2 <> v_ingestion_id_1 THEN
    RAISE EXCEPTION 'TEST 20: FAILED — the second failed attempt used a DIFFERENT email_ingestions row/id';
  END IF;
  IF (SELECT COUNT(*) FROM public.email_ingestions WHERE gmail_message_id = 'gmail-test20-retry-fails-again') <> 1 THEN
    RAISE EXCEPTION 'TEST 20: FAILED — expected exactly 1 email_ingestions row after two failed attempts';
  END IF;
  IF (SELECT processing_status FROM public.email_ingestions WHERE id = v_ingestion_id_1) <> 'failed' THEN
    RAISE EXCEPTION 'TEST 20: FAILED — expected processing_status=failed after the second failure';
  END IF;
  IF v_error_2 IS NULL THEN
    RAISE EXCEPTION 'TEST 20: FAILED — the second failure must record a fresh error_reason';
  END IF;
  IF v_error_2 = v_error_1 THEN
    RAISE EXCEPTION 'TEST 20: FAILED — expected a genuinely fresh error_reason on the second failure (different bogus customer_id -> different error text), found the SAME text as attempt 1 — suggests the row was never actually re-attempted';
  END IF;

  -- Still zero business state after TWO failed attempts (both calls
  -- passed an invalid p_customer_id, which is rejected before any
  -- customer/reservation/guest row is ever written — see Step 6's CREATE
  -- branch):
  IF EXISTS (SELECT 1 FROM public.reservations WHERE source_id=v_source_id AND external_booking_id='90000027') THEN
    RAISE EXCEPTION 'TEST 20: FAILED — a reservation was left behind despite both attempts failing';
  END IF;
  IF EXISTS (SELECT 1 FROM public.customers WHERE id IN (v_bogus_customer_id_1, v_bogus_customer_id_2)) THEN
    RAISE EXCEPTION 'TEST 20: FAILED — a customer row was left behind despite both attempts failing';
  END IF;

  RAISE NOTICE 'TEST 20: PASSED';
END $$;
ROLLBACK;


-- ══════════════════════════════════════════════════════════════════════════
-- TEST 21 — two CONCURRENT retry attempts for the SAME 'failed'
-- gmail_message_id cannot both enter business processing (V5 state-machine
-- item #7). Like TEST 15, true concurrency requires two separate database
-- sessions racing each other and CANNOT run inside a single SQL
-- script/session — documented here as an exact manual procedure.
--
--   1. In a single session, first produce a genuinely 'failed' row:
--        SELECT public.ingest_civitatis_booking(
--          'gmail-test21-concurrent-retry', 'thread-test21', NOW(),
--          'New booking A90000028: Test Tour', 'body', 'new_booking',
--          '<a real civitatis source_id>', '90000028', '<a real tour_id>',
--          'İtalyanca', CURRENT_DATE + 30, '09:00', 2, 0, 3600, 'TL', 4800, 'TL',
--          '00000000-0000-0000-0000-000000000000'::uuid, -- guaranteed not to exist -> fails
--          NULL, NULL, NULL, '[]'::jsonb
--        );
--      Confirm it returned {"result":"failed", ...} and COMMIT this call
--      (do not leave it open) so the 'failed' row is durably visible to
--      both sessions below.
--   2. Open two separate `psql` (or two Supabase SQL editor tabs) sessions
--      against the same staging database.
--   3. In session A, run:
--        BEGIN;
--        SELECT public.ingest_civitatis_booking(
--          'gmail-test21-concurrent-retry', 'thread-test21', NOW(),
--          'New booking A90000028: Test Tour', 'body', 'new_booking',
--          '<the same source_id>', '90000028', '<the same tour_id>',
--          'İtalyanca', CURRENT_DATE + 30, '09:00', 2, 0, 3600, 'TL', 4800, 'TL',
--          NULL, 'Concurrent Retry Contact', NULL, NULL, '[]'::jsonb
--        );
--      but do NOT COMMIT yet — leave the transaction open. This call's
--      Step 1 UPSERT has, by this point, claimed the row (failed ->
--      received) and is proceeding through Step 2 onward while still
--      inside its own open transaction.
--   4. In session B, run the EXACT SAME call (same gmail_message_id).
--      Session B should BLOCK (visibly hang) — it is waiting on the
--      row-level lock Postgres took resolving session A's still-open
--      conflicting UPSERT (see V5 changelog point 9 / the RACE-CONDITION
--      notes in the migration file for the full mechanism).
--   5. COMMIT session A. Session B should then unblock. Because session
--      A's transaction committed the row to processing_status='processed'
--      (no longer 'failed'), session B's own conditional UPSERT now
--      matches ZERO rows — session B must return
--      {"result":"already_processed", "processing_status":"processed", ...}
--      — it must NEVER reach Step 2 and must NEVER create a second
--      reservation/customer/passenger/activity row.
--   6. Verify: SELECT COUNT(*) FROM reservations WHERE external_booking_id
--      = '90000028'; must be exactly 1. SELECT COUNT(*) FROM customers
--      WHERE full_name = 'Concurrent Retry Contact'; must be exactly 1.
--      SELECT COUNT(*) FROM email_ingestions WHERE gmail_message_id =
--      'gmail-test21-concurrent-retry'; must be exactly 1.
--   7. (Optional, to also prove the reverse interleaving is equally safe)
--      Repeat with session B's BEGIN issued first and session A's second
--      — the winner may differ, but the guarantee (exactly one winner,
--      exactly one reservation) must not.
--   8. Clean up: DELETE the test rows created (reservations cascades to
--      reservation_guests; delete the customers/email_ingestions/
--      activity_logs rows manually).
-- ══════════════════════════════════════════════════════════════════════════


-- ══════════════════════════════════════════════════════════════════════════
-- CROSS-REFERENCE — where each requested test-plan item is actually
-- covered (original 21 items, plus the V3 and V4 safety-revision items):
--   #1  new customer created (exactly one)         -> TEST 7
--   #2  exactly one reservation created             -> TEST 1, TEST 7
--   #3  passenger rows created exactly once         -> TEST 2 (initial + replace)
--   #4  retry same Gmail message harmless           -> TEST 1
--   #5  retry same external booking id, no dup      -> TEST 2
--   #6  new + modification use same reservation     -> TEST 2
--   #7  modification updates only allowed fields    -> TEST 3
--   #8  modification preserves guide_id             -> TEST 3
--   #9  modification preserves internal notes       -> TEST 3
--   #10 modification does not create payment rows   -> TEST 3
--   #11 passenger list replacement is atomic         -> TEST 2, TEST 14
--   #12 exactly one auto_ingested activity           -> TEST 1, TEST 2
--   #13 modification creates no new activity          -> TEST 2
--   #14 retry does not duplicate activity              -> TEST 1
--   #15 POSSIBLE_EXISTING_MATCH never writes            -> enforced at the
--       writeAdapter.js GATING layer (never calls the RPC at all for this
--       outcome) — see tests/civitatis/writeAdapter.test.js. The RPC
--       itself has no way to distinguish this case since it never
--       receives the booking in the first place; that is intentional.
--   #16 NEEDS_REVIEW never writes                       -> writeAdapter.test.js
--       (gating) AND TEST 5 (RPC's own defense in depth for a missing
--       tour_id specifically) AND TEST 13 (missing financial/date/guest-
--       count fields)
--   #17 PARSE_ERROR never writes                        -> writeAdapter.test.js
--       (a parse_error event never has a usable externalBookingId/tourId,
--       so it is never grouped into a plannable, eligible booking)
--   #18 authoritative existing customer reused           -> TEST 6
--   #19 unresolved safe booking creates customer          -> TEST 7
--   #20 transaction failure rolls everything back          -> TEST 4
--   #21 concurrent duplicate attempts remain idempotent     -> TEST 1
--       (same-message case, provable in one session) + TEST 15's
--       documented manual two-session procedure (same-booking-different-
--       message case, genuinely requires two concurrent sessions to prove)
--
--   V3 SAFETY-REVISION ITEMS:
--   stale event does not create customer               -> TEST 8
--   stale event does not modify customer                -> TEST 8
--   stale event does not update reservation               -> TEST 8
--   stale event does not replace passengers                 -> TEST 8
--   stale event returns explicit stale result                 -> TEST 8
--   missing financial data does not default to 0/EUR            -> TEST 13
--   invalid event type writes no business state                   -> TEST 10
--   modified-first event creates no reservation                      -> TEST 11
--   modification never creates a second customer                       -> TEST 12
--   modification never changes reservation.customer_id                    -> TEST 12
--   modification contact data does not mutate customer                      -> TEST 12
--   missing passenger payload cannot erase existing guests                     -> TEST 14
--   transaction failure behavior remains intact                                   -> TEST 4 (unchanged from V2)
--   service_role-only execution remains intact                                       -> unchanged REVOKE/GRANT
--       block in the migration itself — re-run the verification queries at
--       the bottom of supabase_migration_civitatis_write.sql after applying
--   same-message retry remains intact                                                    -> TEST 1 (unchanged from V2)
--   same-booking concurrency remains intact                                                  -> TEST 15
--
--   V4 SAFETY-REVISION ITEMS (second new_booking for an existing
--   reservation must never be treated as a modification):
--   new_booking + no reservation => created                                                     -> TEST 1, TEST 8, TEST 16
--   new_booking + existing reservation => booking_already_exists,
--     zero business-state changes                                                                  -> TEST 16
--   second new_booking (different gmail_message_id) cannot modify
--     reservation fields                                                                              -> TEST 16
--   second new_booking cannot replace passengers                                                        -> TEST 16
--   second new_booking cannot create another customer                                                     -> TEST 16
--   second new_booking cannot create another activity notification                                          -> TEST 16
--   modified + existing + non-stale => updated                                                                -> TEST 2, TEST 3, TEST 12, TEST 14
--   modified + existing + stale => stale_ignored                                                                 -> TEST 8
--   modified + no reservation => manual_review_required                                                            -> TEST 11
--   same gmail_message_id => already_processed remains unchanged                                                     -> TEST 1
--
--   V5 SAFETY-REVISION ITEMS (retry state machine for a previously-'failed'
--   Gmail message ingestion attempt):
--   #1  processed gmail_message_id cannot retry                    -> TEST 17 (Part A)
--   #2  needs_review gmail_message_id cannot automatically retry   -> TEST 17 (Part B)
--   #3  received gmail_message_id cannot start a second attempt    -> TEST 18
--   #4  failed gmail_message_id can retry using the SAME
--       email_ingestions row/id                                    -> TEST 19
--   #5  successful retry changes failed -> received -> processed   -> TEST 19
--   #6  retry that fails again returns to failed                   -> TEST 20
--   #7  two concurrent retries of the SAME failed gmail_message_id
--       cannot both enter business processing                      -> TEST 21 (documented
--       two-session manual procedure, same reason TEST 15 requires one)
--   #8  retry does not create duplicate reservation                -> TEST 19
--   #9  retry does not create duplicate customer                   -> TEST 19
--   #10 retry does not create duplicate passengers                 -> TEST 19
--   #11 retry does not create duplicate activity notification      -> TEST 19
--   #12 all V4 event-matrix behavior remains unchanged              -> TEST 1-16, all
--       unmodified and still passing against V5 (Step 6, the event/
--       reservation-state matrix, was not touched by this revision)
-- ══════════════════════════════════════════════════════════════════════════

-- ── END OF MANUAL TEST PLAN ─────────────────────────────────────────────────
