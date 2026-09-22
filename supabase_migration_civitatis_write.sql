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
-- Version: V4 — externally reviewed twice (V2, V3), safety issues
--          raised both times, revised both times. STILL NOT APPROVED
--          FOR EXECUTION.
--
-- STATUS: This migration has NOT been executed against any database.
-- It exists so it can be read, reviewed, and (once approved) applied
-- manually. Nothing in this repository currently calls the function it
-- creates — see api/civitatis/writeAdapter.js, which is fully written
-- and tested but not wired into any reachable HTTP endpoint or cron.
--
-- V4 CHANGELOG (what changed since the reviewed V3, and why)
-- ─────────────────────────────────────────────────────────────
--   8. A SECOND 'new_booking' EVENT FOR AN ALREADY-EXISTING RESERVATION
--      NO LONGER FALLS THROUGH TO THE UPDATE BRANCH. V3's branching
--      only special-cased "reservation exists AND stale" (-> ignored)
--      and otherwise treated "reservation exists AND not stale" as an
--      update, regardless of p_event_type. Since the gmail_message_id
--      uniqueness guard is keyed on the GMAIL message, not the
--      Civitatis booking, a second, genuinely distinct Gmail message
--      that Civitatis itself classified as "New booking A########:"
--      (not "Booking A######## modified:") for a booking that already
--      has a reservation would have been silently treated as a
--      modification and allowed to change reservation fields — even
--      though it is not a modification email at all. V4 makes the
--      event-type check for this case explicit and unconditional: a
--      reservation UPDATE now REQUIRES p_event_type = 'modified' AND an
--      existing reservation AND the event not being stale — a
--      'new_booking' event for an already-existing reservation is
--      never eligible for the UPDATE branch, regardless of its
--      received_at relative to anything else. It is handled as its own
--      explicit branch, returning result:"booking_already_exists" with
--      the SAME zero-business-state-side-effects guarantee a stale
--      event already has: no customer created or changed, no
--      reservation field changed, no passenger replaced, no activity
--      created — only its own email_ingestions row is finalized
--      (processing_status='processed', reservation_id resolved to the
--      existing reservation, for auditability). See the fully explicit,
--      exhaustive event/reservation-state branch in Step 6 below.
--
-- V3 CHANGELOG (what changed since the reviewed V2, and why)
-- ─────────────────────────────────────────────────────────────
--   1. STALE EVENTS NOW HAVE ZERO SIDE EFFECTS OUTSIDE email_ingestions.
--      V2 computed the "is this event stale" ordering guard before
--      resolving/creating a customer, but still ran customer resolution
--      unconditionally — so a stale (out-of-order) event for an ALREADY-
--      EXISTING reservation could create an unused customer row even
--      though nothing else about the reservation changed. V3 locates
--      the existing reservation FIRST, and when one exists AND the
--      event is stale, returns immediately after only finalizing the
--      email_ingestions audit row — no customer, reservation, guest, or
--      activity write is attempted at all.
--   2. NO FABRICATED DEFAULTS. V2's reservation INSERT used
--      COALESCE(p_pax_adult,1), COALESCE(p_total_amount,0),
--      COALESCE(p_currency,'EUR') — inventing plausible-looking business
--      values for data that should always be present on a genuinely
--      parseable Civitatis email. V3 validates every field the
--      validated parser contract (api/civitatis/parser.js) actually
--      guarantees non-null for an `ok:true` parse — source_id,
--      external_booking_id, tour_id, event_type, check_in,
--      check_in_time, pax_adult (>0), total_amount, currency,
--      retail_amount, retail_currency, tour_language — BEFORE any
--      table write, and routes to needs_review instead of guessing if
--      any is missing. The one deliberate exception is pax_child,
--      which COALESCEs to 0 — this is NOT a fabricated default: both
--      api/civitatis/parser.js's extractGuestCounts and dryRun.js's own
--      RESERVATION_DIFF_FIELDS (`fromState: s => s.childCount || 0`)
--      already establish "no children mentioned" = 0 as the actual
--      parser contract, not an invented value.
--   3. EVENT TYPE IS NOW VALIDATED. V2 silently coerced a NULL/invalid
--      p_event_type to 'unknown' for the audit row and otherwise didn't
--      care. V3 still records whatever was given as the audit label
--      (email_ingestions.event_type allows 'unknown' precisely for
--      this), but now REFUSES any business write (customer/reservation/
--      guest/activity) unless p_event_type is exactly 'new_booking' or
--      'modified' — anything else is needs_review.
--   4. MODIFICATIONS NEVER TOUCH CUSTOMER IDENTITY. V2 ran customer
--      resolution/creation unconditionally before deciding create vs.
--      update, so a 'modified' call whose OWN event didn't happen to
--      carry a resolved customer_id could create a stray new customer
--      row even though the reservation (and its real customer) already
--      existed — the row was never attached to anything (the UPDATE
--      branch never wrote customer_id), just wasted. V3 restructures
--      the function so customer resolution/creation ONLY happens on the
--      branch that creates a brand-new reservation. The update branch
--      never calls it, never creates a customer, and never writes
--      reservations.customer_id — it reads the EXISTING reservation's
--      customer_id only to include in the return payload. This also
--      means: a modification email that happens to carry different or
--      newer contact info (e.g. a phone number appearing for the first
--      time) does NOT update the existing customer's email/phone either
--      — customer contact fields are outside the reservation
--      modification allow-list entirely; updating an existing
--      customer's own profile is a distinct, separately-designed
--      feature this migration does not implement.
--   5. A 'modified' EVENT WITH NO EXISTING RESERVATION IS NEVER TREATED
--      AS A NEW BOOKING. V2 had no explicit rule for this; because
--      customer resolution ran unconditionally, and the reservation
--      lookup returning NULL always took the CREATE branch regardless
--      of p_event_type, a 'modified' event arriving with no prior
--      'new_booking' for the same external_booking_id would have
--      silently created a reservation from whatever fields that
--      modification email happened to carry. V3 explicitly checks this
--      case and routes it to needs_review instead — a modification can
--      only ever apply to a reservation that already exists.
--   6. STALE RESULT IS ITS OWN EXPLICIT VALUE. V2 returned
--      result:"updated" with a separate boolean stale:true/false
--      alongside it for an event whose fields were deliberately not
--      applied. V3 returns result:"stale_ignored" instead — a distinct,
--      unambiguous value a caller can branch on without also having to
--      check a second field. email_ingestions.processing_status is
--      still 'processed' for a stale event (the email WAS understood
--      correctly; it was deliberately, correctly ignored — that is a
--      successful outcome, not a failure or a review case).
--   7. PASSENGER-LIST REPLACEMENT ON A MODIFICATION IS NOW GUARDED. V2
--      unconditionally DELETEd and re-INSERTed reservation_guests for
--      any non-stale event, including a modification whose passengers
--      payload was empty/missing — which would have silently erased a
--      real, previously-recorded passenger list if a modification email
--      ever failed to (re-)state passengers, since the parser does not
--      currently guarantee passengers is non-empty for an `ok:true`
--      parse (unlike every OTHER field validated in point 2, parser.js
--      has no check requiring at least one passenger). V3 only replaces
--      reservation_guests on the update path when p_passengers contains
--      at least one entry with a non-empty fullName; otherwise the
--      existing passenger rows are left completely untouched and the
--      return payload reports passengers_replaced:false. The create
--      path is unaffected (there is nothing pre-existing to erase).
--
-- Everything else — the overall single-RPC transactional architecture,
-- the gmail_message_id idempotency guard, the (source_id,
-- external_booking_id) uniqueness/advisory-lock idempotency guard, the
-- exactly-once activity notification, the EXCEPTION-handler rollback
-- behavior, the SECURITY DEFINER / REVOKE-then-GRANT-service_role-only
-- access control, the required-field validation from V3 point 2, the
-- customer creation behavior from V3 point 4, and the passenger-
-- replacement guard for valid non-stale modifications from V3 point 7
-- — is UNCHANGED from the already-reviewed V2/V3 architecture; see
-- below for the full restated contract.
--
-- SCOPE OF THIS MIGRATION
-- ─────────────────────────────────────────────────────────────
-- Adds exactly ONE object: a single transactional PL/pgSQL function,
-- public.ingest_civitatis_booking(...), plus the REVOKE/GRANT
-- statements that restrict who may call it. Same name and parameter
-- signature as V2 (CREATE OR REPLACE — safe to re-run over either V2 or
-- a fresh database). No table is created, altered, or dropped. No
-- existing row is touched. No RLS policy is added, changed, or removed.
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
-- listed in "Depends" above; unchanged from V2's audit, restated here):
--   • reservations.reservation_number is NOT NULL UNIQUE — generated
--     via the existing public.next_ref_number('R','reservations',
--     'reservation_number') helper (supabase_schema.sql), the exact
--     function DeseTourDashboard.jsx's own ReservationRepository.create
--     already calls for manually-created reservations.
--   • reservations.check_in and check_out are both NOT NULL, with
--     CHECK (check_out >= check_in). Civitatis bookings are single-day
--     tours with no independent checkout date, so check_out is always
--     set equal to check_in — the exact same default the existing
--     manual-creation code path already uses.
--   • reservations.customer_id is NOT NULL — a reservation cannot exist
--     without a resolved customer, which is why customer resolution/
--     creation must happen inside the same transaction, before the
--     reservation insert (and, per V3 point 4 above, ONLY on the branch
--     that inserts a brand-new reservation).
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
--     ('stale_ignored' and 'booking_already_exists' are RETURN VALUES
--     of the function, describing the outcome to its caller — the
--     email_ingestions row itself still uses processing_status=
--     'processed' for both cases, an existing, already-allowed value;
--     no new status string is written to the database.)
--   • email_ingestions.event_type CHECK already allows exactly
--     new_booking | modified | unknown. NOT widened by this migration.
--   • customers.full_name is the only NOT NULL column on customers
--     besides its primary key/defaults — email, phone, nationality,
--     language (DEFAULT 'tr'), birthdate, passport fields, address,
--     notes are all nullable, and import_type has NO CHECK constraint
--     restricting its values, so this function can safely set
--     import_type = 'civitatis' without any schema change.
--   • activity_logs.entity_type CHECK already allows 'reservation';
--     activity_logs.action CHECK already allows 'created'. Both
--     confirmed sufficient by supabase_migration_civitatis_ingestion.sql's
--     own audit — not re-widened here.
--   • The existing "activity_logs: sales read system-generated
--     reservation notifications" policy (added by
--     supabase_migration_civitatis_ingestion.sql) already requires
--     exactly entity_type='reservation' AND performed_by IS NULL AND
--     metadata->>'auto_ingested'='true' — this function's activity_logs
--     insert satisfies that contract exactly, unchanged.
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
--     first message for a booking CREATES the reservation. Of every
--     subsequent message for the same booking (found via that same
--     unique pair): a 'modified' one either UPDATES the same row (if
--     not stale) or is safely ignored (if stale); a SECOND
--     'new_booking' message is safely ignored too (result:
--     "booking_already_exists" — see V4 changelog point 8) — never a
--     second INSERT, and never a 'new_booking' event applying an
--     UPDATE.
--   • A stale/out-of-order event (an older email, by received_at,
--     arriving or being retried AFTER a newer one for the same booking
--     has already been applied) is detected via the existing
--     reservation lookup BEFORE any customer/reservation/guest/activity
--     write, and results in result:"stale_ignored" with zero side
--     effects beyond its own email_ingestions row (processing_status=
--     'processed', reservation_id resolved for traceability). See V3
--     changelog point 1 and 6.
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
--     MATCH / NEEDS_REVIEW / PARSE_ERROR bookings.
--   • Does not fabricate a missing business value with a plausible-
--     looking default (see V3 changelog point 2) — missing required
--     data always routes to needs_review, never a guess.
--   • Does not create a payments row, ever, for any Civitatis email.
--   • Does not assign a guide, does not touch guide_id/guide_name.
--   • Does not touch internal_notes, notes, pickup_location, pickup_time,
--     vehicle_info, driver_name, hotel_name, hotel_confirmation, status,
--     payment_status, deposit_amount, assigned_to, lead_id, quote_id,
--     confirmed_at/completed_at/cancelled_at/cancel_reason — on the
--     UPDATE (modification) path, ONLY the fields already covered by
--     dryRun.js's RESERVATION_DIFF_FIELDS allow-list are written:
--     check_in, check_in_time, pax_adult, pax_child, tour_language,
--     total_amount, currency, retail_amount, retail_currency — plus
--     check_out, which is not an independent Civitatis field but is
--     mechanically kept equal to check_in.
--   • Does not touch reservations.customer_id, and does not create or
--     modify any customer row, on the UPDATE (modification) path at all
--     — see V3 changelog point 4. Updating an existing customer's own
--     contact details is explicitly out of scope for this function.
--   • Does not treat a 'modified' event with no existing reservation as
--     a new booking — see V3 changelog point 5.
--   • Does not treat a 'new_booking' event for an ALREADY-EXISTING
--     reservation as a modification, ever, regardless of received_at
--     ordering — see V4 changelog point 8. Only a 'modified' event can
--     ever reach the UPDATE branch.
--   • Does not erase an existing passenger list when a modification's
--     own passenger payload is empty/missing — see V3 changelog point 7.
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
-- SECURITY DEFINER "search_path hijack" risk. Unchanged from V2.
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
-- Unchanged from V2 — the function signature (parameter list/types) is
-- identical, so these statements did not need to change.
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
--     Unchanged from V2; the restructuring in V3 keeps the advisory
--     lock acquisition as the very first statement inside the
--     transactional sub-block, before the reservation lookup it
--     protects.
--   • KNOWN, ACCEPTED LIMITATION (unchanged from V2, kept deliberately
--     unaddressed per explicit instruction — no name-based UNIQUE
--     constraint or automatic merge is attempted in V3 either): two
--     concurrent NEW bookings for the SAME real-world contact who has
--     never been in the CRM before, and who has no email/phone in
--     either message (so neither can match the other by contact info),
--     for two DIFFERENT external_booking_ids, could each create their
--     own new customers row for that person — the advisory lock above
--     is keyed on external_booking_id, not on customer identity, so it
--     does not serialize this case. customers has no UNIQUE constraint
--     on email/phone/full_name to lean on instead. This mirrors the
--     same fundamental limitation matching.js's matchCustomerByName
--     already documents (name-only matching is never treated as
--     certain). In practice this requires two genuinely simultaneous
--     first-ever bookings from the same new contact with no email/phone
--     recorded on either — rare, and recoverable later by a manual
--     customer-merge, never a corrupted reservation/passenger/audit
--     state.
--
-- HOW TO APPLY (once reviewed and approved — NOT done as part of
-- producing this file)
-- ─────────────────────────────────────────────────────────────
-- Supabase Dashboard → SQL Editor → paste and run this file, after
-- confirming supabase_migration_civitatis_ingestion.sql is already
-- applied (it is, per the task history — commit 879d7a5). Safe to
-- re-run in full, and safe to run directly over an already-applied V2:
-- CREATE OR REPLACE FUNCTION and the REVOKE/GRANT statements are all
-- idempotent, and the function signature is unchanged from V2.
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
  p_event_type          TEXT,        -- 'new_booking' | 'modified' — anything else is needs_review
  p_source_id           UUID,
  p_external_booking_id TEXT,
  p_tour_id             UUID,        -- already resolved by matching.js's matchTourChannel (exact match only)
  p_tour_language       TEXT,
  p_check_in            DATE,
  p_check_in_time       TIME,
  p_pax_adult           INTEGER,
  p_pax_child           INTEGER,     -- the ONE field allowed to default (to 0) — see V3 changelog point 2
  p_total_amount        NUMERIC,     -- Civitatis Net price -> reservations.total_amount
  p_currency            TEXT,
  p_retail_amount       NUMERIC,     -- Civitatis Retail price -> reservations.retail_amount
  p_retail_currency     TEXT,
  p_customer_id         UUID,        -- pre-resolved by matching.js's matchCustomer; NULL means "create" (CREATE path only — see V3 changelog point 4)
  p_customer_full_name  TEXT,        -- used ONLY on the CREATE path when p_customer_id IS NULL
  p_customer_email      TEXT,        -- used ONLY on the CREATE path when p_customer_id IS NULL
  p_customer_phone      TEXT,        -- used ONLY on the CREATE path when p_customer_id IS NULL
  p_passengers          JSONB        -- [{"fullName":"...", "sortOrder":0}, ...] from api/civitatis/parser.js
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
  v_has_valid_passengers              BOOLEAN;
  v_passengers_replaced                 BOOLEAN := FALSE;
  v_error_text                            TEXT;
