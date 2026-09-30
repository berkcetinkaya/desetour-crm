-- ============================================================
-- DESE TOUR OPERATIONS CENTER
-- Migration: WhatsApp Core — Database Foundation, Phase 1.1
-- ============================================================
-- File:    supabase_migration_whatsapp_core.sql
-- Depends: supabase_schema.sql, supabase_rls_policies.sql,
--          supabase_migration_guides.sql, supabase_migration_reviews.sql,
--          supabase_migration_tour_channels.sql,
--          supabase_migration_tour_channels_v2_booking_language.sql,
--          supabase_migration_civitatis_ingestion.sql,
--          supabase_migration_civitatis_write_v13_1_cancellation_rpc_repair.sql
--          (all already applied)
-- Version: V1 — schema foundation only. NOT applied. No application code,
--          Meta integration, worker, webhook, or frontend UI is added by
--          this migration or exists yet. Prepared for manual review and
--          manual execution only, exactly like every prior migration in
--          this repository.
--
-- WHAT THIS IS
-- ─────────────────────────────────────────────────────────────
-- This is Phase 1.1 of the WhatsApp automation initiative whose
-- architecture was audited (read-only, no changes) in the preceding
-- Phase 0 pass. This migration creates ONLY the minimum durable
-- persistence the future WhatsApp system will need:
--   1. tour_channels.review_url — the one column gap Phase 0 confirmed
--      (a repo-wide grep found no review_url anywhere).
--   2. A transport-independent "operations destination" abstraction
--      (whatsapp_destinations / whatsapp_destination_recipients), so
--      business logic never depends directly on a WhatsApp group ID.
--   3. A single durable message/outbox table (whatsapp_messages) able to
--      represent every future event type, queued through delivered/read/
--      failed, with idempotency and retry support.
--
-- No Meta client, send endpoint, webhook endpoint, scheduler worker,
-- message templates, frontend UI, or connection of any CRM business event
-- (booking created/modified/cancelled, guide assignment) to this schema
-- is added here. Nothing in this migration sends, queues, or references
-- an actual WhatsApp message. Every new table starts empty; no row is
-- ever inserted by this file.
--
-- ARCHITECTURAL PRINCIPLE THIS SCHEMA ENFORCES
-- ─────────────────────────────────────────────────────────────
-- WhatsApp must be asynchronous and failure-isolated. A Meta outage must
-- NEVER roll back or fail Civitatis booking ingestion, Civitatis
-- modification, Civitatis cancellation, guide assignment, or reservation
-- saves. None of those existing write paths are touched, referenced for
-- write, wrapped, or made to depend on anything this migration adds —
-- every new FK from whatsapp_messages back to reservations/customers/
-- guides/tours is ON DELETE SET NULL, one-directional, and optional
-- (nullable), so nothing on the existing side of those relationships can
-- ever be blocked, cascaded, or altered by what this migration adds.
--
-- activity_logs remains the CRM's own activity/notification system,
-- completely untouched by this migration (no ALTER/INSERT/UPDATE/DROP
-- referencing it anywhere in this file — verified by the regression
-- tests). whatsapp_messages is a deliberately separate, purpose-built
-- table — it is NOT a repurposing of activity_logs and does not attempt
-- to reuse its shape, because (per the Phase 0 audit) activity_logs has
-- no delivery-state, retry-count, or provider-message-id concept, and is
-- itself written from at least four independent, uncoordinated code
-- paths with no idempotency guarantee of its own — exactly the
-- properties a WhatsApp delivery queue cannot safely inherit.
--
-- VERIFIED AGAINST THE ACTUAL REPOSITORY BEFORE WRITING THIS FILE
-- ─────────────────────────────────────────────────────────────
-- Re-inspected directly (not assumed from any prior report):
--   • tour_channels' exact current columns (supabase_migration_tour_
--     channels.sql:324-349, extended by ..._v2_booking_language.sql) —
--     id, tour_id, source_id, external_product_id, price, currency,
--     is_active, listing_url, notes, created_at, updated_at,
--     booking_language. review_url does not exist. listing_url is
--     confirmed to be the sales/product URL, a distinct concept.
--   • UUID convention: every table's id column is
--     "UUID PRIMARY KEY DEFAULT gen_random_uuid()" (supabase_schema.sql:
--     17, and every CREATE TABLE since) — reused exactly, no new
--     extension needed (uuid-ossp already enabled, schema.sql:30).
--   • Timestamp convention: "TIMESTAMPTZ NOT NULL DEFAULT NOW()" for
--     created_at/updated_at on every table that has them — reused
--     exactly.
--   • updated_at trigger convention: a single shared
--     public.set_updated_at() function (defined once, supabase_schema.
--     sql:39-45) reused by every table via
--     "BEFORE UPDATE ... EXECUTE FUNCTION public.set_updated_at()",
--     each guarded by DROP TRIGGER IF EXISTS first (no IF NOT EXISTS
--     exists for CREATE TRIGGER in PostgreSQL) — reused exactly, no new
--     trigger function defined.
--   • RLS convention: is_admin()/is_sales()/is_operations()/is_guide()
--     SECURITY DEFINER helper functions (supabase_rls_policies.sql:
--     95-99), reused exactly. Confirmed staff_users.role CHECK actually
--     allows five values — admin, sales, reservations, operations, guide
--     (supabase_schema.sql:59-60) — but only four RLS helper functions
--     exist; there is no is_reservations() anywhere in the repository.
--     This is a pre-existing gap in the codebase, unrelated to and not
--     fixed by this migration — this migration's own policies use only
--     the four helpers that actually exist, the same set every other
--     migration since supabase_migration_tour_channels.sql already uses.
--   • Server-only-write RLS precedent: public.email_ingestions
--     (supabase_migration_civitatis_ingestion.sql:381-467) is RLS-
--     enabled with ONLY two SELECT policies (admin, operations) and
--     deliberately NO INSERT/UPDATE/DELETE policy for any authenticated
--     role at all — "written exclusively by the future server-side
--     ingestion function via the Supabase service_role key, which
--     bypasses RLS entirely." whatsapp_messages reuses this exact
--     pattern (see RLS section below) because it is the same shape of
--     problem: a durable record a server-side worker must write and
--     staff must only read, never edit through the app.
--   • FK type convention: reservations.customer_id/tour_id/guide_id,
--     tour_channels.tour_id/source_id, tour_itinerary_stops.tour_id —
--     every FK in the schema is UUID referencing another table's UUID
--     id column. Reused exactly.
--
-- ============================================================
-- 1. tour_channels.review_url
-- ============================================================
-- Nullable TEXT. Stores the actual review destination for one exact
-- (tour, channel) combination — NOT the same thing as listing_url (the
-- sales/product page). Every existing row gets NULL; nothing is
-- auto-populated or guessed. A future customer-review-request feature
-- must fail safely with a useful CRM message when this is NULL for a
-- given reservation's tour/channel, rather than fabricating a URL —
-- exactly the Phase 0 audit's explicit requirement.
--
-- Scoping: tour_channels already enforces UNIQUE(tour_id, source_id) —
-- confirmed unchanged by this migration (not touched) — so a tour has at
-- most one row per platform, meaning review_url is automatically scoped
-- 1:1 per (tour, platform), the same shape listing_url already uses. No
-- new table is needed for this single column.
--
-- ============================================================
-- 2. whatsapp_destinations / whatsapp_destination_recipients
-- ============================================================
-- A transport-independent logical destination, so business logic never
-- depends directly on a WhatsApp group ID (Meta Groups API eligibility
-- for the already-manually-created Dese Tour Operations group is
-- unverified — see the Phase 0 report). Deliberately does NOT model
-- dynamic guide/customer recipients as destination rows: a guide or
-- customer recipient is resolved at send time from
-- whatsapp_messages.guide_id/customer_id -> guides.phone/customers.phone
-- (existing tables, unchanged), which already vary per message and have
-- no need of a separate persistent "destination" concept. The only
-- persistent, configured destination this phase needs is the logical
-- "operations" destination.
--
-- Two tables, not one, because the second is genuinely justified: a
-- destination's transport_mode can be 'recipient_list' — inherently
-- one-to-many (a destination can resolve to MULTIPLE configured phone
-- numbers), and each recipient needs its own phone/display name/active
-- state/ordering (four attributes per recipient, per the task's own
-- requirement) — not representable cleanly as a single array column the
-- way tours.tour_type/included_items (simple unordered label lists) are.
-- This mirrors the existing guide_languages/tour_languages/
-- tour_itinerary_stops precedent: a genuinely one-to-many, per-row-
-- attributed relationship gets its own child table, not a bigger parent
-- row or an array column.
--
-- No Meta access token, API secret, or any other credential is stored in
-- either table — provider_group_id is Meta's own GROUP IDENTIFIER
-- (analogous to a public group name/handle), not a credential. All
-- credentials remain server-side environment variables only, per
-- explicit instruction — this migration adds no env var and reads none.
--
-- No row is inserted by this migration (no default "operations"
-- destination is seeded) — this is a schema-only phase; Berk configures
-- the actual destination row(s) manually once Meta setup (a later,
-- separate phase) is complete.
--
-- ============================================================
-- 3. whatsapp_messages — one durable table, not two
-- ============================================================
-- Evaluated whatsapp_outbox + whatsapp_messages as two separate tables
-- and rejected the split: a single row IS one physical WhatsApp message
-- (one eventual Meta API call, one eventual provider_message_id, one
-- delivery-state lifecycle from queued through sent/delivered/read or
-- failed) — there is no natural second entity to split off. A "queue"
-- table and a "history" table would just be the same row at two
-- different points in its own lifecycle, requiring a copy/promote step
-- between them for no benefit; every existing durable-record precedent
-- in this schema (email_ingestions) already uses exactly this "one row,
-- one lifecycle, status column tracks where it is" shape. One table also
-- means the idempotency UNIQUE constraint only has to be enforced once.
--
-- event_type is a plain TEXT NOT NULL column with NO CHECK constraint —
-- a deliberate departure from this repository's usual "CHECK, additively
-- widened later" convention (used for tours.category, activity_logs.
-- entity_type/action, email_ingestions.event_type, etc.), per explicit
-- instruction: "Do NOT hardcode business logic into database CHECK
-- constraints so tightly that every future automation requires a schema
-- migration." Every other enum-shaped CHECK in this schema governs a
-- small, slow-changing set (5-15 values, widened perhaps once a year).
-- event_type will instead grow by roughly one new value per future
-- automation phase (Phase 2 alone adds at least four: tour_reminder,
-- guide_confirmation_missing, guide_not_assigned,
-- daily_operations_summary) — forcing a migration for each would
-- directly contradict the "asynchronous, failure-isolated, extensible"
-- principle this whole schema exists to serve. Validated at the
-- application layer instead, exactly as no event producer exists yet to
-- validate it against.
--
-- audience_type, by contrast, keeps a CHECK: the product brief fixes it
-- at exactly three values (operations/guide/customer) for the entire
-- roadmap through Phase 8 — a genuinely small, stable set, the same
-- shape as every other CHECK-constrained column in this schema.
--
-- language has no CHECK (a stable ISO-style code, validated at the
-- application layer — same convention as the pre-existing, also
-- unconstrained reservations.tour_language) and is never derived in SQL;
-- this migration adds no logic that infers a language from nationality,
-- name, or phone prefix.
--
-- provider column deliberately OMITTED, unlike email_ingestions.provider
-- (which exists there because that table was explicitly designed for a
-- future second booking-ingestion provider beyond Civitatis). Nothing in
-- the Phase 0 brief or roadmap (Phases 1-8) mentions a second WhatsApp
-- Business Solution Provider — the table name itself already scopes it
-- to WhatsApp. Adding an unused single-value CHECK column for a
-- hypothetical future provider that no phase of this roadmap calls for
-- would be speculative, not minimal.
--
-- SNAPSHOT PRINCIPLE (payload, recipient_phone, recipient_display_name)
-- ─────────────────────────────────────────────────────────────
-- A queued message must remain reproducible even if CRM data changes
-- before a future worker sends it. payload JSONB stores whatever
-- deterministic render payload/template parameters a future event
-- producer captures at enqueue time (no rendering logic is implemented
-- by this migration — the column exists so that future logic has
-- somewhere durable to put it). recipient_phone/recipient_display_name
-- are likewise enqueue-time SNAPSHOTS, not live references — if a
-- customer's or guide's phone number is later edited, an already-queued
-- message's snapshot is deliberately left exactly as captured, so what
-- eventually gets sent matches what was decided at enqueue time. This
-- migration does NOT add normalized phone columns to customers/guides
-- (out of scope for this phase, and not required for this schema to be
-- safe — the future application/server layer normalizes before enqueue)
-- and does NOT rewrite a single existing customers.phone/guides.phone
-- value anywhere in this file.
--
-- IDEMPOTENCY
-- ─────────────────────────────────────────────────────────────
-- idempotency_key TEXT NOT NULL UNIQUE — a deterministic key a future
-- event producer computes per logical message (e.g.
-- "booking-created:{reservation_id}",
-- "guide-assigned:{reservation_id}:{guide_id}:{assignment_version}").
-- The UNIQUE constraint is the actual guarantee against a duplicate
-- enqueue — the same guard shape as email_ingestions.gmail_message_id
-- UNIQUE, which the Phase 0 audit confirmed is the primary reason
-- Civitatis re-ingestion is already a safe no-op. TEXT, per instruction,
-- with no existing convention in this repository suggesting otherwise.
--
-- RETRY MODEL
-- ─────────────────────────────────────────────────────────────
-- status (queued/processing/sent/delivered/read/failed) +
-- attempt_count + next_attempt_at + last_attempt_at + last_error is the
-- complete surface a future worker needs: a retryable failure returns
-- the row to 'queued' with attempt_count incremented and next_attempt_at
-- set in the future; a terminal failure sets 'failed' + failed_at +
-- last_error and leaves next_attempt_at alone. No worker logic is
-- implemented by this migration — this is schema support only.
--
-- PROVIDER MESSAGE ID
-- ─────────────────────────────────────────────────────────────
-- provider_message_id TEXT, nullable (does not exist before a message is
-- actually sent), with a PARTIAL UNIQUE index (WHERE NOT NULL) — this is
-- the exact key a future webhook receiver will upsert on to move a row
-- from sent -> delivered -> read, or -> failed, without ever risking two
-- different local rows claiming the same Meta message id.
--
-- SECURITY / RLS
-- ─────────────────────────────────────────────────────────────
-- whatsapp_destinations / whatsapp_destination_recipients are staff-
-- configurable operational settings (like tour_channels) — admin and
-- operations both get FOR ALL, the same shape tour_channels' own
-- admin+operations policies already use, since a future WhatsApp
-- settings UI is a legitimate frontend surface for editing them. No
-- sales/guide policy — RLS default-denies with zero rows back, not an
-- error, the same "deliberate gap" already established for
-- tour_channels' own guide access.
--
-- whatsapp_messages is different in kind: it is message DELIVERY STATE,
-- not configuration, and the frontend must never be able to impersonate
-- the server-side worker or mark arbitrary delivery states. Per explicit
-- instruction ("If server-only writes cannot be expressed safely through
-- current frontend auth patterns, document that clearly rather than
-- weakening RLS"): this repository's frontend client (the anon key +
-- Supabase Auth session) has no existing mechanism to be trusted as "the
-- server worker" — the only trusted writer pattern already in this
-- schema is the service_role key, which bypasses RLS entirely and is
-- never exposed to the browser (see api/_civitatis/supabaseAdmin.js).
-- Therefore whatsapp_messages reuses the email_ingestions shape exactly:
-- RLS enabled, admin + operations get READ-ONLY (SELECT) policies, and
-- there is deliberately NO INSERT/UPDATE/DELETE policy for ANY
-- authenticated role — the only writer is a future server-side
-- enqueue/worker/webhook function via service_role. No sales/guide read
-- policy either, mirroring email_ingestions' own "internal integration-
-- plumbing/audit data, not customer-facing or sales-relevant" reasoning;
-- a narrower future policy (e.g. a guide reading only their own message
-- history) is intentionally left for a later phase that actually needs
-- it, exactly as email_ingestions' own header already documents the same
-- deferral pattern for its future needs_review UI.
--
-- INDEXES
-- ─────────────────────────────────────────────────────────────
-- Only what's evaluated as useful: (status, next_attempt_at) composite
-- for the future worker's polling query; a partial unique index on
-- provider_message_id for the future webhook's upsert; reservation_id,
-- customer_id, guide_id, and created_at (DESC, matching email_ingestions.
-- received_at DESC) for lookups. idempotency_key already has an implicit
-- unique index from its UNIQUE column constraint (not duplicated, same
-- convention as gmail_message_id). tour_id and destination_id are
-- deliberately NOT indexed — neither was in the task's own list of
-- indexes to evaluate, and every tour-scoped query this schema
-- anticipates is reachable via reservation_id first; adding one now
-- would be speculative, not "only useful indexes."
--
-- MIGRATION SAFETY
-- ─────────────────────────────────────────────────────────────
-- 100% additive: one new nullable column, two new tables under the
-- destination abstraction, one new message table. No existing column
-- dropped, retyped, or renamed. No existing row updated, deleted, or
-- backfilled — every new column on every existing table (just
-- tour_channels.review_url) starts NULL for every existing row. No
-- existing constraint narrowed. Civitatis's ingest_civitatis_booking (26
-- params) and cancel_civitatis_booking (7 params) are referenced ONLY by
-- read-only preflight/postflight signature checks — verified unchanged
-- both before and after this migration runs, never written to, never
-- wrapped, never replaced. activity_logs is not referenced anywhere in
-- this file. No auth table, RLS helper function, or reservation
-- constraint is altered. Genuinely idempotent throughout: every ALTER
-- TABLE ... ADD COLUMN IF NOT EXISTS, CREATE TABLE IF NOT EXISTS, CREATE
-- INDEX IF NOT EXISTS, CREATE TRIGGER (guarded by DROP TRIGGER IF EXISTS
-- first), and CREATE POLICY (guarded by DROP POLICY IF EXISTS first) can
-- be run a second time with no error and no change in outcome. Preflight
-- (before any write) and postflight (after every write, before COMMIT)
-- both RAISE EXCEPTION and abort the WHOLE transaction on any unexpected
-- state — nothing partial is ever left committed, same discipline as
-- V12/V13/V13.1/Tour Information Center.
--
-- No SQL in this file has been executed. No Supabase connection was made
-- to produce it.
--
-- HOW TO APPLY
-- ─────────────────────────────────────────────────────────────
-- Supabase Dashboard → SQL Editor → paste and run this file IN FULL, in
-- a single execution. Wrapped in an explicit BEGIN/COMMIT so a failed
-- preflight OR the postflight aborts the whole transaction rather than
-- leaving anything partial.
-- ============================================================


