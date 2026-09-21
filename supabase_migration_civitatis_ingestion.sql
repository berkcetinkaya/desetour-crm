-- ============================================================
-- DESE TOUR OPERATIONS CENTER
-- Migration: Civitatis Email Ingestion — Schema Foundation
-- ============================================================
-- File:    supabase_migration_civitatis_ingestion.sql
-- Depends: supabase_schema.sql, supabase_rls_policies.sql,
--          supabase_migration_guides.sql, supabase_migration_reviews.sql,
--          supabase_migration_tour_channels.sql
--          (all already applied)
-- Version: V2 — approved architecture. Never applied.
--
-- SCOPE OF THIS MIGRATION
-- ─────────────────────────────────────────────────────────────
-- This is schema only. It adds the columns/tables the future
-- Civitatis email-ingestion function will need to write to safely
-- and idempotently. It does NOT implement Gmail polling, email
-- parsing, or any ingestion logic — that is application/server
-- code in a later phase. No row inserted by this migration; no
-- existing row touched.
--
-- WHAT THIS ADDS
-- ─────────────────────────────────────────────────────────────
--   1. reservations.source_id — nullable FK to sources. Snapshot
--      of which sales channel a reservation actually came through,
--      captured once at booking-creation time. This is the exact
--      gap the tour_channels migration's own header comment
--      already flagged and deliberately deferred ("Accurate
--      platform-level revenue/reservation-count reporting will
--      eventually need reservations to snapshot which sales
--      channel a booking actually came through... the exact same
--      snapshot pattern guide_payments.guide_id and
--      reservation_reviews.guide_id already use") — this migration
--      is that deferred follow-up. Distinct from customers.source_id
--      (how the customer originally found Dese Tour, which can
--      differ from which platform listing they actually booked
--      through) for the same reason reservation_reviews.source_id
--      is already distinct from customers.source_id.
--
--   2. reservations.external_booking_id — nullable TEXT. The
--      booking platform's own reservation identifier (Civitatis:
--      "41629692"). TEXT, not INTEGER, matching every other
--      external-id column in this schema (external_product_id,
--      external_review_id, external_thread_id) — an identifier is
--      never arithmetic.
--
--   3. reservations_source_id_external_booking_id_key — a composite
--      UNIQUE(source_id, external_booking_id) constraint. This is
--      the exact uniqueness shape reservation_reviews already uses
--      for the same class of problem (uq_reservation_reviews_external
--      = UNIQUE(reservation_id, source_id, external_review_id)):
--      PostgreSQL never considers two NULLs equal in a UNIQUE
--      constraint, so every existing/manual/legacy reservation
--      (source_id AND external_booking_id both NULL) is completely
--      unaffected and any number of them remain valid side by side.
--      The constraint only ever fires when BOTH columns are set to
--      the same pair — i.e. a genuine duplicate booking from the
--      same channel. Scoped by source_id rather than a bare global
--      external-id uniqueness so a second marketplace, whenever one
--      is added, can never collide with Civitatis's own numbering
--      scheme — no future migration would need to fix this
--      constraint's shape.
--
--   4. reservations.retail_amount / retail_currency — nullable,
--      paired the same way tour_channels.price/currency already
--      are (tour_channels_price_currency_pair). retail_amount is
--      what the traveler paid the platform (Civitatis "Retail
--      price") — money Dese Tour never touches. It is NEVER written
--      into reservations.total_amount, which continues to mean
--      exactly what it means today for every existing reservation:
--      Dese Tour's own receivable (Civitatis "Net price" for a
--      Civitatis booking). Conflating the two would misstate Dese
--      Tour's actual revenue. No payments row is created from
--      either value by this migration or by any future ingestion
--      logic it enables — payments represents money actually
--      received or due on a known schedule, which a booking
--      notification email does not establish by itself.
--
--   5. public.reservation_guests — normalized tour participants.
--      Deliberately NOT linked to customers at all (no customer_id
--      column): a passenger is a fact about who is on a specific
--      tour, not a CRM contact with their own profile/marketing
--      history, and the booking contact (who becomes
--      reservations.customer_id, matched via the existing
--      SupabaseCustomerRepo.findByContact) is frequently a
--      different person or a travel agency entirely — conflating
--      the two would silently misattribute real travelers to
--      whichever contact happened to place the booking. Structurally
--      the same "child rows describing one specific parent,
--      replace-all on update" shape already used twice in this
--      schema (guide_languages, tour_languages) — no new pattern
--      for the app layer to learn.
--
--   6. public.email_ingestions — the normalized, auditable record
--      of every inbound booking-notification email this system has
--      ever seen, keyed for idempotency on gmail_message_id (so
--      reprocessing the same Gmail message is a guaranteed no-op)
--      and carrying its own source_id/external_booking_id (so a
--      "Booking modified" email can locate the reservation created
--      by the earlier "New booking" email via the same composite
--      identity as point 3 above). processing_status distinguishes
--      received | processed | ignored | failed | needs_review so an
--      unmatched or malformed email is always visible and auditable
--      rather than silently dropped or silently guessed into a
--      wrong reservation. event_type is deliberately limited to
--      ('new_booking','modified','unknown') for this phase — no
--      cancellation parsing is implemented yet, per instruction —
--      but the CHECK is written to be widened the exact same
--      additive way every other CHECK in this schema already has
--      been (tours.category, tours.status, activity_logs.entity_type):
--      a future DROP CONSTRAINT IF EXISTS / ADD CONSTRAINT that adds
--      'cancelled' to the list, nothing structural.
--
--   7. public.activity_log_reads — the smallest table that can
--      answer "has staff member X already seen event Y", without
--      touching activity_logs itself. activity_logs is append-only
--      by explicit design (activity_logs_no_update /
--      activity_logs_no_delete rules already forbid mutating a row)
--      and must stay that way, so per-staff "read" state cannot be
--      a column on activity_logs — it has to be a separate table
--      that references an activity_logs row without ever needing to
--      change it.
--
--   8. One additional activity_logs SELECT policy for sales — NOT a
--      table/column change. Auto-ingested reservation activity rows
--      have performed_by = NULL (the ingestion function has no
--      auth.uid() session), and the existing "activity_logs: sales
--      read own" policy (supabase_rls_policies.sql, untouched by
--      this migration) only allows performed_by = auth.uid(), so
--      sales would otherwise never see a Civitatis-ingested "Yeni
--      Rezervasyon Geldi" notification at all. This is an ADDITIONAL
--      permissive policy, combined with the existing one via
--      PostgreSQL's standard OR-of-permissive-policies rule — sales
--      keeps exactly the access they have today, plus this one
--      narrow slice. Scoped to entity_type = 'reservation' AND
--      performed_by IS NULL AND metadata->>'auto_ingested' = 'true':
--      the first two conditions alone are already a structurally
--      reliable "this is reservation activity nobody typed in
--      through the app" signal (performed_by can only be NULL via a
--      service_role write — "activity_logs: all staff insert"
--      already forces performed_by = auth.uid() on every
--      browser-originated insert), and the metadata condition is
--      layered on top as the explicit, narrower "system generated"
--      marker the product decision asked for, establishing the
--      contract the future ingestion function must write
--      (metadata containing {"auto_ingested": true, ...}). Admin and
--      operations policies are untouched. No guide policy is added —
--      guide access to reservation activity remains exactly what
--      "activity_logs: guide read own" already permits.
--
-- WHY NOTHING ELSE WAS ADDED
-- ─────────────────────────────────────────────────────────────
--   • No new "platforms"/"marketplaces" table and no duplicate
--     Civitatis row in sources — sources.is_sales_channel (added by
--     supabase_migration_tour_channels.sql) already models this, and
--     a real Civitatis row with is_sales_channel = TRUE is assumed
--     to already exist. This migration does not touch sources' data
--     at all, only reservations/email_ingestions' FK to it.
--   • No new tour-mapping table. tour_channels.external_product_id
--     already exists for exactly "the platform's own product/listing
--     ID, where applicable" and is already editable today via the
--     New Tour / Tour Detail "Satış Kanalları" UI. The future
--     ingestion parser matches Civitatis's "Internal code" against
--     tour_channels.external_product_id (scoped to the Civitatis
--     source_id) by exact string match only; no match routes the
--     email to email_ingestions.processing_status = 'needs_review'
--     rather than guessing. This is a parsing/matching rule for
--     later application code, not a schema gap — nothing here
--     changes tour_channels.
--   • No calendar/event table. Confirmed by prior audit:
--     useCalendarEvents() derives Takvim purely from the
--     reservations repo. A normal, complete reservations row
--     (populated with the same check_in/check_in_time/pax_adult/
--     pax_child columns every reservation already uses) is
--     sufficient; nothing about calendar rendering changes here.
--   • No new language table. reservations.tour_language (added by
--     supabase_migration_reviews.sql) remains the sole authoritative
--     field for the language a specific booking was actually
--     conducted in. Mapping Civitatis's "Italiano"/"Español" free
--     text to the app's canonical LANGUAGE_OPTIONS values is a fixed
--     dictionary in future ingestion code, not a schema concern.
--   • activity_logs.entity_type is NOT widened by this migration.
--     Audited against its current CHECK (customer, lead, quote,
--     reservation, payment, task, reminder, tour, message, settings,
--     guide, guide_payment, reservation_review, tour_language,
--     tour_channel): 'reservation' already covers the normal
--     successful-booking notification this integration needs to
--     write (entity_type = 'reservation', entity_id = the new
--     reservation's id — the same shape every other reservation
--     activity log entry already uses). No new entity is logged
--     into activity_logs by this migration or by the ingestion
--     design it supports: email_ingestions is itself the audit trail
--     for the ingestion process, and reservation_guests rows are not
--     individually logged. Widening this CHECK now would be an
--     unused change.
--   • No payments row is ever created by anything this migration
--     enables — see point 4 above.
--   • No new staff_users role. Ingestion runs entirely under the
--     Supabase service_role key (bypasses RLS by design — see
--     "SERVICE ROLE BYPASS" in supabase_rls_policies.sql, which
--     already names webhook handlers as its intended use). None of
--     admin/sales/operations/guide is a fit for "automated system",
--     and RLS in this repo is written per human staff role, not
--     per-caller-trust-level, so inventing a fifth role would be
--     unused machinery, not a real access boundary — service_role
--     bypass already is that boundary.
--
-- SAFETY
-- ─────────────────────────────────────────────────────────────
--   • 100% additive: three new tables, four new nullable columns on
--     the existing reservations table, one new composite UNIQUE
--     constraint (inert for every row with NULL source_id/
--     external_booking_id — i.e. every existing reservation today),
--     one new paired CHECK constraint (inert whenever both new
--     columns are NULL), and one new SELECT-only RLS policy added
--     to the existing activity_logs table (point 8 above) — no
--     column, no table structure, and no INSERT/UPDATE/DELETE
--     behavior on activity_logs changes; its append-only rules
--     (activity_logs_no_update / activity_logs_no_delete) are
--     untouched. No existing column dropped, retyped, renamed, or
--     given a NOT NULL/default that could reject an existing row.
--     No existing table's meaning changed. No SQL in this file
--     inserts, updates, or deletes a single existing row.
--   • No production Supabase connection was made and no SQL from
--     this file has been executed to produce it.
--   • RLS is enabled on all three new tables in the same statement
--     block that creates them — never left unprotected. No INSERT/
--     UPDATE/DELETE policy is granted to any authenticated role on
--     email_ingestions (see its RLS section below for the full
--     reasoning) — only service_role, which bypasses RLS entirely
--     and is never exposed to the browser, can write to it.
--   • Genuinely idempotent throughout: every CREATE TABLE, CREATE
--     INDEX, ALTER TABLE ... ADD COLUMN, ALTER TABLE ... ADD
--     CONSTRAINT, and CREATE POLICY statement can be run a second
--     time without error and without changing the end result —
--     CREATE POLICY has no IF NOT EXISTS in PostgreSQL, so every one
--     is preceded by a matching DROP POLICY IF EXISTS, same
--     convention as every prior migration in this repo.
--
-- HOW TO APPLY
-- ─────────────────────────────────────────────────────────────
-- Supabase Dashboard → SQL Editor → paste and run this file.
-- Run AFTER supabase_schema.sql, supabase_rls_policies.sql,
-- supabase_migration_guides.sql, supabase_migration_reviews.sql, and
-- supabase_migration_tour_channels.sql.
-- Safe to re-run in full.
-- NOT executed as part of producing this file.
-- ============================================================


