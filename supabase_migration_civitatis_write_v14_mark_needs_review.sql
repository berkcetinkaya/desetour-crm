-- ============================================================
-- DESE TOUR OPERATIONS CENTER
-- Migration: Civitatis Email Ingestion — needs_review MARKER RPC
-- ============================================================
-- File:    supabase_migration_civitatis_write_v14_mark_needs_review.sql
-- Depends: everything V13 depends on (supabase_schema.sql,
--          supabase_rls_policies.sql, supabase_migration_guides.sql,
--          supabase_migration_reviews.sql,
--          supabase_migration_tour_channels.sql,
--          supabase_migration_tour_channels_v2_booking_language.sql,
--          supabase_migration_civitatis_ingestion.sql,
--          supabase_migration_civitatis_write.sql (V6) through
--          supabase_migration_civitatis_write_v13_cancellation.sql (V13),
--          and supabase_migration_civitatis_write_v13_1_cancellation_rpc_repair.sql
--          if applied) — assumes V13 is already live.
--
-- Version: V14 — a brand-new, isolated function,
--          public.mark_civitatis_email_needs_review(...). It does NOT
--          modify public.ingest_civitatis_booking(...) or
--          public.cancel_civitatis_booking(...) in any way — neither
--          their signatures, bodies, nor permissions. NO existing table
--          column, constraint, or index is added, altered, or dropped.
--          STILL NOT APPROVED FOR EXECUTION — DO NOT RUN.
--
-- REVISED (same V14, pre-production review finding): THIS FUNCTION'S
-- OWN Step 1 reclaim is DELIBERATELY NARROWER than the other two
-- Civitatis RPCs' — it reclaims only 'failed', never 'needs_review'.
-- The first draft of this function reclaimed both, exactly like
-- ingest_civitatis_booking/cancel_civitatis_booking do — but unlike
-- those two, a 'needs_review' row THIS function wrote represents an
-- already-fully-recorded, deliberate safety decision (an identity
-- ambiguity, a chain parse failure, an unresolved booking id) that
-- cannot become resolvable merely because the scheduler's 24-hour
-- overlap window rediscovers the same Gmail message again — which it
-- does, every 15 minutes, for as long as the message stays inside that
-- window. The first draft would have rewritten processed_at/
-- error_reason to the identical value on every single one of those
-- rediscoveries (dozens of writes for one still-unresolved booking)
-- and caused a GitHub Actions warning to fire every run, with zero new
-- information each time. This revision adds a new, explicit, fourth
-- result value — 'already_needs_review' — returned (with NO write at
-- all, not even processed_at) whenever the row is already
-- 'needs_review', so repeated rediscovery costs one SELECT instead of
-- one write, while the review state stays exactly as visible to
-- operators as before. See Step 0/Step 1 below for the exact logic.
--
-- WHY THIS MIGRATION EXISTS
-- ─────────────────────────────────────────────────────────────
-- Real production incident: Civitatis reservation A42264118 ("Cruzeiro
-- pelo Bósforo + Mesquita Azul + Santa Sofia", contact "Nelson
-- Goncalves Filho") was discovered by Gmail, parsed successfully, and
-- tour-mapped successfully, but api/_civitatis/writeAdapter.js's
-- planCivitatisIngestion blocked it at the exact-normalized-customer-
-- name match gate (api/_civitatis/matching.js's matchCustomerByName)
-- BEFORE it ever reached public.ingest_civitatis_booking. Because that
-- gate returns eligible:false and the booking is never sent to the
-- RPC, Step 1 of ingest_civitatis_booking (the statement that claims an
-- email_ingestions row) never runs either — the booking left ZERO
-- persisted trace anywhere in the database, for every single scheduled
-- run since it arrived, and remained invisible to any query against
-- email_ingestions.
--
-- The SAME class of exposure exists for every other client-side,
-- pre-RPC safety gate in writeAdapter.js: an email/phone contact
-- conflict between two existing customers, an unlinked legacy
-- reservation matching tour+date+time+guest-count, a booking chain
-- containing one unparseable event (which currently blocks the WHOLE
-- chain, including events that themselves parsed fine), and a message
-- whose externalBookingId could not be resolved at all (e.g. a
-- subject/body reservation-number mismatch). None of these gates is
-- being weakened or removed by this migration — each one still
-- correctly refuses to auto-bind an ambiguous customer or auto-link an
-- ambiguous reservation. What changes is only WHERE the refusal is
-- recorded: every one of them can now call this new function to claim
-- the Gmail message and persist a retryable, queryable
-- processing_status='needs_review' row, instead of leaving zero trace.
--
-- WHY A SEPARATE FUNCTION, RATHER THAN EXTENDING
-- ingest_civitatis_booking's SIGNATURE
-- ─────────────────────────────────────────────────────────────
-- Exactly the same reasoning V13 already used to keep
-- cancel_civitatis_booking entirely separate from the booking-ingestion
-- function: this is architecturally a different, much simpler
-- operation (claim the Gmail message, mark it needs_review, done — no
-- business-domain write of any kind) than booking ingestion's CREATE/
-- UPDATE/stale/auto-provisioning branch matrix. Keeping it in its own,
-- small, independently reviewable function means its "never writes
-- reservations/customers/tours" guarantee is provable by inspection —
-- there is no INSERT or UPDATE against those three tables anywhere in
-- this file at all — rather than merely being one more conditional
-- branch inside an already-complex 1000+ line function.
--
-- SCOPE OF THIS MIGRATION
-- ─────────────────────────────────────────────────────────────
-- Creates ONE new function: public.mark_civitatis_email_needs_review(...).
-- No table is created, altered, or dropped. No existing constraint is
-- widened (email_ingestions.event_type's existing CHECK already allows
-- 'unknown', which this function uses for any event type it does not
-- recognize — see the function body). No existing row is touched. No
-- RLS policy is added, changed, or removed — this function is SECURITY
-- DEFINER, callable only by service_role, exactly like the two existing
-- Civitatis RPCs, so it needs no RLS policy of its own.
--
-- REUSED, NEVER RE-IMPLEMENTED, ARCHITECTURE
-- ─────────────────────────────────────────────────────────────
--   - Step 0/Step 1 (gmail_message_id idempotency + failed/needs_review
--     reclaim): the EXACT SAME two-step pattern both
--     ingest_civitatis_booking's and cancel_civitatis_booking's own
--     Step 0/Step 1 already establish — same advisory-lock-then-INSERT-
--     ON-CONFLICT shape, same processing_status vocabulary. Reuses the
--     SAME advisory-lock seed (1) as both existing functions — safe
--     because all three are always keyed by a DIFFERENT
--     gmail_message_id per call (a given Gmail message is exactly one
--     event; it is never simultaneously a booking email, a
--     cancellation email, AND a needs-review marker target for the
--     SAME call).
--   - processing_status='needs_review' and the free-text error_reason
--     column (both already exist, already used this way by
--     ingest_civitatis_booking's own Step 2/Step 6b/etc.) are reused
--     exactly as-is. error_reason encodes "<reason_code>: <reason_detail>"
--     — a plain, safe, non-PII structured-text convention (candidate
--     customer/reservation ids only — never an email address, phone
--     number, or passenger name), never a new column.
--
-- WHAT THIS MIGRATION DELIBERATELY DOES NOT DO
-- ─────────────────────────────────────────────────────────────
--   - Never inserts or updates a reservations row.
--   - Never inserts or updates a customers row.
--   - Never inserts or updates a tours/tour_languages/tour_channels row.
--   - Never auto-binds a candidate customer or auto-links a candidate
--     reservation to anything — it has no mechanism to do so; it only
--     ever writes to email_ingestions.
--   - Never widens any CHECK constraint, never adds a column, never
--     adds an index (the needed index, idx_email_ingestions_processing_
--     status, already exists — supabase_migration_civitatis_ingestion.sql).
--   - Never modifies ingest_civitatis_booking or cancel_civitatis_booking
--     in any way.
--
-- HOW TO APPLY (once reviewed and approved — NOT done as part of
-- producing this file)
-- ─────────────────────────────────────────────────────────────
-- Confirm V13 is already live, then Supabase Dashboard → SQL Editor →
-- paste and run this file. Wrapped in an explicit BEGIN/COMMIT, same
-- convention as V10/V11/V12/V13, so a failed preflight check aborts the
-- whole transaction.
-- ============================================================


BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'email_ingestions' AND column_name = 'processing_status'
  ) THEN
    RAISE EXCEPTION 'V14 PREFLIGHT FAILED: public.email_ingestions.processing_status does not exist. Apply supabase_migration_civitatis_ingestion.sql BEFORE this migration. Aborting before touching anything — no function was created.';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
      JOIN pg_class t ON t.oid = c.conrelid
     WHERE t.relname = 'email_ingestions' AND c.conname = 'email_ingestions_gmail_message_id_key'
  ) THEN
    RAISE EXCEPTION 'V14 PREFLIGHT FAILED: unique constraint public.email_ingestions_gmail_message_id_key does not exist. Apply supabase_migration_civitatis_ingestion.sql BEFORE this migration. Aborting before touching anything.';
  END IF;

  RAISE NOTICE 'V14 PREFLIGHT PASSED: email_ingestions.processing_status and its gmail_message_id uniqueness constraint are both present. Proceeding.';
END $$;


-- ──────────────────────────────────────────────────────────────────────────
-- FUNCTION: mark_civitatis_email_needs_review
-- One call = one Gmail message a caller has decided NOT to send through
-- the normal booking/cancellation RPCs, for a reviewable, never-auto-
-- resolved reason (an ambiguous identity match, a chain-poisoning parse
-- failure, or an unresolved external booking id). Claims the Gmail
-- message via the SAME idempotent Step 0/Step 1 shape the other two
-- Civitatis RPCs already use, then marks it needs_review. Contains NO
-- write of any kind against reservations, customers, or tours.
-- ──────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.mark_civitatis_email_needs_review(
  p_gmail_message_id    TEXT,
  p_gmail_thread_id     TEXT,
  p_received_at         TIMESTAMPTZ,
  p_raw_subject         TEXT,
  p_raw_body_snapshot   TEXT,
  p_source_id           UUID,
  p_external_booking_id TEXT,
  p_event_type          TEXT,
  p_reason_code         TEXT,
  p_reason_detail       TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_ingestion_id    UUID;
  v_existing_status TEXT;
  v_existing_res_id UUID;
  v_event_type_safe TEXT;
  v_error_text      TEXT;
BEGIN
  -- ── Step 0: non-blocking, gmail_message_id-scoped processing lock —
  -- SAME seed (1) and SAME shape as ingest_civitatis_booking's and
  -- cancel_civitatis_booking's own Step 0. See this migration's header
  -- for why reusing seed 1 here introduces no collision risk. A true
  -- concurrent collision (another call for this SAME message already
  -- in flight right now) is rare and this read may observe a
  -- momentarily stale status either way — reported as
  -- 'already_needs_review' only when the snapshot read here already
  -- shows 'needs_review', for the same classification consistency the
  -- Step 1 branch below provides; any other status (including the
  -- in-flight call's own 'received' row, not yet resolved) is reported
  -- as 'already_processed', matching this branch's pre-existing,
  -- deliberately conservative COALESCE fallback.
  IF NOT pg_try_advisory_xact_lock(
    hashtextextended('civitatis_ingest:gmail_message:' || p_gmail_message_id, 1)
  ) THEN
    SELECT id, processing_status, reservation_id
      INTO v_ingestion_id, v_existing_status, v_existing_res_id
      FROM public.email_ingestions
     WHERE gmail_message_id = p_gmail_message_id;
    IF v_existing_status = 'needs_review' THEN
      RETURN jsonb_build_object(
        'result', 'already_needs_review',
        'ingestion_id', v_ingestion_id,
        'processing_status', v_existing_status,
        'reservation_id', v_existing_res_id
      );
    END IF;
    RETURN jsonb_build_object(
      'result', 'already_processed',
      'ingestion_id', v_ingestion_id,
      'processing_status', COALESCE(v_existing_status, 'received'),
      'reservation_id', v_existing_res_id
    );
  END IF;

  -- email_ingestions.event_type's existing CHECK constraint (widened by
  -- V13 to add 'cancelled') only ever allows
  -- 'new_booking'/'modified'/'unknown'/'cancelled' — never widened
  -- further by this migration. Anything this function is called for
  -- that is not exactly 'new_booking' or 'modified' (including a
  -- genuinely unresolved event type, e.g. the
  -- EXTERNAL_BOOKING_ID_UNRESOLVED reason code, where the caller may
  -- not even know the event type with confidence) is stored as
  -- 'unknown' — the SAME fallback ingest_civitatis_booking's own Step 1
  -- already uses for the identical reason.
  v_event_type_safe := CASE WHEN p_event_type IN ('new_booking', 'modified') THEN p_event_type ELSE 'unknown' END;

  -- ── Step 1: Gmail-message-level idempotency — DELIBERATELY NARROWER
  -- than ingest_civitatis_booking's/cancel_civitatis_booking's own
  -- Step 1. Those two functions reclaim BOTH 'failed' and
  -- 'needs_review', because for THEM a 'needs_review' row genuinely can
  -- become resolvable on a later run (e.g. a tour mapping that didn't
  -- exist yet now does). For THIS function, a 'needs_review' row was
  -- produced by a deliberate, already-fully-recorded safety decision
  -- (an identity ambiguity, a chain parse failure, an unresolved
  -- booking id) whose outcome cannot change just because the SAME
  -- unresolved Gmail message was rediscovered by the next 15-minute
  -- cron scan — re-running this function against it every single run
  -- while it stays inside the scheduler's lookback window would
  -- silently rewrite processed_at/error_reason to the identical value
  -- dozens of times with zero new information (see the real production
  -- finding this fixes: the pre-fix version reclaimed 'needs_review'
  -- unconditionally). Only a genuinely transient 'failed' attempt
  -- (e.g. an unexpected error in the UPDATE below) is reclaimed here —
  -- a 'needs_review' row is left completely untouched and reported via
  -- the 'already_needs_review' branch below instead.
  INSERT INTO public.email_ingestions (
    gmail_message_id, gmail_thread_id, external_booking_id, source_id,
    event_type, processing_status, raw_subject, raw_body_snapshot, received_at
  ) VALUES (
    p_gmail_message_id, p_gmail_thread_id, p_external_booking_id, p_source_id,
    v_event_type_safe, 'received', p_raw_subject, p_raw_body_snapshot,
    COALESCE(p_received_at, NOW())
  )
  ON CONFLICT (gmail_message_id) DO UPDATE
    SET processing_status = 'received',
        error_reason      = NULL,
        processed_at      = NULL
    WHERE public.email_ingestions.processing_status = 'failed'
  RETURNING id INTO v_ingestion_id;

  IF v_ingestion_id IS NULL THEN
    -- Either an existing 'processed' row (the only permanently terminal
    -- state — a message already fully ingested by the real booking
    -- RPC, the cancellation RPC, or a PRIOR call to this function that
    -- was since superseded by an operator/human resolving the
    -- underlying ambiguity through the normal flow) OR an existing
    -- 'needs_review' row (already under review — left completely
    -- untouched: NO write of any kind happens below this point for
    -- this branch, not even processed_at). Distinguished purely by a
    -- read, never a write, so this entire IF branch costs nothing
    -- beyond one SELECT no matter how many times the same unresolved
    -- message is rediscovered.
    SELECT id, processing_status, reservation_id
      INTO v_ingestion_id, v_existing_status, v_existing_res_id
      FROM public.email_ingestions
     WHERE gmail_message_id = p_gmail_message_id;

    IF v_existing_status = 'needs_review' THEN
      RETURN jsonb_build_object(
        'result', 'already_needs_review',
        'ingestion_id', v_ingestion_id,
        'processing_status', v_existing_status,
        'reservation_id', v_existing_res_id
      );
    END IF;

    RETURN jsonb_build_object(
      'result', 'already_processed',
      'ingestion_id', v_ingestion_id,
      'processing_status', v_existing_status,
      'reservation_id', v_existing_res_id
    );
  END IF;

  -- This function NEVER writes reservations/customers/tours — by
  -- construction, no such statement exists anywhere in this body, with
  -- or without this nested block. The nested block exists only so an
  -- unexpected failure in the UPDATE below (e.g. a constraint this
  -- function's author did not anticipate) still leaves the Step-1 claim
  -- intact and explicitly recorded as 'failed' with a diagnostic
  -- reason, rather than propagating an uncaught exception.
  BEGIN
    v_error_text := NULL;
    UPDATE public.email_ingestions
       SET processing_status = 'needs_review',
           error_reason = COALESCE(p_reason_code, 'UNSPECIFIED') ||
                           CASE WHEN p_reason_detail IS NOT NULL AND btrim(p_reason_detail) <> ''
                                THEN ': ' || p_reason_detail ELSE '' END,
           processed_at = NOW()
     WHERE id = v_ingestion_id;

    RETURN jsonb_build_object(
      'result', 'manual_review_required',
      'ingestion_id', v_ingestion_id,
      'reason_code', p_reason_code
    );
  EXCEPTION WHEN OTHERS THEN
    v_error_text := SQLERRM;
    UPDATE public.email_ingestions
       SET processing_status = 'failed',
           error_reason = format('stage=mark_needs_review_update; error=%s', v_error_text),
           processed_at = NOW()
     WHERE id = v_ingestion_id;
    RETURN jsonb_build_object(
      'result', 'failed',
      'ingestion_id', v_ingestion_id,
      'error', v_error_text
    );
  END;
END;
$$;

COMMENT ON FUNCTION public.mark_civitatis_email_needs_review IS
  'Claims exactly one Civitatis Gmail message (by gmail_message_id, '
  'using the SAME idempotent Step 0/Step 1 shape as '
  'ingest_civitatis_booking and cancel_civitatis_booking) and marks it '
  'processing_status=''needs_review'' with a safe, structured, non-PII '
  'error_reason (''<reason_code>: <reason_detail>''). Used by '
  'api/_civitatis/writeAdapter.js for every pre-RPC safety gate '
  '(exact-name-only customer match, email/phone contact conflict, '
  'legacy-reservation possible match, booking-chain parse failure, '
  'unresolved external booking id) that must never auto-resolve an '
  'identity ambiguity but must also never leave zero persisted trace. '
  'Contains NO INSERT or UPDATE against reservations, customers, or '
  'tours anywhere in its body — it is structurally incapable of '
  'auto-binding a candidate customer or auto-linking a candidate '
  'reservation. Never modifies ingest_civitatis_booking or '
  'cancel_civitatis_booking. FOUR possible result values: '
  '''manual_review_required'' (fresh claim, row written to '
  'needs_review); ''already_needs_review'' (the row was ALREADY '
  'needs_review — read-only, zero writes, including processed_at — '
  'this is what makes repeated 15-minute cron rediscovery of the same '
  'still-unresolved message cheap and non-spammy); ''already_processed'' '
  '(the row is ''processed'', the only permanently terminal state — a '
  'pure no-op); ''failed'' (an unexpected error inside this call''s own '
  'UPDATE, reclaimable on a later retry). Re-invoking with a '
  'gmail_message_id whose prior attempt is ''failed'' atomically '
  'reclaims that SAME row; re-invoking one whose prior attempt is '
  '''needs_review'' or ''processed'' never rewrites it. SECURITY '
  'DEFINER; callable only by service_role. Never call directly from '
  'browser code.';


-- ──────────────────────────────────────────────────────────────────────────
-- SECURITY: restrict EXECUTE to service_role only. Idempotent: REVOKE/
-- GRANT can be re-run any number of times safely. 10-parameter
-- signature — MUST match the CREATE FUNCTION above exactly, or these
-- statements would silently apply to nothing.
-- ──────────────────────────────────────────────────────────────────────────

REVOKE ALL ON FUNCTION public.mark_civitatis_email_needs_review(
  TEXT, TEXT, TIMESTAMPTZ, TEXT, TEXT, UUID, TEXT, TEXT, TEXT, TEXT
) FROM PUBLIC;

REVOKE ALL ON FUNCTION public.mark_civitatis_email_needs_review(
  TEXT, TEXT, TIMESTAMPTZ, TEXT, TEXT, UUID, TEXT, TEXT, TEXT, TEXT
) FROM anon;

REVOKE ALL ON FUNCTION public.mark_civitatis_email_needs_review(
  TEXT, TEXT, TIMESTAMPTZ, TEXT, TEXT, UUID, TEXT, TEXT, TEXT, TEXT
) FROM authenticated;

GRANT EXECUTE ON FUNCTION public.mark_civitatis_email_needs_review(
  TEXT, TEXT, TIMESTAMPTZ, TEXT, TEXT, UUID, TEXT, TEXT, TEXT, TEXT
) TO service_role;


-- ──────────────────────────────────────────────────────────────────────────
-- POSTFLIGHT — read-only verification that the function and its grants
-- exist exactly as intended.
-- ──────────────────────────────────────────────────────────────────────────
SELECT
  p.proname                                              AS function_name,
  pg_get_function_identity_arguments(p.oid)               AS signature,
  p.prosecdef                                              AS is_security_definer,
  (SELECT array_agg(grantee::text)
     FROM information_schema.routine_privileges
    WHERE routine_schema = 'public'
      AND routine_name = 'mark_civitatis_email_needs_review'
      AND privilege_type = 'EXECUTE')                       AS execute_grantees
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public' AND p.proname = 'mark_civitatis_email_needs_review';

COMMIT;

-- ── END OF MIGRATION ────────────────────────────────────────────────────────