BEGIN;

-- ──────────────────────────────────────────────────────────────────────────
-- PREFLIGHT: confirm every table/column/function this migration depends on
-- is exactly what it's expected to be, BEFORE touching anything. Read-only.
-- ──────────────────────────────────────────────────────────────────────────

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
     WHERE table_schema = 'public' AND table_name = 'tour_channels'
  ) THEN
    RAISE EXCEPTION 'WHATSAPP CORE PREFLIGHT FAILED: public.tour_channels does not exist. Apply supabase_migration_tour_channels.sql BEFORE this migration. Aborting before touching anything.';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='tour_channels' AND column_name='listing_url'
  ) THEN
    RAISE EXCEPTION 'WHATSAPP CORE PREFLIGHT FAILED: public.tour_channels.listing_url does not exist. This migration must never be applied against a schema where that baseline is missing. Aborting before touching anything.';
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='tour_channels' AND column_name='review_url'
  ) THEN
    RAISE NOTICE 'WHATSAPP CORE PREFLIGHT: tour_channels.review_url already exists — Step 1 will no-op (idempotent re-run).';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='reservations')
     OR NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='customers')
     OR NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='guides')
     OR NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='tours')
  THEN
    RAISE EXCEPTION 'WHATSAPP CORE PREFLIGHT FAILED: one of public.reservations/customers/guides/tours does not exist. Apply supabase_schema.sql and supabase_migration_guides.sql BEFORE this migration. Aborting before touching anything.';
  END IF;

  -- Required RLS helper functions this migration's own policies call.
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'is_admin')
     OR NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'is_operations')
  THEN
    RAISE EXCEPTION 'WHATSAPP CORE PREFLIGHT FAILED: is_admin()/is_operations() do not exist. Apply supabase_rls_policies.sql BEFORE this migration. Aborting before touching anything.';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'set_updated_at') THEN
    RAISE EXCEPTION 'WHATSAPP CORE PREFLIGHT FAILED: public.set_updated_at() does not exist. Apply supabase_schema.sql BEFORE this migration. Aborting before touching anything.';
  END IF;

  -- Read-only confirmation that the two stable Civitatis RPCs this
  -- migration must NEVER affect are present with their known signatures
  -- — never a write, never a replace, the same oidvector-vs-oidvector
  -- technique established by V12/V13.1 and reused by Tour Information
  -- Center for the same read-only-dependency-sanity purpose.
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
    RAISE EXCEPTION 'WHATSAPP CORE PREFLIGHT FAILED: public.ingest_civitatis_booking with the expected 26-parameter V10/V11/V12 signature was not found. This migration must never be applied against a schema where that function is missing/altered. Aborting before touching anything.';
  END IF;

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
    RAISE EXCEPTION 'WHATSAPP CORE PREFLIGHT FAILED: public.cancel_civitatis_booking with the expected 7-parameter V13.1 signature was not found. This migration must never be applied against a schema where that function is missing/altered. Aborting before touching anything.';
  END IF;

  RAISE NOTICE 'WHATSAPP CORE PREFLIGHT PASSED: all dependencies present. Proceeding — additive schema only, no application data touched, no Meta integration, no worker.';