-- ──────────────────────────────────────────────────────────────────────────
-- reservations: booking-source snapshot + external identity + retail value
-- ──────────────────────────────────────────────────────────────────────────

-- Idempotent: ADD COLUMN IF NOT EXISTS. All four nullable — no existing row
-- is affected; every existing reservation simply has NULL in all four,
-- which is the correct, permanent state for any manually-created or
-- pre-integration booking, not a value to be backfilled later.
ALTER TABLE public.reservations
  ADD COLUMN IF NOT EXISTS source_id           UUID REFERENCES public.sources(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS external_booking_id TEXT,
  ADD COLUMN IF NOT EXISTS retail_amount       NUMERIC(12,2),
  ADD COLUMN IF NOT EXISTS retail_currency     TEXT;

COMMENT ON COLUMN public.reservations.source_id           IS 'Snapshot of the sales channel this reservation actually came through (e.g. Civitatis), captured once at creation time — deliberately independent of tour_channels, which can change later. Distinct from customers.source_id (how the customer originally found Dese Tour). NULL for every reservation created before this column existed and for every reservation entered manually with no platform channel.';
COMMENT ON COLUMN public.reservations.external_booking_id IS 'The booking platform''s own reservation reference, e.g. Civitatis reservation number "41629692". NULL unless source_id is also set. Paired with source_id via reservations_source_id_external_booking_id_key for duplicate-booking protection — see that constraint''s comment.';
COMMENT ON COLUMN public.reservations.retail_amount       IS 'What the traveler paid the booking platform (Civitatis "Retail price") — informational only. NEVER Dese Tour''s own revenue figure; that remains total_amount (Civitatis "Net price" for a Civitatis booking). Paired with retail_currency — see reservations_retail_amount_currency_pair.';
COMMENT ON COLUMN public.reservations.retail_currency      IS 'NULL exactly when retail_amount is NULL; required alongside a non-null retail_amount so a retail value is never interpreted in an assumed/default currency.';

-- Idempotent: DROP CONSTRAINT IF EXISTS before ADD CONSTRAINT.
-- NULL-safe duplicate-booking guard — see the migration header for the full
-- rationale (mirrors uq_reservation_reviews_external's exact NULL
-- semantics). Every existing reservation (both columns NULL) is completely
-- unaffected; the constraint can only ever be violated by two rows that
-- both have the same non-null source_id AND the same non-null
-- external_booking_id — a genuine duplicate booking from the same channel.
ALTER TABLE public.reservations DROP CONSTRAINT IF EXISTS reservations_source_id_external_booking_id_key;
ALTER TABLE public.reservations ADD CONSTRAINT reservations_source_id_external_booking_id_key
  UNIQUE (source_id, external_booking_id);

-- Idempotent: DROP CONSTRAINT IF EXISTS before ADD CONSTRAINT. Makes
-- "retail_amount without retail_currency" and "retail_currency without
-- retail_amount" both structurally impossible, and rejects a negative
-- retail_amount outright — same paired-nullable shape as
-- tour_channels_price_currency_pair, applied to a different pair of
-- columns for a different reason (retail value, not a price override).
ALTER TABLE public.reservations DROP CONSTRAINT IF EXISTS reservations_retail_amount_currency_pair;
ALTER TABLE public.reservations ADD CONSTRAINT reservations_retail_amount_currency_pair CHECK (
  (retail_amount IS NULL AND retail_currency IS NULL)
  OR (retail_amount IS NOT NULL AND retail_currency IS NOT NULL AND retail_amount >= 0)
);

-- No separate idx_reservations_source_id is added: the UNIQUE constraint
-- above already creates a composite btree index on (source_id,
-- external_booking_id), which already serves source_id-only lookups via
-- its leftmost column — the same reasoning already used in
-- supabase_migration_guides.sql for guide_languages_guide_id_language_code_key
-- ("already creates a composite index usable for guide_id-only lookups").
-- A second, narrower index here would just be redundant storage.


-- ──────────────────────────────────────────────────────────────────────────
-- TABLE: reservation_guests
-- Named tour participants for a reservation. NOT customers.
-- ──────────────────────────────────────────────────────────────────────────

-- Idempotent: IF NOT EXISTS — a second run no-ops if the table already exists.
CREATE TABLE IF NOT EXISTS public.reservation_guests (
  id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  reservation_id UUID        NOT NULL REFERENCES public.reservations(id) ON DELETE CASCADE,
  full_name      TEXT        NOT NULL,
  sort_order     INTEGER     NOT NULL DEFAULT 0 CHECK (sort_order >= 0),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
  -- No updated_at: a reservation's passenger list is managed as a
  -- replace-all set (delete rows for this reservation_id, reinsert the
  -- current full list) exactly like guide_languages/tour_languages already
  -- are — individual rows are never edited in place, so a per-row updated_at
  -- would never have a reason to differ from created_at.
);

COMMENT ON TABLE  public.reservation_guests                IS 'Named participants on a specific reservation (e.g. Civitatis "Passenger information 1/2/..."). Deliberately NOT linked to customers — a passenger is a fact about who travels, not a CRM contact; the booking contact (who may be a travel agency or a different person entirely) is reservations.customer_id. Names are stored exactly as received from the source, never normalized/re-cased.';
COMMENT ON COLUMN public.reservation_guests.reservation_id IS 'Owning reservation. ON DELETE CASCADE: removing a reservation removes its passenger rows (no orphaned participant links).';
COMMENT ON COLUMN public.reservation_guests.sort_order      IS 'Display/entry order — e.g. Civitatis "Passenger information 1" = 0, "2" = 1. Not a uniqueness key: a parsing pass that cannot confidently order passengers may leave this at the default 0 for all of them without being rejected.';

-- Idempotent: IF NOT EXISTS.
CREATE INDEX IF NOT EXISTS idx_reservation_guests_reservation_id ON public.reservation_guests(reservation_id);

-- Idempotent: enabling RLS twice is a no-op in PostgreSQL. Enabled
-- immediately alongside table creation — never left unprotected.
ALTER TABLE public.reservation_guests ENABLE ROW LEVEL SECURITY;

-- Admin: full access
DROP POLICY IF EXISTS "reservation_guests: admin full access" ON public.reservation_guests;
CREATE POLICY "reservation_guests: admin full access"
  ON public.reservation_guests FOR ALL TO authenticated
  USING   ( is_admin() )
  WITH CHECK ( is_admin() );

-- Operations: full access — they manage reservations day-to-day, same role
-- that already has full read+write on reservations itself.
DROP POLICY IF EXISTS "reservation_guests: operations full access" ON public.reservation_guests;
CREATE POLICY "reservation_guests: operations full access"
  ON public.reservation_guests FOR ALL TO authenticated
  USING   ( is_operations() )
  WITH CHECK ( is_operations() );

-- Sales: read-only — useful context when discussing a booking with a
-- customer, same visibility tier sales already has on reservations itself.
DROP POLICY IF EXISTS "reservation_guests: sales read" ON public.reservation_guests;
CREATE POLICY "reservation_guests: sales read"
  ON public.reservation_guests FOR SELECT TO authenticated
  USING ( is_sales() );

-- Guide: read-only, and ONLY for reservations actually assigned to them —
-- this deliberately mirrors "reservations: guide reads assigned" (the
-- existing, narrower, reservation-specific guide policy: is_guide() AND
-- assigned_to = auth.uid() AND status NOT IN ('cancelled')) via EXISTS,
-- rather than the broader unrestricted "is_guide()" pattern used by
-- reservation_reviews: guide role read. A guide needs passenger names only
-- for tours they are actually guiding — anything broader would exceed what
-- existing reservation data already permits them to see, which the product
-- decision for this migration explicitly rules out. No guide write policy:
-- guides already cannot edit reservation financial/passenger-shaped data,
-- only their own status/notes — passenger rows follow that same limit by
-- having no guide write policy at all, the same "zero rows back, not an
-- error" gap already used deliberately for tour_channels' guide access.
DROP POLICY IF EXISTS "reservation_guests: guide reads assigned" ON public.reservation_guests;
CREATE POLICY "reservation_guests: guide reads assigned"
  ON public.reservation_guests FOR SELECT TO authenticated
  USING (
    is_guide()
    AND EXISTS (
      SELECT 1 FROM public.reservations r
      WHERE r.id = reservation_guests.reservation_id
        AND r.assigned_to = auth.uid()
        AND r.status NOT IN ('cancelled')
    )
  );


-- ──────────────────────────────────────────────────────────────────────────
-- TABLE: email_ingestions
-- Auditable, idempotent record of every inbound booking-notification email
-- this system has processed or attempted to process. Written exclusively by
-- the future server-side ingestion function via the Supabase service_role
-- key, which bypasses RLS entirely — this table intentionally has NO
-- INSERT/UPDATE/DELETE policy for any authenticated (browser) role. See the
-- RLS section below for the full reasoning.
-- ──────────────────────────────────────────────────────────────────────────

-- Idempotent: IF NOT EXISTS — a second run no-ops if the table already exists.
CREATE TABLE IF NOT EXISTS public.email_ingestions (
  id                    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  provider              TEXT        NOT NULL DEFAULT 'civitatis'
                                     CHECK (provider IN ('civitatis')),
  gmail_message_id      TEXT        NOT NULL UNIQUE,
  gmail_thread_id       TEXT,
  external_booking_id   TEXT,
  source_id             UUID        REFERENCES public.sources(id) ON DELETE SET NULL,
  event_type            TEXT        NOT NULL
                                     CHECK (event_type IN ('new_booking','modified','unknown')),
  processing_status     TEXT        NOT NULL DEFAULT 'received'
                                     CHECK (processing_status IN (
                                       'received','processed','ignored','failed','needs_review'
                                     )),
  reservation_id        UUID        REFERENCES public.reservations(id) ON DELETE SET NULL,
  raw_subject           TEXT,
  raw_body_snapshot     TEXT,
  error_reason          TEXT,
  received_at           TIMESTAMPTZ NOT NULL,
  processed_at           TIMESTAMPTZ,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW()
  -- No updated_at: processed_at already records the one meaningful state
  -- transition this row's lifecycle has (received -> a terminal status).
  -- A generic updated_at alongside it would duplicate that fact without
  -- adding one of its own.
);

COMMENT ON TABLE  public.email_ingestions                    IS 'Auditable history of every inbound Civitatis booking-notification email seen by the ingestion function — one row per Gmail message, regardless of outcome. Never casually edited from the CRM UI; written only by the server-side ingestion function under service_role.';
COMMENT ON COLUMN public.email_ingestions.provider            IS 'Single-value CHECK today (civitatis only), widened additively the same way tours.category/activity_logs.entity_type already have been when a second provider is ever added — never narrowed.';
COMMENT ON COLUMN public.email_ingestions.gmail_message_id    IS 'Gmail''s own message ID. UNIQUE — the primary idempotency guard: reprocessing the same Gmail message is a guaranteed no-op at the database level, not just an application-level check.';
COMMENT ON COLUMN public.email_ingestions.gmail_thread_id     IS 'Gmail''s conversation/thread ID — a new-booking email and its later modification emails typically share one, useful for manual review even before external_booking_id is parsed.';
COMMENT ON COLUMN public.email_ingestions.external_booking_id IS 'Parsed Civitatis reservation number, e.g. "41629692". Paired with source_id (not uniquely constrained on this table — a booking legitimately has more than one email: one new_booking plus any number of modified) to locate the matching reservations row via reservations_source_id_external_booking_id_key.';
COMMENT ON COLUMN public.email_ingestions.event_type          IS 'new_booking | modified | unknown for this phase — cancellation is explicitly not parsed yet. Deliberately a plain CHECK, not a separate lookup table, so adding ''cancelled'' later is a one-line additive constraint widen, matching how every other enum-shaped CHECK in this schema has been extended.';
COMMENT ON COLUMN public.email_ingestions.processing_status   IS 'received = just fetched, not yet acted on. processed = resulted in a created/updated reservation. ignored = a genuine duplicate or a legitimately irrelevant message. failed = an unexpected error during processing. needs_review = well-formed Civitatis email that could not be safely auto-processed (e.g. Internal code did not match any tour_channels row) — never silently turned into a guessed reservation.';
COMMENT ON COLUMN public.email_ingestions.reservation_id      IS 'The reservation this email resulted in or updated, once resolved. NULL until then, and NULL forever for ignored/failed/needs_review rows that never reached a reservation. ON DELETE SET NULL rather than CASCADE: this table is an audit trail and should be able to outlive the reservation it refers to (reservations are soft-cancelled in normal operation, never hard-deleted, so this is a safety backstop rather than an expected path).';
COMMENT ON COLUMN public.email_ingestions.raw_subject         IS 'The email''s subject line, verbatim, for manual review of needs_review/failed rows.';
COMMENT ON COLUMN public.email_ingestions.raw_body_snapshot   IS 'The email body, verbatim, at ingestion time — audit trail and the raw material for manual review or future re-parsing (e.g. once cancellation parsing is added, existing rows already carry the body needed to backfill it).';
COMMENT ON COLUMN public.email_ingestions.received_at         IS 'When the email itself was received (Gmail''s own timestamp for the message), distinct from created_at (when this audit row was written, which may lag behind a poll interval).';

-- Idempotent: IF NOT EXISTS. gmail_message_id already has an implicit
-- unique index from its UNIQUE column constraint above — not duplicated
-- here.
CREATE INDEX IF NOT EXISTS idx_email_ingestions_processing_status  ON public.email_ingestions(processing_status);
CREATE INDEX IF NOT EXISTS idx_email_ingestions_received_at        ON public.email_ingestions(received_at DESC);
CREATE INDEX IF NOT EXISTS idx_email_ingestions_reservation_id     ON public.email_ingestions(reservation_id);
CREATE INDEX IF NOT EXISTS idx_email_ingestions_source_external    ON public.email_ingestions(source_id, external_booking_id);

-- Idempotent: enabling RLS twice is a no-op in PostgreSQL.
ALTER TABLE public.email_ingestions ENABLE ROW LEVEL SECURITY;

-- Read-only for admin and operations — the two roles that already own
-- reservation/tour-catalog operations day to day and would act on a
-- needs_review or failed row. Deliberately NOT given to sales or guide:
-- this is internal integration-plumbing/audit data about an external
-- system's processing state, not customer-facing or sales-relevant
-- information — RLS default-denies with no matching policy, the same
-- "zero rows back, not an error" behavior already relied on for
-- tour_channels' deliberate guide gap.
--
-- Deliberately NO INSERT/UPDATE/DELETE policy for ANY authenticated role,
-- including admin — per explicit instruction, this table must not be
-- casually editable by normal frontend users even at the highest staff
-- privilege level. The only writer is the future server-side ingestion
-- function via the service_role key, which bypasses RLS entirely and is
-- never exposed to the browser. A later phase that builds a "resolve this
-- needs_review row" UI will need its own narrow, explicitly-scoped write
-- policy (e.g. admin/operations UPDATE limited to processing_status and
-- reservation_id) — intentionally not added now, per instruction.
DROP POLICY IF EXISTS "email_ingestions: admin read" ON public.email_ingestions;
CREATE POLICY "email_ingestions: admin read"
  ON public.email_ingestions FOR SELECT TO authenticated
  USING ( is_admin() );

DROP POLICY IF EXISTS "email_ingestions: operations read" ON public.email_ingestions;
CREATE POLICY "email_ingestions: operations read"
  ON public.email_ingestions FOR SELECT TO authenticated
  USING ( is_operations() );


-- ──────────────────────────────────────────────────────────────────────────
-- TABLE: activity_log_reads
-- Per-staff "has this dashboard notification been opened" state, kept
-- entirely separate from activity_logs itself so that table can remain
-- append-only (activity_logs_no_update / activity_logs_no_delete already
-- forbid mutating a row — this table exists so per-staff read state never
-- needs to become an exception to that rule).
-- ──────────────────────────────────────────────────────────────────────────

-- Idempotent: IF NOT EXISTS — a second run no-ops if the table already exists.
CREATE TABLE IF NOT EXISTS public.activity_log_reads (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  activity_log_id UUID        NOT NULL REFERENCES public.activity_logs(id) ON DELETE CASCADE,
  staff_id        UUID        NOT NULL REFERENCES public.staff_users(id) ON DELETE CASCADE,
  read_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT activity_log_reads_activity_log_id_staff_id_key UNIQUE (activity_log_id, staff_id)
  -- No separate created_at: read_at already is this row's one meaningful
  -- timestamp — the moment the read happened is the only fact this table
  -- exists to record, and the row is never updated afterward (a second
  -- "read" by the same staff member for the same event is exactly what the
  -- UNIQUE constraint below prevents from being recorded twice).
);

COMMENT ON TABLE  public.activity_log_reads                    IS 'Per-staff read receipts for activity_logs events (e.g. an auto-ingested "Yeni Rezervasyon Geldi" dashboard notification), so it can remain visible until opened without ever mutating activity_logs, which is append-only by design. One row per (event, staff member) who has opened it.';
COMMENT ON COLUMN public.activity_log_reads.activity_log_id    IS 'The event being acknowledged. ON DELETE CASCADE: activity_logs rows are never actually deletable in normal operation (see activity_logs_no_delete), so this is a safety backstop rather than an expected path — if it were ever removed, its read receipts have no remaining purpose either.';
COMMENT ON COLUMN public.activity_log_reads.staff_id            IS 'The staff member who opened it. ON DELETE CASCADE, not SET NULL: unlike assigned_to-style attribution on reservations/leads/payments (where the parent record must remain meaningful even if the staff member is gone), a read receipt with no staff attached has no remaining purpose at all — the whole row exists only to describe that one staff member''s read state.';

-- Idempotent: IF NOT EXISTS. The UNIQUE constraint above already creates a
-- composite index usable for activity_log_id-only lookups (same leftmost-
-- column reasoning as reservations_source_id_external_booking_id_key), so
-- only staff_id needs its own index — the "has this staff member read
-- anything" direction the UNIQUE index does not already serve well.
CREATE INDEX IF NOT EXISTS idx_activity_log_reads_staff_id ON public.activity_log_reads(staff_id);

-- Idempotent: enabling RLS twice is a no-op in PostgreSQL.
ALTER TABLE public.activity_log_reads ENABLE ROW LEVEL SECURITY;

-- Every staff role may record their OWN read state — this is a live,
-- browser-driven interaction (a staff member opens a reservation, the app
-- marks it read for them), unlike email_ingestions above. staff_id must
-- equal auth.uid(): no staff member can mark an event read on another's
-- behalf, the same self-attribution shape already enforced for outbound
-- messages ("messages: sales insert outbound" requires staff_id = auth.uid()).
DROP POLICY IF EXISTS "activity_log_reads: staff insert own" ON public.activity_log_reads;
CREATE POLICY "activity_log_reads: staff insert own"
  ON public.activity_log_reads FOR INSERT TO authenticated
  WITH CHECK ( staff_id = auth.uid() );

-- Every staff role may read their OWN read receipts (so the UI can ask "have
-- I already seen this").
DROP POLICY IF EXISTS "activity_log_reads: staff read own" ON public.activity_log_reads;
CREATE POLICY "activity_log_reads: staff read own"
  ON public.activity_log_reads FOR SELECT TO authenticated
  USING ( staff_id = auth.uid() );

-- Admin: read all — oversight only; admin still cannot create a read
-- receipt on another staff member's behalf (the insert policy above is the
-- only INSERT path, and it is not role-gated, so admin already has it for
-- their own rows through the same policy every other role uses).
DROP POLICY IF EXISTS "activity_log_reads: admin read all" ON public.activity_log_reads;
CREATE POLICY "activity_log_reads: admin read all"
  ON public.activity_log_reads FOR SELECT TO authenticated
  USING ( is_admin() );

-- No UPDATE or DELETE policy for any role: a read receipt, once recorded,
-- is a permanent fact and is never edited or removed by the application.


-- ──────────────────────────────────────────────────────────────────────────
-- activity_logs: additional sales visibility for system-generated
-- reservation notifications (RLS policy only — see point 8 in the header
-- comment for the full rationale). activity_logs itself is untouched:
-- no column, no table structure, no change to its append-only rules
-- (activity_logs_no_update / activity_logs_no_delete). RLS on
-- activity_logs is already enabled by supabase_rls_policies.sql, a hard
-- dependency of this migration — not re-enabled here.
-- ──────────────────────────────────────────────────────────────────────────

-- Idempotent: CREATE POLICY has no IF NOT EXISTS — guard with DROP POLICY
-- IF EXISTS first, matching every other policy in this migration and in
-- supabase_rls_policies.sql.
--
-- This is an ADDITIONAL permissive policy alongside the existing
-- "activity_logs: sales read own" (defined in supabase_rls_policies.sql,
-- not modified by this migration) — PostgreSQL combines multiple
-- permissive SELECT policies for the same role with OR, so sales keeps
-- their existing own-activity visibility (performed_by = auth.uid())
-- completely unchanged, and additionally gains this one narrow slice.
--
-- Three conditions, all required:
--   entity_type = 'reservation'        — never any other entity type.
--   performed_by IS NULL                — structurally reliable signal
--     that this row did NOT come from a staff member's browser session:
--     "activity_logs: all staff insert" already forces
--     WITH CHECK (is_staff() AND performed_by = auth.uid()) on every
--     authenticated-role insert, so a NULL performed_by is only reachable
--     via a service_role write (the future ingestion function) or a
--     direct privileged SQL action — never a normal staff action.
--   metadata->>'auto_ingested' = 'true' — the explicit "system generated"
--     marker the product decision asked for, layered on top of the
--     already-reliable performed_by signal rather than replacing it.
--     This establishes the contract the future ingestion function must
--     write: an activity_logs row for an auto-created/updated reservation
--     must include metadata containing {"auto_ingested": true, ...}.
--     JSONB ->> against a NULL metadata column evaluates to NULL (not an
--     error), which is not TRUE in a USING clause, so a row with no
--     metadata is safely excluded rather than causing any error.
--
-- No guide policy is added here and no existing guide policy is touched —
-- guide visibility into reservation activity remains exactly what
-- "activity_logs: guide read own" already permits today. Admin
-- ("activity_logs: admin read all") and operations
-- ("activity_logs: operations read own") policies are untouched.
DROP POLICY IF EXISTS "activity_logs: sales read system-generated reservation notifications" ON public.activity_logs;
CREATE POLICY "activity_logs: sales read system-generated reservation notifications"
  ON public.activity_logs FOR SELECT TO authenticated
  USING (
    is_sales()
    AND entity_type = 'reservation'
    AND performed_by IS NULL
    AND metadata->>'auto_ingested' = 'true'
  );


-- ── END OF MIGRATION ────────────────────────────────────────────────────────
