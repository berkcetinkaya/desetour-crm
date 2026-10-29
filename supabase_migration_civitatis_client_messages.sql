-- ============================================================
-- DESE TOUR OPERATIONS CENTER
-- Migration: Civitatis Client/Reservation Messages
-- ============================================================
-- File:    supabase_migration_civitatis_client_messages.sql
-- Depends: supabase_schema.sql, supabase_rls_policies.sql,
--          supabase_migration_aal2_enforcement.sql (is_admin/is_sales/
--          is_operations/is_guide/is_aal2 helpers),
--          supabase_migration_civitatis_ingestion.sql
--          (reservations.source_id/external_booking_id columns +
--          reservations_source_id_external_booking_id_key).
-- Version: Civitatis client-message ingestion — Phase 1 (ingest + display
--          only; see PART 9 of the approved design — never auto-mutates
--          any reservation field).
--
-- WHAT THIS ADDS
-- ─────────────────────────────────────────────────────────────
-- Exactly ONE new table (public.reservation_messages) and ONE new
-- function (public.ingest_civitatis_reservation_message). NO ALTER to
-- any existing table — reservations, activity_logs, email_ingestions,
-- agency_emails are all completely untouched; entity_type='reservation'
-- and action='reply' are already allowed by activity_logs' own CHECK
-- constraints (see supabase_migration_civitatis_settlement_phase1.sql /
-- supabase_migration_agency_draft_flow.sql), so no CHECK-constraint
-- widening is needed either.
--
-- WHY A NEW TABLE (not email_ingestions, not an existing notes field)
-- ─────────────────────────────────────────────────────────────
-- email_ingestions is explicitly an internal booking-pipeline audit
-- trail — admin/operations SELECT-only, its own event_type CHECK does
-- not include this case, and it was never meant to hold staff-facing
-- message content. reservations.notes/internal_notes are free-text
-- staff fields; writing external Civitatis message text into them would
-- destroy source/timestamp/history information and risks being
-- mistaken for a staff note — explicitly ruled out by the approved
-- design.
--
-- IDEMPOTENCY (Part 5)
-- ─────────────────────────────────────────────────────────────
-- UNIQUE (source, gmail_message_id) is the sole authority. The function
-- below checks for an existing row by this key BEFORE doing any
-- matching work, and additionally catches a unique_violation on INSERT
-- (defense in depth against a genuine race between two overlapping
-- ingestion runs) — both paths return {result:'already_processed'}
-- rather than creating a duplicate row or a duplicate activity_logs
-- entry. Never deduplicated by message body text.
--
-- MATCHING (Part 2) — never fuzzy
-- ─────────────────────────────────────────────────────────────
-- Exact match only, against reservations.external_booking_id scoped to
-- the Civitatis source_id (the SAME identity key
-- reservations_source_id_external_booking_id_key already enforces
-- uniqueness on for bookings). Exactly one match -> 'matched'
-- (reservation_id set). Zero matches -> 'unmatched' (reservation_id
-- NULL, row still persisted — never silently discarded). More than one
-- match (structurally prevented today by that same UNIQUE constraint,
-- but handled anyway, defensively) -> 'ambiguous' (reservation_id NULL,
-- fails closed, never guessed).
--
-- NOTIFICATION + ACTIVITY LOG (Parts 7/8) — ONE row does both
-- ─────────────────────────────────────────────────────────────
-- Exactly one activity_logs INSERT, only for a newly-matched message
-- (never for unmatched/ambiguous, never for an already-processed
-- repeat): entity_type='reservation', action='reply' (both already
-- allowed), metadata.auto_ingested='true'. This is the EXACT same
-- precedent api/_agencies/gmailInboundSync.js's logInboundReply already
-- established for Agency Mailbox replies, reused here without
-- modifying that file at all. The existing activity_log_reads table and
-- useOperationalNotifications()/NotificationBell already surface any
-- entity_type='reservation' row generically — zero frontend/query
-- change required for the notification itself. The message body is
-- NEVER written into activity_logs.
--
-- SECURITY / RLS (Part 11)
-- ─────────────────────────────────────────────────────────────
-- RLS enabled, mirroring reservations'/reservation_guests' own policies
-- exactly (is_admin()/is_sales()/is_operations()/is_guide() + is_aal2()
-- on every single policy — no AAL2 weakening anywhere):
--   • admin/operations: SELECT all rows (including unmatched/ambiguous,
--     for investigation) — NOT "full access": there is deliberately NO
--     INSERT/UPDATE/DELETE policy for ANY authenticated role, matching
--     email_ingestions' own "not casually editable, even at admin
--     level" precedent. The service_role-authenticated ingestion job is
--     the only writer — see the SECURITY DEFINER AUDIT section below for
--     exactly how this function enforces that without SECURITY DEFINER.
--   • sales: SELECT, matched rows only (reservation_id IS NOT NULL).
--     Audited against reservations' own policy before finalizing this:
--     "reservations: sales read" is already unconditional
--     (is_sales() AND is_aal2(), no per-row restriction) — Sales can
--     already read every reservation, so seeing every MATCHED
--     reservation_message exposes nothing Sales could not already see
--     via the reservations table itself. Never exposed to Sales:
--     unmatched/ambiguous rows (reservation_id IS NULL) — these are an
--     internal ingestion-investigation concern, not operational data
--     tied to any reservation Sales can look up.
--   • guide: SELECT, scoped exactly like "reservations: guide reads
--     assigned" / "reservation_guests: guide reads assigned" — only
--     rows whose reservation is their own assigned, non-cancelled
--     reservation.
-- RLS is never weakened on any existing table by this migration.
--
-- SECURITY DEFINER AUDIT (performed before this migration was approved
-- for application — not SECURITY DEFINER, by deliberate decision)
-- ─────────────────────────────────────────────────────────────
-- The three existing Civitatis RPCs (ingest_civitatis_booking,
-- cancel_civitatis_booking, mark_civitatis_email_needs_review) are all
-- SECURITY DEFINER. This function deliberately is NOT, after auditing
-- whether that elevation is actually load-bearing here:
--   • The ONLY caller, enforced by the REVOKE/GRANT block below, is
--     service_role — never authenticated, never anon.
--   • Supabase's service_role key "automatically bypasses RLS" (see
--     supabase_rls_policies.sql's own "SERVICE ROLE BYPASS" section) —
--     this is a role-level attribute (effectively BYPASSRLS), not
--     something SECURITY DEFINER would additionally grant. A SECURITY
--     INVOKER function executed by a service_role-authenticated session
--     already runs with every privilege SECURITY DEFINER could offer
--     here: unrestricted read of public.reservations, unrestricted
--     insert into public.reservation_messages/public.activity_logs,
--     RLS bypassed on all three regardless.
--   • None of the existing migrations GRANT service_role any explicit
--     table-level privilege on reservations/activity_logs, yet the
--     three existing SECURITY DEFINER RPCs already read/write both
--     successfully in production when called by service_role — proving
--     service_role's OWN baseline privileges (not those three
--     functions' SECURITY DEFINER elevation) are what make those calls
--     work. The same baseline privileges apply here.
--   • SECURITY INVOKER is therefore strictly MORE defense-in-depth, not
--     less: if the EXECUTE grant were ever misconfigured and a non-
--     service_role session somehow invoked this function, RLS would
--     still apply to THAT session's own privileges (no INSERT policy
--     exists for authenticated/anon — see STEP 3 above), so the write
--     would be rejected by RLS itself, a second independent gate beyond
--     the EXECUTE grant. A SECURITY DEFINER function would have bypassed
--     that second gate entirely, relying on the EXECUTE grant alone.
-- Confirmed as part of this audit, all still true with SECURITY INVOKER:
--   ✓ search_path is explicitly fixed (SET search_path = public on the
--     function itself, belt-and-suspenders alongside the fact that
--     every table reference inside the function body is ALSO fully
--     schema-qualified — public.reservations, public.reservation_messages,
--     public.activity_logs — so a hostile search_path could not redirect
--     any reference even without the SET clause).
--   ✓ The function cannot be executed by authenticated or anon roles
--     (REVOKE ALL ... FROM authenticated / FROM anon below).
--   ✓ EXECUTE is revoked from PUBLIC.
--   ✓ Only service_role is GRANTed EXECUTE.
--   ✓ Every table reference is schema-qualified (public.*) throughout.
--   ✓ No dynamic SQL (no EXECUTE/format()/string-built SQL) anywhere in
--     the function body — every statement is a static, literal SQL
--     statement; no user-controlled input is ever concatenated into SQL
--     text.
-- RLS is not weakened by any of this — if anything, removing SECURITY
-- DEFINER means RLS keeps mattering as a real, live second gate for this
-- function specifically, which it would not under SECURITY DEFINER.
--
-- HOW TO APPLY
-- ─────────────────────────────────────────────────────────────
-- Supabase Dashboard -> SQL Editor -> paste and run this file IN FULL,
-- in a single execution. Wrapped in an explicit BEGIN/COMMIT so a failed
-- postflight aborts the whole transaction rather than leaving anything
-- partial.
-- ============================================================