END $$;


-- ──────────────────────────────────────────────────────────────────────────
-- STEP 1: tour_channels.review_url — one new nullable column.
-- ──────────────────────────────────────────────────────────────────────────

ALTER TABLE public.tour_channels
  ADD COLUMN IF NOT EXISTS review_url TEXT;

COMMENT ON COLUMN public.tour_channels.review_url IS 'The review destination URL for this exact (tour, channel) combination — e.g. where a customer who booked this tour through this platform should leave a review. NOT the same as listing_url (the sales/product page) and never derived from it. Scoped 1:1 per (tour, platform) by the existing tour_channels_tour_id_source_id_key UNIQUE constraint, unchanged by this migration. NULL for every existing row and never auto-populated or guessed by this migration or by any future automation — a future review-request feature must fail safely with a useful CRM message when this is NULL for a given reservation''s tour/channel, never fabricate a URL.';


-- ──────────────────────────────────────────────────────────────────────────
-- STEP 2: whatsapp_destinations — the logical, transport-independent
-- destination abstraction. Business logic resolves a destination_key
-- (e.g. 'operations'), never a raw WhatsApp group ID.
-- ──────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.whatsapp_destinations (
  id                 UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  destination_key    TEXT        NOT NULL UNIQUE,
  display_name       TEXT        NOT NULL,
  transport_mode     TEXT        NOT NULL DEFAULT 'recipient_list'
                                  CHECK (transport_mode IN ('meta_group', 'recipient_list')),
  provider_group_id  TEXT,
  is_active          BOOLEAN     NOT NULL DEFAULT TRUE,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- Makes "meta_group mode with no group id" structurally impossible —
  -- the same paired-column CHECK convention as
  -- tour_channels_price_currency_pair. recipient_list mode never needs a
  -- provider_group_id (its recipients live in the child table below), so
  -- it is left unconstrained by this CHECK.
  CONSTRAINT whatsapp_destinations_group_mode_pair CHECK (
    (transport_mode = 'meta_group' AND provider_group_id IS NOT NULL)
    OR (transport_mode = 'recipient_list')
  )
);

