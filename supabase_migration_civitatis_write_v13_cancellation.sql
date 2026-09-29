-- ============================================================
-- DESE TOUR OPERATIONS CENTER
-- Migration: Civitatis Email Ingestion — CANCELLATION Write RPC
-- ============================================================
-- File:    supabase_migration_civitatis_write_v13_cancellation.sql
-- Depends: everything V12 depends on (supabase_schema.sql,
--          supabase_rls_policies.sql, supabase_migration_guides.sql,
--          supabase_migration_reviews.sql,
--          supabase_migration_tour_channels.sql,
--          supabase_migration_tour_channels_v2_booking_language.sql,
--          supabase_migration_civitatis_ingestion.sql,
--          supabase_migration_civitatis_write.sql (V6) through
--          supabase_migration_civitatis_write_v12_uuid_recheck_fix.sql
--          (V12)) — assumes V12 is already live.
--
-- Version: V13 — Civitatis CANCELLATION ingestion. A brand-new, isolated
--          function, public.cancel_civitatis_booking(...) — it does NOT
--          modify public.ingest_civitatis_booking(...) in any way, does
--          not change its signature, its body, or its permissions. This
--          is deliberate: cancellation is architecturally a completely
--          different operation (locate + status-update an EXISTING
--          reservation, never create/update booking fields, never touch
--          tours/tour_channels/customers), so it gets its own dedicated,
--          independently reviewable RPC rather than adding a branch to
--          the already-complex, already-stable booking-ingestion
--          function. STILL NOT APPROVED FOR EXECUTION — DO NOT RUN.
--
-- WHY THIS MIGRATION EXISTS
-- ─────────────────────────────────────────────────────────────
-- Real production test case: external booking ID A38807986 has both an
-- original "New booking A38807986: ..." email (handled by the existing,
-- unmodified new-booking pipeline) AND a separate cancellation email,
-- subject "Cancellation A38807986: Visita guiada pela Istambul
-- imprescindível" — confirmed verbatim. No cancellation handling exists
-- anywhere in this codebase before this migration; such an email was
-- previously either ignored or (after api/_civitatis/eventDetector.js's
-- companion JS change in this same review) classified 'cancelled' by
-- detectCivitatisEvent but never had anywhere to go — this migration is
-- the write-path half of that support.
--
-- CORE RULE (never violated by anything below): a Civitatis cancellation
-- email NEVER deletes a reservation. It locates the existing reservation
-- by (source_id, external_booking_id) — the SAME identity
-- reservations_source_id_external_booking_id_key already uniquely
-- constrains (supabase_migration_civitatis_ingestion.sql) — and marks it
-- cancelled, preserving every other column exactly as it already was:
-- customer_id, tour_id, guide_name, all financial columns, notes,
-- internal_notes, and every row in reservation_guests/payments/
-- guide_payments (this function touches none of those tables at all).
--
-- SCOPE OF THIS MIGRATION
-- ─────────────────────────────────────────────────────────────
-- 1. Widens email_ingestions.event_type's CHECK constraint to add
--    'cancelled' — purely additive (DROP CONSTRAINT IF EXISTS + ADD
--    CONSTRAINT, the exact same idempotent pattern already used for
--    activity_logs.entity_type/action and tours.status/category/
--    tour_type elsewhere in this schema), foreseen and explicitly
--    invited by this column's own existing comment ("cancellation is
--    explicitly not parsed yet... adding 'cancelled' later is a
--    one-line additive constraint widen"). No other schema change: no
--    new table, no new column, no new index beyond what the CHECK widen
--    itself implies (none — it only changes a validation rule).
-- 2. Creates ONE new function: public.cancel_civitatis_booking(...).
-- No existing table is altered in any other way. No existing function
-- (ingest_civitatis_booking included) is touched. No RLS policy is
-- added, changed, or removed — this function is SECURITY DEFINER,
-- callable only by service_role, exactly like ingest_civitatis_booking,
-- so it needs no RLS policy of its own (RLS does not apply to a
-- SECURITY DEFINER function's internal reads/writes).
--
-- REUSED, NEVER RE-IMPLEMENTED, ARCHITECTURE
-- ─────────────────────────────────────────────────────────────
--   - Step 0/Step 1 (gmail_message_id idempotency + failed/needs_review
--     reclaim): the EXACT same two-step pattern
--     ingest_civitatis_booking's own Step 0/Step 1 already established —
--     same advisory-lock-then-INSERT-ON-CONFLICT shape, same
--     processing_status vocabulary (received/processed/needs_review/
--     failed), same reclaim semantics. A cancellation email retried by
--     the scheduler (the same 24h overlap window every other email type
--     already re-scans) is exactly as safe here as a booking email is.
--   - The booking-level advisory lock: reuses the EXACT SAME lock
--     namespace/key ingest_civitatis_booking's own Step 3 already uses
--     — hashtextextended(p_source_id::text || ':' || p_external_
--     booking_id, 0) — so a cancellation for booking X and a concurrent
--     new_booking/modified write for that SAME booking X can never run
--     at the same time. This is what makes the "cancellation arrives
--     before the original booking" ordering problem safe by
--     CONSTRUCTION, not merely by hoping the scheduler processes emails
--     in a particular order: whichever call acquires the lock first
--     simply runs to completion before the other is even allowed to
--     start, and if the booking genuinely does not exist yet when this
--     function's turn comes, it reports needs_review (see Step 3 below)
--     — retryable on a later scheduler run, exactly like any other
--     needs_review row, never a permanent failure.
--   - activity_logs / activity_log_reads: the EXACT same "auto-ingested
--     dashboard notification" shape ingest_civitatis_booking's own
--     Step "activity_log_insert" already uses for "Yeni Rezervasyon
--     Geldi" — entity_type='reservation', metadata.auto_ingested=true,
--     performed_by=NULL. The existing frontend query
--     (SupabaseActivityRepo.getReservationNotifications in
--     DeseTourDashboard.jsx) filters ONLY on entity_type='reservation'
--     AND metadata->>auto_ingested='true' — no action filter — so this
--     row is picked up by the notification bell with ZERO frontend
--     change. Existing RLS on activity_logs (supabase_rls_policies.sql)
--     already grants: admin sees everything; operations sees every
--     entity_type='reservation' row regardless of performed_by; sales
--     and guide policies require performed_by = auth.uid(), which a
--     NULL performed_by row never satisfies — identical to how those
--     roles already do not see the existing "Yeni Rezervasyon Geldi"
--     notification today. No RLS change is needed or made: guides
--     structurally cannot see this notification under the existing
--     policy, exactly as required, and no new guide-scoped notification
--     channel is invented.
--   - reservations.status='cancelled' + cancelled_at + cancel_reason:
--     all THREE columns already exist in supabase_schema.sql, unused by
--     any Civitatis code path until now. The frontend already fully
--     supports this status: mapResFromDB's _r2App maps DB 'cancelled' to
--     app-level opStatus "İptal", and every "upcoming/active" filter
--     across the dashboard, reservation list, guide workload, and
--     payment views already excludes "İptal". The one gap found and
--     fixed by this same review (see DeseTourDashboard.jsx diff): the
--     Calendar page's useCalendarEvents() hook did not yet exclude
--     "İptal" reservations from its event list — fixed there, not here;
--     this migration makes no calendar-related change of its own.
--
-- WHAT THIS MIGRATION DELIBERATELY DOES NOT DO
-- ─────────────────────────────────────────────────────────────
--   - Never deletes a reservations row, a reservation_guests row, a
--     payments row, or a guide_payments row.
--   - Never creates a reservation, a customer, or a tour. Auto-
--     provisioning (V10/V12) is never reachable from this function —
--     it contains no INSERT INTO tours/tour_languages/tour_channels
--     statement at all, and no call to any function that does.
--   - Never modifies guide_name (or any future guide_id), any payment
--     row, deposit_amount, total_amount, or any financial column.
--     Financial reconciliation for a cancelled booking remains a
--     separate, manual staff concern — this function only ever sets
--     status/cancelled_at/cancel_reason.
--   - Never infers a cancellation reason from free text — cancel_reason
--     is always the same fixed, honest string (see Step 4 below), never
--     parsed or guessed from the email body.
--   - Never processes a "Booking A######## modified:" email differently
--     — MODIFIED_SUBJECT's own handling in eventDetector.js/parser.js/
--     ingest_civitatis_booking is completely untouched by this file.
--
-- HOW TO APPLY (once reviewed and approved — NOT done as part of
-- producing this file)
-- ─────────────────────────────────────────────────────────────
-- Confirm V12 is already live (its own preflight-guarded migration must
-- have been run first), then Supabase Dashboard → SQL Editor → paste and
-- run this file. Wrapped in an explicit BEGIN/COMMIT, same convention as
-- V10/V11/V12, so a failed preflight check aborts the whole transaction.
-- ============================================================


BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'email_ingestions' AND column_name = 'event_type'
  ) THEN
    RAISE EXCEPTION 'V13 PREFLIGHT FAILED: public.email_ingestions.event_type does not exist. Apply supabase_migration_civitatis_ingestion.sql BEFORE this migration. Aborting before touching anything — no constraint was widened, no function was created.';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
      JOIN pg_class t ON t.oid = c.conrelid
     WHERE t.relname = 'reservations' AND c.conname = 'reservations_source_id_external_booking_id_key'
  ) THEN
    RAISE EXCEPTION 'V13 PREFLIGHT FAILED: unique constraint public.reservations_source_id_external_booking_id_key does not exist. Apply supabase_migration_civitatis_ingestion.sql BEFORE this migration. Aborting before touching anything.';
  END IF;

  -- Same structural, OID-based signature check pattern V12's own
  -- (twice-revised) preflight established, applied here to confirm
  -- ingest_civitatis_booking's V10/V11/V12 signature is live — i.e.
  -- V12 has been applied — before this migration adds a SEPARATE
  -- function alongside it. This is a structural safety check only; it
  -- does not and cannot verify V12's specific uuid-recheck fix is
  -- present, only that the expected function/signature exists at all.
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
    RAISE EXCEPTION 'V13 PREFLIGHT FAILED: public.ingest_civitatis_booking with the expected 26-parameter V10/V11/V12 signature was not found. Confirm V12 is live before applying V13. Aborting before touching anything.';
  END IF;

  RAISE NOTICE 'V13 PREFLIGHT PASSED: email_ingestions.event_type, reservations_source_id_external_booking_id_key, and the expected ingest_civitatis_booking(...) signature are all present. Proceeding.';
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

COMMIT;

-- ── END OF MIGRATION ────────────────────────────────────────────────────────
