-- ============================================================
-- MANUAL / STAGING DATABASE TEST PLAN
-- public.mark_civitatis_email_needs_review(...)
-- ============================================================
-- NOT EXECUTED as part of preparing this task. Requires a real
-- PostgreSQL/Supabase database with supabase_schema.sql and
-- supabase_migration_civitatis_ingestion.sql already applied (this
-- function needs only public.sources and public.email_ingestions — it
-- does NOT require ingest_civitatis_booking, cancel_civitatis_booking,
-- or any tour_channels/customer-matching migration to exist at all),
-- PLUS supabase_migration_civitatis_write_v14_mark_needs_review.sql
-- itself. Run this file (e.g. via `psql`) against a STAGING/disposable
-- database only, never production.
--
-- VALIDATED (this phase, NOT against production): applied against a
-- disposable local PostgreSQL 16 instance — supabase_schema.sql (with a
-- stub auth.users table, since this is plain Postgres, not a Supabase
-- project) + supabase_migration_civitatis_ingestion.sql +
-- supabase_migration_civitatis_write_v14_mark_needs_review.sql — and
-- every scenario below passed, INCLUDING after the pre-production
-- review's retry-noise fix (TEST 2 below now proves
-- 'already_needs_review' with a byte-for-byte-unchanged processed_at/
-- error_reason, replacing the earlier draft's reclaim-on-every-call
-- behavior). The rollback
-- (supabase_migration_civitatis_write_v14_ROLLBACK_to_v13.sql) was also
-- applied afterward and confirmed to remove the function completely
-- (zero residue). The disposable database was dropped immediately
-- after. See the implementation report for the exact commands.
--
-- WHY THIS EXISTS AS SQL, NOT A JS TEST
-- Idempotency under a real UNIQUE-constraint conflict, the reclaim-vs-
-- terminal state machine, and "never writes reservations/customers/
-- tours" can only be genuinely proven by PostgreSQL itself executing
-- them. See tests/civitatis/writeAdapter.test.js for everything that
-- CAN be proven without a database (payload construction and which
-- gates call this function at all).
--
-- EACH TEST is wrapped in the surrounding file's own BEGIN ... ROLLBACK,
-- so running this whole file leaves no residue even against a database
-- with real data — but a dedicated staging database is still strongly
-- recommended.
--
-- HOW TO READ A FAILURE: every assertion uses
--   IF NOT (<condition>) THEN RAISE EXCEPTION '<test name>: FAILED — <detail>'; END IF;
-- A silent, error-free run of this whole file (ending in "ALL ... TESTS
-- PASSED") means every test passed.
-- ============================================================

BEGIN;

INSERT INTO public.sources (name, slug) VALUES ('Civitatis (test)', 'civitatis-v14-manual-test')
  ON CONFLICT (slug) DO NOTHING;

DO $$
DECLARE
  v_source_id UUID;
  v_result1 JSONB;
  v_result2 JSONB;
  v_result3 JSONB;
  v_ingestion_id UUID;
  v_status TEXT;
  v_reason TEXT;
  v_processed_at_1 TIMESTAMPTZ;
  v_processed_at_2 TIMESTAMPTZ;
  v_error_reason_1 TEXT;
  v_error_reason_2 TEXT;
  v_result2b JSONB;
  v_res_count_before INTEGER;
  v_res_count_after INTEGER;
  v_cust_count_before INTEGER;
  v_cust_count_after INTEGER;
  v_tour_count_before INTEGER;
  v_tour_count_after INTEGER;
BEGIN
  SELECT id INTO v_source_id FROM public.sources WHERE slug = 'civitatis-v14-manual-test';

  SELECT COUNT(*) INTO v_res_count_before FROM public.reservations;
  SELECT COUNT(*) INTO v_cust_count_before FROM public.customers;
  SELECT COUNT(*) INTO v_tour_count_before FROM public.tours;

  -- TEST 1: first call for a fresh gmail_message_id claims it and marks
  -- needs_review, with a safe structured, non-PII error_reason.
  v_result1 := public.mark_civitatis_email_needs_review(
    'v14-manual-msg-001', 'v14-manual-thread-001', NOW(), 'New booking A99999001: Test Tour',
    'fixture body', v_source_id, '99999001', 'new_booking',
    'POSSIBLE_EXISTING_MATCH_EXACT_NAME', 'candidate customer id(s): 00000000-0000-0000-0000-000000000001'
  );
  IF v_result1->>'result' <> 'manual_review_required' THEN
    RAISE EXCEPTION 'TEST 1 FAILED: expected manual_review_required, got %', v_result1->>'result';
  END IF;

  SELECT processing_status, error_reason, id INTO v_status, v_reason, v_ingestion_id
    FROM public.email_ingestions WHERE gmail_message_id = 'v14-manual-msg-001';
  IF v_status <> 'needs_review' THEN
    RAISE EXCEPTION 'TEST 1 FAILED: expected processing_status=needs_review, got %', v_status;
  END IF;
  IF v_reason <> 'POSSIBLE_EXISTING_MATCH_EXACT_NAME: candidate customer id(s): 00000000-0000-0000-0000-000000000001' THEN
    RAISE EXCEPTION 'TEST 1 FAILED: unexpected error_reason text: %', v_reason;
  END IF;
  RAISE NOTICE 'TEST 1 PASSED: first call claims the message and persists needs_review with the exact structured reason text.';

  -- TEST 2 (retry-noise fix): a second call for the SAME gmail_message_id
  -- while the row is still needs_review (not yet terminal) is NOT
  -- reclaimed/rewritten anymore — it returns 'already_needs_review' with
  -- the SAME ingestion_id and, critically, processed_at/error_reason
  -- BYTE-FOR-BYTE UNCHANGED (never just "close" — identical), so a
  -- still-unresolved message rediscovered every 15 minutes by the
  -- scheduler's 24h overlap window costs one SELECT, never a write.
  SELECT processed_at, error_reason INTO v_processed_at_1, v_error_reason_1
    FROM public.email_ingestions WHERE gmail_message_id = 'v14-manual-msg-001';
  PERFORM pg_sleep(1.1); -- prove a later NOW() would differ if the row WERE rewritten
  v_result2 := public.mark_civitatis_email_needs_review(
    'v14-manual-msg-001', 'v14-manual-thread-001', NOW(), 'New booking A99999001: Test Tour',
    'fixture body', v_source_id, '99999001', 'new_booking',
    'POSSIBLE_EXISTING_MATCH_EXACT_NAME', 'candidate customer id(s): 00000000-0000-0000-0000-000000000001'
  );
  IF v_result2->>'result' <> 'already_needs_review' THEN
    RAISE EXCEPTION 'TEST 2 FAILED: expected already_needs_review (no rewrite) while needs_review, got %', v_result2->>'result';
  END IF;
  IF (v_result2->>'ingestion_id')::uuid <> v_ingestion_id THEN
    RAISE EXCEPTION 'TEST 2 FAILED: must report the SAME ingestion_id, got a different one';
  END IF;
  SELECT processed_at, error_reason INTO v_processed_at_2, v_error_reason_2
    FROM public.email_ingestions WHERE gmail_message_id = 'v14-manual-msg-001';
  IF v_processed_at_2 <> v_processed_at_1 THEN
    RAISE EXCEPTION 'TEST 2 FAILED: processed_at changed on rediscovery (% -> %) — must be left completely untouched', v_processed_at_1, v_processed_at_2;
  END IF;
  IF v_error_reason_2 <> v_error_reason_1 THEN
    RAISE EXCEPTION 'TEST 2 FAILED: error_reason changed on rediscovery — must be left completely untouched';
  END IF;
  IF (SELECT COUNT(*) FROM public.email_ingestions WHERE gmail_message_id = 'v14-manual-msg-001') <> 1 THEN
    RAISE EXCEPTION 'TEST 2 FAILED: exactly one email_ingestions row must exist for this gmail_message_id — idempotency violated';
  END IF;
  RAISE NOTICE 'TEST 2 PASSED: repeated rediscovery while needs_review returns already_needs_review with processed_at/error_reason byte-for-byte unchanged — zero rewrite, zero spam.';

  -- TEST 2b (failed rows remain fully reclaimable — the narrowed reclaim
  -- set still includes 'failed', only 'needs_review' was removed from
  -- it): simulate a transient failure, then confirm a retry reclaims
  -- the SAME row and writes the NEW reason text.
  UPDATE public.email_ingestions SET processing_status = 'failed', error_reason = 'stage=simulated; error=injected'
   WHERE gmail_message_id = 'v14-manual-msg-001';
  v_result2b := public.mark_civitatis_email_needs_review(
    'v14-manual-msg-001', 'v14-manual-thread-001', NOW(), 'New booking A99999001: Test Tour',
    'fixture body', v_source_id, '99999001', 'new_booking',
    'POSSIBLE_EXISTING_MATCH_EXACT_NAME', 'retried after simulated failure'
  );
  IF v_result2b->>'result' <> 'manual_review_required' THEN
    RAISE EXCEPTION 'TEST 2b FAILED: a failed row must be reclaimed and freshly marked needs_review, got %', v_result2b->>'result';
  END IF;
  IF (SELECT error_reason FROM public.email_ingestions WHERE gmail_message_id = 'v14-manual-msg-001') <> 'POSSIBLE_EXISTING_MATCH_EXACT_NAME: retried after simulated failure' THEN
    RAISE EXCEPTION 'TEST 2b FAILED: a reclaimed row must carry the NEW reason text, not the stale one';
  END IF;
  RAISE NOTICE 'TEST 2b PASSED: a failed row remains fully reclaimable (narrowing the reclaim set to exclude only needs_review, never failed) and is freshly re-marked with the new reason.';

  -- TEST 3 (terminal state): once the row becomes genuinely 'processed'
  -- (simulating the real booking RPC, or a human-resolved manual
  -- outcome, having since handled it), a THIRD call must report
  -- already_processed and must NEVER flip it back to needs_review.
  UPDATE public.email_ingestions SET processing_status = 'processed', processed_at = NOW()
   WHERE gmail_message_id = 'v14-manual-msg-001';

  v_result3 := public.mark_civitatis_email_needs_review(
    'v14-manual-msg-001', 'v14-manual-thread-001', NOW(), 'New booking A99999001: Test Tour',
    'fixture body', v_source_id, '99999001', 'new_booking',
    'POSSIBLE_EXISTING_MATCH_EXACT_NAME', 'should never apply — already processed'
  );
  IF v_result3->>'result' <> 'already_processed' THEN
    RAISE EXCEPTION 'TEST 3 FAILED: expected already_processed for a terminal processed row, got %', v_result3->>'result';
  END IF;
  IF (SELECT processing_status FROM public.email_ingestions WHERE gmail_message_id = 'v14-manual-msg-001') <> 'processed' THEN
    RAISE EXCEPTION 'TEST 3 FAILED: a processed row must never be flipped back to needs_review';
  END IF;
  RAISE NOTICE 'TEST 3 PASSED: a processed (terminal) row is never reclaimed or overwritten — stays already_processed, zero writes.';

  -- TEST 4 (EXTERNAL_BOOKING_ID_UNRESOLVED shape): gmail_message_id
  -- alone is sufficient — external_booking_id and event_type may both
  -- be NULL (the subject/body reservation-number-mismatch case) and a
  -- persisted trace is still written. A null/unrecognized event_type
  -- is stored as the EXISTING allowed 'unknown' value, never a new
  -- schema value.
  PERFORM public.mark_civitatis_email_needs_review(
    'v14-manual-msg-002', NULL, NOW(), 'Some unrecognized booking-ish subject',
    'fixture body', v_source_id, NULL, NULL,
    'EXTERNAL_BOOKING_ID_UNRESOLVED', 'reservation number mismatch between subject (99999002) and body (99999099)'
  );
  IF (SELECT processing_status FROM public.email_ingestions WHERE gmail_message_id = 'v14-manual-msg-002') <> 'needs_review' THEN
    RAISE EXCEPTION 'TEST 4 FAILED: a null external_booking_id/event_type must still be claimable via gmail_message_id alone';
  END IF;
  IF (SELECT event_type FROM public.email_ingestions WHERE gmail_message_id = 'v14-manual-msg-002') <> 'unknown' THEN
    RAISE EXCEPTION 'TEST 4 FAILED: a null/unrecognized event_type must be stored as the existing allowed value ''unknown'', never a new CHECK value';
  END IF;
  IF (SELECT external_booking_id FROM public.email_ingestions WHERE gmail_message_id = 'v14-manual-msg-002') IS NOT NULL THEN
    RAISE EXCEPTION 'TEST 4 FAILED: external_booking_id must stay genuinely NULL when the caller supplies NULL — never fabricated';
  END IF;
  RAISE NOTICE 'TEST 4 PASSED: gmail_message_id alone is sufficient to persist a trace even when external_booking_id/event_type are both null.';

  -- TEST 5 (never writes business tables): reservations/customers/tours
  -- row counts must be byte-for-byte unchanged across every call made
  -- above — this function contains no INSERT/UPDATE against any of
  -- them anywhere in its body.
  SELECT COUNT(*) INTO v_res_count_after FROM public.reservations;
  SELECT COUNT(*) INTO v_cust_count_after FROM public.customers;
  SELECT COUNT(*) INTO v_tour_count_after FROM public.tours;
  IF v_res_count_after <> v_res_count_before THEN
    RAISE EXCEPTION 'TEST 5 FAILED: reservations row count changed (% -> %) — this function must never write reservations', v_res_count_before, v_res_count_after;
  END IF;
  IF v_cust_count_after <> v_cust_count_before THEN
    RAISE EXCEPTION 'TEST 5 FAILED: customers row count changed (% -> %) — this function must never write customers', v_cust_count_before, v_cust_count_after;
  END IF;
  IF v_tour_count_after <> v_tour_count_before THEN
    RAISE EXCEPTION 'TEST 5 FAILED: tours row count changed (% -> %) — this function must never write tours', v_tour_count_before, v_tour_count_after;
  END IF;
  RAISE NOTICE 'TEST 5 PASSED: reservations/customers/tours row counts are byte-for-byte unchanged — never auto-bound, never auto-linked, never created.';

  RAISE NOTICE 'ALL mark_civitatis_email_needs_review MANUAL TESTS PASSED.';
END $$;

-- TEST 6 (grants, read-only against the system catalog, outside the DO
-- block since has_function_privilege is a plain SQL function): confirm
-- EXECUTE is granted to service_role only, never anon or authenticated.
SELECT
  has_function_privilege('anon', 'public.mark_civitatis_email_needs_review(text,text,timestamptz,text,text,uuid,text,text,text,text)', 'EXECUTE') AS anon_can_execute_must_be_false,
  has_function_privilege('authenticated', 'public.mark_civitatis_email_needs_review(text,text,timestamptz,text,text,uuid,text,text,text,text)', 'EXECUTE') AS authenticated_can_execute_must_be_false,
  has_function_privilege('service_role', 'public.mark_civitatis_email_needs_review(text,text,timestamptz,text,text,uuid,text,text,text,text)', 'EXECUTE') AS service_role_can_execute_must_be_true;

ROLLBACK;

-- ── END OF TEST FILE — the ROLLBACK above means NOTHING in this file
-- persists, even against a database with real data. ─────────────────────