COMMENT ON TABLE  public.whatsapp_destinations                    IS 'A logical, transport-independent WhatsApp destination (e.g. "operations"). Business logic resolves destination_key, never a raw WhatsApp group ID directly — see whatsapp_messages.destination_id and the Phase 0 audit''s "operations destination abstraction" requirement. Meta Groups API eligibility for the already-manually-created Dese Tour Operations group is unverified as of this migration; this table lets that be resolved later (meta_group vs. recipient_list) without changing any booking/cancellation/guide-assignment business logic. No row is seeded by this migration — configured manually once Meta setup is complete. No credential/token of any kind is stored here — see provider_group_id.';
COMMENT ON COLUMN public.whatsapp_destinations.destination_key    IS 'Stable, application-resolved key, e.g. "operations". No CHECK enum — unlike audience_type, new destination keys may be added by configuration alone, never a schema migration.';
COMMENT ON COLUMN public.whatsapp_destinations.transport_mode     IS 'How this destination is physically reached: meta_group (one send to an official Meta/API-supported WhatsApp group) or recipient_list (fan-out to the configured phone numbers in whatsapp_destination_recipients). Never assumed to be meta_group by default — defaults to recipient_list, the mode that requires no unverified Meta capability.';
COMMENT ON COLUMN public.whatsapp_destinations.provider_group_id  IS 'Meta''s own WhatsApp group identifier — a public identifier, NOT a credential/access token. Required exactly when transport_mode=''meta_group'', enforced by whatsapp_destinations_group_mode_pair. Provider access tokens/secrets are never stored in this database — server-side environment variables only.';
COMMENT ON COLUMN public.whatsapp_destinations.is_active          IS 'Set false to deactivate a destination without deleting its configuration or its message history.';

DROP TRIGGER IF EXISTS trg_whatsapp_destinations_updated_at ON public.whatsapp_destinations;
CREATE TRIGGER trg_whatsapp_destinations_updated_at
  BEFORE UPDATE ON public.whatsapp_destinations
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.whatsapp_destinations ENABLE ROW LEVEL SECURITY;

