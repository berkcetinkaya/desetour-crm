-- ============================================================
-- DESE TOUR OPERATIONS CENTER
-- Migration: Civitatis Email Ingestion — Transactional Write RPC
-- ============================================================
-- File:    supabase_migration_civitatis_write_v12_uuid_recheck_fix.sql
-- Depends: everything V11 depends on (supabase_schema.sql,
--          supabase_rls_policies.sql, supabase_migration_guides.sql,
--          supabase_migration_reviews.sql,
--          supabase_migration_tour_channels.sql,
--          supabase_migration_tour_channels_v2_booking_language.sql,
--          supabase_migration_civitatis_ingestion.sql,
--          supabase_migration_civitatis_write.sql (V6) through
--          supabase_migration_civitatis_write_v9_diagnostic_stage_instrumentation.sql (V9),
--          supabase_migration_civitatis_write_v10_tour_auto_provisioning.sql (V10)),
--          PLUS supabase_migration_civitatis_write_v11_optional_check_in_time.sql
--          (V11) itself — this file is a drop-in replacement for the
--          exact function V11 installs and assumes V11 is already live.
--
-- Version: V12 — fix a live production SQL defect in Step 6a's post-lock
--          tour_channels re-check: `MIN(tour_id)` fails with SQLSTATE
--          42883 ("function min(uuid) does not exist") because stock
--          PostgreSQL defines no MIN/MAX aggregate over the uuid type.
--          STILL NOT APPROVED FOR EXECUTION — DO NOT RUN.
--
-- WHY THIS MIGRATION EXISTS
-- ─────────────────────────────────────────────────────────────
-- Production evidence (workflow_dispatch run 2026-09-29T05:44:54Z,
-- GitHub Actions run 36527627818): bookings A41323338, A41330832,
-- A41596990 (all "Bosforo y Barrio Sultanahmet", Portekizce — the exact
-- product/language V11 unblocked) each passed V11's Step 2 field
-- validation cleanly, reached Step 6a's tour auto-provisioning lock, and
-- then every one of them returned result:'failed' with the SAME
-- diagnostics:
--   stage=tour_provision_recheck; error=function min(uuid) does not
--   exist; sqlstate=42883
-- at this exact statement (originally introduced in V10, carried
-- unchanged through V11 — see supabase_migration_civitatis_write_v10_tour_auto_provisioning.sql:1166):
--   SELECT COUNT(*), MIN(tour_id) INTO v_provision_match_count, v_provisioned_tour_id
--     FROM public.tour_channels
--    WHERE source_id = p_source_id
--      AND external_product_id = p_civitatis_internal_code
--      AND booking_language = p_tour_language;
-- tour_channels.tour_id is UUID. Unlike integer/text/numeric/timestamp,
-- PostgreSQL ships NO built-in MIN or MAX aggregate for uuid (it has a
-- btree opclass, so ORDER BY / comparisons / DISTINCT all work fine —
-- only the MIN/MAX AGGREGATE wrapper is missing). This statement was
-- therefore never able to succeed, on any input, since the day V10
-- introduced it — it was simply never reached in practice until V11
-- stopped bouncing NULL-check_in_time bookings out one stage earlier.
-- V11 is confirmed working exactly as designed; this is an independent,
-- pre-existing defect one stage further into the same code path.
--
-- WHY THIS IS THE SAFEST FIX — SEMANTICS ARE 100% UNCHANGED
-- ─────────────────────────────────────────────────────────────
-- The ONLY functional requirement on this statement is:
--   0 rows  -> v_provision_match_count = 0, v_provisioned_tour_id may
--              be NULL (a brand-new product/language pair -> CREATE)
--   1 row   -> v_provision_match_count = 1, v_provisioned_tour_id MUST
--              equal that row's tour_id (an existing mapping -> REUSE)
--   >1 rows -> v_provision_match_count > 1, v_provisioned_tour_id is
--              ALREADY discarded by the very next IF branch (fail-closed
--              ambiguity handling — see "tour_provision_ambiguous" a few
--              lines below, completely unchanged by this migration) —
--              its exact value in this branch has never mattered.
-- COUNT(*) is untouched. The only change is how the "give me some
-- tour_id from this group, when there is only one" half of the
-- statement is computed: MIN(tour_id) becomes MIN(tour_id::text)::uuid
-- — casting to text (which DOES have a built-in MIN aggregate, via its
-- own btree opclass), taking the minimum of the canonical lowercase
-- hex-with-dashes text representation Postgres always produces for a
-- uuid, then casting the single winning value back to uuid. When
-- v_provision_match_count = 1 this trivially returns that one row's own
-- tour_id, byte-for-byte identical to what a hypothetical native
-- MIN(uuid) would have returned — there is only one candidate value, so
-- "which one text-sorts smallest" is not a meaningful choice, only a
-- mechanical one. When v_provision_match_count = 0, MIN over zero rows
-- is SQL NULL either way (text or uuid), so v_provisioned_tour_id stays
-- NULL exactly as before. When v_provision_match_count > 1, whatever
-- value comes back is discarded by the existing ambiguous-branch logic,
-- exactly as it already was designed to be. No branch, no lock, no
-- reservation/customer/tour write, and no ordering guarantee changes.
--
-- SCOPE OF THIS MIGRATION
-- ─────────────────────────────────────────────────────────────
-- Replaces ONE object: public.ingest_civitatis_booking(...). The
-- parameter list is COMPLETELY UNCHANGED from V10/V11 (still 26
-- parameters, same names, same types, same order, same defaults) — only
-- the BODY changes (one SELECT statement inside Step 6a), so CREATE OR
-- REPLACE FUNCTION alone is sufficient; no DROP FUNCTION is needed
-- (Postgres replaces a function in place when the argument type list is
-- identical). No table is created, altered, or dropped. No existing row
-- is touched. No RLS policy is added, changed, or removed. No advisory
-- lock, no re-check ordering, and no unique-index backstop is touched —
-- see REQUIREMENTS 3 below. Every other V11 behavior (optional
-- check_in_time, tour auto-provisioning's overall shape, the retry-safe
-- needs_review reclaim, every other required-field check) is completely
-- unchanged — see supabase_migration_civitatis_write_v11_optional_check_in_time.sql's
-- own header for that full history, which remains accurate and is not
-- restated here.
--
-- THE ONLY FUNCTIONAL CHANGE (everything else below is byte-for-byte
-- identical to V11)
-- ─────────────────────────────────────────────────────────────
--   SELECT COUNT(*), MIN(tour_id) INTO v_provision_match_count, v_provisioned_tour_id
-- becomes
--   SELECT COUNT(*), MIN(tour_id::text)::uuid INTO v_provision_match_count, v_provisioned_tour_id
-- — a single-line change, at the exact statement diagnosed above.
-- Nothing else in the function body is touched.
--
-- HOW TO APPLY (once reviewed and approved — NOT done as part of
-- producing this file)
-- ─────────────────────────────────────────────────────────────
-- Confirm V11 is already live (its own preflight-guarded migration must
-- have been run first), then Supabase Dashboard → SQL Editor → paste and
-- run this file. Wrapped in an explicit BEGIN/COMMIT, same convention as
-- V10/V11, so a failed preflight check aborts the whole transaction.
-- ============================================================


BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'tour_channels' AND column_name = 'booking_language'
  ) THEN
    RAISE EXCEPTION 'V12 PREFLIGHT FAILED: public.tour_channels.booking_language does not exist. Apply supabase_migration_tour_channels_v2_booking_language.sql BEFORE this migration. Aborting before touching public.ingest_civitatis_booking — no function was dropped or replaced.';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
     WHERE schemaname = 'public' AND tablename = 'tour_channels'
       AND indexname = 'uq_tour_channels_source_product_language'
  ) THEN
    RAISE EXCEPTION 'V12 PREFLIGHT FAILED: unique index public.uq_tour_channels_source_product_language does not exist. Apply supabase_migration_tour_channels_v2_booking_language.sql BEFORE this migration. Aborting before touching public.ingest_civitatis_booking — no function was dropped or replaced.';
  END IF;

  -- V12-specific: confirm a function named ingest_civitatis_booking with
  -- the exact V10/V11 26-parameter identity signature already exists,
  -- so CREATE OR REPLACE FUNCTION below is guaranteed to replace that
  -- SAME function in place rather than (if the signature had ever
  -- silently drifted) creating a second, overloaded function of the
  -- same name. This is a structural safety check, not a behavioral one
  -- — it does not and cannot verify V11's specific check_in_time fix is
  -- present, only that the expected function/signature exists at all.
  --
  -- STRUCTURAL type-OID comparison against pg_proc.proargtypes, NOT a
  -- formatted-string comparison against pg_get_function_identity_arguments().
  -- An earlier revision of this exact check compared
  -- pg_get_function_identity_arguments(p.oid) to a hand-written literal
  -- string of bare type names ('text, text, timestamp with time zone,
  -- ...') and was PROVEN WRONG in a live production preflight attempt:
  -- when a function's parameters are named (as every parameter of
  -- ingest_civitatis_booking is, e.g. p_gmail_message_id), Postgres's
  -- reconstructed identity-arguments string includes those NAMES
  -- alongside each type ("p_gmail_message_id text, p_gmail_thread_id
  -- text, ..."), never bare types alone — so a name-free literal could
  -- never equal the real function's identity-arguments string, and the
  -- exact-match check failed closed against the correctly-signatured,
  -- genuinely-live V11 function every single time, not only when the
  -- signature had actually drifted. That failure mode is a FALSE
  -- NEGATIVE bug in the preflight check itself, not evidence of any real
  -- signature mismatch.
  --
  -- proargtypes is an oidvector of the function's INPUT argument type
  -- OIDs, in declaration order — the same representation Postgres's own
  -- overload resolution uses internally to identify a function, entirely
  -- independent of parameter names, whitespace, or which of several
  -- equivalent spellings a type has (uuid, timestamptz vs "timestamp
  -- with time zone", time vs "time without time zone" all resolve to the
  -- exact same underlying type OID regardless of which spelling is
  -- written on either side of this comparison). Casting a computed
  -- regtype[] of the expected 26 types to oid[], and proargtypes itself
  -- to oid[], makes this a plain OID-array equality check — nothing
  -- fragile about formatting or naming remains, and it fails closed
  -- exactly the same way: any real difference in argument count, order,
  -- or types still makes this NOT EXISTS.
  IF NOT EXISTS (
    SELECT 1
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname = 'ingest_civitatis_booking'
       AND p.pronargs = 26
       AND p.proargtypes::oid[] = ARRAY[
             'text', 'text', 'timestamptz', 'text', 'text', 'text', 'uuid', 'text', 'uuid', 'text',
             'date', 'time', 'integer', 'integer', 'numeric', 'text', 'numeric', 'text', 'uuid',
             'text', 'text', 'text', 'jsonb', 'boolean', 'text', 'text'
           ]::regtype[]::oid[]
  ) THEN
    RAISE EXCEPTION 'V12 PREFLIGHT FAILED: public.ingest_civitatis_booking with the expected 26-parameter V10/V11 signature was not found. Confirm V11 is live before applying V12. Aborting before touching the function — no function was dropped or replaced.';
  END IF;

  RAISE NOTICE 'V12 PREFLIGHT PASSED: tour_channels.booking_language, uq_tour_channels_source_product_language, and the expected ingest_civitatis_booking(...) signature are all present. Proceeding.';
END $$;


-- ──────────────────────────────────────────────────────────────────────────
-- No DROP FUNCTION needed: V12's parameter list is IDENTICAL to V11's/
-- V10's (26 parameters, same names/types/order/defaults) — only the
-- function BODY changes (the Step 6a tour_provision_recheck statement,
-- below). CREATE OR REPLACE FUNCTION replaces the existing V11 function
-- in place.
-- ──────────────────────────────────────────────────────────────────────────

-- ──────────────────────────────────────────────────────────────────────────
-- FUNCTION: ingest_civitatis_booking
-- One call = one parsed, already-matched-or-provisionable Civitatis
-- email (a single Gmail message). See the header above for the full
-- contract.
-- ──────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.ingest_civitatis_booking(
  p_gmail_message_id    TEXT,
  p_gmail_thread_id     TEXT,
  p_received_at         TIMESTAMPTZ,
  p_raw_subject         TEXT,
  p_raw_body_snapshot   TEXT,
  p_event_type          TEXT,        -- 'new_booking' | 'modified' — anything else is needs_review
  p_source_id           UUID,
  p_external_booking_id TEXT,
  p_tour_id             UUID,        -- resolved by matching.js's matchTourChannel (exact match), OR NULL if unresolved — see p_auto_provision_tour
  p_tour_language       TEXT,
  p_check_in            DATE,
  p_check_in_time       TIME,
  p_pax_adult           INTEGER,
  p_pax_child           INTEGER,     -- the ONE original field allowed to default (to 0) — see V3 changelog point 2
  p_total_amount        NUMERIC,     -- Civitatis Net price -> reservations.total_amount
  p_currency            TEXT,
  p_retail_amount       NUMERIC,     -- Civitatis Retail price -> reservations.retail_amount
  p_retail_currency     TEXT,
  p_customer_id         UUID,        -- pre-resolved by matching.js's matchCustomer; NULL means "create" (CREATE path only — see V3 changelog point 4)
  p_customer_full_name  TEXT,        -- used ONLY on the CREATE path when p_customer_id IS NULL
  p_customer_email      TEXT,        -- used ONLY on the CREATE path when p_customer_id IS NULL
  p_customer_phone      TEXT,        -- used ONLY on the CREATE path when p_customer_id IS NULL
  p_passengers          JSONB,       -- [{"fullName":"...", "sortOrder":0}, ...] from api/civitatis/parser.js
  -- V10: tour auto-provisioning — see changelog point 13. All three
  -- default to "do nothing new", so any caller that omits them behaves
  -- exactly as it did against V9/V8.
  p_auto_provision_tour     BOOLEAN DEFAULT FALSE,
  p_civitatis_internal_code TEXT    DEFAULT NULL,
  p_civitatis_language_code TEXT    DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_ingestion_id        UUID;
  v_existing_status      TEXT;
  v_existing_res_id       UUID;
  v_missing_fields         TEXT[] := '{}';
  v_customer_id              UUID;
  v_reservation_id             UUID;
  v_reservation_number          TEXT;
  v_tour_name                    TEXT;
  v_result                        TEXT;
  v_newer_exists                    BOOLEAN;
  v_expected_passenger_count          INTEGER;
  v_usable_passenger_count              INTEGER;
  v_passengers_replaced                   BOOLEAN := FALSE;
  v_error_text                              TEXT;
  -- V10: tour auto-provisioning working variables — see Step 6a.
  v_provisioned_tour_id                       UUID;
  v_provision_match_count                      INTEGER;
  -- V9: diagnostic-only. v_stage records the last stage entered before
  -- Step 3 onward; the six v_diag_* variables are populated ONLY inside
  -- the EXCEPTION handler, from GET STACKED DIAGNOSTICS — see V9
  -- CHANGELOG. None of these are ever persisted outside this one
  -- function call except inside error_reason/the returned JSONB, in
  -- exactly the same way v_error_text/SQLERRM always already were.
  v_stage                                     TEXT;
  v_diag_sqlstate                              TEXT;
  v_diag_constraint                             TEXT;
  v_diag_table                                   TEXT;
  v_diag_column                                   TEXT;
  v_diag_detail                                    TEXT;
  v_diag_hint                                       TEXT;
  v_diag_context                                     TEXT;
BEGIN
  -- ── Step 0 (V6): non-blocking, gmail_message_id-scoped processing lock
  -- — acquired BEFORE Step 1 is even attempted, and BEFORE the row is
  -- touched in any way. See V6 changelog point 10 for the full
  -- concurrency argument (unchanged).
  IF NOT pg_try_advisory_xact_lock(
    hashtextextended('civitatis_ingest:gmail_message:' || p_gmail_message_id, 1)
  ) THEN
    SELECT id, processing_status, reservation_id
      INTO v_ingestion_id, v_existing_status, v_existing_res_id
      FROM public.email_ingestions
     WHERE gmail_message_id = p_gmail_message_id;
    RETURN jsonb_build_object(
      'result', 'already_processed',
      'ingestion_id', v_ingestion_id,
      'processing_status', COALESCE(v_existing_status, 'received'),
      'reservation_id', v_existing_res_id
    );
  END IF;

  -- ── Step 1 (V10: reclaim set widened to include 'needs_review' — see
  -- changelog point 15): Gmail-message-level idempotency, with safe
  -- retry for a previously-failed OR previously-needs_review attempt at
  -- the SAME message. Atomic at the database level via a single
  -- conditional UPSERT, not an application-side "SELECT then UPDATE".
  --
  -- Three possible outcomes of this single statement:
  --   (a) no existing row for this gmail_message_id -> plain INSERT
  --       succeeds, RETURNING gives the new id -> fresh attempt.
  --   (b) existing row's processing_status IN ('failed','needs_review')
  --       -> the ON CONFLICT DO UPDATE's WHERE clause matches -> the
  --       SAME row is atomically reclaimed (flipped to 'received', stale
  --       failure/review metadata cleared), RETURNING gives the SAME id
  --       -> retry attempt, Step 2 onward proceeds exactly as for a
  --       fresh attempt (now including a fresh Step 2a provisioning
  --       opportunity).
  --   (c) existing row's processing_status = 'processed' (the only
  --       remaining terminal state) -> the WHERE clause does not match
  --       -> zero rows are inserted or updated -> RETURNING gives no row
  --       -> v_ingestion_id stays NULL -> falls through to the
  --       already_processed report below.
  INSERT INTO public.email_ingestions (
    gmail_message_id, gmail_thread_id, external_booking_id, source_id,
    event_type, processing_status, raw_subject, raw_body_snapshot, received_at
  ) VALUES (
    p_gmail_message_id, p_gmail_thread_id, p_external_booking_id, p_source_id,
    CASE WHEN p_event_type IN ('new_booking', 'modified') THEN p_event_type ELSE 'unknown' END,
    'received', p_raw_subject, p_raw_body_snapshot,
    COALESCE(p_received_at, NOW())
  )
  ON CONFLICT (gmail_message_id) DO UPDATE
    SET processing_status = 'received',
        error_reason      = NULL,
        processed_at      = NULL
    -- Deliberately NOT reset on a retry: gmail_thread_id, external_booking_id,
    -- source_id, event_type, raw_subject, raw_body_snapshot, received_at —
    -- a retry is the SAME Gmail message, not a new one.
    WHERE public.email_ingestions.processing_status IN ('failed', 'needs_review')
  RETURNING id INTO v_ingestion_id;

  IF v_ingestion_id IS NULL THEN
    -- Outcome (c): an existing 'processed' row — the only permanently
    -- terminal state as of V10.
    SELECT id, processing_status, reservation_id
      INTO v_ingestion_id, v_existing_status, v_existing_res_id
      FROM public.email_ingestions
     WHERE gmail_message_id = p_gmail_message_id;
    RETURN jsonb_build_object(
      'result', 'already_processed',
      'ingestion_id', v_ingestion_id,
      'processing_status', v_existing_status,
      'reservation_id', v_existing_res_id
    );
  END IF;

  -- ── Step 2: consolidated required-field validation — BEFORE any
  -- customer/reservation/guest/activity write is even attempted. Every
  -- field checked here is guaranteed non-null by api/civitatis/parser.js
  -- for any event with ok:true. p_pax_child is deliberately NOT
  -- validated here (0-default is the established parser contract, not a
  -- fabrication). V10: p_tour_id is DELIBERATELY NOT checked here
  -- anymore — see changelog point 14; it is checked at Step 2b, after
  -- Step 2a has had a chance to resolve it via auto-provisioning.
  IF p_source_id IS NULL THEN
    v_missing_fields := array_append(v_missing_fields, 'source_id');
  END IF;
  IF p_external_booking_id IS NULL OR btrim(p_external_booking_id) = '' THEN
    v_missing_fields := array_append(v_missing_fields, 'external_booking_id');
  END IF;
  IF p_event_type IS NULL OR p_event_type NOT IN ('new_booking', 'modified') THEN
    v_missing_fields := array_append(v_missing_fields, 'event_type (must be exactly new_booking or modified)');
  END IF;
  IF p_check_in IS NULL THEN
    v_missing_fields := array_append(v_missing_fields, 'check_in');
  END IF;
  -- V11: check_in_time is now OPTIONAL. NULL is accepted as a legitimate
  -- "this Civitatis product states no fixed check-in hour" value, never
  -- treated as a missing/invalid field. This is safe specifically because
  -- the only real caller (api/_civitatis/writeAdapter.js) never forwards a
  -- NULL here for a PRESENT-but-malformed source "Hour:" value — that case
  -- fails closed one layer earlier, inside api/_civitatis/parser.js, and
  -- never reaches this RPC call at all. See this migration file's header
  -- for the full argument. reservations.check_in_time is already a
  -- nullable TIME column — no schema change accompanies this migration.
  IF p_pax_adult IS NULL OR p_pax_adult <= 0 THEN
    v_missing_fields := array_append(v_missing_fields, 'pax_adult');
  END IF;
  IF p_total_amount IS NULL THEN
    v_missing_fields := array_append(v_missing_fields, 'total_amount (Civitatis Net price)');
  END IF;
  IF p_currency IS NULL OR btrim(p_currency) = '' THEN
    v_missing_fields := array_append(v_missing_fields, 'currency');
  END IF;
  IF p_retail_amount IS NULL THEN
    v_missing_fields := array_append(v_missing_fields, 'retail_amount (Civitatis Retail price)');
  END IF;
  IF p_retail_currency IS NULL OR btrim(p_retail_currency) = '' THEN
    v_missing_fields := array_append(v_missing_fields, 'retail_currency');
  END IF;
  IF p_tour_language IS NULL OR btrim(p_tour_language) = '' THEN
    v_missing_fields := array_append(v_missing_fields, 'tour_language');
  END IF;
  -- V8: p_passengers, when provided, must be a genuine JSONB ARRAY.
  IF p_passengers IS NOT NULL AND jsonb_typeof(p_passengers) <> 'array' THEN
    v_missing_fields := array_append(v_missing_fields, 'passengers (must be a JSON array when provided)');
  END IF;

  IF array_length(v_missing_fields, 1) > 0 THEN
    UPDATE public.email_ingestions
       SET processing_status = 'needs_review',
           error_reason = 'missing required field(s): ' || array_to_string(v_missing_fields, ', '),
           processed_at = NOW()
     WHERE id = v_ingestion_id;
    RETURN jsonb_build_object(
      'result', 'manual_review_required',
      'ingestion_id', v_ingestion_id,
      'reason', 'missing required field(s)',
      'missing_fields', to_jsonb(v_missing_fields)
    );
  END IF;

  -- ── Step 2b-precompute (V7, unchanged): passenger-completeness inputs.
  v_expected_passenger_count := p_pax_adult + COALESCE(p_pax_child, 0);
  SELECT COUNT(*) INTO v_usable_passenger_count
    FROM jsonb_array_elements(COALESCE(p_passengers, '[]'::jsonb)) AS g
   WHERE btrim(g->>'fullName') IS NOT NULL AND btrim(g->>'fullName') <> '';

  BEGIN  -- nested block: on any unexpected error below, roll back every
         -- tour/tour_language/tour_channel/customer/reservation/guest/
         -- activity write attempted in this call (but NOT the
         -- email_ingestions row from Step 1, which this handler
         -- explicitly re-records as 'failed' after the implicit
         -- rollback-to-savepoint) — see migration header.
    v_stage := 'nested_block_entry';  -- V9: diagnostic only

    -- ── Step 3: serialize concurrent processing of the SAME booking
    -- (unchanged from V2-V9). NOTE (corrected V10 placement): tour
    -- auto-provisioning (Step 6a below) is now positioned INSIDE the
    -- CREATE branch of Step 6, after the passenger-completeness guard
    -- and a hoisted, write-free customer-identity validation, but BEFORE
    -- the actual customer lookup/insert — i.e. only once this call is
    -- genuinely committed to creating a reservation, and before the
    -- first real write of any kind. It is DELIBERATELY not here
    -- (immediately after entering this block) — an earlier revision
    -- placed it here and a pre-deployment review found that every
    -- controlled needs_review/manual_review_required
    -- RETURN reachable after that point (modification-with-no-
    -- reservation, passenger-count mismatch, missing booking-contact
    -- identity) does NOT raise an exception, so it would NOT roll back
    -- a tour already provisioned earlier in the same call — a real gap
    -- in the "fully succeeds or fully fails" guarantee. See the V10
    -- CHANGELOG "CORRECTED PLACEMENT" note above for the full incident.
    v_stage := 'booking_advisory_lock';  -- V9: diagnostic only
    PERFORM pg_advisory_xact_lock(
      hashtextextended(p_source_id::text || ':' || p_external_booking_id, 0)
    );

    -- ── Step 4: locate the existing reservation for this booking, if any
    -- (unchanged from V3-V9).
    v_stage := 'reservation_lookup';  -- V9: diagnostic only
    SELECT id, customer_id INTO v_reservation_id, v_customer_id
      FROM public.reservations
     WHERE source_id = p_source_id AND external_booking_id = p_external_booking_id
     FOR UPDATE;

    -- ── Step 5: ordering guard (unchanged from V3-V9).
    v_stage := 'newer_event_check';  -- V9: diagnostic only
    SELECT EXISTS (
      SELECT 1 FROM public.email_ingestions
       WHERE source_id = p_source_id
         AND external_booking_id = p_external_booking_id
         AND processing_status = 'processed'
         AND received_at > COALESCE(p_received_at, NOW())
    ) INTO v_newer_exists;

    -- ── Step 6: branch — fully explicit, exhaustive event/reservation-
    -- state matrix (unchanged from V4-V9):
    --   event_type=new_booking, no reservation          -> CREATE
    --   event_type=modified,    reservation exists,
    --                            not stale                -> UPDATE
    --   event_type=modified,    reservation exists,
    --                            stale                     -> stale_ignored
    --   event_type=modified,    no reservation              -> manual_review_required
    --   event_type=new_booking, reservation exists            -> booking_already_exists
    IF v_reservation_id IS NOT NULL AND p_event_type = 'new_booking' THEN
      v_stage := 'booking_already_exists_mark';  -- V9: diagnostic only
      UPDATE public.email_ingestions
         SET processing_status = 'processed', reservation_id = v_reservation_id, processed_at = NOW()
       WHERE id = v_ingestion_id;
      RETURN jsonb_build_object(
        'result', 'booking_already_exists',
        'ingestion_id', v_ingestion_id,
        'reservation_id', v_reservation_id,
        'customer_id', v_customer_id
      );

    ELSIF v_reservation_id IS NULL AND p_event_type = 'modified' THEN
      v_stage := 'modification_no_reservation_mark';  -- V9: diagnostic only
      UPDATE public.email_ingestions
         SET processing_status = 'needs_review',
             error_reason = 'modification event with no existing reservation for this source_id/external_booking_id',
             processed_at = NOW()
       WHERE id = v_ingestion_id;
      RETURN jsonb_build_object(
        'result', 'manual_review_required',
        'ingestion_id', v_ingestion_id,
        'reason', 'modification event with no existing reservation'
      );

    ELSIF v_reservation_id IS NULL AND p_event_type = 'new_booking' THEN
      -- V7: passenger-completeness guard.
      v_stage := 'passenger_completeness_check';  -- V9: diagnostic only
      IF v_usable_passenger_count <> v_expected_passenger_count THEN
        UPDATE public.email_ingestions
           SET processing_status = 'needs_review',
               error_reason = format(
                 'passenger count mismatch on create: expected %s usable passenger(s) (pax_adult=%s + pax_child=%s), found %s usable entr%s in p_passengers',
                 v_expected_passenger_count, p_pax_adult, COALESCE(p_pax_child, 0), v_usable_passenger_count,
                 CASE WHEN v_usable_passenger_count = 1 THEN 'y' ELSE 'ies' END
               ),
               processed_at = NOW()
         WHERE id = v_ingestion_id;
        RETURN jsonb_build_object(
          'result', 'manual_review_required',
          'ingestion_id', v_ingestion_id,
          'reason', 'passenger count mismatch',
          'expected_passenger_count', v_expected_passenger_count,
          'usable_passenger_count', v_usable_passenger_count
        );
      END IF;

      -- ── Step 6a-precheck (V10): customer-identity VALIDATION ONLY,
      -- hoisted here — no write. V9's customer resolution interleaved
      -- this exact check ("is there a usable customer_id, or do we at
      -- least have a full name to create one from?") with the customer
      -- INSERT itself, which was perfectly safe in V9 (nothing was ever
      -- written before it in the CREATE branch). It is NOT safe to leave
      -- interleaved once tour auto-provisioning (Step 6a below) can
      -- write a tour earlier in the same call: if the identity check
      -- fired its RETURN from its ORIGINAL position (inside customer
      -- resolution, after tour provisioning), that RETURN — a plain
      -- PL/pgSQL RETURN, not an exception — would NOT roll back a tour
      -- Step 6a had already written, leaving a real, persisted,
      -- reservation-less tour behind. Hoisting the VALIDATION (never the
      -- actual customer lookup/insert, which still happens in its
      -- original relative position, after tour resolution — see the
      -- "CREATE path. Customer resolution" block below) closes this
      -- completely: by construction, EVERY controlled RETURN in this
      -- branch (passenger completeness above, this check, and Step 6b
      -- below) now occurs before ANY write of ANY kind — tour, tour_
      -- language, tour_channel, activity_log, OR customer. Only once ALL
      -- of them have passed does this call write anything at all, and
      -- every write from that point on is protected exclusively by this
      -- block's EXCEPTION handler, never by a controlled RETURN.
      -- p_customer_id itself being invalid (a garbage/nonexistent UUID)
      -- is deliberately NOT re-validated here — that check still lives
      -- in the CREATE path's customer-resolution block below and raises
      -- a genuine EXCEPTION (RAISE EXCEPTION, not RETURN), which the
      -- unchanged EXCEPTION handler already rolls back correctly
      -- regardless of position, so moving it earlier would add nothing.
      IF p_customer_id IS NULL AND (p_customer_full_name IS NULL OR btrim(p_customer_full_name) = '') THEN
        v_stage := 'customer_identity_precheck';  -- V10 diagnostic tag
        UPDATE public.email_ingestions
           SET processing_status = 'needs_review',
               error_reason = 'no resolved customer_id and no booking-contact full name to create one',
               processed_at = NOW()
         WHERE id = v_ingestion_id;
        RETURN jsonb_build_object(
          'result', 'manual_review_required',
          'ingestion_id', v_ingestion_id,
          'reason', 'missing booking-contact identity'
        );
      END IF;

      -- ── Step 6a (V10, CORRECTED PLACEMENT): tour auto-provisioning —
      -- positioned HERE: after every zero-write validation above
      -- (passenger completeness, the customer-identity precheck just
      -- above) and BEFORE the actual customer lookup/insert below. By
      -- this line, the only controlled needs_review/manual_review_
      -- required RETURNs reachable WITHOUT having written anything yet
      -- are the two immediately above (both plain RETURNs, neither
      -- preceded by any write) and Step 6b immediately below. From Step
      -- 6a through the end of the CREATE branch, EVERY remaining
      -- statement is either a plain assignment/lookup or a write whose
      -- only failure mode is a genuine EXCEPTION (the customer-
      -- resolution block's p_customer_id-does-not-exist check —
      -- RAISE EXCEPTION, not RETURN — reference-number allocation, the
      -- customer INSERT, the reservation INSERT, the passenger INSERT,
      -- any constraint violation) — all caught by this block's own
      -- EXCEPTION handler further below, which correctly rolls back
      -- EVERYTHING written since entering this nested block, tour/
      -- tour_language/tour_channel/activity_log/customer included. There
      -- is no controlled RETURN anywhere from here to the function's
      -- normal success RETURN. This is what makes "a genuinely new
      -- language-specific tour — and a genuinely new customer — is
      -- created only when the booking is genuinely ready to create a
      -- reservation" actually true, not merely asserted.
      --
      -- Skipped entirely (p_tour_id left exactly as given) unless
      -- p_tour_id is NULL AND the caller explicitly requested
      -- provisioning AND the identity fields it requires are present.
      -- For an already-matched booking (the overwhelmingly common case,
      -- and every pre-V10 caller), this IF is FALSE and nothing here
      -- executes — byte-for-byte the same CREATE branch as V9 for that
      -- case.
      --
      -- NEVER reached for a 'modified' event, a stale event, a second
      -- new_booking for an already-existing reservation, or a
      -- modification with no existing reservation — this code exists
      -- ONLY inside the new_booking + no-existing-reservation branch.
      -- Those other branches never reference p_tour_id at all (the V9
      -- UPDATE path never writes tour_id; V9's other early-return
      -- branches never needed it either), so a modification email that
      -- happens to reference an unmapped product/language is NEVER a
      -- trigger for creating a new tour — see the migration header's
      -- "MODIFIED EVENTS" section.
      IF p_tour_id IS NULL
         AND p_auto_provision_tour
         AND p_civitatis_internal_code IS NOT NULL AND btrim(p_civitatis_internal_code) <> ''
         AND p_tour_language IS NOT NULL AND btrim(p_tour_language) <> ''
      THEN
        -- Blocking, transaction-scoped, identity-keyed lock — a THIRD,
        -- independent namespace (seed 2) from the Step 0 gmail-message
        -- lock (seed 1) and the Step 3 booking lock (seed 0), acquired
        -- strictly AFTER Step 3's lock in every code path that reaches
        -- here (this code is nested inside the CREATE branch, which is
        -- only reachable after Step 3). Every call that could ever
        -- acquire this lock has already acquired Step 3's lock first,
        -- and no call ever acquires them in the reverse order — a fixed,
        -- universal ordering (seed 1 -> seed 0 -> seed 2) across every
        -- code path, which rules out a deadlock cycle by construction.
        -- Blocking (not non-blocking) is deliberate: two simultaneous
        -- FIRST bookings for the SAME (product, language) must both
        -- eventually succeed against ONE shared tour, never one
        -- rejecting the other.
        v_stage := 'tour_provision_lock';
        PERFORM pg_advisory_xact_lock(
          hashtextextended(
            'civitatis_ingest:tour_provision:' || p_source_id::text || ':' ||
            p_civitatis_internal_code || ':' || p_tour_language,
            2
          )
        );

        -- Re-check AFTER acquiring the lock — never trust the caller's
        -- pre-lock snapshot. A concurrent sibling call for the identical
        -- identity may have committed a mapping while this call was
        -- blocked. Deterministic 0/1/>1 count, NOT a plain
        -- "SELECT ... INTO" that would silently take an arbitrary row if
        -- more than one somehow matched — application/RPC correctness
        -- must not depend solely on the partial UNIQUE index backstop
        -- (uq_tour_channels_source_product_language) being what actually
        -- prevents that; this makes the same guarantee explicit and
        -- fail-closed here too.
        --
        -- V12: MIN(tour_id) alone does not exist in stock PostgreSQL —
        -- there is no built-in MIN/MAX aggregate over the uuid type
        -- (unlike its perfectly normal use in ORDER BY / comparisons).
        -- Casting to text first (text DOES have a MIN aggregate), then
        -- casting the single winning value back to uuid, sidesteps that
        -- gap without changing what this statement means: COUNT(*) is
        -- untouched, and the ONLY case where the second column's value
        -- is ever actually used downstream is v_provision_match_count=1
        -- — a single-row group, where "the minimum" and "the only value
        -- present" are trivially the same value regardless of how it was
        -- selected. See this migration file's own header for the full
        -- argument.
        v_stage := 'tour_provision_recheck';
        SELECT COUNT(*), MIN(tour_id::text)::uuid INTO v_provision_match_count, v_provisioned_tour_id
          FROM public.tour_channels
         WHERE source_id = p_source_id
           AND external_product_id = p_civitatis_internal_code
           AND booking_language = p_tour_language;

        IF v_provision_match_count > 1 THEN
          -- Ambiguous configuration discovered AT THE LOCK, independent
          -- of whatever the caller's own pre-lock matching decided —
          -- fail closed exactly like matchTourChannel's own ambiguity
          -- check, never guess. v_provisioned_tour_id is discarded
          -- (MIN(tour_id::text)::uuid above is never used as a real
          -- answer in this branch) and p_tour_id is deliberately left
          -- NULL so the
          -- existing "tour still unresolved" check just below reports
          -- it as a review case, with zero writes attempted.
          v_stage := 'tour_provision_ambiguous';
          v_provisioned_tour_id := NULL;
        ELSIF v_provision_match_count = 0 THEN
          -- Genuinely first-ever booking for this exact (product,
          -- language) pair. Name is the VERBATIM Civitatis internal code
          -- — never translated, decorated, or otherwise altered; the
          -- database permits multiple tours sharing a name (no UNIQUE
          -- constraint on tours.name), and language identity is carried
          -- structurally by tour_languages/tour_channels.booking_language,
          -- not by the display name. status='draft': never bookable/
          -- active until an operator reviews it — but the reservation
          -- below is still created against it normally regardless (draft
          -- is an operator-review state, not a booking-ingestion
          -- blocker). base_price=0/currency='EUR': the same safe neutral
          -- defaults the JS create-tour path already uses for an unset
          -- price — never derived from THIS booking's own retail/net
          -- price, which remains a reservation-level fact only.
          v_stage := 'tour_provision_create_tour';
          INSERT INTO public.tours (name, category, status, base_price, currency)
          VALUES (p_civitatis_internal_code, 'other', 'draft', 0, 'EUR')
          RETURNING id INTO v_provisioned_tour_id;

          v_stage := 'tour_provision_create_language';
          INSERT INTO public.tour_languages (tour_id, language_code, language_name)
          VALUES (v_provisioned_tour_id, p_civitatis_language_code, p_tour_language);

          v_stage := 'tour_provision_create_channel';
          INSERT INTO public.tour_channels (tour_id, source_id, external_product_id, booking_language, is_active)
          VALUES (v_provisioned_tour_id, p_source_id, p_civitatis_internal_code, p_tour_language, TRUE);

          -- Distinct audit trail for the provisioning event itself,
          -- separate from the reservation-created notification this
          -- same CREATE branch inserts a few statements below.
          -- entity_type='tour' and action='created' are both already-
          -- allowed CHECK values (supabase_migration_tour_channels.sql)
          -- — no schema change needed. Reached ONLY on this exact
          -- branch (v_provision_match_count = 0, a genuine first-ever
          -- mapping) — a concurrent sibling that instead finds
          -- v_provision_match_count = 1 (the ELSE branch below) never
          -- reaches this INSERT, so no second "tour created" event is
          -- ever possible for the same identity.
          v_stage := 'tour_provision_activity_log';
          INSERT INTO public.activity_logs (entity_type, entity_id, action, description, metadata, performed_by)
          VALUES (
            'tour', v_provisioned_tour_id, 'created',
            'Yeni Civitatis turu otomatik oluşturuldu: ' || p_civitatis_internal_code,
            jsonb_build_object(
              'auto_provisioned', true,
              'source', 'civitatis',
              'booking_language', p_tour_language,
              'external_product_id', p_civitatis_internal_code,
              'civitatis_booking_id', p_external_booking_id
            ),
            NULL  -- system-generated, no staff session performed this
          );
        END IF;
        -- ELSE (v_provision_match_count = 1): v_provisioned_tour_id
        -- already holds the single existing match from the SELECT above
        -- — reused as-is, nothing written.

        -- Resolved (just-created, reused from an existing/concurrently-
        -- committed mapping, or left NULL by the ambiguous-count branch
        -- above) — everything downstream is unaware whether this arrived
        -- pre-matched from the caller or was resolved right here.
        p_tour_id := v_provisioned_tour_id;
      END IF;

      -- ── Step 6b (V10, CORRECTED PLACEMENT): p_tour_id must be resolved
      -- by now — either from the caller's exact match (unchanged) or
      -- from Step 6a just above. Still NULL here means auto-provisioning
      -- was not requested/eligible (the genuinely fail-closed tour-
      -- matching cases: ambiguous mapping discovered either by the
      -- caller's matchTourChannel or, independently, by Step 6a's own
      -- post-lock recheck; unrecognized/missing language; missing
      -- internal code) or, defensively, something unexpected left it
      -- unset. This is the EXACT SAME "Internal code did not match
      -- tour_channels" needs_review outcome every prior version produced
      -- earlier in Step 2 — evaluated here, immediately after Step 6a and
      -- still before the actual customer lookup/insert below, so this
      -- check (and the RETURN below) is reached with ZERO writes made in
      -- this call (neither tour nor customer — the customer-identity
      -- precheck above already ran with no write of its own either) when
      -- auto-provisioning was never eligible in the first place.
      IF p_tour_id IS NULL THEN
        v_stage := 'tour_unresolved_mark';  -- V9-style diagnostic tag, V10 addition
        v_missing_fields := array_append(v_missing_fields, 'tour_id (Internal code did not match tour_channels)');
        UPDATE public.email_ingestions
           SET processing_status = 'needs_review',
               error_reason = 'missing required field(s): ' || array_to_string(v_missing_fields, ', '),
               processed_at = NOW()
         WHERE id = v_ingestion_id;
        RETURN jsonb_build_object(
          'result', 'manual_review_required',
          'ingestion_id', v_ingestion_id,
          'reason', 'missing required field(s)',
          'missing_fields', to_jsonb(v_missing_fields)
        );
      END IF;

      -- CREATE path. Customer resolution/creation happens ONLY here
      -- (V3 changelog point 4). The "do we have enough to create a
      -- customer" VALIDATION already ran, with zero writes, in the
      -- customer-identity precheck above (V10) — deliberately hoisted
      -- ahead of Step 6a/6b so it can never follow a tour-provisioning
      -- write. What remains here is only the ACTUAL lookup/insert, whose
      -- one remaining failure mode (an invalid p_customer_id) is a
      -- genuine RAISE EXCEPTION, not a RETURN, so it is already safe
      -- regardless of position — correctly caught and rolled back,
      -- tour included, by this block's unchanged EXCEPTION handler.
      v_stage := 'customer_resolution';  -- V9: diagnostic only
      IF p_customer_id IS NOT NULL THEN
        IF NOT EXISTS (SELECT 1 FROM public.customers WHERE id = p_customer_id) THEN
          RAISE EXCEPTION 'ingest_civitatis_booking: provided customer_id % does not exist', p_customer_id;
        END IF;
        v_customer_id := p_customer_id;
      ELSE
        -- p_customer_full_name is already guaranteed non-blank here —
        -- the customer-identity precheck above already returned
        -- manual_review_required if it were not, before this line could
        -- ever be reached.
        v_stage := 'customer_insert';  -- V9: diagnostic only
        INSERT INTO public.customers (full_name, email, phone, source_id, import_type)
        VALUES (p_customer_full_name, p_customer_email, p_customer_phone, p_source_id, 'civitatis')
        RETURNING id INTO v_customer_id;
      END IF;

      v_stage := 'tour_lookup';  -- V9: diagnostic only
      SELECT name INTO v_tour_name FROM public.tours WHERE id = p_tour_id;
      v_stage := 'reference_number_allocation';  -- V9: diagnostic only
      SELECT public.next_ref_number('R', 'reservations', 'reservation_number') INTO v_reservation_number;

      v_stage := 'reservation_insert';  -- V9: diagnostic only
      INSERT INTO public.reservations (
        reservation_number, customer_id, tour_id, source_id, external_booking_id,
        status, payment_status, destination, check_in, check_out, check_in_time,
        pax_adult, pax_child, tour_language, total_amount, currency,
        retail_amount, retail_currency
      ) VALUES (
        v_reservation_number, v_customer_id, p_tour_id, p_source_id, p_external_booking_id,
        'pending_confirmation', 'pending', v_tour_name,
        p_check_in, p_check_in,
        p_check_in_time,
        p_pax_adult, COALESCE(p_pax_child, 0),
        p_tour_language, p_total_amount, p_currency,
        p_retail_amount, p_retail_currency
      )
      RETURNING id INTO v_reservation_id;

      v_result := 'created';

      v_stage := 'passenger_insert';  -- V9: diagnostic only
      INSERT INTO public.reservation_guests (reservation_id, full_name, sort_order)
      SELECT v_reservation_id, (g->>'fullName'),
             CASE WHEN g->>'sortOrder' ~ '^-?\d+$' THEN (g->>'sortOrder')::int ELSE 0 END
        FROM jsonb_array_elements(COALESCE(p_passengers, '[]'::jsonb)) AS g
       WHERE btrim(g->>'fullName') IS NOT NULL AND btrim(g->>'fullName') <> '';
      v_passengers_replaced := TRUE;

      v_stage := 'ingestion_mark_processed';  -- V9: diagnostic only
      UPDATE public.email_ingestions
         SET processing_status = 'processed', reservation_id = v_reservation_id, processed_at = NOW()
       WHERE id = v_ingestion_id;

      v_stage := 'activity_log_insert';  -- V9: diagnostic only
      INSERT INTO public.activity_logs (entity_type, entity_id, action, description, metadata, performed_by)
      VALUES (
        'reservation', v_reservation_id, 'created',
        'Yeni Rezervasyon Geldi: ' || v_reservation_number,
        jsonb_build_object(
          'auto_ingested', true,
          'source', 'civitatis',
          'external_booking_id', p_external_booking_id
        ),
        NULL
      );

    ELSIF v_reservation_id IS NOT NULL AND p_event_type = 'modified' AND v_newer_exists THEN
      v_stage := 'stale_mark_processed';  -- V9: diagnostic only
      UPDATE public.email_ingestions
         SET processing_status = 'processed', reservation_id = v_reservation_id, processed_at = NOW()
       WHERE id = v_ingestion_id;
      RETURN jsonb_build_object(
        'result', 'stale_ignored',
        'ingestion_id', v_ingestion_id,
        'reservation_id', v_reservation_id,
        'customer_id', v_customer_id
      );

    ELSIF v_reservation_id IS NOT NULL AND p_event_type = 'modified' AND NOT v_newer_exists THEN
      v_stage := 'reservation_update';  -- V9: diagnostic only
      UPDATE public.reservations SET
        check_in         = p_check_in,
        check_out        = p_check_in,
        check_in_time     = p_check_in_time,
        pax_adult          = p_pax_adult,
        pax_child           = COALESCE(p_pax_child, 0),
        tour_language        = p_tour_language,
        total_amount          = p_total_amount,
        currency                = p_currency,
        retail_amount            = p_retail_amount,
        retail_currency            = p_retail_currency
      WHERE id = v_reservation_id;

      v_result := 'updated';

      IF v_usable_passenger_count = v_expected_passenger_count AND v_expected_passenger_count > 0 THEN
        v_stage := 'modification_passenger_replace';  -- V9: diagnostic only
        DELETE FROM public.reservation_guests WHERE reservation_id = v_reservation_id;
        INSERT INTO public.reservation_guests (reservation_id, full_name, sort_order)
        SELECT v_reservation_id, (g->>'fullName'),
               CASE WHEN g->>'sortOrder' ~ '^-?\d+$' THEN (g->>'sortOrder')::int ELSE 0 END
          FROM jsonb_array_elements(p_passengers) AS g
         WHERE btrim(g->>'fullName') IS NOT NULL AND btrim(g->>'fullName') <> '';
        v_passengers_replaced := TRUE;
      END IF;

      v_stage := 'ingestion_mark_processed';  -- V9: diagnostic only
      UPDATE public.email_ingestions
         SET processing_status = 'processed', reservation_id = v_reservation_id, processed_at = NOW()
       WHERE id = v_ingestion_id;

    ELSE
      v_stage := 'unexpected_branch';  -- V9: diagnostic only
      UPDATE public.email_ingestions
         SET processing_status = 'needs_review',
             error_reason = 'unexpected event_type/reservation-state combination',
             processed_at = NOW()
       WHERE id = v_ingestion_id;
      RETURN jsonb_build_object(
        'result', 'manual_review_required',
        'ingestion_id', v_ingestion_id,
        'reason', 'unexpected event_type/reservation-state combination'
      );
    END IF;

    RETURN jsonb_build_object(
      'result', v_result,
      'ingestion_id', v_ingestion_id,
      'reservation_id', v_reservation_id,
      'customer_id', v_customer_id,
      'passengers_replaced', v_passengers_replaced,
      'tour_id', p_tour_id,
      'tour_auto_provisioned', (p_auto_provision_tour AND v_provisioned_tour_id IS NOT NULL)
    );

  EXCEPTION WHEN OTHERS THEN
    v_error_text := SQLERRM;

    GET STACKED DIAGNOSTICS
      v_diag_sqlstate  = RETURNED_SQLSTATE,
      v_diag_constraint = CONSTRAINT_NAME,
      v_diag_table      = TABLE_NAME,
      v_diag_column     = COLUMN_NAME,
      v_diag_detail     = PG_EXCEPTION_DETAIL,
      v_diag_hint       = PG_EXCEPTION_HINT,
      v_diag_context    = PG_EXCEPTION_CONTEXT;

    v_error_text := format(
      'stage=%s; error=%s; sqlstate=%s; constraint=%s; table=%s; column=%s; detail=%s; hint=%s',
      COALESCE(v_stage, 'unknown'),
      v_error_text,
      COALESCE(v_diag_sqlstate, '-'),
      COALESCE(NULLIF(v_diag_constraint, ''), '-'),
      COALESCE(NULLIF(v_diag_table, ''), '-'),
      COALESCE(NULLIF(v_diag_column, ''), '-'),
      COALESCE(NULLIF(v_diag_detail, ''), '-'),
      COALESCE(NULLIF(v_diag_hint, ''), '-')
    );

    UPDATE public.email_ingestions
       SET processing_status = 'failed',
           error_reason = v_error_text,
           processed_at = NOW()
     WHERE id = v_ingestion_id;

    RETURN jsonb_build_object(
      'result', 'failed',
      'ingestion_id', v_ingestion_id,
      'error', v_error_text,
      'stage', COALESCE(v_stage, 'unknown'),
      'diagnostics', jsonb_build_object(
        'sqlstate', v_diag_sqlstate,
        'constraint_name', NULLIF(v_diag_constraint, ''),
        'table_name', NULLIF(v_diag_table, ''),
        'column_name', NULLIF(v_diag_column, ''),
        'detail', NULLIF(v_diag_detail, ''),
        'hint', NULLIF(v_diag_hint, ''),
        'context', LEFT(COALESCE(v_diag_context, ''), 1000)
      )
    );
  END;
END;
$$;

COMMENT ON FUNCTION public.ingest_civitatis_booking IS
  'Atomically ingests one already-parsed Civitatis booking-notification '
  'email, matched OR flagged provisionable by api/_civitatis/matching.js. '
  'On the CREATE path: resolves/creates the booking-contact customer, '
  'resolves or (V10, when p_auto_provision_tour=TRUE and no exact '
  'tour_channels mapping exists yet) automatically creates a new '
  'language-specific draft tour + its Civitatis mapping under a '
  'transaction-scoped advisory lock keyed on the exact (source, '
  'external_product_id, booking_language) identity, creates the '
  'reservation, inserts passengers, records the email_ingestions audit '
  'row, and inserts activity_logs notifications (one for the '
  'reservation, and — only on a genuine first-ever tour auto-'
  'provisioning event — one for the new tour). On the UPDATE path: '
  'updates ONLY the Civitatis-allowed reservation fields and, only when '
  'the passenger payload is complete, replaces reservation_guests. Never '
  'touches customer identity on UPDATE, never creates a second activity '
  'row, never re-provisions or duplicates an existing tour mapping. A '
  'stale modification, a modification with no existing reservation, a '
  'second new_booking for an already-existing reservation, an unmapped '
  'tour with auto-provisioning not requested or not eligible, or a call '
  'missing any other required field has ZERO business-state side '
  'effects and is reported distinctly. Any unexpected error rolls back '
  'ALL business writes for that call, including any tour just auto-'
  'provisioned, while still recording a ''failed'' audit row. '
  'Re-invoking with a gmail_message_id whose prior attempt is '
  '''processed'' is always a no-op (already_processed) — the only '
  'permanently terminal state. Re-invoking one whose prior attempt is '
  '''failed'' OR ''needs_review'' (V10) atomically reclaims that SAME '
  'row and reprocesses it as a fresh attempt, giving auto-provisioning '
  'a fresh chance to resolve a previously-unmapped tour. A non-blocking, '
  'gmail_message_id-scoped advisory lock guarantees at most one '
  'concurrent caller can ever claim or retry a given Gmail message. A '
  'SEPARATE, blocking, (source,external_product_id,booking_language)-'
  'scoped advisory lock (V10) guarantees at most one CRM tour is ever '
  'auto-provisioned per exact product+language identity, even under '
  'true concurrency, while unrelated product/language identities '
  'provision fully in parallel. SECURITY DEFINER; callable only by '
  'service_role — see this migration file''s header for the full '
  'contract. Never call directly from browser code.';


-- ──────────────────────────────────────────────────────────────────────────
-- SECURITY: restrict EXECUTE to service_role only.
-- Idempotent: REVOKE/GRANT can be re-run any number of times safely.
-- NEW 26-parameter signature — MUST match the CREATE FUNCTION above
-- exactly, or these statements would silently apply to nothing.
-- ──────────────────────────────────────────────────────────────────────────

REVOKE ALL ON FUNCTION public.ingest_civitatis_booking(
  TEXT, TEXT, TIMESTAMPTZ, TEXT, TEXT, TEXT, UUID, TEXT, UUID, TEXT, DATE, TIME,
  INTEGER, INTEGER, NUMERIC, TEXT, NUMERIC, TEXT, UUID, TEXT, TEXT, TEXT, JSONB,
  BOOLEAN, TEXT, TEXT
) FROM PUBLIC;

REVOKE ALL ON FUNCTION public.ingest_civitatis_booking(
  TEXT, TEXT, TIMESTAMPTZ, TEXT, TEXT, TEXT, UUID, TEXT, UUID, TEXT, DATE, TIME,
  INTEGER, INTEGER, NUMERIC, TEXT, NUMERIC, TEXT, UUID, TEXT, TEXT, TEXT, JSONB,
  BOOLEAN, TEXT, TEXT
) FROM anon;

REVOKE ALL ON FUNCTION public.ingest_civitatis_booking(
  TEXT, TEXT, TIMESTAMPTZ, TEXT, TEXT, TEXT, UUID, TEXT, UUID, TEXT, DATE, TIME,
  INTEGER, INTEGER, NUMERIC, TEXT, NUMERIC, TEXT, UUID, TEXT, TEXT, TEXT, JSONB,
  BOOLEAN, TEXT, TEXT
) FROM authenticated;

GRANT EXECUTE ON FUNCTION public.ingest_civitatis_booking(
  TEXT, TEXT, TIMESTAMPTZ, TEXT, TEXT, TEXT, UUID, TEXT, UUID, TEXT, DATE, TIME,
  INTEGER, INTEGER, NUMERIC, TEXT, NUMERIC, TEXT, UUID, TEXT, TEXT, TEXT, JSONB,
  BOOLEAN, TEXT, TEXT
) TO service_role;

COMMIT;

-- ── END OF MIGRATION ────────────────────────────────────────────────────────