BEGIN
  -- ── Step 1: Gmail-message-level idempotency (the primary guard) ────────
  -- Atomic at the database level, not an application-side "SELECT then
  -- INSERT". Records the event_type LABEL as given (even if invalid —
  -- COALESCEd to 'unknown' only for this audit row) so there is always a
  -- permanent record of what was received; validity is enforced in Step 2
  -- BEFORE any business write.
  INSERT INTO public.email_ingestions (
    gmail_message_id, gmail_thread_id, external_booking_id, source_id,
    event_type, processing_status, raw_subject, raw_body_snapshot, received_at
  ) VALUES (
    p_gmail_message_id, p_gmail_thread_id, p_external_booking_id, p_source_id,
    CASE WHEN p_event_type IN ('new_booking', 'modified') THEN p_event_type ELSE 'unknown' END,
    'received', p_raw_subject, p_raw_body_snapshot,
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

  -- ── Step 2: consolidated required-field validation — BEFORE any
  -- customer/reservation/guest/activity write is even attempted. Every
  -- field checked here is guaranteed non-null by api/civitatis/parser.js
  -- for any event with ok:true (see that file's reasons.push(...) calls
  -- for internalCode/languageRaw/date/time/adultCount/retail/net/client);
  -- a NULL here on a real ingestion call means either the caller
  -- (writeAdapter.js) has a bug or the underlying data is genuinely
  -- unusable — either way, this function never substitutes a fabricated
  -- value (see V3 changelog point 2). p_pax_child is deliberately NOT
  -- validated here: parser.js/dryRun.js's own established contract is
  -- that an absent child count means zero children, not missing data.
  IF p_source_id IS NULL THEN
    v_missing_fields := array_append(v_missing_fields, 'source_id');
  END IF;
  IF p_external_booking_id IS NULL OR btrim(p_external_booking_id) = '' THEN
    v_missing_fields := array_append(v_missing_fields, 'external_booking_id');
  END IF;
  IF p_tour_id IS NULL THEN
    v_missing_fields := array_append(v_missing_fields, 'tour_id (Internal code did not match tour_channels)');
  END IF;
  IF p_event_type IS NULL OR p_event_type NOT IN ('new_booking', 'modified') THEN
    v_missing_fields := array_append(v_missing_fields, 'event_type (must be exactly new_booking or modified)');
  END IF;
  IF p_check_in IS NULL THEN
    v_missing_fields := array_append(v_missing_fields, 'check_in');
  END IF;
  IF p_check_in_time IS NULL THEN
    v_missing_fields := array_append(v_missing_fields, 'check_in_time');
  END IF;
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

  BEGIN  -- nested block: on any unexpected error below, roll back every
         -- customer/reservation/guest/activity write attempted in this
         -- call (but NOT the email_ingestions row from Step 1, which
         -- this handler explicitly re-records as 'failed' after the
         -- implicit rollback-to-savepoint) — see migration header.

    -- ── Step 3: serialize concurrent processing of the SAME booking ──────
    -- hashtextextended returns bigint, matching pg_advisory_xact_lock's
    -- signature; released automatically at transaction end (COMMIT or
    -- ROLLBACK) — never needs an explicit unlock call. Acquired BEFORE
    -- the reservation lookup it protects.
    PERFORM pg_advisory_xact_lock(
      hashtextextended(p_source_id::text || ':' || p_external_booking_id, 0)
    );

    -- ── Step 4: locate the existing reservation for this booking, if any
    -- — moved BEFORE any customer write (V3 changelog points 1 and 4).
    -- FOR UPDATE locks the row (if found) for the remainder of this
    -- transaction, consistent with the advisory lock's serialization.
    SELECT id, customer_id INTO v_reservation_id, v_customer_id
      FROM public.reservations
     WHERE source_id = p_source_id AND external_booking_id = p_external_booking_id
     FOR UPDATE;

    -- ── Step 5: ordering guard — has a NEWER event for this booking
    -- already been applied? Only meaningful when a reservation already
    -- exists; a booking with no reservation yet cannot have a 'processed'
    -- email_ingestions row either (Step 8 always sets both together), so
    -- this is trivially FALSE when v_reservation_id IS NULL.
    SELECT EXISTS (
      SELECT 1 FROM public.email_ingestions
       WHERE source_id = p_source_id
         AND external_booking_id = p_external_booking_id
         AND processing_status = 'processed'
         AND received_at > COALESCE(p_received_at, NOW())
    ) INTO v_newer_exists;

    -- ── Step 6: branch — fully explicit, exhaustive event/reservation-
    -- state matrix (V4 changelog point 8). Every branch condition names
    -- BOTH p_event_type and the reservation-existence state explicitly
    -- — a reservation UPDATE is reachable ONLY via the one branch that
    -- requires p_event_type = 'modified' AND an existing reservation
    -- AND NOT v_newer_exists, all three, together. A 'new_booking'
    -- event can NEVER reach the UPDATE branch, regardless of
    -- received_at ordering — see the explicit
    -- "booking_already_exists" branch below, which handles a second,
    -- genuinely distinct 'new_booking' Gmail message for a booking that
    -- already has a reservation.
    --
    --   event_type=new_booking, no reservation          -> CREATE
    --   event_type=modified,    reservation exists,
    --                            not stale                -> UPDATE
    --   event_type=modified,    reservation exists,
    --                            stale                     -> stale_ignored
    --   event_type=modified,    no reservation              -> manual_review_required
    --   event_type=new_booking, reservation exists            -> booking_already_exists
    IF v_reservation_id IS NOT NULL AND p_event_type = 'new_booking' THEN
      -- A second, distinct Gmail message that Civitatis itself
      -- classified as "New booking A########:" (not a modification) for
      -- a booking that already has a reservation. This is NOT a
      -- modification and must never be treated as one — zero business-
      -- state side effects beyond this event's own audit row: no
      -- customer created or changed, no reservation field changed, no
      -- passenger replaced, no activity created (V4 changelog point 8).
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
      -- A 'modified' event with NO existing reservation to modify (V3
      -- changelog point 5) — never silently treated as a new booking.
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
      -- CREATE path. Customer resolution/creation happens ONLY here
      -- (V3 changelog point 4) — the update branch below never reaches
      -- this code.
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
          RETURN jsonb_build_object(
            'result', 'manual_review_required',
            'ingestion_id', v_ingestion_id,
            'reason', 'missing booking-contact identity'
          );
        END IF;
        -- Booking-contact data only — never a passenger. Never invented:
        -- email/phone/nationality/country stay NULL when Civitatis did
        -- not provide them. import_type has no CHECK constraint
        -- restricting its values, so 'civitatis' needs no migration.
        INSERT INTO public.customers (full_name, email, phone, source_id, import_type)
        VALUES (p_customer_full_name, p_customer_email, p_customer_phone, p_source_id, 'civitatis')
        RETURNING id INTO v_customer_id;
      END IF;

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
        p_pax_adult, COALESCE(p_pax_child, 0),  -- pax_adult already validated NOT NULL/>0 in Step 2; pax_child's 0-default is the established parser contract, not a fabrication (see header)
        p_tour_language, p_total_amount, p_currency,
        p_retail_amount, p_retail_currency
      )
      RETURNING id INTO v_reservation_id;

      v_result := 'created';

      -- Passenger insert — harmless even if p_passengers is empty (there
      -- is nothing pre-existing to protect on the create path).
      INSERT INTO public.reservation_guests (reservation_id, full_name, sort_order)
      SELECT v_reservation_id, (g->>'fullName'), COALESCE((g->>'sortOrder')::int, 0)
        FROM jsonb_array_elements(COALESCE(p_passengers, '[]'::jsonb)) AS g
       WHERE btrim(g->>'fullName') IS NOT NULL AND btrim(g->>'fullName') <> '';
      v_passengers_replaced := TRUE;

      UPDATE public.email_ingestions
         SET processing_status = 'processed', reservation_id = v_reservation_id, processed_at = NOW()
       WHERE id = v_ingestion_id;

      -- Exactly-once "new reservation" activity notification — only ever
      -- reached from this CREATE branch, which — by the UNIQUE
      -- constraint + advisory lock — can execute at most once per
      -- (source_id, external_booking_id), ever.
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
              -- satisfies explicitly keys on performed_by IS NULL
      );

    ELSIF v_reservation_id IS NOT NULL AND p_event_type = 'modified' AND v_newer_exists THEN
      -- STALE modification for an existing reservation: zero side
      -- effects beyond this event's own audit row (V3 changelog points
      -- 1 and 6). No customer, reservation, guest, or activity write of
      -- any kind.
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
      -- UPDATE path: the ONLY branch that ever writes reservation
      -- fields — reachable ONLY when p_event_type = 'modified' AND an
      -- existing reservation was found AND the event is not stale, all
      -- three required together (V4 changelog point 8).
      -- Customer identity is NEVER touched here (V3 changelog point 4):
      -- v_customer_id already holds the EXISTING reservation's
      -- customer_id from Step 4's lookup, read-only, for the return
      -- payload — no customers table write of any kind on this path,
      -- regardless of what p_customer_id/p_customer_full_name/
      -- p_customer_email/p_customer_phone were given.
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
      -- Deliberately absent from this SET list (never written on an
      -- update, by construction — not merely by convention): customer_id,
      -- guide_id, guide_name, internal_notes, notes, status,
      -- payment_status, deposit_amount, pickup_location, pickup_time,
      -- vehicle_info, driver_name, hotel_name, hotel_confirmation,
      -- assigned_to, lead_id, quote_id, confirmed_at, completed_at,
      -- cancelled_at, cancel_reason, destination.

      v_result := 'updated';

      -- Passenger-list replacement is guarded (V3 changelog point 7): a
      -- modification with no usable passenger entries never erases a
      -- real, previously-recorded passenger list.
      SELECT EXISTS (
        SELECT 1 FROM jsonb_array_elements(COALESCE(p_passengers, '[]'::jsonb)) AS g
         WHERE btrim(g->>'fullName') IS NOT NULL AND btrim(g->>'fullName') <> ''
      ) INTO v_has_valid_passengers;

      IF v_has_valid_passengers THEN
        DELETE FROM public.reservation_guests WHERE reservation_id = v_reservation_id;
        INSERT INTO public.reservation_guests (reservation_id, full_name, sort_order)
        SELECT v_reservation_id, (g->>'fullName'), COALESCE((g->>'sortOrder')::int, 0)
          FROM jsonb_array_elements(p_passengers) AS g
         WHERE btrim(g->>'fullName') IS NOT NULL AND btrim(g->>'fullName') <> '';
        v_passengers_replaced := TRUE;
      END IF;
      -- else: v_passengers_replaced stays FALSE; existing
      -- reservation_guests rows for this reservation are left completely
      -- untouched.

      -- No activity_logs row on the update path — a modification never
      -- creates a second "new reservation" notification.
      UPDATE public.email_ingestions
         SET processing_status = 'processed', reservation_id = v_reservation_id, processed_at = NOW()
       WHERE id = v_ingestion_id;

    ELSE
      -- Defensively unreachable: Step 2 already guarantees p_event_type
      -- is exactly 'new_booking' or 'modified', and the five branches
      -- above are an exhaustive case split over
      -- {new_booking,modified} x {reservation exists?} x {stale?
      -- — only meaningful for modified+exists}. Never silently write
      -- business state if this is somehow reached anyway.
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
      'passengers_replaced', v_passengers_replaced
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
  'booking-notification email. On the CREATE path (event_type= '
  'new_booking, no existing reservation): resolves/creates the '
  'booking-contact customer, creates the reservation, inserts '
  'passengers, records the email_ingestions audit row, and inserts '
  'exactly one activity_logs notification. On the UPDATE path '
  '(event_type=modified, an existing reservation found, event not '
  'stale — ALL THREE required together): updates ONLY the '
  'Civitatis-allowed reservation fields and, if a usable passenger list '
  'was supplied, replaces reservation_guests — never touches customer '
  'identity, never creates a second activity row. A stale modification, '
  'a modification with no existing reservation, a second new_booking '
  'event for an already-existing reservation, or a call missing any '
  'required field has ZERO business-state side effects and is reported '
  'distinctly (stale_ignored / manual_review_required / '
  'booking_already_exists). Any unexpected error rolls back all '
  'business writes for that call while still recording a '
  '''failed'' audit row. SECURITY DEFINER; callable only by '
  'service_role — see this migration file''s header for the full '
  'contract. Never call directly from browser code.';


-- ──────────────────────────────────────────────────────────────────────────
-- SECURITY: restrict EXECUTE to service_role only.
-- Idempotent: REVOKE/GRANT can be re-run any number of times safely.
-- Signature unchanged from V2 — these statements did not need to change.
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