-- Staff-configurable operational settings — same admin+operations FOR ALL
-- shape as tour_channels' own policies. No sales/guide policy: RLS
-- default-denies, zero rows back, not an error.
DROP POLICY IF EXISTS "whatsapp_destinations: admin full access" ON public.whatsapp_destinations;
CREATE POLICY "whatsapp_destinations: admin full access"
  ON public.whatsapp_destinations FOR ALL TO authenticated
  USING   ( is_admin() )
  WITH CHECK ( is_admin() );

DROP POLICY IF EXISTS "whatsapp_destinations: operations full access" ON public.whatsapp_destinations;
CREATE POLICY "whatsapp_destinations: operations full access"
  ON public.whatsapp_destinations FOR ALL TO authenticated
  USING   ( is_operations() )
  WITH CHECK ( is_operations() );


-- ──────────────────────────────────────────────────────────────────────────
-- STEP 3: whatsapp_destination_recipients — configured phone recipients
-- for a destination in 'recipient_list' transport mode. Genuinely
-- one-to-many with per-recipient attributes (phone, name, active state,
-- ordering) — justifies its own child table rather than an array column.
-- ──────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.whatsapp_destination_recipients (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  destination_id  UUID        NOT NULL REFERENCES public.whatsapp_destinations(id) ON DELETE CASCADE,
  phone           TEXT        NOT NULL,
  display_name    TEXT,
  is_active       BOOLEAN     NOT NULL DEFAULT TRUE,
  sort_order      INTEGER     NOT NULL DEFAULT 0,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE  public.whatsapp_destination_recipients                 IS 'One row per configured phone recipient of a whatsapp_destinations row in recipient_list transport mode. ON DELETE CASCADE from whatsapp_destinations: removing a destination removes its recipient list (same convention as tour_languages/tour_channels/tour_itinerary_stops cascading from their own parent).';
COMMENT ON COLUMN public.whatsapp_destination_recipients.destination_id  IS 'Owning destination. ON DELETE CASCADE: see table comment.';
COMMENT ON COLUMN public.whatsapp_destination_recipients.phone           IS 'Configured recipient phone number, entered directly by staff for this operational recipient list — not derived from, and never written back to, customers.phone or guides.phone.';
COMMENT ON COLUMN public.whatsapp_destination_recipients.is_active       IS 'Set false to remove a recipient from the active fan-out list without deleting the row (e.g. temporary absence).';
COMMENT ON COLUMN public.whatsapp_destination_recipients.sort_order      IS 'Optional display/processing order among a destination''s recipients. Default 0 — most destinations will not need explicit ordering.';

CREATE INDEX IF NOT EXISTS idx_whatsapp_destination_recipients_destination_id ON public.whatsapp_destination_recipients(destination_id);

DROP TRIGGER IF EXISTS trg_whatsapp_destination_recipients_updated_at ON public.whatsapp_destination_recipients;
CREATE TRIGGER trg_whatsapp_destination_recipients_updated_at
  BEFORE UPDATE ON public.whatsapp_destination_recipients
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.whatsapp_destination_recipients ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "whatsapp_destination_recipients: admin full access" ON public.whatsapp_destination_recipients;
CREATE POLICY "whatsapp_destination_recipients: admin full access"
  ON public.whatsapp_destination_recipients FOR ALL TO authenticated
  USING   ( is_admin() )
  WITH CHECK ( is_admin() );

DROP POLICY IF EXISTS "whatsapp_destination_recipients: operations full access" ON public.whatsapp_destination_recipients;
CREATE POLICY "whatsapp_destination_recipients: operations full access"
  ON public.whatsapp_destination_recipients FOR ALL TO authenticated
  USING   ( is_operations() )
  WITH CHECK ( is_operations() );


-- ──────────────────────────────────────────────────────────────────────────
-- STEP 4: whatsapp_messages — the single durable message/outbox record.
-- One row = one physical WhatsApp message across its whole lifecycle
-- (queued -> ... -> sent -> delivered -> read, or -> failed). See the
-- header for why this is one table, not whatsapp_outbox + a separate
-- whatsapp_messages history table.
-- ──────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.whatsapp_messages (
  id                      UUID        PRIMARY KEY DEFAULT gen_random_uuid(),

  -- WHAT this message is about. event_type intentionally has NO CHECK —
  -- see header. audience_type is a small, stable, CHECK-constrained set.
  event_type              TEXT        NOT NULL,
  audience_type           TEXT        NOT NULL
                                       CHECK (audience_type IN ('operations', 'guide', 'customer')),

  -- Deterministic duplicate-enqueue guard. The actual guarantee is this
  -- UNIQUE constraint, not application discipline alone.
  idempotency_key         TEXT        NOT NULL UNIQUE,

  -- Optional CRM context. Every FK here is nullable and ON DELETE SET
  -- NULL: this table's rows must be able to outlive the record they
  -- refer to (same audit-trail posture as email_ingestions.reservation_id),
  -- and nothing here may ever block or cascade a delete on the
  -- reservations/customers/guides/tours side.
  reservation_id          UUID        REFERENCES public.reservations(id) ON DELETE SET NULL,
  customer_id             UUID        REFERENCES public.customers(id)    ON DELETE SET NULL,
  guide_id                UUID        REFERENCES public.guides(id)       ON DELETE SET NULL,
  tour_id                 UUID        REFERENCES public.tours(id)        ON DELETE SET NULL,

  -- Meaningful primarily for audience_type='operations' (see
  -- whatsapp_destinations above); NULL for guide/customer messages, which
  -- resolve their single recipient from guide_id/customer_id instead.
  destination_id          UUID        REFERENCES public.whatsapp_destinations(id) ON DELETE SET NULL,

  -- Enqueue-time SNAPSHOTS — see "SNAPSHOT PRINCIPLE" in the header.
  -- Never kept in sync with a later customers.phone/guides.phone edit.
  recipient_phone         TEXT,
  recipient_display_name  TEXT,

  -- What to send and in what language. template_key names an approved,
  -- pre-translated template (rendering/templates are a later phase, not
  -- implemented here). language is a stable code (tr/en/es/it/pt/fr, ...)
  -- with no CHECK — never derived in SQL, never inferred here or by any
  -- future logic from nationality/name/phone prefix.
  template_key            TEXT        NOT NULL,
  language                TEXT        NOT NULL,

  -- Deterministic render payload / template parameters, captured at
  -- enqueue time so a queued message remains reproducible even if CRM
  -- data changes before a future worker sends it. No rendering logic is
  -- implemented by this migration.
  payload                 JSONB       NOT NULL DEFAULT '{}'::jsonb,

  -- Set only after a real send attempt. Partial-unique below (not a
  -- plain UNIQUE column constraint) because it is legitimately NULL for
  -- every not-yet-sent row.
  provider_message_id     TEXT,

  status                  TEXT        NOT NULL DEFAULT 'queued'
                                       CHECK (status IN ('queued', 'processing', 'sent', 'delivered', 'read', 'failed')),
  attempt_count            INTEGER     NOT NULL DEFAULT 0,
  next_attempt_at          TIMESTAMPTZ,
  last_attempt_at          TIMESTAMPTZ,
  last_error               TEXT,

  sent_at                  TIMESTAMPTZ,
  delivered_at             TIMESTAMPTZ,
  read_at                  TIMESTAMPTZ,
  failed_at                TIMESTAMPTZ,

  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- A guide/customer message must always carry the single phone it is
  -- going to (its recipient is not resolved via the destination
  -- abstraction); an operations message may or may not, depending on
  -- transport_mode (a meta_group send has no single recipient_phone).
  CONSTRAINT whatsapp_messages_recipient_or_operations CHECK (
    audience_type = 'operations' OR recipient_phone IS NOT NULL
  )
);

COMMENT ON TABLE  public.whatsapp_messages                          IS 'The single durable WhatsApp message/outbox record — one row per physical message across its whole lifecycle (queued through sent/delivered/read, or failed). This is NOT activity_logs and does not replace it: activity_logs remains the CRM''s own activity/notification system, completely untouched by this migration. No Meta client, worker, webhook, or event producer exists yet — this table has no writer and no reader beyond this migration''s own preflight/postflight until a later phase adds them. Written exclusively by a future server-side worker/enqueue function via the Supabase service_role key, which bypasses RLS entirely — see the RLS section below for why this deliberately has no INSERT/UPDATE/DELETE policy for any authenticated (browser) role, mirroring email_ingestions.';
COMMENT ON COLUMN public.whatsapp_messages.event_type               IS 'The CRM event this message is about (e.g. booking_created, guide_assigned, review_request, ...). Deliberately NOT a CHECK-constrained enum, unlike most other enum-shaped columns in this schema — see this migration''s header for why: this value will grow by roughly one per future automation phase, and forcing a schema migration for each would contradict the explicit extensibility requirement. Validated at the application layer.';
COMMENT ON COLUMN public.whatsapp_messages.audience_type            IS 'operations | guide | customer — fixed for the whole roadmap (Phase 0 through Phase 8), so unlike event_type this keeps a CHECK, the same convention every other small/stable enum column in this schema already uses.';
COMMENT ON COLUMN public.whatsapp_messages.idempotency_key          IS 'Deterministic per-logical-message key a future event producer computes (e.g. "booking-created:{reservation_id}"). UNIQUE is the actual duplicate-enqueue guard — the same shape as email_ingestions.gmail_message_id UNIQUE.';
COMMENT ON COLUMN public.whatsapp_messages.reservation_id            IS 'The reservation this message concerns, where applicable. ON DELETE SET NULL: this table is a durable record and must be able to outlive the reservation it refers to, same posture as email_ingestions.reservation_id.';
COMMENT ON COLUMN public.whatsapp_messages.destination_id            IS 'The configured operations destination this message was (or will be) sent through. Meaningful primarily for audience_type=''operations'' — NULL for guide/customer messages, whose single recipient is resolved from guide_id/customer_id instead, not through the destination abstraction.';
COMMENT ON COLUMN public.whatsapp_messages.recipient_phone            IS 'Enqueue-time SNAPSHOT of the destination phone number — never a live reference to customers.phone/guides.phone, and never kept in sync with a later edit to either. NULL only for an operations message sent via a meta_group destination (which has no single recipient phone) — see whatsapp_messages_recipient_or_operations.';
COMMENT ON COLUMN public.whatsapp_messages.payload                    IS 'Deterministic render payload / template parameters, snapshotted at enqueue time so a queued message remains reproducible even if the underlying reservation/tour/customer/guide data changes before a future worker sends it. No rendering logic exists yet; this column exists for that future logic to use.';
COMMENT ON COLUMN public.whatsapp_messages.provider_message_id        IS 'Meta''s own WhatsApp message identifier, set only after a successful send. NULL before send — never assumed to exist earlier. A future webhook receiver upserts on this value (see uq_whatsapp_messages_provider_message_id) to move a row through sent/delivered/read/failed without risking two rows claiming the same provider message.';
COMMENT ON COLUMN public.whatsapp_messages.status                     IS 'queued -> processing -> sent -> delivered -> read, or -> failed at any point after queued. A future worker returns a retryable failure to ''queued'' (with attempt_count incremented and next_attempt_at set in the future) rather than ''failed'' — see attempt_count/next_attempt_at/last_error.';
COMMENT ON COLUMN public.whatsapp_messages.attempt_count              IS 'Number of send attempts made so far by a future worker. Incremented by that worker, never by this migration (starts at 0 for every row).';
COMMENT ON COLUMN public.whatsapp_messages.next_attempt_at            IS 'When a future worker should next attempt this message, for a retryable failure. NULL when not applicable (not yet attempted, or a terminal state).';

CREATE INDEX IF NOT EXISTS idx_whatsapp_messages_status_next_attempt  ON public.whatsapp_messages(status, next_attempt_at);
CREATE UNIQUE INDEX IF NOT EXISTS uq_whatsapp_messages_provider_message_id ON public.whatsapp_messages(provider_message_id) WHERE provider_message_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_whatsapp_messages_reservation_id       ON public.whatsapp_messages(reservation_id);
CREATE INDEX IF NOT EXISTS idx_whatsapp_messages_customer_id          ON public.whatsapp_messages(customer_id);
CREATE INDEX IF NOT EXISTS idx_whatsapp_messages_guide_id             ON public.whatsapp_messages(guide_id);
CREATE INDEX IF NOT EXISTS idx_whatsapp_messages_created_at           ON public.whatsapp_messages(created_at DESC);

DROP TRIGGER IF EXISTS trg_whatsapp_messages_updated_at ON public.whatsapp_messages;
CREATE TRIGGER trg_whatsapp_messages_updated_at
  BEFORE UPDATE ON public.whatsapp_messages
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.whatsapp_messages ENABLE ROW LEVEL SECURITY;

-- Read-only for admin and operations — the two roles that would act on a
-- failed/needs-attention message, same shape as email_ingestions' own
-- admin+operations read policies. Deliberately NOT given to sales or
-- guide in this phase (no frontend UI reads this table yet at all).
--
-- Deliberately NO INSERT/UPDATE/DELETE policy for ANY authenticated
-- role, including admin — per explicit instruction, frontend staff must
-- never be able to impersonate the server-side worker or mark arbitrary
-- delivery states. The only writer is a future server-side enqueue/
-- worker/webhook function via the service_role key, which bypasses RLS
-- entirely and is never exposed to the browser — exactly the
-- email_ingestions precedent, reused rather than reinvented.
DROP POLICY IF EXISTS "whatsapp_messages: admin read" ON public.whatsapp_messages;
CREATE POLICY "whatsapp_messages: admin read"
  ON public.whatsapp_messages FOR SELECT TO authenticated
  USING ( is_admin() );

DROP POLICY IF EXISTS "whatsapp_messages: operations read" ON public.whatsapp_messages;
CREATE POLICY "whatsapp_messages: operations read"
  ON public.whatsapp_messages FOR SELECT TO authenticated
  USING ( is_operations() );


-- ──────────────────────────────────────────────────────────────────────────
-- POSTFLIGHT: verify every object this migration was supposed to create
-- actually exists, with the expected shape, and that nothing outside this
-- migration's explicit scope was touched. RAISE EXCEPTION aborts the
-- WHOLE transaction if anything is wrong.
-- ──────────────────────────────────────────────────────────────────────────

DO $$
DECLARE
  v_missing TEXT[] := '{}';
BEGIN
  -- 1. tour_channels.review_url exists, is TEXT, is nullable.
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='tour_channels' AND column_name='review_url'
       AND data_type='text' AND is_nullable='YES'
  ) THEN
    v_missing := array_append(v_missing, 'tour_channels.review_url (nullable TEXT)');
  END IF;

  -- listing_url must be untouched (still exists, unchanged).
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='tour_channels' AND column_name='listing_url'
  ) THEN
    v_missing := array_append(v_missing, 'tour_channels.listing_url was removed — out of scope, must never happen');
  END IF;

  -- 2. whatsapp_destinations exists with expected columns + RLS + policies.
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='whatsapp_destinations') THEN
    v_missing := array_append(v_missing, 'table whatsapp_destinations');
  ELSE
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='whatsapp_destinations' AND column_name='destination_key') THEN v_missing := array_append(v_missing, 'whatsapp_destinations.destination_key'); END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='whatsapp_destinations' AND column_name='transport_mode') THEN v_missing := array_append(v_missing, 'whatsapp_destinations.transport_mode'); END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='whatsapp_destinations' AND column_name='provider_group_id') THEN v_missing := array_append(v_missing, 'whatsapp_destinations.provider_group_id'); END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'whatsapp_destinations_group_mode_pair' AND contype = 'c') THEN v_missing := array_append(v_missing, 'whatsapp_destinations_group_mode_pair CHECK'); END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname='whatsapp_destinations' AND c.relrowsecurity = TRUE) THEN v_missing := array_append(v_missing, 'whatsapp_destinations RLS enabled'); END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='whatsapp_destinations' AND policyname='whatsapp_destinations: admin full access') THEN v_missing := array_append(v_missing, 'policy: whatsapp_destinations admin full access'); END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='whatsapp_destinations' AND policyname='whatsapp_destinations: operations full access') THEN v_missing := array_append(v_missing, 'policy: whatsapp_destinations operations full access'); END IF;
    -- No default row was seeded.
    IF EXISTS (SELECT 1 FROM public.whatsapp_destinations) THEN
      v_missing := array_append(v_missing, 'whatsapp_destinations has a seeded row — this migration must insert none');
    END IF;
  END IF;

  -- 3. whatsapp_destination_recipients exists with expected columns + RLS.
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='whatsapp_destination_recipients') THEN
    v_missing := array_append(v_missing, 'table whatsapp_destination_recipients');
  ELSE
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='whatsapp_destination_recipients' AND column_name='destination_id' AND is_nullable='NO') THEN v_missing := array_append(v_missing, 'whatsapp_destination_recipients.destination_id NOT NULL'); END IF;
    IF NOT EXISTS (
      SELECT 1
        FROM information_schema.table_constraints tc
        JOIN information_schema.referential_constraints rc ON rc.constraint_name = tc.constraint_name
        JOIN information_schema.key_column_usage kcu ON kcu.constraint_name = tc.constraint_name
       WHERE tc.table_schema='public' AND tc.table_name='whatsapp_destination_recipients'
         AND tc.constraint_type='FOREIGN KEY' AND kcu.column_name='destination_id'
         AND rc.delete_rule = 'CASCADE'
    ) THEN
      v_missing := array_append(v_missing, 'whatsapp_destination_recipients.destination_id FK ON DELETE CASCADE');
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='whatsapp_destination_recipients' AND column_name='phone' AND is_nullable='NO') THEN v_missing := array_append(v_missing, 'whatsapp_destination_recipients.phone NOT NULL'); END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname='whatsapp_destination_recipients' AND c.relrowsecurity = TRUE) THEN v_missing := array_append(v_missing, 'whatsapp_destination_recipients RLS enabled'); END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='whatsapp_destination_recipients' AND policyname='whatsapp_destination_recipients: admin full access') THEN v_missing := array_append(v_missing, 'policy: whatsapp_destination_recipients admin full access'); END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='whatsapp_destination_recipients' AND policyname='whatsapp_destination_recipients: operations full access') THEN v_missing := array_append(v_missing, 'policy: whatsapp_destination_recipients operations full access'); END IF;
  END IF;

  -- 4. whatsapp_messages exists with expected columns/constraints/indexes/RLS.
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='whatsapp_messages') THEN
    v_missing := array_append(v_missing, 'table whatsapp_messages');
  ELSE
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='whatsapp_messages' AND column_name='event_type' AND is_nullable='NO') THEN v_missing := array_append(v_missing, 'whatsapp_messages.event_type NOT NULL'); END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='whatsapp_messages' AND column_name='audience_type') THEN v_missing := array_append(v_missing, 'whatsapp_messages.audience_type'); END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='whatsapp_messages' AND column_name='idempotency_key' AND is_nullable='NO') THEN v_missing := array_append(v_missing, 'whatsapp_messages.idempotency_key NOT NULL'); END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='whatsapp_messages' AND column_name='reservation_id') THEN v_missing := array_append(v_missing, 'whatsapp_messages.reservation_id'); END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='whatsapp_messages' AND column_name='customer_id') THEN v_missing := array_append(v_missing, 'whatsapp_messages.customer_id'); END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='whatsapp_messages' AND column_name='guide_id') THEN v_missing := array_append(v_missing, 'whatsapp_messages.guide_id'); END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='whatsapp_messages' AND column_name='tour_id') THEN v_missing := array_append(v_missing, 'whatsapp_messages.tour_id'); END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='whatsapp_messages' AND column_name='destination_id') THEN v_missing := array_append(v_missing, 'whatsapp_messages.destination_id'); END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='whatsapp_messages' AND column_name='recipient_phone') THEN v_missing := array_append(v_missing, 'whatsapp_messages.recipient_phone'); END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='whatsapp_messages' AND column_name='payload' AND data_type='jsonb') THEN v_missing := array_append(v_missing, 'whatsapp_messages.payload JSONB'); END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='whatsapp_messages' AND column_name='provider_message_id' AND is_nullable='YES') THEN v_missing := array_append(v_missing, 'whatsapp_messages.provider_message_id nullable'); END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='whatsapp_messages' AND column_name='status') THEN v_missing := array_append(v_missing, 'whatsapp_messages.status'); END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='whatsapp_messages' AND column_name='attempt_count') THEN v_missing := array_append(v_missing, 'whatsapp_messages.attempt_count'); END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='whatsapp_messages' AND column_name='next_attempt_at') THEN v_missing := array_append(v_missing, 'whatsapp_messages.next_attempt_at'); END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='whatsapp_messages' AND column_name='last_attempt_at') THEN v_missing := array_append(v_missing, 'whatsapp_messages.last_attempt_at'); END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='whatsapp_messages' AND column_name='last_error') THEN v_missing := array_append(v_missing, 'whatsapp_messages.last_error'); END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='whatsapp_messages' AND column_name='sent_at') THEN v_missing := array_append(v_missing, 'whatsapp_messages.sent_at'); END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='whatsapp_messages' AND column_name='delivered_at') THEN v_missing := array_append(v_missing, 'whatsapp_messages.delivered_at'); END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='whatsapp_messages' AND column_name='read_at') THEN v_missing := array_append(v_missing, 'whatsapp_messages.read_at'); END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='whatsapp_messages' AND column_name='failed_at') THEN v_missing := array_append(v_missing, 'whatsapp_messages.failed_at'); END IF;

    -- event_type must NOT be CHECK-constrained (structural confirmation
    -- of the deliberate extensibility decision).
    IF EXISTS (
      SELECT 1 FROM pg_constraint c
        JOIN pg_class t ON t.oid = c.conrelid
       WHERE t.relname = 'whatsapp_messages' AND c.contype = 'c'
         AND pg_get_constraintdef(c.oid) ILIKE '%event_type%'
    ) THEN
      v_missing := array_append(v_missing, 'whatsapp_messages.event_type must NOT be CHECK-constrained, but a CHECK referencing it was found');
    END IF;

    -- idempotency_key UNIQUE.
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid
       WHERE t.relname='whatsapp_messages' AND c.contype='u'
         AND pg_get_constraintdef(c.oid) LIKE '%idempotency_key%'
    ) THEN
      v_missing := array_append(v_missing, 'whatsapp_messages.idempotency_key UNIQUE');
    END IF;

    -- provider_message_id partial unique index.
    IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname='public' AND tablename='whatsapp_messages' AND indexname='uq_whatsapp_messages_provider_message_id') THEN
      v_missing := array_append(v_missing, 'uq_whatsapp_messages_provider_message_id index');
    END IF;

    -- status + next_attempt_at composite index.
    IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname='public' AND tablename='whatsapp_messages' AND indexname='idx_whatsapp_messages_status_next_attempt') THEN
      v_missing := array_append(v_missing, 'idx_whatsapp_messages_status_next_attempt index');
    END IF;

    -- RLS enabled.
    IF NOT EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname='whatsapp_messages' AND c.relrowsecurity = TRUE) THEN
      v_missing := array_append(v_missing, 'whatsapp_messages RLS enabled');
    END IF;

    -- Read-only policies present.
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='whatsapp_messages' AND policyname='whatsapp_messages: admin read') THEN v_missing := array_append(v_missing, 'policy: whatsapp_messages admin read'); END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='whatsapp_messages' AND policyname='whatsapp_messages: operations read') THEN v_missing := array_append(v_missing, 'policy: whatsapp_messages operations read'); END IF;

    -- No INSERT/UPDATE/DELETE policy for any role must exist — server-
    -- only writes via service_role, which bypasses RLS and is never
    -- expressed as a policy here.
    IF EXISTS (
      SELECT 1 FROM pg_policies
       WHERE schemaname='public' AND tablename='whatsapp_messages' AND cmd IN ('INSERT','UPDATE','DELETE')
    ) THEN
      v_missing := array_append(v_missing, 'whatsapp_messages must have NO INSERT/UPDATE/DELETE policy for any role, but one was found');
    END IF;

    -- No default row was seeded.
    IF EXISTS (SELECT 1 FROM public.whatsapp_messages) THEN
      v_missing := array_append(v_missing, 'whatsapp_messages has a seeded row — this migration must insert none');
    END IF;
  END IF;

  IF array_length(v_missing, 1) > 0 THEN
    RAISE EXCEPTION 'WHATSAPP CORE POSTFLIGHT FAILED: missing/incorrect after migration: %. This means the script above did not fully execute — aborting the whole transaction so this can never silently report success again. Re-run this ENTIRE file, in full, in a single SQL Editor execution.', array_to_string(v_missing, ', ');
  END IF;

  -- Re-confirm both Civitatis RPCs are STILL exactly what they were
  -- before this migration ran — provably a no-op with respect to them,
  -- not just "didn't intend to change them".
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
    RAISE EXCEPTION 'WHATSAPP CORE POSTFLIGHT FAILED: public.ingest_civitatis_booking signature changed or the function disappeared during this migration. This must never happen — aborting.';
  END IF;

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
    RAISE EXCEPTION 'WHATSAPP CORE POSTFLIGHT FAILED: public.cancel_civitatis_booking signature changed or the function disappeared during this migration. This must never happen — aborting.';
  END IF;

  RAISE NOTICE 'WHATSAPP CORE POSTFLIGHT PASSED: tour_channels.review_url added; whatsapp_destinations, whatsapp_destination_recipients, and whatsapp_messages all exist with expected columns/constraints/indexes/RLS/policies; no default row seeded anywhere; event_type is confirmed NOT CHECK-constrained; whatsapp_messages has no write policy for any authenticated role; ingest_civitatis_booking and cancel_civitatis_booking are unchanged. Migration verified complete.';
END $$;

COMMIT;

-- ============================================================
-- END OF MIGRATION supabase_migration_whatsapp_core.sql
-- ============================================================