BEGIN;

-- ──────────────────────────────────────────────────────────────────────────
-- STEP 1: the table itself.
-- ──────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.reservation_messages (
  id                    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  -- ON DELETE SET NULL, deliberately NOT CASCADE: Civitatis communication
  -- is historical operational evidence and must never be physically
  -- destroyed merely because the reservation row it referenced is later
  -- removed. A message whose reservation disappears simply becomes
  -- reservation_id = NULL — same shape as an 'unmatched' row, still
  -- fully visible to admin/operations for investigation.
  reservation_id        UUID        REFERENCES public.reservations(id) ON DELETE SET NULL,
  source                TEXT        NOT NULL DEFAULT 'civitatis'
                                     CHECK (source IN ('civitatis')),
  direction              TEXT        NOT NULL DEFAULT 'inbound'
                                     CHECK (direction IN ('inbound')),
  match_status           TEXT        NOT NULL
                                     CHECK (match_status IN ('matched','unmatched','ambiguous')),
  -- Kept even when unmatched/ambiguous — the raw evidence of what the
  -- email claimed, for later investigation; never discarded.
  external_booking_id     TEXT        NOT NULL,
  gmail_message_id         TEXT        NOT NULL,
  gmail_thread_id           TEXT,
  subject                    TEXT,
  -- Clean, sanitized, customer/agency message text ONLY — never the
  -- Civitatis template/branding/footer/price summary. See
  -- api/_civitatis/clientMessageExtraction.js.
  message_text                TEXT        NOT NULL,
  -- Reserved for Part 6's optional "Mesajı Civitatis'te Aç" action.
  -- Deliberately left NULL/unpopulated in this phase — no such URL is
  -- safely, deterministically extractable from the evidence available;
  -- never fabricated.
  external_url                  TEXT,
  received_at                     TIMESTAMPTZ NOT NULL,
  created_at                        TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Idempotency authority (Part 5) — never deduplicated by body text.
  CONSTRAINT reservation_messages_source_gmail_message_id_key
    UNIQUE (source, gmail_message_id),

  -- match_status and reservation_id can never disagree: a 'matched' row
  -- always carries its reservation_id, an 'unmatched'/'ambiguous' row
  -- never does. Structurally prevents ever displaying a message under a
  -- GUESSED reservation (Part 2's core rule).
  CONSTRAINT reservation_messages_match_status_consistency CHECK (
    (match_status = 'matched'   AND reservation_id IS NOT NULL)
    OR
    (match_status IN ('unmatched','ambiguous') AND reservation_id IS NULL)
  )
);

COMMENT ON TABLE public.reservation_messages IS 'Civitatis client/agency messages about a reservation ("New client message about your reservation <number>" emails) — a reservation communication timeline, never mixed into internal staff notes. Ingested by public.ingest_civitatis_reservation_message(...) only; no authenticated role may INSERT/UPDATE/DELETE. Phase 1: ingest + display only — never mutates any reservations column.';
COMMENT ON COLUMN public.reservation_messages.reservation_id IS 'NULL exactly when match_status is unmatched/ambiguous (see the consistency CHECK). ON DELETE SET NULL, not CASCADE — this communication history must survive even if the reservation row is later deleted.';
COMMENT ON COLUMN public.reservation_messages.match_status IS 'matched: exactly one reservation found by (source_id, external_booking_id) at ingestion time. unmatched: zero found. ambiguous: more than one found (defensive — the existing reservations_source_id_external_booking_id_key UNIQUE constraint already makes this unreachable in practice). Never fuzzy-matched, never guessed.';
COMMENT ON COLUMN public.reservation_messages.external_booking_id IS 'The Civitatis reservation number as extracted from the email (subject, with the body''s "Reservation number:" line as a deterministic fallback) — same bare-digit shape as reservations.external_booking_id. Kept even when unmatched.';
COMMENT ON COLUMN public.reservation_messages.message_text IS 'The actual customer/agency message only — Civitatis branding, footer, social links, price summary, and decorative template copy are stripped before this column is ever written. Never translated, never rewritten, never summarized.';

-- ──────────────────────────────────────────────────────────────────────────
-- STEP 2: indexes — only what the UI/ingestion actually query by.
-- ──────────────────────────────────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS idx_reservation_messages_reservation_id ON public.reservation_messages(reservation_id);
CREATE INDEX IF NOT EXISTS idx_reservation_messages_received_at   ON public.reservation_messages(received_at DESC);
CREATE INDEX IF NOT EXISTS idx_reservation_messages_match_status  ON public.reservation_messages(match_status);

-- ──────────────────────────────────────────────────────────────────────────
-- STEP 3: RLS — enabled, mirrors reservations'/reservation_guests' own
-- policies exactly; no INSERT/UPDATE/DELETE policy for any authenticated
-- role (service_role, via the SECURITY INVOKER function below — see the
-- SECURITY DEFINER AUDIT section above — is the only writer, since only
-- service_role is ever granted EXECUTE).
-- ──────────────────────────────────────────────────────────────────────────

ALTER TABLE public.reservation_messages ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "reservation_messages: admin read" ON public.reservation_messages;
CREATE POLICY "reservation_messages: admin read" ON public.reservation_messages
  FOR SELECT TO authenticated
  USING ( is_admin() AND is_aal2() );

DROP POLICY IF EXISTS "reservation_messages: operations read" ON public.reservation_messages;
CREATE POLICY "reservation_messages: operations read" ON public.reservation_messages
  FOR SELECT TO authenticated
  USING ( is_operations() AND is_aal2() );

-- Audited against "reservations: sales read" (unconditional
-- is_sales() AND is_aal2(), no per-row restriction) before finalizing —
-- Sales already sees every reservation, so matched-only visibility here
-- exposes nothing Sales could not already reach via reservations.
DROP POLICY IF EXISTS "reservation_messages: sales read matched" ON public.reservation_messages;
CREATE POLICY "reservation_messages: sales read matched" ON public.reservation_messages
  FOR SELECT TO authenticated
  USING ( is_sales() AND is_aal2() AND reservation_id IS NOT NULL );

DROP POLICY IF EXISTS "reservation_messages: guide reads assigned" ON public.reservation_messages;
CREATE POLICY "reservation_messages: guide reads assigned" ON public.reservation_messages
  FOR SELECT TO authenticated
  USING (
    is_guide() AND is_aal2() AND reservation_id IS NOT NULL AND EXISTS (
      SELECT 1 FROM public.reservations r
       WHERE r.id = reservation_messages.reservation_id
         AND r.assigned_to = auth.uid()
         AND r.status NOT IN ('cancelled')
    )
  );

-- ──────────────────────────────────────────────────────────────────────────
-- STEP 4: the ingestion function. SECURITY INVOKER (the default — listed
-- explicitly for auditability) + locked-down EXECUTE grant. Deliberately
-- NOT SECURITY DEFINER, unlike ingest_civitatis_booking(...)/
-- cancel_civitatis_booking(...)/mark_civitatis_email_needs_review(...) —
-- see the "SECURITY DEFINER AUDIT" section in this file's header for the
-- full reasoning: the only caller is service_role, which already
-- bypasses RLS and holds the needed table privileges directly, so
-- SECURITY DEFINER would add privilege-escalation risk with no
-- compensating benefit here.
-- ──────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.ingest_civitatis_reservation_message(
  p_gmail_message_id    TEXT,
  p_gmail_thread_id     TEXT,
  p_received_at         TIMESTAMPTZ,
  p_raw_subject         TEXT,
  p_source_id           UUID,
  p_external_booking_id TEXT,
  p_message_text        TEXT,
  -- Part 1's subject/body reservation-number-mismatch fail-closed rule:
  -- when the caller (api/_civitatis/clientMessageAdapter.js) already
  -- detected that the subject and body disagree on the reservation
  -- number, it sets this TRUE and passes whichever number it has (the
  -- subject's, per Part 1's own subject-is-primary ordering) ONLY as a
  -- diagnostic trace — this function then skips the matching step
  -- entirely and forces match_status='ambiguous', reservation_id=NULL,
  -- so a possibly-wrong number can never accidentally collide with and
  -- attach to an unrelated real reservation. Defaults FALSE so every
  -- other (non-mismatch) call site is unaffected.
  p_force_ambiguous     BOOLEAN DEFAULT FALSE
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_existing_id        UUID;
  v_match_count        INTEGER;
  v_reservation_id      UUID;
  v_reservation_number    TEXT;
  v_match_status            TEXT;
  v_message_id                UUID;
BEGIN
  -- STEP 0 — missing-field guard. A caller bug must fail loudly, never
  -- silently insert a half-formed row.
  IF p_gmail_message_id IS NULL OR btrim(p_gmail_message_id) = '' THEN
    RETURN jsonb_build_object('result','failed','reason','missing_gmail_message_id');
  END IF;
  IF p_external_booking_id IS NULL OR btrim(p_external_booking_id) = '' THEN
    RETURN jsonb_build_object('result','failed','reason','missing_external_booking_id');
  END IF;
  IF p_message_text IS NULL OR btrim(p_message_text) = '' THEN
    RETURN jsonb_build_object('result','failed','reason','missing_message_text');
  END IF;
  IF p_source_id IS NULL THEN
    RETURN jsonb_build_object('result','failed','reason','missing_source_id');
  END IF;

  -- STEP 1 — idempotency FIRST, before any matching work (Part 5).
  SELECT id INTO v_existing_id
    FROM public.reservation_messages
   WHERE source = 'civitatis' AND gmail_message_id = p_gmail_message_id;

  IF v_existing_id IS NOT NULL THEN
    RETURN jsonb_build_object('result','already_processed','reservation_message_id',v_existing_id);
  END IF;

  -- STEP 2 — exact match only (Part 2), UNLESS the caller already
  -- determined this is an unresolvable subject/body mismatch, in which
  -- case the lookup is skipped entirely — never attempted with a number
  -- that might not even be the right one. Otherwise counted explicitly,
  -- never an exception-driven path, so 'ambiguous' is an intentional
  -- branch.
  IF p_force_ambiguous THEN
    v_reservation_id := NULL;
    v_match_status := 'ambiguous';
  ELSE
    SELECT COUNT(*) INTO v_match_count
      FROM public.reservations
     WHERE source_id = p_source_id AND external_booking_id = p_external_booking_id;

    IF v_match_count = 1 THEN
      SELECT id, reservation_number INTO v_reservation_id, v_reservation_number
        FROM public.reservations
       WHERE source_id = p_source_id AND external_booking_id = p_external_booking_id;
      v_match_status := 'matched';
    ELSIF v_match_count = 0 THEN
      v_reservation_id := NULL;
      v_match_status := 'unmatched';
    ELSE
      v_reservation_id := NULL;
      v_match_status := 'ambiguous';
    END IF;
  END IF;

  -- STEP 3 — persist the message. Never discarded, even when unmatched.
  INSERT INTO public.reservation_messages (
    reservation_id, source, direction, match_status,
    external_booking_id, gmail_message_id, gmail_thread_id,
    subject, message_text, received_at
  ) VALUES (
    v_reservation_id, 'civitatis', 'inbound', v_match_status,
    p_external_booking_id, p_gmail_message_id, p_gmail_thread_id,
    p_raw_subject, p_message_text, p_received_at
  )
  RETURNING id INTO v_message_id;

  -- STEP 4 — ONE activity_logs row, ONLY for a newly matched message.
  -- Never the message body. Serves Part 7 (notification) and Part 8
  -- (activity log) simultaneously — see gmailInboundSync.js's
  -- logInboundReply for the identical established precedent.
  IF v_match_status = 'matched' THEN
    INSERT INTO public.activity_logs (entity_type, entity_id, action, description, metadata, performed_by)
    VALUES (
      'reservation', v_reservation_id, 'reply',
      COALESCE(v_reservation_number, p_external_booking_id) || ' numaralı rezervasyona yeni Civitatis mesajı geldi.',
      jsonb_build_object(
        'auto_ingested', 'true',
        'source', 'civitatis_message',
        'external_booking_id', p_external_booking_id,
        'reservation_number', v_reservation_number
      ),
      NULL
    );
  END IF;

  RETURN jsonb_build_object(
    'result', v_match_status,
    'reservation_message_id', v_message_id,
    'reservation_id', v_reservation_id
  );
EXCEPTION
  -- Defense in depth against a genuine race between two overlapping
  -- ingestion runs for the SAME Gmail message (the Step 1 SELECT above
  -- is not itself a lock) — the UNIQUE constraint is the final
  -- authority either way. Treated as the SAME idempotent skip as Step
  -- 1, never as a failure.
  WHEN unique_violation THEN
    RETURN jsonb_build_object('result','already_processed');
END;
$$;

COMMENT ON FUNCTION public.ingest_civitatis_reservation_message(TEXT, TEXT, TIMESTAMPTZ, TEXT, UUID, TEXT, TEXT, BOOLEAN) IS 'Ingests ONE Civitatis client-message email (already detected/extracted in JS — see api/_civitatis/clientMessageAdapter.js). Idempotent on (source, gmail_message_id). Exact-match-only against reservations.external_booking_id scoped to p_source_id, never fuzzy. Writes exactly one activity_logs row (entity_type=reservation, action=reply) when, and only when, a NEW message is matched to a reservation. Never mutates any reservations column.';

-- ──────────────────────────────────────────────────────────────────────────
-- SECURITY: restrict EXECUTE to service_role only — same lockdown as
-- every other Civitatis ingestion RPC. Idempotent.
-- ──────────────────────────────────────────────────────────────────────────

REVOKE ALL ON FUNCTION public.ingest_civitatis_reservation_message(
  TEXT, TEXT, TIMESTAMPTZ, TEXT, UUID, TEXT, TEXT, BOOLEAN
) FROM PUBLIC;

REVOKE ALL ON FUNCTION public.ingest_civitatis_reservation_message(
  TEXT, TEXT, TIMESTAMPTZ, TEXT, UUID, TEXT, TEXT, BOOLEAN
) FROM anon;

REVOKE ALL ON FUNCTION public.ingest_civitatis_reservation_message(
  TEXT, TEXT, TIMESTAMPTZ, TEXT, UUID, TEXT, TEXT, BOOLEAN
) FROM authenticated;

GRANT EXECUTE ON FUNCTION public.ingest_civitatis_reservation_message(
  TEXT, TEXT, TIMESTAMPTZ, TEXT, UUID, TEXT, TEXT, BOOLEAN
) TO service_role;

-- ──────────────────────────────────────────────────────────────────────────
-- POSTFLIGHT — verify every object this migration was supposed to create
-- exists with exactly the expected properties, and that nothing outside
-- this migration's explicit scope was touched. RAISE EXCEPTION aborts
-- the whole transaction (COMMIT below never runs) on any mismatch.
-- ──────────────────────────────────────────────────────────────────────────

DO $$
DECLARE
  v_policy_count       INT;
  v_function_secdef     BOOLEAN;
  v_execute_grantees      TEXT[];
  v_entity_type_def          TEXT;
  v_action_def                 TEXT;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
     WHERE table_schema='public' AND table_name='reservation_messages'
  ) THEN
    RAISE EXCEPTION 'CIVITATIS CLIENT MESSAGES POSTFLIGHT FAILED: public.reservation_messages was not created. Aborting.';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.reservation_messages'::regclass
       AND conname = 'reservation_messages_source_gmail_message_id_key'
  ) THEN
    RAISE EXCEPTION 'CIVITATIS CLIENT MESSAGES POSTFLIGHT FAILED: UNIQUE (source, gmail_message_id) constraint missing. Aborting.';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.reservation_messages'::regclass
       AND conname = 'reservation_messages_match_status_consistency'
  ) THEN
    RAISE EXCEPTION 'CIVITATIS CLIENT MESSAGES POSTFLIGHT FAILED: match_status/reservation_id consistency CHECK missing. Aborting.';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname='public' AND tablename='reservation_messages' AND indexname='idx_reservation_messages_reservation_id') THEN
    RAISE EXCEPTION 'CIVITATIS CLIENT MESSAGES POSTFLIGHT FAILED: idx_reservation_messages_reservation_id missing. Aborting.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname='public' AND tablename='reservation_messages' AND indexname='idx_reservation_messages_received_at') THEN
    RAISE EXCEPTION 'CIVITATIS CLIENT MESSAGES POSTFLIGHT FAILED: idx_reservation_messages_received_at missing. Aborting.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname='public' AND tablename='reservation_messages' AND indexname='idx_reservation_messages_match_status') THEN
    RAISE EXCEPTION 'CIVITATIS CLIENT MESSAGES POSTFLIGHT FAILED: idx_reservation_messages_match_status missing. Aborting.';
  END IF;

  SELECT COUNT(*) INTO v_policy_count FROM pg_policies WHERE schemaname='public' AND tablename='reservation_messages';
  IF v_policy_count <> 4 THEN
    RAISE EXCEPTION 'CIVITATIS CLIENT MESSAGES POSTFLIGHT FAILED: expected exactly 4 RLS policies (admin/operations/sales/guide, all SELECT-only), found %. Aborting.', v_policy_count;
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname='public' AND tablename='reservation_messages'
       AND cmd IN ('INSERT','UPDATE','DELETE','ALL')
  ) THEN
    RAISE EXCEPTION 'CIVITATIS CLIENT MESSAGES POSTFLIGHT FAILED: a non-SELECT policy exists for an authenticated role — no authenticated role may write to this table. Aborting.';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'ingest_civitatis_reservation_message') THEN
    RAISE EXCEPTION 'CIVITATIS CLIENT MESSAGES POSTFLIGHT FAILED: public.ingest_civitatis_reservation_message was not created. Aborting.';
  END IF;

  -- Deliberately SECURITY INVOKER, NOT SECURITY DEFINER — see this
  -- file's "SECURITY DEFINER AUDIT" header section. The only caller is
  -- service_role (enforced below), which already bypasses RLS and holds
  -- the needed table privileges directly; SECURITY DEFINER would only
  -- add privilege-escalation risk with no compensating benefit here.
  SELECT prosecdef INTO v_function_secdef FROM pg_proc WHERE proname = 'ingest_civitatis_reservation_message';
  IF v_function_secdef THEN
    RAISE EXCEPTION 'CIVITATIS CLIENT MESSAGES POSTFLIGHT FAILED: ingest_civitatis_reservation_message is SECURITY DEFINER, which this design deliberately avoids (see the SECURITY DEFINER AUDIT header section). Aborting.';
  END IF;

  SELECT array_agg(grantee::text) INTO v_execute_grantees
    FROM information_schema.routine_privileges
   WHERE routine_schema = 'public' AND routine_name = 'ingest_civitatis_reservation_message' AND privilege_type = 'EXECUTE';
  IF v_execute_grantees IS NULL OR NOT ('service_role' = ANY(v_execute_grantees)) OR 'authenticated' = ANY(v_execute_grantees) OR 'anon' = ANY(v_execute_grantees) THEN
    RAISE EXCEPTION 'CIVITATIS CLIENT MESSAGES POSTFLIGHT FAILED: EXECUTE must be granted to service_role only (found: %). Aborting.', v_execute_grantees;
  END IF;

  -- Confirm nothing outside this migration's explicit scope was touched:
  -- activity_logs' existing CHECK constraints must still allow
  -- 'reservation'/'reply' (already true before this migration — this
  -- just re-confirms it, never re-defines it) and must be byte-for-byte
  -- unchanged by this migration.
  SELECT pg_get_constraintdef(oid) INTO v_entity_type_def FROM pg_constraint WHERE conrelid = 'public.activity_logs'::regclass AND conname = 'activity_logs_entity_type_check';
  IF v_entity_type_def NOT ILIKE '%reservation%' THEN
    RAISE EXCEPTION 'CIVITATIS CLIENT MESSAGES POSTFLIGHT FAILED: activity_logs_entity_type_check unexpectedly does not allow ''reservation''. Aborting.';
  END IF;
  SELECT pg_get_constraintdef(oid) INTO v_action_def FROM pg_constraint WHERE conrelid = 'public.activity_logs'::regclass AND conname = 'activity_logs_action_check';
  IF v_action_def NOT ILIKE '%reply%' THEN
    RAISE EXCEPTION 'CIVITATIS CLIENT MESSAGES POSTFLIGHT FAILED: activity_logs_action_check unexpectedly does not allow ''reply''. Aborting.';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='reservations' AND column_name='external_booking_id') THEN
    RAISE EXCEPTION 'CIVITATIS CLIENT MESSAGES POSTFLIGHT FAILED: reservations.external_booking_id disappeared — out of scope, must never happen. Aborting.';
  END IF;

  RAISE NOTICE 'CIVITATIS CLIENT MESSAGES POSTFLIGHT PASSED: reservation_messages exists with its UNIQUE/consistency constraints, 3 indexes, RLS enabled with exactly 4 SELECT-only policies (admin/operations/sales/guide), ingest_civitatis_reservation_message() is SECURITY INVOKER (deliberately not SECURITY DEFINER) and EXECUTE-restricted to service_role only; activity_logs/reservations are unchanged. Migration verified complete.';
END $$;

COMMIT;
