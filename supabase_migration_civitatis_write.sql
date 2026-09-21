-- ============================================================
-- DESE TOUR OPERATIONS CENTER
-- Migration: Civitatis Email Ingestion — Transactional Write RPC
-- ============================================================
-- File:    supabase_migration_civitatis_write.sql
-- Depends: supabase_schema.sql, supabase_rls_policies.sql,
--          supabase_migration_guides.sql, supabase_migration_reviews.sql,
--          supabase_migration_tour_channels.sql,
--          supabase_migration_civitatis_ingestion.sql
--          (all already applied to production, per the audit below)
-- Version: V2 — PREPARED, NOT YET REVIEWED FOR PRODUCTION USE.
--
-- STATUS: This migration has NOT been executed against any database.
-- It exists so it can be read, reviewed, and (once approved) applied
-- manually. Nothing in this repository currently calls the function it
-- creates — see api/civitatis/writeAdapter.js, which is fully written
-- and tested but not wired into any reachable HTTP endpoint or cron.
--
-- SCOPE OF THIS MIGRATION
-- ─────────────────────────────────────────────────────────────
-- Adds exactly ONE new object: a single transactional PL/pgSQL
-- function, public.ingest_civitatis_booking(...), plus the REVOKE/
-- GRANT statements that restrict who may call it. No table is created,
-- altered, or dropped. No existing row is touched. No RLS policy is
-- added, changed, or removed.
--
-- WHY A SINGLE RPC INSTEAD OF A CHAIN OF INSERTS
-- ─────────────────────────────────────────────────────────────
-- A Civitatis booking write touches up to five tables (customers,
-- reservations, reservation_guests, email_ingestions, activity_logs)
-- and must never leave them inconsistent — e.g. a reservation created
-- with no email_ingestions audit row, or a customer created with the
-- reservation insert failing right after. A sequence of separate
-- Supabase JS .insert()/.update() calls cannot guarantee this: each
-- one commits independently. A single SQL function invoked once via
-- supabase.rpc(...) runs as one implicit database transaction — every
-- write inside it commits together or (on any unhandled error) rolls
-- back together, which is exactly the guarantee required.
--
-- SCHEMA AUDIT THIS FUNCTION RELIES ON (verified against the files
-- listed in "Depends" above — see the implementation report for the
-- full audit findings; summarized here for anyone reviewing this SQL):
--   • reservations.reservation_number is NOT NULL UNIQUE — generated
--     via the existing public.next_ref_number('R','reservations',
--     'reservation_number') helper (supabase_schema.sql), the exact
--     function DeseTourDashboard.jsx's own ReservationRepository.create
--     already calls for manually-created reservations.
--   • reservations.check_in and check_out are both NOT NULL, with
--     CHECK (check_out >= check_in). Civitatis bookings are single-day
--     tours with no independent checkout date, so check_out is always
--     set equal to check_in — the exact same default the existing
--     manual-creation code path already uses
--     (check_out:d.checkOut||d.date||null in DeseTourDashboard.jsx).
--   • reservations.customer_id is NOT NULL — a reservation cannot exist
--     without a resolved customer, which is why customer resolution/
--     creation must happen inside the same transaction, before the
--     reservation insert.
--   • reservations.status CHECK allows 'pending_confirmation' — the
--     exact initial status this function uses, matching
--     dryRun.js's already-reported proposedReservationStatus.
--   • reservations_source_id_external_booking_id_key (composite UNIQUE,
--     added by supabase_migration_civitatis_ingestion.sql) is the
--     business-identity idempotency guard this function relies on for
--     "never two reservations for the same Civitatis booking."
--   • email_ingestions.gmail_message_id is NOT NULL UNIQUE (same prior
--     migration) — the Gmail-message-level idempotency guard this
--     function relies on for "reprocessing the same email is a no-op."
--   • email_ingestions.processing_status CHECK already allows exactly
--     the vocabulary this function needs: received | processed |
--     ignored | failed | needs_review. NOT widened by this migration.
--   • email_ingestions.event_type CHECK already allows exactly
--     new_booking | modified | unknown. NOT widened by this migration.
--   • customers.full_name is the only NOT NULL column on customers
--     besides its primary key/defaults — email, phone, nationality,
--     language (DEFAULT 'tr'), birthdate, passport fields, address,
--     notes are all nullable, and import_type has NO CHECK constraint
--     restricting its values (unlike most other enum-shaped columns in
--     this schema), so this function can safely set import_type =
--     'civitatis' without any schema change.
--   • activity_logs.entity_type CHECK already allows 'reservation';
--     activity_logs.action CHECK already allows 'created'. Both
--     confirmed sufficient by supabase_migration_civitatis_ingestion.sql's
--     own audit — not re-widened here.
--   • The existing "activity_logs: sales read system-generated
--     reservation notifications" policy (added by
--     supabase_migration_civitatis_ingestion.sql) already requires
--     exactly entity_type='reservation' AND performed_by IS NULL AND
--     metadata->>'auto_ingested'='true' — this function's activity_logs
--     insert is written to satisfy that contract exactly, unchanged.
--
-- IDEMPOTENCY CONTRACT
-- ─────────────────────────────────────────────────────────────
--   • Re-invoking with the SAME gmail_message_id is a guaranteed no-op:
--     the function's first statement is an INSERT ... ON CONFLICT
--     (gmail_message_id) DO NOTHING into email_ingestions. If no row
--     was inserted (conflict), the function returns
--     {"result":"already_processed"} immediately — no customer,
--     reservation, guest, or activity write is even attempted.
--   • Re-invoking for the SAME (source_id, external_booking_id) from a
--     DIFFERENT gmail_message_id (e.g. New booking + a later Booking
--     modified — two distinct real Gmail messages) is NOT deduplicated
--     at that first step (they are legitimately different emails, both
--     must get their own email_ingestions row) — instead a session-
--     level advisory lock (pg_advisory_xact_lock, released
--     automatically at transaction end) keyed on the SAME
--     (source_id, external_booking_id) pair serializes concurrent
--     processing of the same booking, and the reservation itself is
--     located via reservations_source_id_external_booking_id_key: the
--     first message for a booking CREATES the reservation, every
--     subsequent one (found via that same unique pair) UPDATES the
--     same row — never a second INSERT.
--   • A stale/out-of-order event (an older email, by received_at,
--     arriving or being retried AFTER a newer one for the same booking
--     has already been applied) is detected and its field updates are
--     skipped — it still gets its own permanent, correctly-flagged
--     email_ingestions row (processing_status='processed', its
--     reservation_id resolved), but never regresses already-applied
--     newer data. See "ordering guard" in the function body.
--   • Exactly one activity_logs "new reservation" row is possible per
--     booking: it is only ever inserted in the branch that CREATES the
--     reservation, which — by the UNIQUE constraint above plus the
--     advisory lock — can only execute once per (source_id,
--     external_booking_id), ever, regardless of how many times any
--     message for that booking is retried.
--
-- WHAT THIS FUNCTION DELIBERATELY DOES NOT DO
-- ─────────────────────────────────────────────────────────────
--   • Does not parse email bodies, match tours, match customers by
--     name, or decide whether a booking is safe to write. All of that
--     already exists, is already validated against the real Civitatis
--     mailbox, and is NOT duplicated here — see api/civitatis/parser.js,
--     matching.js, and dryRun.js. This function receives ALREADY-
--     RESOLVED, already-validated inputs (a matched tour_id, and either
--     an already-matched customer_id or the raw booking-contact fields
--     to create one) from api/civitatis/writeAdapter.js, which is the
--     only intended caller. It is the caller's job — not this
--     function's — to refuse to call it at all for POSSIBLE_EXISTING_
--     MATCH / NEEDS_REVIEW / PARSE_ERROR bookings (see writeAdapter.js's
--     own header for how that gating works, reusing the exact same
--     matching functions dryRun.js already uses).
--   • Does not create a payments row, ever, for any Civitatis email.
--   • Does not assign a guide, does not touch guide_id/guide_name.
--   • Does not touch internal_notes, notes, pickup_location, pickup_time,
--     vehicle_info, driver_name, hotel_name, hotel_confirmation, status,
--     payment_status, deposit_amount, assigned_to, lead_id, quote_id,
--     confirmed_at/completed_at/cancelled_at/cancel_reason — on an
--     UPDATE (modification) path, ONLY the fields already covered by
--     dryRun.js's RESERVATION_DIFF_FIELDS allow-list are written:
--     check_in, check_in_time, pax_adult, pax_child, tour_language,
--     total_amount, currency, retail_amount, retail_currency — plus
--     check_out, which is not an independent Civitatis field but is
--     mechanically kept equal to check_in (see schema audit above);
--     this is a structural consequence of check_out's own NOT NULL/
--     CHECK constraint, not a new allowed field.
--   • Does not become callable by browser code: EXECUTE is revoked
--     from PUBLIC, anon, and authenticated, and granted only to
--     service_role (see SECURITY section below).
--
-- SECURITY
-- ─────────────────────────────────────────────────────────────
-- SECURITY DEFINER, so it runs with the privileges of its owner (able
-- to write to every table it touches) regardless of who calls it —
-- which is exactly why controlling WHO can call it matters more than
-- for any other function in this schema so far. Every table reference
-- inside the function body is schema-qualified (public.customers, not
-- customers) AND `SET search_path = public` is set on the function
-- itself, matching the existing convention already used by
-- is_admin()/is_sales()/is_operations()/is_guide()/is_staff() in
-- supabase_rls_policies.sql — both together close the standard
-- SECURITY DEFINER "search_path hijack" risk.
--
-- This repository has never previously needed an explicit REVOKE/GRANT
-- statement (audited: zero GRANT/REVOKE anywhere in supabase_schema.sql,
-- supabase_rls_policies.sql, or any prior supabase_migration_*.sql —
-- every existing SECURITY DEFINER function is a read-only boolean
-- predicate used inside RLS USING clauses, safe to leave at Postgres's
-- default PUBLIC EXECUTE because it can only ever return TRUE/FALSE
-- about the CALLING user's own row). This function is different: it
-- writes to five tables and must never be reachable from a browser
-- session, so this migration is the first to add explicit REVOKE/GRANT
-- statements, immediately after the function definition:
--   REVOKE EXECUTE ... FROM PUBLIC
--   REVOKE EXECUTE ... FROM anon
--   REVOKE EXECUTE ... FROM authenticated
--   GRANT  EXECUTE ... TO service_role
-- The Supabase service_role key is read only from a server-side
-- environment variable by api/civitatis/supabaseAdmin.js (see that
-- file's own header) and is never sent to the browser — this migration
-- does not change that; it only makes the database's own permission
-- system enforce it too, as defense in depth, matching the "SERVICE
-- ROLE BYPASS" section of supabase_rls_policies.sql, which already
-- names webhook/server-side handlers as its intended use.
--
-- RACE-CONDITION / CONCURRENCY NOTES
-- ─────────────────────────────────────────────────────────────
--   • Two concurrent calls with the SAME gmail_message_id: the second
--     one's INSERT ... ON CONFLICT DO NOTHING simply finds no row to
--     insert (Postgres's own UNIQUE constraint enforcement, not
--     application logic) and returns already_processed — no matter how
--     the two calls interleave.
--   • Two concurrent calls for the SAME (source_id, external_booking_id)
--     from different gmail_message_ids: pg_advisory_xact_lock blocks
--     the second call until the first COMMITs (or rolls back), so the
--     second call's SELECT for an existing reservation always sees the
--     first call's result — it can never independently decide to
--     INSERT a second reservation row. The composite UNIQUE constraint
--     is also still in force as a hard backstop even if the advisory
--     lock were ever bypassed by a future code path that forgets it.
--   • KNOWN, ACCEPTED LIMITATION: two concurrent NEW bookings for the
--     SAME real-world contact who has never been in the CRM before, and
--     who has no email/phone in either message (so neither can match
--     the other by contact info), for two DIFFERENT external_booking_
--     ids, could each create their own new customers row for that
--     person — the advisory lock above is keyed on external_booking_id,
--     not on customer identity, so it does not serialize this case.
--     customers has no UNIQUE constraint on email/phone/full_name (
--     verified: supabase_schema.sql defines only non-unique indexes on
--     those columns) to lean on instead. This mirrors the same
--     fundamental limitation matching.js's matchCustomerByName already
--     documents (name-only matching is never treated as certain); it
--     is not introduced by this function. In practice this requires
--     two genuinely simultaneous first-ever bookings from the same new
--     contact with no email/phone recorded on either — rare, and
--     recoverable later by a manual customer-merge, never a corrupted
--     reservation/passenger/audit state. Documented here rather than
--     silently ignored, per the review this migration is meant for.
--
-- HOW TO APPLY (once reviewed and approved — NOT done as part of
-- producing this file)
-- ─────────────────────────────────────────────────────────────
-- Supabase Dashboard → SQL Editor → paste and run this file, after
-- confirming supabase_migration_civitatis_ingestion.sql is already
-- applied (it is, per the task history — commit 879d7a5). Safe to
-- re-run in full: CREATE OR REPLACE FUNCTION and the REVOKE/GRANT
-- statements are all idempotent.
-- ============================================================


-- ──────────────────────────────────────────────────────────────────────────
-- FUNCTION: ingest_civitatis_booking
-- One call = one parsed, already-matched Civitatis email (a single Gmail
-- message). See the header above for the full contract.
-- ──────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.ingest_civitatis_booking(
  p_gmail_message_id    TEXT,
  p_gmail_thread_id     TEXT,
  p_received_at         TIMESTAMPTZ,
  p_raw_subject         TEXT,
  p_raw_body_snapshot   TEXT,
  p_event_type          TEXT,        -- 'new_booking' | 'modified'
  p_source_id           UUID,
  p_external_booking_id TEXT,
  p_tour_id             UUID,        -- already resolved by matching.js's matchTourChannel (exact match only)
  p_tour_language       TEXT,
  p_check_in            DATE,
  p_check_in_time       TIME,
  p_pax_adult           INTEGER,
  p_pax_child           INTEGER,
  p_total_amount        NUMERIC,     -- Civitatis Net price -> reservations.total_amount
  p_currency             TEXT,
  p_retail_amount        NUMERIC,     -- Civitatis Retail price -> reservations.retail_amount
  p_retail_currency       TEXT,
  p_customer_id           UUID,        -- pre-resolved by matching.js's matchCustomer; NULL means "create"
  p_customer_full_name    TEXT,        -- used ONLY when p_customer_id IS NULL
  p_customer_email        TEXT,        -- used ONLY when p_customer_id IS NULL
  p_customer_phone        TEXT,        -- used ONLY when p_customer_id IS NULL
  p_passengers             JSONB        -- [{"fullName":"...", "sortOrder":0}, ...] from api/civitatis/parser.js
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_ingestion_id      UUID;
  v_existing_status    TEXT;
  v_existing_res_id     UUID;
  v_customer_id          UUID;
  v_reservation_id        UUID;
  v_reservation_number     TEXT;
  v_tour_name               TEXT;
  v_result                   TEXT;
  v_newer_exists               BOOLEAN;
  v_error_text                   TEXT;
BEGIN
  -- ── Step 1: Gmail-message-level idempotency (the primary guard) ────────
  -- Atomic at the database level, not an application-side "SELECT then
  -- INSERT" — see the migration header's concurrency notes.
  INSERT INTO public.email_ingestions (
    gmail_message_id, gmail_thread_id, external_booking_id, source_id,
    event_type, processing_status, raw_subject, raw_body_snapshot, received_at
  ) VALUES (
    p_gmail_message_id, p_gmail_thread_id, p_external_booking_id, p_source_id,
    COALESCE(p_event_type, 'unknown'), 'received', p_raw_subject, p_raw_body_snapshot,
    COALESCE(p_received_at, NOW())
  )
  ON CONFLICT (gmail_message_id) DO NOTHING
  RETURNING id INTO v_ingestion_id;

  IF v_ingestion_id IS NULL THEN
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

  -- ── Step 2: required-identifier validation ──────────────────────────────
  -- Never guessed. A booking that reaches this function without these is a
  -- caller bug (writeAdapter.js should never invoke it in that case), but
  -- this function does not trust its caller blindly.
  IF p_source_id IS NULL OR p_external_booking_id IS NULL OR btrim(p_external_booking_id) = '' THEN
    UPDATE public.email_ingestions
       SET processing_status = 'needs_review',
           error_reason = 'missing source_id or external_booking_id',
           processed_at = NOW()
     WHERE id = v_ingestion_id;
    RETURN jsonb_build_object('result', 'manual_review_required', 'ingestion_id', v_ingestion_id,
                               'reason', 'missing source_id or external_booking_id');
  END IF;

  IF p_tour_id IS NULL THEN
    UPDATE public.email_ingestions
       SET processing_status = 'needs_review',
           error_reason = 'no matched tour_id supplied (Internal code did not match tour_channels)',
           processed_at = NOW()
     WHERE id = v_ingestion_id;
    RETURN jsonb_build_object('result', 'manual_review_required', 'ingestion_id', v_ingestion_id,
                               'reason', 'no matched tour_id');
  END IF;

  BEGIN  -- nested block: on any unexpected error below, roll back every
         -- customer/reservation/guest/activity write attempted in this
         -- call (but NOT the email_ingestions row from Step 1, which
         -- this handler explicitly re-records as 'failed' after the
         -- implicit rollback-to-savepoint) — see migration header.

    -- ── Step 3: serialize concurrent processing of the SAME booking ──────
    -- hashtextextended returns bigint, matching pg_advisory_xact_lock's
    -- signature; released automatically at transaction end (COMMIT or
    -- ROLLBACK) — never needs an explicit unlock call.
    PERFORM pg_advisory_xact_lock(
      hashtextextended(p_source_id::text || ':' || p_external_booking_id, 0)
    );

    -- ── Step 4: ordering guard — has a NEWER event for this booking
    -- already been applied? If so, this event is stale (out-of-order
    -- delivery/backfill retry) and must not regress already-applied data,
    -- but it is still a real, successfully-understood email and gets its
    -- own permanent audit row.
    SELECT EXISTS (
      SELECT 1 FROM public.email_ingestions
       WHERE source_id = p_source_id
         AND external_booking_id = p_external_booking_id
         AND processing_status = 'processed'
         AND received_at > COALESCE(p_received_at, NOW())
    ) INTO v_newer_exists;

    -- ── Step 5: resolve or create the booking-contact customer ──────────
    IF p_customer_id IS NOT NULL THEN
      IF NOT EXISTS (SELECT 1 FROM public.customers WHERE id = p_customer_id) THEN
        RAISE EXCEPTION 'ingest_civitatis_booking: provided customer_id % does not exist', p_customer_id;
      END IF;
      v_customer_id := p_customer_id;
    ELSE
      IF p_customer_full_name IS NULL OR btrim(p_customer_full_name) = '' THEN
        UPDATE public.email_ingestions
           SET processing_status = 'needs_review',
               error_reason = 'no resolved customer_id and no booking-contact full name to create one',
               processed_at = NOW()
         WHERE id = v_ingestion_id;
        RETURN jsonb_build_object('result', 'manual_review_required', 'ingestion_id', v_ingestion_id,
                                   'reason', 'missing booking-contact identity');
      END IF;
      -- Booking-contact data only — never a passenger. Never invented:
      -- email/phone/nationality/country stay NULL when Civitatis did not
      -- provide them. import_type has no CHECK constraint restricting its
      -- values (confirmed by schema audit above), so 'civitatis' needs no
      -- migration of its own.
      INSERT INTO public.customers (full_name, email, phone, source_id, import_type)
      VALUES (p_customer_full_name, p_customer_email, p_customer_phone, p_source_id, 'civitatis')
      RETURNING id INTO v_customer_id;
    END IF;

    -- ── Step 6: locate or create the reservation ─────────────────────────
    SELECT id INTO v_reservation_id
      FROM public.reservations
     WHERE source_id = p_source_id AND external_booking_id = p_external_booking_id
     FOR UPDATE;

    IF v_reservation_id IS NULL THEN
      SELECT name INTO v_tour_name FROM public.tours WHERE id = p_tour_id;
      SELECT public.next_ref_number('R', 'reservations', 'reservation_number') INTO v_reservation_number;

      INSERT INTO public.reservations (
        reservation_number, customer_id, tour_id, source_id, external_booking_id,
        status, payment_status, destination, check_in, check_out, check_in_time,
        pax_adult, pax_child, tour_language, total_amount, currency,
        retail_amount, retail_currency
      ) VALUES (
        v_reservation_number, v_customer_id, p_tour_id, p_source_id, p_external_booking_id,
        'pending_confirmation', 'pending', v_tour_name,
        p_check_in, p_check_in,  -- day-tour: check_out mirrors check_in (see schema audit)
        p_check_in_time,
        COALESCE(p_pax_adult, 1), COALESCE(p_pax_child, 0), p_tour_language,
        COALESCE(p_total_amount, 0), COALESCE(p_currency, 'EUR'),
        p_retail_amount, p_retail_currency
      )
      RETURNING id INTO v_reservation_id;

      v_result := 'created';

    ELSIF NOT v_newer_exists THEN
      -- Modification: ONLY the fields in dryRun.js's RESERVATION_DIFF_FIELDS
      -- allow-list, reused exactly — never guide_id/guide_name/internal_notes/
      -- notes/status/payment_status/pickup_*/vehicle_info/driver_name/
      -- hotel_*/assigned_to/lead_id/quote_id/confirmed_at/completed_at/
      -- cancelled_at/cancel_reason.
      UPDATE public.reservations SET
        check_in         = COALESCE(p_check_in, check_in),
        check_out        = COALESCE(p_check_in, check_out),
        check_in_time     = COALESCE(p_check_in_time, check_in_time),
        pax_adult          = COALESCE(p_pax_adult, pax_adult),
        pax_child           = COALESCE(p_pax_child, pax_child),
        tour_language        = COALESCE(p_tour_language, tour_language),
        total_amount          = COALESCE(p_total_amount, total_amount),
        currency                = COALESCE(p_currency, currency),
        retail_amount            = COALESCE(p_retail_amount, retail_amount),
        retail_currency            = COALESCE(p_retail_currency, retail_currency)
      WHERE id = v_reservation_id;

      v_result := 'updated';
    ELSE
      v_result := 'updated';  -- resolved to an existing reservation, but this
                               -- specific event was stale and its fields were
                               -- deliberately not applied (see Step 4)
    END IF;

    -- ── Step 7: atomic passenger-list replacement ────────────────────────
    -- Skipped for a stale/out-of-order event for the same reason as Step 6's
    -- field update — never regress a newer passenger list with an older one.
    -- Harmless no-op DELETE on the 'created' path (no existing rows yet).
    IF NOT v_newer_exists THEN
      DELETE FROM public.reservation_guests WHERE reservation_id = v_reservation_id;
      INSERT INTO public.reservation_guests (reservation_id, full_name, sort_order)
      SELECT v_reservation_id, (g->>'fullName'), COALESCE((g->>'sortOrder')::int, 0)
        FROM jsonb_array_elements(COALESCE(p_passengers, '[]'::jsonb)) AS g
       WHERE g->>'fullName' IS NOT NULL;
    END IF;

    -- ── Step 8: finalize the email_ingestions audit row ──────────────────
    UPDATE public.email_ingestions
       SET processing_status = 'processed',
           reservation_id = v_reservation_id,
           processed_at = NOW()
     WHERE id = v_ingestion_id;

    -- ── Step 9: exactly-once "new reservation" activity notification ────
    -- Only on the branch that CREATED the reservation — which, by the
    -- UNIQUE constraint + advisory lock, can happen at most once per
    -- (source_id, external_booking_id), ever. A modification never
    -- creates a second "new reservation" notification.
    IF v_result = 'created' THEN
      INSERT INTO public.activity_logs (entity_type, entity_id, action, description, metadata, performed_by)
      VALUES (
        'reservation', v_reservation_id, 'created',
        'Yeni Rezervasyon Geldi: ' || v_reservation_number,
        jsonb_build_object(
          'auto_ingested', true,
          'source', 'civitatis',
          'external_booking_id', p_external_booking_id
        ),
        NULL  -- no staff session performed this — the RLS policy this
              -- satisfies (supabase_migration_civitatis_ingestion.sql)
              -- explicitly keys on performed_by IS NULL
      );
    END IF;

    RETURN jsonb_build_object(
      'result', v_result,
      'ingestion_id', v_ingestion_id,
      'reservation_id', v_reservation_id,
      'customer_id', v_customer_id,
      'stale', v_newer_exists
    );

  EXCEPTION WHEN OTHERS THEN
    -- Rolls back to the implicit savepoint at the start of this BEGIN
    -- block — every customer/reservation/guest/activity write attempted
    -- above is undone together. The email_ingestions row from Step 1
    -- survives (it was written before this block began) and is now
    -- updated to a permanent, honest 'failed' record rather than being
    -- silently lost.
    v_error_text := SQLERRM;
    UPDATE public.email_ingestions
       SET processing_status = 'failed',
           error_reason = v_error_text,
           processed_at = NOW()
     WHERE id = v_ingestion_id;
    RETURN jsonb_build_object('result', 'failed', 'ingestion_id', v_ingestion_id, 'error', v_error_text);
  END;
END;
$$;

COMMENT ON FUNCTION public.ingest_civitatis_booking IS
  'Atomically ingests one already-parsed, already-matched Civitatis '
  'booking-notification email (customer resolve/create, reservation '
  'create-or-update, passenger-list replace, email_ingestions audit row, '
  'and — only for a brand-new reservation — one activity_logs '
  'notification) or fully rolls back and records a failure. SECURITY '
  'DEFINER; callable only by service_role — see this migration file''s '
  'header for the full contract, idempotency guarantees, and the REVOKE/ '
  'GRANT statements immediately following this definition. Never call '
  'directly from browser code.';


-- ──────────────────────────────────────────────────────────────────────────
-- SECURITY: restrict EXECUTE to service_role only.
-- Idempotent: REVOKE/GRANT can be re-run any number of times safely.
-- ──────────────────────────────────────────────────────────────────────────

REVOKE ALL ON FUNCTION public.ingest_civitatis_booking(
  TEXT, TEXT, TIMESTAMPTZ, TEXT, TEXT, TEXT, UUID, TEXT, UUID, TEXT, DATE, TIME,
  INTEGER, INTEGER, NUMERIC, TEXT, NUMERIC, TEXT, UUID, TEXT, TEXT, TEXT, JSONB
) FROM PUBLIC;

REVOKE ALL ON FUNCTION public.ingest_civitatis_booking(
  TEXT, TEXT, TIMESTAMPTZ, TEXT, TEXT, TEXT, UUID, TEXT, UUID, TEXT, DATE, TIME,
  INTEGER, INTEGER, NUMERIC, TEXT, NUMERIC, TEXT, UUID, TEXT, TEXT, TEXT, JSONB
) FROM anon;

REVOKE ALL ON FUNCTION public.ingest_civitatis_booking(
  TEXT, TEXT, TIMESTAMPTZ, TEXT, TEXT, TEXT, UUID, TEXT, UUID, TEXT, DATE, TIME,
  INTEGER, INTEGER, NUMERIC, TEXT, NUMERIC, TEXT, UUID, TEXT, TEXT, TEXT, JSONB
) FROM authenticated;

GRANT EXECUTE ON FUNCTION public.ingest_civitatis_booking(
  TEXT, TEXT, TIMESTAMPTZ, TEXT, TEXT, TEXT, UUID, TEXT, UUID, TEXT, DATE, TIME,
  INTEGER, INTEGER, NUMERIC, TEXT, NUMERIC, TEXT, UUID, TEXT, TEXT, TEXT, JSONB
) TO service_role;


-- ──────────────────────────────────────────────────────────────────────────
-- VERIFICATION QUERIES (for manual review after applying — not executed
-- as part of producing this file)
-- ──────────────────────────────────────────────────────────────────────────

/*
-- 1. Confirm only service_role can execute:
SELECT grantee, privilege_type
FROM information_schema.role_routine_grants
WHERE routine_name = 'ingest_civitatis_booking';
-- Expect exactly one row: grantee = service_role, privilege_type = EXECUTE.

-- 2. Confirm the function is SECURITY DEFINER with a pinned search_path:
SELECT proname, prosecdef, proconfig
FROM pg_proc
WHERE proname = 'ingest_civitatis_booking';
-- Expect prosecdef = true, proconfig containing 'search_path=public'.
*/

-- ── END OF MIGRATION ────────────────────────────────────────────────────────
