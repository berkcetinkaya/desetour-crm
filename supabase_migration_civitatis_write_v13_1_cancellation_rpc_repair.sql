-- ============================================================
-- DESE TOUR OPERATIONS CENTER
-- Migration: Civitatis CANCELLATION Write RPC — REPAIR
-- ============================================================
-- File:    supabase_migration_civitatis_write_v13_1_cancellation_rpc_repair.sql
--
-- WHY THIS MIGRATION EXISTS
-- ─────────────────────────────────────────────────────────────
-- Production evidence, all three pieces pointing the same way:
--   1. supabase_migration_civitatis_write_v13_cancellation.sql was
--      manually applied in the Supabase SQL Editor, which reported
--      "Success. No rows returned."
--   2. A direct, read-only production catalog query —
--        SELECT p.oid, n.nspname, p.proname, p.pronargs,
--               pg_get_function_identity_arguments(p.oid)
--          FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
--         WHERE p.proname = 'cancel_civitatis_booking';
--      — returned ZERO rows. public.cancel_civitatis_booking does not
--      exist in production, full stop — this is not a PostgREST
--      schema-cache staleness question (a stale cache would still show
--      the function via a direct pg_proc query; it does not exist at
--      all).
--   3. A real scheduler run (external_booking_id 38807986) failed with
--      "Could not find the function public.cancel_civitatis_booking(...)
--      in the schema cache" — consistent with #2, not contradicting it.
--
-- ROOT CAUSE (audited directly against the exact committed file,
-- supabase_migration_civitatis_write_v13_cancellation.sql, line by
-- line): no defect was found in the file itself. Its BEGIN;/COMMIT;
-- pair is single and correctly matched (lines 156/636 of that file);
-- its two dollar-quoted blocks (the preflight DO $$ ... END $$; at
-- lines 158-202, and the function body AS $$ ... $$; at lines 243-582)
-- are both cleanly opened and closed, with no stray or nested $$
-- anywhere else in the file (confirmed by direct grep — exactly 4
-- occurrences, forming exactly those 2 pairs); the preflight DO block
-- has no code path that "skips" a later top-level statement without
-- erroring (a DO block either RAISEs — which aborts the WHOLE
-- transaction with a loud, unmissable ERROR, never a silent "Success"
-- — or completes and execution simply continues to the next statement);
-- CREATE OR REPLACE FUNCTION is a clean top-level statement, never
-- nested inside a string, comment, or block; and the function's own
-- PL/pgSQL BEGIN/END nesting is balanced (one outer frame, one nested
-- exception-handling block, closed by exactly two END; before the
-- final $$;). A file with any of those defects would not produce
-- "Success. No rows returned" for the WHOLE script — a broken
-- dollar-quote or a genuinely malformed CREATE FUNCTION statement
-- produces a loud Postgres parse/syntax ERROR at the point of failure,
-- not blanket success covering statements after it.
--
-- Given the file is internally sound end-to-end, and would create the
-- function if executed to completion, the single most parsimonious
-- explanation consistent with EVERY piece of evidence — no error
-- reported, yet the function does not exist — is that only PART of the
-- 639-line file actually reached Postgres during the manual apply (for
-- example: a partial clipboard paste, or only a portion of the SQL
-- Editor buffer being selected/run). This migration does not depend on
-- confirming that theory to be safe to apply — see "SAFE REGARDLESS OF
-- HOW FAR V13 GOT" below.
--
-- WHAT V13 IS CONFIRMED TO HAVE DONE VS. UNKNOWN
-- ─────────────────────────────────────────────────────────────
-- CONFIRMED (from the evidence above): public.cancel_civitatis_booking
-- does not exist. CONFIRMED UNTOUCHED: public.ingest_civitatis_booking
-- and every V10/V11/V12 object — nothing in V13 or in this repair ever
-- references them except in read-only preflight checks. NOT YET
-- CONFIRMED from the evidence available in this session: whether
-- email_ingestions.event_type's CHECK constraint was actually widened
-- to permit 'cancelled' (V13's Step 1, which comes BEFORE the function
-- definition in file order — so if the partial-apply theory is right
-- and the paste ran out partway through, Step 1 may or may not have
-- been reached). This repair does not need that question answered
-- first — see below — but the exact same read-only style query used
-- above, run against email_ingestions_event_type_check's definition
-- (e.g. SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE
-- conname = 'email_ingestions_event_type_check'), would answer it if
-- wanted for the record.
--
-- SAFE REGARDLESS OF HOW FAR V13 GOT
-- ─────────────────────────────────────────────────────────────
-- This repair re-applies the CHECK widen (Step 1) using the exact same
-- idempotent DROP CONSTRAINT IF EXISTS + ADD CONSTRAINT pattern V13
-- itself used — safe to run whether V13's Step 1 already succeeded
-- (a pure no-op: dropping and recreating an identical constraint) or
-- never ran at all (creates it for the first time). It then
-- CREATE OR REPLACE FUNCTIONs cancel_civitatis_booking with the
-- EXACT, byte-for-byte already-reviewed V13 function body (extracted
-- directly from the committed V13 file, not retyped, to eliminate any
-- risk of semantic drift between "V13 as reviewed" and "what this
-- repair actually installs") — safe whether the function already
-- exists (replaces it in place, identical definition) or does not
-- (creates it for the first time). ingest_civitatis_booking and every
-- V12 object are never referenced except by the same read-only
-- preflight check V13 itself used.
--
-- NEW IN THIS REPAIR: POSTFLIGHT VERIFICATION
-- ─────────────────────────────────────────────────────────────
-- V13 had a preflight (checked prerequisites BEFORE creating anything)
-- but no postflight — nothing that would have caught "the CREATE
-- FUNCTION statement itself was silently never reached." This repair
-- adds one: immediately after the REVOKE/GRANT block, a second DO $$
-- block re-queries pg_proc for cancel_civitatis_booking with the exact
-- expected 7-parameter signature (same oidvector-comparison technique
-- V12's own twice-corrected preflight established) and RAISEs an
-- EXCEPTION — aborting the whole transaction, so nothing partial is
-- ever left committed — if it is not found. This directly closes the
-- exact gap that let this incident go unnoticed as "Success."
--
-- ALSO: an explicit `NOTIFY pgrst, 'reload schema';` after COMMIT,
-- so that even if PostgREST's schema cache were stale for any reason
-- (ruled out as the root cause here, but harmless and cheap to send
-- regardless), the newly (re)created function becomes callable via
-- supabase.rpc(...) immediately rather than waiting for PostgREST's
-- own periodic reload.
--
-- WHAT THIS REPAIR DELIBERATELY DOES NOT DO
-- ─────────────────────────────────────────────────────────────
-- Does not touch public.ingest_civitatis_booking in any way (signature,
-- body, or permissions) — confirmed by this file containing no
-- CREATE/ALTER/DROP referencing it, only the same read-only preflight
-- SELECT V13 itself used. Does not touch V10/V12 tour auto-provisioning.
-- Does not change the already-reviewed cancellation semantics in any
-- way — the function body is a verbatim copy, not a rewrite. Does not
-- delete, update, or otherwise touch any row in reservations, customers,
-- tours, payments, guide_payments, reservation_guests, or activity_logs.
--
-- HOW TO APPLY (once reviewed and approved — NOT done as part of
-- producing this file)
-- ─────────────────────────────────────────────────────────────
-- Supabase Dashboard → SQL Editor → paste and run this file IN FULL —
-- given this repair exists specifically because a prior apply may not
-- have reached the end of its file, take particular care this time to
-- confirm the editor's response after running reflects the ENTIRE
-- script (the postflight's own RAISE NOTICE / success path, or a clean
-- "Success" after the whole file, not merely after a prefix of it).
-- Wrapped in an explicit BEGIN/COMMIT, same convention as every prior
-- migration in this series, so a failed preflight OR the new postflight
-- aborts the whole transaction rather than leaving anything partial.
-- ============================================================


BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'email_ingestions' AND column_name = 'event_type'
  ) THEN
    RAISE EXCEPTION 'V13.1 PREFLIGHT FAILED: public.email_ingestions.event_type does not exist. Apply supabase_migration_civitatis_ingestion.sql BEFORE this migration. Aborting before touching anything.';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
      JOIN pg_class t ON t.oid = c.conrelid
     WHERE t.relname = 'reservations' AND c.conname = 'reservations_source_id_external_booking_id_key'
  ) THEN
    RAISE EXCEPTION 'V13.1 PREFLIGHT FAILED: unique constraint public.reservations_source_id_external_booking_id_key does not exist. Apply supabase_migration_civitatis_ingestion.sql BEFORE this migration. Aborting before touching anything.';
  END IF;

  -- Same structural, OID-based signature check V13's own preflight used,
  -- confirming ingest_civitatis_booking (V10/V11/V12) is live. This
  -- repair never creates, replaces, or alters that function — read-only.
  IF NOT EXISTS (
    SELECT 1
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname = 'ingest_civitatis_booking'
       AND p.pronargs = 26
       AND p.proargtypes = array_to_string(
             ARRAY[
               'text', 'text', 'timestamptz', 'text', 'text', 'text', 'uuid', 'text', 'uuid', 'text',
               'date', 'time', 'integer', 'integer', 'numeric', 'text', 'numeric', 'text', 'uuid',
               'text', 'text', 'text', 'jsonb', 'boolean', 'text', 'text'
             ]::regtype[]::oid[],
             ' '
           )::oidvector
  ) THEN
    RAISE EXCEPTION 'V13.1 PREFLIGHT FAILED: public.ingest_civitatis_booking with the expected 26-parameter V10/V11/V12 signature was not found. Confirm V12 is live before applying this repair. Aborting before touching anything.';
  END IF;

  RAISE NOTICE 'V13.1 PREFLIGHT PASSED: prerequisites present. Proceeding to (re)create public.cancel_civitatis_booking.';
