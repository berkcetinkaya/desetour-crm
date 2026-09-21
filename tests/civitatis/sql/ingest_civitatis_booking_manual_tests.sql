-- ============================================================
-- MANUAL / STAGING DATABASE TEST PLAN
-- public.ingest_civitatis_booking(...)
-- ============================================================
-- NOT EXECUTED as part of preparing this task. These tests require a
-- real PostgreSQL/Supabase database with supabase_schema.sql,
-- supabase_rls_policies.sql, supabase_migration_guides.sql,
-- supabase_migration_reviews.sql, supabase_migration_tour_channels.sql,
-- supabase_migration_civitatis_ingestion.sql, AND
-- supabase_migration_civitatis_write.sql already applied — none of
-- which this task applies. Run this file (e.g. via `psql` or the
-- Supabase SQL editor) against a STAGING database only, never
-- production, after the write migration has been reviewed and applied
-- there.
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
-- TEST 8 — an out-of-order (stale) event never regresses already-applied
-- newer data, but still gets its own audit row (idempotency under reordered
-- retries / backfill — test plan item #21, ordering half)
-- ══════════════════════════════════════════════════════════════════════════
BEGIN;
DO $$
DECLARE
  v_source_id UUID; v_tour_id UUID;
  r1 JSONB; r2 JSONB;
  v_res RECORD;
BEGIN
  SELECT id INTO v_source_id FROM public.sources WHERE slug ILIKE 'civitatis%' LIMIT 1;
  INSERT INTO public.tours (name, is_active) VALUES ('TEST8 Tour', TRUE) RETURNING id INTO v_tour_id;

  -- Apply the NEWER (modification) event FIRST...
  r1 := public.ingest_civitatis_booking(
    'gmail-test8-mod', 'thread-test8', NOW(), 'Booking A90000008 modified: Test Tour', 'body', 'modified',
    v_source_id, '90000008', v_tour_id, 'Español', CURRENT_DATE + 40, '14:00', 5, 0,
    9000, 'TL', 12000, 'TL', NULL, 'Test Contact Eight', NULL, NULL, '[]'::jsonb
  );
  -- ...then the OLDER (new_booking) event arrives late (e.g. a backfill
  -- re-run, or genuinely out-of-order Gmail delivery).
  r2 := public.ingest_civitatis_booking(
    'gmail-test8-new', 'thread-test8', NOW() - INTERVAL '2 days', 'New booking A90000008: Test Tour', 'body', 'new_booking',
    v_source_id, '90000008', v_tour_id, 'İtalyanca', CURRENT_DATE + 30, '09:00', 2, 0,
    3600, 'TL', 4800, 'TL', NULL, 'Test Contact Eight', NULL, NULL, '[]'::jsonb
  );

  IF r1->>'result' <> 'created' THEN RAISE EXCEPTION 'TEST 8: FAILED — first (out-of-order-newer) call should create'; END IF;
  IF r2->>'result' <> 'updated' THEN RAISE EXCEPTION 'TEST 8: FAILED — second (stale older) call should still resolve, got %', r2->>'result'; END IF;
  IF (r2->>'stale')::boolean IS DISTINCT FROM TRUE THEN
    RAISE EXCEPTION 'TEST 8: FAILED — second call should be flagged stale=true';
  END IF;

  SELECT * INTO v_res FROM public.reservations WHERE id = (r1->>'reservation_id')::uuid;
  IF v_res.check_in <> CURRENT_DATE + 40 THEN
    RAISE EXCEPTION 'TEST 8: FAILED — the stale older event regressed check_in back to its own (wrong) value';
  END IF;
  IF v_res.pax_adult <> 5 THEN
    RAISE EXCEPTION 'TEST 8: FAILED — the stale older event regressed pax_adult back to its own (wrong) value';
  END IF;

  -- Both Gmail messages still each have their own permanent audit row:
  IF (SELECT COUNT(*) FROM public.email_ingestions WHERE source_id=v_source_id AND external_booking_id='90000008') <> 2 THEN
    RAISE EXCEPTION 'TEST 8: FAILED — expected 2 separate email_ingestions rows';
  END IF;

  RAISE NOTICE 'TEST 8: PASSED';
END $$;
ROLLBACK;


-- ══════════════════════════════════════════════════════════════════════════
-- TEST 9 — concurrent duplicate attempts remain idempotent under real
-- concurrency (test plan item #21, concurrency half).
-- THIS TEST CANNOT RUN INSIDE A SINGLE SQL SCRIPT/SESSION — advisory locks
-- and true concurrent transactions require two separate database sessions
-- racing each other. Documented here as an exact manual procedure instead:
--
--   1. Open two separate `psql` (or two Supabase SQL editor tabs) sessions
--      against the same staging database.
--   2. In session A, run:
--        BEGIN;
--        SELECT public.ingest_civitatis_booking(
--          'gmail-test9-a', 'thread-test9', NOW(),
--          'New booking A90000009: Test Tour', 'body', 'new_booking',
--          '<a real civitatis source_id>', '90000009', '<a real tour_id>',
--          'İtalyanca', CURRENT_DATE + 30, '09:00', 2, 0, 3600, 'TL', 4800, 'TL',
--          NULL, 'Concurrent Test Contact', NULL, NULL, '[]'::jsonb
--        );
--      but do NOT COMMIT yet — leave the transaction open.
--   3. In session B, run the SAME call with a DIFFERENT gmail_message_id
--      ('gmail-test9-b') but the SAME external_booking_id ('90000009').
--      Session B should BLOCK (visibly hang) at the
--      pg_advisory_xact_lock call inside the function — this in itself
--      confirms the lock is serializing the two sessions.
--   4. COMMIT session A. Session B should then unblock, see the
--      reservation A already created, and return result: "updated" (or
--      "created" only if it somehow ran first — either way, never a
--      SECOND reservation).
--   5. Verify: SELECT COUNT(*) FROM reservations WHERE external_booking_id
--      = '90000009'; must be exactly 1.
--   6. Clean up: DELETE the test rows created (reservations cascades to
--      reservation_guests; delete the customers/email_ingestions/
--      activity_logs rows manually, or run inside a wrapping transaction
--      you roll back instead of committing in step 4, then repeat the
--      procedure understanding the final commit is what step 4 needs).
-- ══════════════════════════════════════════════════════════════════════════


-- ══════════════════════════════════════════════════════════════════════════
-- CROSS-REFERENCE — where each of the 21 requested test-plan items is
-- actually covered:
--   #1  new customer created (exactly one)         -> TEST 7 above
--   #2  exactly one reservation created             -> TEST 1, TEST 7
--   #3  passenger rows created exactly once         -> TEST 2 (initial + replace)
--   #4  retry same Gmail message harmless           -> TEST 1
--   #5  retry same external booking id, no dup      -> TEST 2
--   #6  new + modification use same reservation     -> TEST 2
--   #7  modification updates only allowed fields    -> TEST 3
--   #8  modification preserves guide_id             -> TEST 3
--   #9  modification preserves internal notes       -> TEST 3
--   #10 modification does not create payment rows   -> TEST 3
--   #11 passenger list replacement is atomic         -> TEST 2
--   #12 exactly one auto_ingested activity           -> TEST 1, TEST 2
--   #13 modification creates no new activity          -> TEST 2
--   #14 retry does not duplicate activity              -> TEST 1
--   #15 POSSIBLE_EXISTING_MATCH never writes            -> enforced at the
--       writeAdapter.js GATING layer (never calls the RPC at all for this
--       outcome) — see tests/civitatis/writeAdapter.test.js. The RPC
--       itself has no way to distinguish this case since it never
--       receives the booking in the first place; that is intentional.
--   #16 NEEDS_REVIEW never writes                       -> writeAdapter.test.js
--       (gating) AND TEST 5 above (RPC's own defense in depth for a
--       missing tour_id specifically)
--   #17 PARSE_ERROR never writes                        -> writeAdapter.test.js
--       (a parse_error event never has a usable externalBookingId/tourId,
--       so it is never grouped into a plannable, eligible booking)
--   #18 authoritative existing customer reused           -> TEST 6
--   #19 unresolved safe booking creates customer          -> TEST 7
--   #20 transaction failure rolls everything back          -> TEST 4
--   #21 concurrent duplicate attempts remain idempotent     -> TEST 1
--       (same-message case, provable in one session) + TEST 9's documented
--       manual two-session procedure (same-booking-different-message case,
--       genuinely requires two concurrent sessions to prove)
-- ══════════════════════════════════════════════════════════════════════════

-- ── END OF MANUAL TEST PLAN ─────────────────────────────────────────────────