END $$;

-- ──────────────────────────────────────────────────────────────────────────
-- STEP 1: widen email_ingestions.event_type to permit 'cancelled'.
-- Idempotent: DROP CONSTRAINT IF EXISTS before ADD CONSTRAINT — same
-- pattern already used for activity_logs.entity_type/action and
-- tours.status/category/tour_type. Purely additive: every row that was
-- already valid ('new_booking'/'modified'/'unknown') remains valid; no
-- existing row is touched, revalidated-away, or deleted.
-- ──────────────────────────────────────────────────────────────────────────

ALTER TABLE public.email_ingestions DROP CONSTRAINT IF EXISTS email_ingestions_event_type_check;
ALTER TABLE public.email_ingestions ADD CONSTRAINT email_ingestions_event_type_check
  CHECK (event_type IN ('new_booking','modified','unknown','cancelled'));

COMMENT ON COLUMN public.email_ingestions.event_type IS 'new_booking | modified | cancelled | unknown. V13: cancelled added — the one-line additive widen this column''s original comment explicitly anticipated.';


-- ──────────────────────────────────────────────────────────────────────────
-- FUNCTION: cancel_civitatis_booking
-- One call = one Civitatis cancellation email (a single Gmail message).
-- Locates the existing reservation by (source_id, external_booking_id)
-- and marks it cancelled. NEVER deletes, NEVER creates a reservation/
-- customer/tour, NEVER touches financial data, NEVER erases the guide
-- assignment. See this migration file's header for the full contract.
-- ──────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.cancel_civitatis_booking(
  p_gmail_message_id    TEXT,
  p_gmail_thread_id     TEXT,
  p_received_at         TIMESTAMPTZ,
  p_raw_subject         TEXT,
  p_raw_body_snapshot   TEXT,
  p_source_id           UUID,
  p_external_booking_id TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_ingestion_id       UUID;
  v_existing_status     TEXT;
  v_existing_res_id      UUID;
  v_missing_fields         TEXT[] := '{}';
  v_match_count               INTEGER;
  v_reservation_id                UUID;
  v_current_status                 TEXT;
  v_reservation_number              TEXT;
  v_customer_id                      UUID;
  v_tour_id                           UUID;
  v_check_in                           DATE;
  v_customer_name                       TEXT;
  v_tour_name                            TEXT;
  v_stage                                  TEXT;
  v_error_text                              TEXT;
  v_diag_sqlstate                            TEXT;
  v_diag_constraint                           TEXT;
  v_diag_table                                 TEXT;
  v_diag_column                                 TEXT;
  v_diag_detail                                  TEXT;
  v_diag_hint                                     TEXT;
  v_diag_context                                   TEXT;
BEGIN
  -- ── Step 0: non-blocking, gmail_message_id-scoped processing lock —
  -- SAME shape as ingest_civitatis_booking's own Step 0. Seed 1 is
  -- reused (not a THIRD distinct seed): the two functions' Step-0 locks
  -- are always keyed by DIFFERENT gmail_message_id strings (a
  -- cancellation email and a new-booking email are two different Gmail
  -- messages with two different IDs), so reusing the same seed integer
  -- creates no collision risk between them.
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

  -- ── Step 1: Gmail-message-level idempotency, with safe retry for a
  -- previously-failed OR previously-needs_review attempt at the SAME
  -- message — the EXACT same conditional UPSERT shape as
  -- ingest_civitatis_booking's own Step 1. This is also exactly how
  -- requirement 9 (cancellation arriving before the original booking is
  -- ingested) resolves itself automatically: that first attempt returns
  -- manual_review_required (Step 3 below) and leaves this row at
  -- processing_status='needs_review', which THIS SAME conditional
  -- UPSERT reclaims on the next scheduled run that re-discovers the
  -- same Gmail message inside the normal 24h overlap window — no
  -- special-cased retry logic needed anywhere else.
  INSERT INTO public.email_ingestions (
    gmail_message_id, gmail_thread_id, external_booking_id, source_id,
    event_type, processing_status, raw_subject, raw_body_snapshot, received_at
  ) VALUES (
    p_gmail_message_id, p_gmail_thread_id, p_external_booking_id, p_source_id,
    'cancelled', 'received', p_raw_subject, p_raw_body_snapshot,
    COALESCE(p_received_at, NOW())
  )
  ON CONFLICT (gmail_message_id) DO UPDATE
    SET processing_status = 'received',
        error_reason      = NULL,
        processed_at      = NULL
    WHERE public.email_ingestions.processing_status IN ('failed', 'needs_review')
  RETURNING id INTO v_ingestion_id;

  IF v_ingestion_id IS NULL THEN
    -- An existing 'processed' row — the only permanently terminal state
    -- — INCLUDING an already-cancelled reservation's original
    -- cancellation email being re-discovered: this is exactly the
    -- idempotent "process the same cancellation email multiple times"
    -- case (requirement 8), and it is a pure no-op here with zero new
    -- writes, before Step 2 even runs.
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

  -- ── Step 2: required-field validation — before any read/write of
  -- reservations. Both fields are always supplied by the only real
  -- caller (api/_civitatis/cancellationAdapter.js), but validated
  -- explicitly anyway, same discipline as ingest_civitatis_booking's own
  -- Step 2, and fails the SAME way (needs_review, retryable) rather than
  -- raising an exception for a caller-shape problem.
  IF p_source_id IS NULL THEN
    v_missing_fields := array_append(v_missing_fields, 'source_id');
  END IF;
  IF p_external_booking_id IS NULL OR btrim(p_external_booking_id) = '' THEN
    v_missing_fields := array_append(v_missing_fields, 'external_booking_id');
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

  BEGIN -- nested block: any unexpected error rolls back the reservation
        -- UPDATE and the activity_logs INSERT below (but NOT the
        -- email_ingestions row from Step 1, re-recorded as 'failed'
        -- after the implicit rollback-to-savepoint — identical pattern
        -- to ingest_civitatis_booking).
    v_stage := 'nested_block_entry';

    -- ── Step 3: booking-level advisory lock — the EXACT SAME lock
    -- namespace/key ingest_civitatis_booking's own Step 3 already uses.
    -- See this migration's header for why this is what makes the
    -- ordering problem (requirement 9) safe by construction: a
    -- cancellation and a new-booking/modified write for the SAME
    -- external_booking_id can never execute concurrently.
    v_stage := 'booking_advisory_lock';
    PERFORM pg_advisory_xact_lock(
      hashtextextended(p_source_id::text || ':' || p_external_booking_id, 0)
    );

    -- ── Step 4: exact reservation match — deliberately TWO plain
    -- queries (COUNT(*) first, then a separate SELECT only when exactly
    -- one row matches) rather than one combined
    -- "SELECT COUNT(*), <aggregate>(id)" statement: id is UUID, and
    -- Postgres ships no MIN/MAX aggregate for uuid — the exact defect
    -- V12 (supabase_migration_civitatis_write_v12_uuid_recheck_fix.sql)
    -- had to fix elsewhere in this same RPC family. This two-query shape
    -- has no aggregate-type risk at all, by construction, and reservations_
    -- source_id_external_booking_id_key already guarantees v_match_count
    -- can only ever be 0 or 1 in practice — the >1 branch below exists
    -- purely as the same explicit, never-guess fail-closed discipline
    -- ingest_civitatis_booking's own tour_channels re-check already uses,
    -- not because this schema can actually produce it.
    v_stage := 'reservation_match_count';
    SELECT COUNT(*) INTO v_match_count
      FROM public.reservations
     WHERE source_id = p_source_id AND external_booking_id = p_external_booking_id;

    IF v_match_count = 0 THEN
      -- Zero matches: the original booking has not been (successfully)
      -- ingested yet, or was never eligible. NEVER create a reservation,
      -- customer, or tour from a cancellation — report needs_review and
      -- stop. Retryable: Step 1's reclaim picks this row up again on a
      -- later scheduled run once (if) the original booking exists by
      -- then. Never permanently terminal.
      v_stage := 'zero_match_mark';
      UPDATE public.email_ingestions
         SET processing_status = 'needs_review',
             error_reason = 'no matching reservation found for source_id/external_booking_id — the original booking may not be ingested yet',
             processed_at = NOW()
       WHERE id = v_ingestion_id;
      RETURN jsonb_build_object(
        'result', 'manual_review_required',
        'ingestion_id', v_ingestion_id,
        'reason', 'no matching reservation found — original booking may not be ingested yet'
      );
    ELSIF v_match_count > 1 THEN
      -- Structurally should never happen (the UNIQUE constraint
      -- prevents it) — fail closed exactly like every other ambiguity
      -- check in this RPC family, never guess/choose arbitrarily.
      v_stage := 'ambiguous_match_mark';
      UPDATE public.email_ingestions
         SET processing_status = 'needs_review',
             error_reason = 'more than one reservation matches this exact source_id/external_booking_id — ambiguous, never auto-resolved',
             processed_at = NOW()
       WHERE id = v_ingestion_id;
      RETURN jsonb_build_object(
        'result', 'manual_review_required',
        'ingestion_id', v_ingestion_id,
        'reason', 'ambiguous: more than one reservation matches this exact source_id/external_booking_id'
      );
    END IF;

    -- Exactly one match — lock the row (FOR UPDATE) before branching on
    -- its current status, so a concurrent cancel attempt for the same
    -- reservation (e.g. a genuine duplicate cancellation email, already
    -- serialized by the booking-level lock above, but defensive in
    -- depth) can never race this read.
    v_stage := 'reservation_lookup';
    SELECT id, status, reservation_number, customer_id, tour_id, check_in
      INTO v_reservation_id, v_current_status, v_reservation_number, v_customer_id, v_tour_id, v_check_in
      FROM public.reservations
     WHERE source_id = p_source_id AND external_booking_id = p_external_booking_id
     FOR UPDATE;

    IF v_current_status = 'cancelled' THEN
      -- ── Idempotency (requirement 8): already cancelled — a pure
      -- no-op. NEVER re-writes reservations, NEVER inserts a second
      -- activity_logs row (which would duplicate the staff
      -- notification) — the append-only audit trail stays exactly one
      -- 'cancelled' entry per reservation, no matter how many times its
      -- cancellation email is reprocessed within the retry window.
      v_stage := 'already_cancelled_mark';
      UPDATE public.email_ingestions
         SET processing_status = 'processed', reservation_id = v_reservation_id, processed_at = NOW()
       WHERE id = v_ingestion_id;
      RETURN jsonb_build_object(
        'result', 'already_cancelled',
        'ingestion_id', v_ingestion_id,
        'reservation_id', v_reservation_id,
        'customer_id', v_customer_id,
        'tour_id', v_tour_id
      );
    END IF;

    -- ── Step 5: the ONLY write this function ever makes to
    -- reservations — exactly THREE columns. Every other column
    -- (customer_id, tour_id, guide_name, all financial columns,
    -- pax_adult/pax_child, check_in/check_out, notes, internal_notes,
    -- everything else) is left completely untouched by this UPDATE,
    -- preserving full historical/operational context. cancel_reason is
    -- always this SAME fixed, honest string — never inferred/guessed
    -- from the cancellation email's own text, which this function does
    -- not even parse.
    v_stage := 'reservation_cancel';
    UPDATE public.reservations
       SET status = 'cancelled',
           cancelled_at = NOW(),
           cancel_reason = 'Civitatis cancellation email received (external booking id ' || p_external_booking_id || ')'
     WHERE id = v_reservation_id;

    -- Best-effort human-readable enrichment for the notification's
    -- metadata only (requirement 5: "customer name if available, tour,
    -- tour date") — never required for the cancellation itself to
    -- succeed; a lookup miss (e.g. a since-deleted customer/tour row)
    -- simply leaves the corresponding metadata field null, exactly like
    -- ingest_civitatis_booking's own "if available" fields elsewhere.
    IF v_customer_id IS NOT NULL THEN
      SELECT full_name INTO v_customer_name FROM public.customers WHERE id = v_customer_id;
    END IF;
    IF v_tour_id IS NOT NULL THEN
      SELECT name INTO v_tour_name FROM public.tours WHERE id = v_tour_id;
    END IF;

    -- ── Step 6: the persistent staff notification (requirement 5) —
    -- SAME shape (entity_type/metadata.auto_ingested=true/
    -- performed_by=NULL) as ingest_civitatis_booking's own "Yeni
    -- Rezervasyon Geldi" notification, so the existing NotificationBell/
    -- getReservationNotifications()/activity_log_reads machinery picks
    -- it up with ZERO frontend change and stays unread until a staff
    -- member opens it (activity_logs itself is never mutated — a read
    -- is recorded as a SEPARATE activity_log_reads row, exactly as
    -- already established for every other auto-ingested notification).
    v_stage := 'activity_log_insert';
    INSERT INTO public.activity_logs (entity_type, entity_id, action, description, metadata, performed_by)
    VALUES (
      'reservation', v_reservation_id, 'cancelled',
      'Civitatis Rezervasyonu İptal Edildi: ' || v_reservation_number,
      jsonb_build_object(
        'auto_ingested', true,
        'source', 'civitatis',
        'external_booking_id', p_external_booking_id,
        'reservation_number', v_reservation_number,
        'customer_id', v_customer_id,
        'customer_name', v_customer_name,
        'tour_id', v_tour_id,
        'tour_name', v_tour_name,
        'tour_date', v_check_in
      ),
      NULL
    );

    v_stage := 'ingestion_mark_processed';
    UPDATE public.email_ingestions
       SET processing_status = 'processed', reservation_id = v_reservation_id, processed_at = NOW()
     WHERE id = v_ingestion_id;

    RETURN jsonb_build_object(
      'result', 'cancelled',
      'ingestion_id', v_ingestion_id,
      'reservation_id', v_reservation_id,
      'customer_id', v_customer_id,
      'tour_id', v_tour_id
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

COMMENT ON FUNCTION public.cancel_civitatis_booking IS
  'Atomically processes one Civitatis cancellation email. Locates the '
  'existing reservation by the EXACT (source_id, external_booking_id) '
  'identity and, when exactly one match is found and it is not already '
  'cancelled, sets status=''cancelled'', cancelled_at=NOW(), and a fixed '
  'cancel_reason — never any other column. NEVER deletes a reservation, '
  'NEVER creates a reservation/customer/tour, NEVER triggers tour '
  'auto-provisioning, NEVER touches payments/guide_payments/guide '
  'assignment/reservation_guests. Zero matches or more than one match '
  'both report manual_review_required (fail closed, never guessed) and '
  'leave a retryable email_ingestions row — the SAME failed/needs_review '
  'reclaim semantics ingest_civitatis_booking already uses, so a '
  'cancellation that arrives before its original booking has been '
  'ingested safely retries on a later scheduled run rather than being '
  'permanently stuck. An already-cancelled reservation returns '
  'already_cancelled with zero additional writes (idempotent — no '
  'duplicate notification). On success, records a persistent staff '
  'notification via activity_logs (entity_type=''reservation'', '
  'action=''cancelled'', metadata.auto_ingested=true) using the EXACT '
  'SAME shape the existing ''Yeni Rezervasyon Geldi'' notification '
  'already uses, so the existing NotificationBell/activity_log_reads '
  'read-receipt machinery requires zero changes. A booking-identity- '
  'scoped advisory lock (SAME namespace as ingest_civitatis_booking''s '
  'own Step 3) guarantees this can never run concurrently with a '
  'new_booking/modified write for the same booking. SECURITY DEFINER; '
  'callable only by service_role — see this migration file''s header '
  'for the full contract. Never call directly from browser code.';


-- ──────────────────────────────────────────────────────────────────────────
-- SECURITY: restrict EXECUTE to service_role only. Idempotent: REVOKE/
-- GRANT can be re-run any number of times safely. 7-parameter signature
-- — MUST match the CREATE FUNCTION above exactly, or these statements
-- would silently apply to nothing.
-- ──────────────────────────────────────────────────────────────────────────

REVOKE ALL ON FUNCTION public.cancel_civitatis_booking(
  TEXT, TEXT, TIMESTAMPTZ, TEXT, TEXT, UUID, TEXT
) FROM PUBLIC;

REVOKE ALL ON FUNCTION public.cancel_civitatis_booking(
  TEXT, TEXT, TIMESTAMPTZ, TEXT, TEXT, UUID, TEXT
) FROM anon;

REVOKE ALL ON FUNCTION public.cancel_civitatis_booking(
  TEXT, TEXT, TIMESTAMPTZ, TEXT, TEXT, UUID, TEXT
) FROM authenticated;

GRANT EXECUTE ON FUNCTION public.cancel_civitatis_booking(
  TEXT, TEXT, TIMESTAMPTZ, TEXT, TEXT, UUID, TEXT
) TO service_role;


-- ──────────────────────────────────────────────────────────────────────────
-- POSTFLIGHT VERIFICATION (NEW in this repair — V13 itself had none)
-- This is the exact gap that let the production incident go unnoticed as
-- "Success. No rows returned.": nothing re-checked, after CREATE FUNCTION,
-- that the function actually landed in pg_proc. This block closes it —
-- same OID-based, oidvector-vs-oidvector comparison technique as every
-- preflight in this series (never a general-array cast, which is exactly
-- what caused the two false negatives fixed during V12's preflight).
-- If the function is not found with this EXACT 7-parameter signature
-- immediately after the CREATE OR REPLACE FUNCTION above, this RAISEs an
-- EXCEPTION, which aborts the ENTIRE transaction (including the Step 1
-- CHECK widen) — so this repair can never again report a bare "Success"
-- while silently failing to install the function.
-- ──────────────────────────────────────────────────────────────────────────

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname = 'cancel_civitatis_booking'
       AND p.pronargs = 7
       AND p.proargtypes = array_to_string(
             ARRAY['text','text','timestamptz','text','text','uuid','text']::regtype[]::oid[],
             ' '
           )::oidvector
  ) THEN
    RAISE EXCEPTION 'V13.1 POSTFLIGHT FAILED: public.cancel_civitatis_booking(TEXT, TEXT, TIMESTAMPTZ, TEXT, TEXT, UUID, TEXT) was NOT found in pg_proc immediately after CREATE OR REPLACE FUNCTION. This means the CREATE FUNCTION statement above did not actually execute (e.g. this script was only partially run/pasted) — aborting the whole transaction so this can never silently report success again. Re-run this ENTIRE file, in full, in a single SQL Editor execution.';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
      JOIN pg_class t ON t.oid = c.conrelid
     WHERE t.relname = 'email_ingestions'
       AND c.conname = 'email_ingestions_event_type_check'
       AND pg_get_constraintdef(c.oid) LIKE '%''cancelled''%'
  ) THEN
    RAISE EXCEPTION 'V13.1 POSTFLIGHT FAILED: email_ingestions_event_type_check does not permit ''cancelled'' after Step 1 ran. Aborting — re-run this ENTIRE file in a single execution.';
  END IF;

  RAISE NOTICE 'V13.1 POSTFLIGHT PASSED: public.cancel_civitatis_booking exists with the exact expected 7-parameter signature, and email_ingestions.event_type permits ''cancelled''. Repair verified complete.';
END $$;

COMMIT;

-- Force PostgREST to pick up the (re)created function immediately, rather
-- than waiting for its own periodic schema-cache reload. Harmless no-op if
-- PostgREST's cache was never actually stale (ruled out as the root cause
-- of this incident, but this is cheap and correct to send regardless).
NOTIFY pgrst, 'reload schema';

-- ============================================================
-- END OF MIGRATION supabase_migration_civitatis_write_v13_1_cancellation_rpc_repair.sql
-- ============================================================
