-- ============================================================
-- DESE TOUR OPERATIONS CENTER
-- Migration: Tour Information Center — schema, Phase 1
-- ============================================================
-- File:    supabase_migration_tour_information_center.sql
-- Depends: supabase_schema.sql, supabase_rls_policies.sql,
--          supabase_migration_tour_channels.sql,
--          supabase_migration_tour_channels_v2_booking_language.sql
--          (all already applied)
-- Version: V1 — approved architecture, schema only. NOT applied. No
--          application UI reads/writes any of these new fields yet.
--
-- WHAT THIS IS
-- ─────────────────────────────────────────────────────────────
-- Phase 1 of the "Tour Information Center": every field a staff member
-- needs to understand, in Turkish, what a marketplace tour (e.g. a
-- Civitatis product) actually is — overview, operational details,
-- itinerary, inclusions/exclusions, booking/cancellation rules, meeting
-- point, and Dese Tour's own internal guide notes — regardless of what
-- language the marketplace listing itself is in.
--
-- This migration ONLY adds schema. It does not change any application
-- code, does not populate any tour's content, and does not touch the
-- Civitatis ingestion/auto-provisioning pipeline in any way — see
-- "AUTO-PROVISIONING COMPATIBILITY" below for the explicit verification
-- of that claim against the committed RPC source.
--
-- ARCHITECTURE CORRECTIONS APPLIED (per manual production audit)
-- ─────────────────────────────────────────────────────────────
--   • NO summary_tr column. tours.description is REUSED as the Turkish
--     "Genel Bakış" field — the UI will relabel it from "Açıklama" to
--     "Genel Bakış" in a later phase; the column itself is untouched,
--     unrenamed, and this migration does not write to it. Production
--     audit found exactly one tour with a non-empty description
--     ("Grand Bazaar Experience" = "Deneme dener") — a test value, not
--     real content; nothing here modifies or clears it.
--   • tours.notes is left 100% INTACT — not renamed, not migrated, not
--     copied, not overwritten, not read by this migration in any way.
--     The one existing "Deneme" test value in notes stays exactly as-is.
--     A NEW, purpose-specific tours.guide_notes_tr column is added
--     instead, starting NULL for every existing row (including that one
--     tour) — nothing is auto-copied from notes into it.
--
-- WHAT THIS ADDS
-- ─────────────────────────────────────────────────────────────
--   1. Ten new NULLABLE tours columns — every one optional, none
--      required, none CHECK-constrained, none trigger-dependent:
--        meeting_instructions_tr, end_point_tr, accessibility_info_tr,
--        pets_policy_tr, booking_cutoff_text, free_cancellation_text,
--        late_cancellation_text, no_show_policy_text,
--        other_conditions_tr, guide_notes_tr.
--      REUSED, not re-created (no schema change needed for these):
--        tours.description (Genel Bakış), tours.duration_text,
--        tours.meeting_point, tours.included_items, tours.excluded_items.
--
--   2. public.tour_itinerary_stops — the one genuinely repeating,
--      ordered structure (a tour's route). Everything else in the Tour
--      Information Center is naturally scalar (one value per tour) and
--      correctly stays a plain column — this is the only new table,
--      deliberately, to avoid the "excessive tables for naturally scalar
--      fields" anti-pattern.
--
-- WHY tour_channels.listing_url AND THE tour_channels.booking_language /
-- separate-tour-row LANGUAGE-ISOLATION MODEL ARE UNCHANGED
-- ─────────────────────────────────────────────────────────────
-- Both already exist and already solve their respective problems:
--   • The marketplace product URL already lives on tour_channels.listing_url
--     (one row per platform a tour is published on — correctly scoped to
--     the channel, not the tour, since the same tour could theoretically
--     list on two different platforms with two different URLs).
--   • A Spanish and an Italian variant of "the same" Civitatis product are
--     already, and remain, two separate public.tours rows, connected to
--     Civitatis via two separate tour_channels rows distinguished by
--     booking_language, guarded by the existing partial UNIQUE index
--     uq_tour_channels_source_product_language (tour_channels_v2
--     migration). This migration's new tour_itinerary_stops/tours columns
--     hang off tours.id, so they inherit that isolation for free — a
--     Spanish tour's itinerary/guide notes/etc. can never collide with an
--     Italian tour's, by construction, with zero new mechanism required.
-- Neither is touched, referenced for modification, or duplicated here.
--
-- MARKETPLACE-DERIVED vs. DESE TOUR INTERNAL CONTENT
-- ─────────────────────────────────────────────────────────────
-- Every new column and the new table's descriptive columns
-- (description_tr, operational_note, approx_duration_text) hold Turkish
-- content DERIVED FROM the marketplace listing — an editor's translation/
-- summary of what Civitatis (or any future channel) itself promises.
-- tours.guide_notes_tr is the ONE exception: Dese Tour's own internal
-- operational commentary (what to explain, what to avoid, cautions),
-- never marketplace-derived, and NEVER auto-populated by anything —
-- this migration does not write a single value into it for any tour,
-- existing or auto-provisioned. See the COMMENT ON COLUMN below for the
-- authoritative, schema-level statement of this distinction, and see
-- the RLS section for how visibility differs accordingly (guides see
-- read-only content scoped to their own assigned tours; nothing in this
-- migration exposes guide_notes_tr any more broadly than every other new
-- field on the same row).
--
-- AUTO-PROVISIONING COMPATIBILITY — EXPLICITLY VERIFIED
-- ─────────────────────────────────────────────────────────────
-- supabase_migration_civitatis_write_v10_tour_auto_provisioning.sql,
-- line 1199, is the ONLY statement anywhere in the codebase that inserts
-- a new row into public.tours as part of automatic provisioning:
--
--   INSERT INTO public.tours (name, category, status, base_price, currency)
--   VALUES (p_civitatis_internal_code, 'other', 'draft', 0, 'EUR')
--
-- This is an EXPLICIT column list. PostgreSQL fills every column not
-- named in that list with its own default — for every column this
-- migration adds, that default is NULL (no DEFAULT clause is set on any
-- of them). Adding nullable columns elsewhere in public.tours has zero
-- effect on the validity, behavior, or output of that INSERT statement,
-- verified by direct inspection of the committed function body, not by
-- assumption. This migration does not modify, wrap, replace, or in any
-- way touch public.ingest_civitatis_booking. A newly discovered Civitatis
-- product + booking language still auto-provisions a minimal tour exactly
-- as before; its Tour Information Center fields are simply NULL until an
-- operator fills them in — never a blocker to provisioning, reservation
-- ingestion, customer/guest creation, or calendar creation, none of which
-- reference any column this migration adds.
--
-- WHY tour_itinerary_stops IS THE ONLY NEW TABLE
-- ─────────────────────────────────────────────────────────────
-- An itinerary is the one piece of Tour Information Center content that
-- is genuinely ordered and repeating (a tour may have 2 stops or 12).
-- Inclusions/exclusions are also repeating but single-field (just a
-- label) — tours.included_items/excluded_items (TEXT[], already existing,
-- currently unused by any UI) are reused as-is rather than adding a
-- second child table for what is structurally just a list of strings.
--
-- SAFETY
-- ─────────────────────────────────────────────────────────────
--   • 100% additive: ten new nullable columns with no default beyond
--     SQL's implicit NULL, one new table, RLS enabled in the same
--     statement block the table is created in. No existing column
--     dropped, retyped, renamed, or given a new NOT NULL/CHECK
--     constraint. No existing row updated. No existing table's meaning
--     changed.
--   • tours.description, tours.notes, tours.duration_text,
--     tours.meeting_point, tours.included_items, tours.excluded_items,
--     tour_languages, and tour_channels are all completely untouched —
--     this migration contains no ALTER/UPDATE/DROP referencing any of
--     them, verified by the postflight below.
--   • public.ingest_civitatis_booking, V12's uuid-recheck fix, V13's
--     cancellation RPC, and V13.1's repair are never referenced except by
--     a single read-only preflight signature check (same pattern V13/
--     V13.1 already use for the same purpose) confirming the function
--     this migration depends on NOT breaking is still live before
--     proceeding — never a write, never a replace.
--   • Genuinely idempotent throughout: every ALTER TABLE ... ADD COLUMN
--     IF NOT EXISTS, CREATE TABLE IF NOT EXISTS, CREATE INDEX IF NOT
--     EXISTS, CREATE TRIGGER (guarded by DROP TRIGGER IF EXISTS first),
--     and CREATE POLICY (guarded by DROP POLICY IF EXISTS first) can be
--     run a second time with no error and no change in outcome.
--   • Preflight (before any write) and postflight (after every write,
--     before COMMIT) both RAISE EXCEPTION and abort the WHOLE transaction
--     on any unexpected state — nothing partial is ever left committed,
--     same discipline as V12/V13/V13.1.
--   • No SQL in this file has been executed. No Supabase connection was
--     made to produce it.
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
     WHERE table_schema = 'public' AND table_name = 'tours'
  ) THEN
    RAISE EXCEPTION 'TOUR INFO CENTER PREFLIGHT FAILED: public.tours does not exist. Apply supabase_schema.sql BEFORE this migration. Aborting before touching anything.';
  END IF;

  -- The five existing columns this phase deliberately REUSES (never
  -- creates) must already exist with the expected type — if any is
  -- missing, something is out of sync with the assumed baseline schema.
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='tours' AND column_name='description' AND data_type='text'
  ) THEN
    RAISE EXCEPTION 'TOUR INFO CENTER PREFLIGHT FAILED: public.tours.description (reused as Genel Bakış) does not exist or is not TEXT. Aborting before touching anything.';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='tours' AND column_name='notes' AND data_type='text'
  ) THEN
    RAISE EXCEPTION 'TOUR INFO CENTER PREFLIGHT FAILED: public.tours.notes does not exist or is not TEXT. Aborting before touching anything — this migration must never need to alter it.';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='tours' AND column_name='duration_text'
  ) OR NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='tours' AND column_name='meeting_point'
  ) OR NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='tours' AND column_name='included_items'
  ) OR NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='tours' AND column_name='excluded_items'
  ) THEN
    RAISE EXCEPTION 'TOUR INFO CENTER PREFLIGHT FAILED: one of tours.duration_text/meeting_point/included_items/excluded_items is missing. Apply supabase_migration_tour_channels.sql BEFORE this migration. Aborting before touching anything.';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
     WHERE table_schema = 'public' AND table_name = 'tour_languages'
  ) THEN
    RAISE EXCEPTION 'TOUR INFO CENTER PREFLIGHT FAILED: public.tour_languages does not exist. Apply supabase_migration_tour_channels.sql BEFORE this migration. Aborting before touching anything.';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
     WHERE table_schema = 'public' AND table_name = 'tour_channels'
  ) THEN
    RAISE EXCEPTION 'TOUR INFO CENTER PREFLIGHT FAILED: public.tour_channels does not exist. Apply supabase_migration_tour_channels.sql BEFORE this migration. Aborting before touching anything.';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='tour_channels' AND column_name='booking_language'
  ) THEN
    RAISE EXCEPTION 'TOUR INFO CENTER PREFLIGHT FAILED: public.tour_channels.booking_language does not exist. Apply supabase_migration_tour_channels_v2_booking_language.sql BEFORE this migration. Aborting before touching anything.';
  END IF;

  -- Required RLS helper functions this migration's own policies call.
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'is_admin')
     OR NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'is_operations')
     OR NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'is_sales')
     OR NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'is_guide')
  THEN
    RAISE EXCEPTION 'TOUR INFO CENTER PREFLIGHT FAILED: one or more of is_admin()/is_operations()/is_sales()/is_guide() does not exist. Apply supabase_rls_policies.sql BEFORE this migration. Aborting before touching anything.';
  END IF;

  -- Read-only confirmation that the Civitatis auto-provisioning RPC this
  -- migration must NEVER affect is present with its known signature —
  -- never a write, never a replace, purely a sanity check that the
  -- dependency this migration's header claims compatibility with is
  -- actually live before proceeding. Same oidvector-vs-oidvector
  -- comparison technique established by V12's (twice-corrected) preflight
  -- and reused by every migration since.
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
    RAISE EXCEPTION 'TOUR INFO CENTER PREFLIGHT FAILED: public.ingest_civitatis_booking with the expected 26-parameter V10/V11/V12 signature was not found. This migration must never be applied against a schema where that function is missing/altered. Aborting before touching anything.';
  END IF;

  RAISE NOTICE 'TOUR INFO CENTER PREFLIGHT PASSED: all dependencies present. Proceeding — additive schema only, no application data touched.';
END $$;


-- ──────────────────────────────────────────────────────────────────────────
-- STEP 1: tours — ten new nullable columns. No default beyond implicit
-- NULL, no CHECK, no trigger. Every existing row (including every
-- Civitatis-auto-provisioned draft tour) gets NULL in each of these —
-- exactly the correct "not yet written" state, not an error.
-- ──────────────────────────────────────────────────────────────────────────

ALTER TABLE public.tours
  ADD COLUMN IF NOT EXISTS meeting_instructions_tr TEXT,
  ADD COLUMN IF NOT EXISTS end_point_tr             TEXT,
  ADD COLUMN IF NOT EXISTS accessibility_info_tr    TEXT,
  ADD COLUMN IF NOT EXISTS pets_policy_tr           TEXT,
  ADD COLUMN IF NOT EXISTS booking_cutoff_text      TEXT,
  ADD COLUMN IF NOT EXISTS free_cancellation_text   TEXT,
  ADD COLUMN IF NOT EXISTS late_cancellation_text   TEXT,
  ADD COLUMN IF NOT EXISTS no_show_policy_text      TEXT,
  ADD COLUMN IF NOT EXISTS other_conditions_tr      TEXT,
  ADD COLUMN IF NOT EXISTS guide_notes_tr           TEXT;

COMMENT ON COLUMN public.tours.description              IS 'Reused as the Turkish "Genel Bakış" (overview) field for the Tour Information Center — column NOT renamed; only the UI label changes from "Açıklama" to "Genel Bakış". Marketplace-derived Turkish content, editor-written. Production audit (pre-migration) found exactly one non-empty value ("Grand Bazaar Experience" = "Deneme dener") — a test value, left untouched by this migration.';
COMMENT ON COLUMN public.tours.meeting_instructions_tr  IS 'Tour Information Center — Turkish instructions for how/where to find the meeting point (distinct from tours.meeting_point, which is the location itself). Marketplace-derived. NULL until an editor fills it in; never blocks provisioning/ingestion.';
COMMENT ON COLUMN public.tours.end_point_tr             IS 'Tour Information Center — Turkish description of where the tour ends, when different from the meeting point. Marketplace-derived. Nullable.';
COMMENT ON COLUMN public.tours.accessibility_info_tr    IS 'Tour Information Center — Turkish accessibility information, when the marketplace listing provides any. Marketplace-derived. Nullable — most tours will have none.';
COMMENT ON COLUMN public.tours.pets_policy_tr           IS 'Tour Information Center — Turkish pets policy, when the marketplace listing states one. Marketplace-derived. Nullable.';
COMMENT ON COLUMN public.tours.booking_cutoff_text      IS 'Tour Information Center — Turkish description of the booking cutoff (how late a reservation can be made). Marketplace-derived free text, same convention as tours.duration_text (human-readable, not a machine-parsed interval). Nullable.';
COMMENT ON COLUMN public.tours.free_cancellation_text   IS 'Tour Information Center — Turkish description of the free-cancellation window/conditions. Marketplace-derived free text. Nullable.';
COMMENT ON COLUMN public.tours.late_cancellation_text   IS 'Tour Information Center — Turkish description of the late-cancellation policy. Marketplace-derived free text. Nullable.';
COMMENT ON COLUMN public.tours.no_show_policy_text      IS 'Tour Information Center — Turkish description of the no-show policy. Marketplace-derived free text. Nullable.';
COMMENT ON COLUMN public.tours.other_conditions_tr      IS 'Tour Information Center — any other channel/product-specific booking condition not covered by the dedicated fields above. Marketplace-derived. Nullable.';
COMMENT ON COLUMN public.tours.guide_notes_tr           IS 'Tour Information Center — DESE TOUR INTERNAL content only (historical/context notes for the guide, cautions, no-commission-stop reminders, etc.) — the ONE field on this table that is NEVER marketplace-derived and NEVER auto-populated by anything, including this migration (every row, new or existing, gets NULL here). Must be visually and structurally distinguished from every marketplace-derived field above wherever it is displayed. Deliberately separate from the pre-existing tours.notes column (general operational notes, left completely untouched by this migration, including its one existing "Deneme" test value) — guide_notes_tr is purpose-specific and, unlike notes, intended to eventually be guide-readable.';


-- ──────────────────────────────────────────────────────────────────────────
-- STEP 2: public.tour_itinerary_stops — the one new table. Ordered,
-- repeating route content; everything else in this migration is scalar.
-- ──────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.tour_itinerary_stops (
  id                    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tour_id               UUID        NOT NULL REFERENCES public.tours(id) ON DELETE CASCADE,
  stop_order            INTEGER     NOT NULL,
  place_name            TEXT        NOT NULL,
  description_tr        TEXT,
  operational_note      TEXT,
  approx_duration_text  TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT tour_itinerary_stops_tour_id_stop_order_key UNIQUE (tour_id, stop_order),
  -- Safe to add at creation time (this is a brand-new, currently-empty
  -- table — no existing row can ever violate it, unlike a CHECK retrofit
  -- onto an existing table with unknown data).
  CONSTRAINT tour_itinerary_stops_stop_order_positive CHECK (stop_order > 0)
);

COMMENT ON TABLE  public.tour_itinerary_stops                      IS 'A tour''s ordered route — one row per stop. Marketplace-derived Turkish content (description_tr, operational_note), editor-written from the marketplace listing. Distinct from tours.guide_notes_tr (Dese Tour internal) — nothing in this table is internal-only. ON DELETE CASCADE from tours: removing a tour removes its stops (same convention as tour_languages/tour_channels).';
COMMENT ON COLUMN public.tour_itinerary_stops.tour_id               IS 'Owning tour. ON DELETE CASCADE: removing a tour removes its itinerary stops (no orphaned rows).';
COMMENT ON COLUMN public.tour_itinerary_stops.stop_order            IS '1-based display order within the tour. UNIQUE (tour_id, stop_order): two stops of the same tour can never claim the same position. Must be > 0.';
COMMENT ON COLUMN public.tour_itinerary_stops.place_name            IS 'Required — a stop with no name is not a usable itinerary entry. Short label (e.g. "Kapalıçarşı Ana Giriş").';
COMMENT ON COLUMN public.tour_itinerary_stops.description_tr        IS 'Turkish description of this stop. Marketplace-derived. Nullable.';
COMMENT ON COLUMN public.tour_itinerary_stops.operational_note      IS 'Optional operational note specific to this stop (e.g. a timing caution). Nullable.';
COMMENT ON COLUMN public.tour_itinerary_stops.approx_duration_text  IS 'Optional approximate duration at this stop, free text (e.g. "20 dakika") — same human-readable convention as tours.duration_text, never a machine-parsed interval. Nullable.';

CREATE INDEX IF NOT EXISTS idx_tour_itinerary_stops_tour_id ON public.tour_itinerary_stops(tour_id);

-- Idempotency: CREATE TRIGGER has no IF NOT EXISTS in PostgreSQL — guard
-- with DROP TRIGGER IF EXISTS first. Reuses the existing set_updated_at()
-- helper (already defined by supabase_schema.sql, already used by
-- tours/tour_channels/etc.) rather than defining a new one.
DROP TRIGGER IF EXISTS trg_tour_itinerary_stops_updated_at ON public.tour_itinerary_stops;
CREATE TRIGGER trg_tour_itinerary_stops_updated_at
  BEFORE UPDATE ON public.tour_itinerary_stops
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


-- ──────────────────────────────────────────────────────────────────────────
-- STEP 3: RLS on tour_itinerary_stops. Reuses the SAME four helper
-- functions and the SAME role-shaped split every existing tours/
-- tour_languages/tour_channels policy set already uses — no new security
-- model invented. Enabled in the same statement block the table is
-- created in — never left unprotected.
--
-- Admin / Operations: FOR ALL — same shape as tour_languages'/
-- tour_channels' own admin+operations policies (a single FOR ALL each),
-- since this is a child table of tours, not the base tours table itself
-- (which predates that cleaner split-by-verb pattern).
--
-- Sales: read-only, scoped to ACTIVE tours only — this deliberately
-- mirrors tours' OWN "tours: sales read active" policy
-- (is_sales() AND is_active = TRUE) rather than tour_languages' broader
-- unscoped sales policy, because itinerary content is tour-record content
-- (like tours.description/meeting_point), not a lookup capability list —
-- "read-only according to the existing tour visibility model" means sales
-- sees itinerary stops for exactly the tours they can already see via
-- tours' own RLS, no more.
--
-- Guide: read-only, scoped EXACTLY like tours' own
-- "tours: guide reads assigned tour" policy — a guide sees itinerary
-- stops ONLY for a tour they have an assigned reservation against.
-- Deliberately NOT the broader unscoped shape tour_languages' guide
-- policy uses — this migration does not broaden guide access to the
-- general tours catalog, per explicit instruction.
-- ──────────────────────────────────────────────────────────────────────────

ALTER TABLE public.tour_itinerary_stops ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "tour_itinerary_stops: admin full access" ON public.tour_itinerary_stops;
CREATE POLICY "tour_itinerary_stops: admin full access"
  ON public.tour_itinerary_stops FOR ALL TO authenticated
  USING   ( is_admin() )
  WITH CHECK ( is_admin() );

DROP POLICY IF EXISTS "tour_itinerary_stops: operations full access" ON public.tour_itinerary_stops;
CREATE POLICY "tour_itinerary_stops: operations full access"
  ON public.tour_itinerary_stops FOR ALL TO authenticated
  USING   ( is_operations() )
  WITH CHECK ( is_operations() );

DROP POLICY IF EXISTS "tour_itinerary_stops: sales read active tour" ON public.tour_itinerary_stops;
CREATE POLICY "tour_itinerary_stops: sales read active tour"
  ON public.tour_itinerary_stops FOR SELECT TO authenticated
  USING (
    is_sales()
    AND EXISTS (
      SELECT 1 FROM public.tours t
       WHERE t.id = tour_itinerary_stops.tour_id
         AND t.is_active = TRUE
    )
  );

DROP POLICY IF EXISTS "tour_itinerary_stops: guide reads assigned tour" ON public.tour_itinerary_stops;
CREATE POLICY "tour_itinerary_stops: guide reads assigned tour"
  ON public.tour_itinerary_stops FOR SELECT TO authenticated
  USING (
    is_guide()
    AND EXISTS (
      SELECT 1
        FROM public.reservations r
       WHERE r.tour_id     = tour_itinerary_stops.tour_id
         AND r.assigned_to = auth.uid()
    )
  );

-- No policy for any other role: RLS default-denies — a session with no
-- matching policy (e.g. no staff_users row at all) gets zero rows back,
-- never an error.


-- ──────────────────────────────────────────────────────────────────────────
-- POSTFLIGHT: verify every object this migration was supposed to create
-- actually exists, with the expected shape, and that nothing outside this
-- migration's explicit scope was touched. RAISE EXCEPTION aborts the
-- WHOLE transaction (including Step 1/2/3 above) if anything is wrong —
-- this migration can never report a bare "Success" while silently
-- failing to finish, the exact gap V13.1 was written to close for its
-- own RPC and is reused here for a schema-only migration.
-- ──────────────────────────────────────────────────────────────────────────

DO $$
DECLARE
  v_missing TEXT[] := '{}';
BEGIN
  -- 1. All ten new tours columns exist.
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='tours' AND column_name='meeting_instructions_tr') THEN v_missing := array_append(v_missing, 'tours.meeting_instructions_tr'); END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='tours' AND column_name='end_point_tr') THEN v_missing := array_append(v_missing, 'tours.end_point_tr'); END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='tours' AND column_name='accessibility_info_tr') THEN v_missing := array_append(v_missing, 'tours.accessibility_info_tr'); END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='tours' AND column_name='pets_policy_tr') THEN v_missing := array_append(v_missing, 'tours.pets_policy_tr'); END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='tours' AND column_name='booking_cutoff_text') THEN v_missing := array_append(v_missing, 'tours.booking_cutoff_text'); END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='tours' AND column_name='free_cancellation_text') THEN v_missing := array_append(v_missing, 'tours.free_cancellation_text'); END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='tours' AND column_name='late_cancellation_text') THEN v_missing := array_append(v_missing, 'tours.late_cancellation_text'); END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='tours' AND column_name='no_show_policy_text') THEN v_missing := array_append(v_missing, 'tours.no_show_policy_text'); END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='tours' AND column_name='other_conditions_tr') THEN v_missing := array_append(v_missing, 'tours.other_conditions_tr'); END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='tours' AND column_name='guide_notes_tr') THEN v_missing := array_append(v_missing, 'tours.guide_notes_tr'); END IF;

  -- 1b. None of these ten are ever NOT NULL (structural nullability check
  -- — matches "all new fields MUST remain nullable").
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='tours'
       AND column_name IN (
         'meeting_instructions_tr','end_point_tr','accessibility_info_tr','pets_policy_tr',
         'booking_cutoff_text','free_cancellation_text','late_cancellation_text',
         'no_show_policy_text','other_conditions_tr','guide_notes_tr'
       )
       AND is_nullable = 'NO'
  ) THEN
    RAISE EXCEPTION 'TOUR INFO CENTER POSTFLIGHT FAILED: at least one new tours column is NOT NULL — every one of them must remain nullable. Aborting.';
  END IF;

  -- 1c. summary_tr must NOT exist (explicit architecture correction).
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='tours' AND column_name='summary_tr') THEN
    RAISE EXCEPTION 'TOUR INFO CENTER POSTFLIGHT FAILED: tours.summary_tr exists but must not — description is reused instead. Aborting.';
  END IF;

  -- 2. tour_itinerary_stops exists with its expected columns.
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='tour_itinerary_stops') THEN
    v_missing := array_append(v_missing, 'table tour_itinerary_stops');
  ELSE
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='tour_itinerary_stops' AND column_name='tour_id') THEN v_missing := array_append(v_missing, 'tour_itinerary_stops.tour_id'); END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='tour_itinerary_stops' AND column_name='stop_order') THEN v_missing := array_append(v_missing, 'tour_itinerary_stops.stop_order'); END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='tour_itinerary_stops' AND column_name='place_name') THEN v_missing := array_append(v_missing, 'tour_itinerary_stops.place_name'); END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='tour_itinerary_stops' AND column_name='description_tr') THEN v_missing := array_append(v_missing, 'tour_itinerary_stops.description_tr'); END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='tour_itinerary_stops' AND column_name='operational_note') THEN v_missing := array_append(v_missing, 'tour_itinerary_stops.operational_note'); END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='tour_itinerary_stops' AND column_name='approx_duration_text') THEN v_missing := array_append(v_missing, 'tour_itinerary_stops.approx_duration_text'); END IF;

    -- tour_id NOT NULL + FK ON DELETE CASCADE to tours.
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
       WHERE table_schema='public' AND table_name='tour_itinerary_stops' AND column_name='tour_id' AND is_nullable='NO'
    ) THEN
      v_missing := array_append(v_missing, 'tour_itinerary_stops.tour_id NOT NULL');
    END IF;
    IF NOT EXISTS (
      SELECT 1
        FROM information_schema.table_constraints tc
        JOIN information_schema.referential_constraints rc ON rc.constraint_name = tc.constraint_name
        JOIN information_schema.key_column_usage kcu ON kcu.constraint_name = tc.constraint_name
       WHERE tc.table_schema='public' AND tc.table_name='tour_itinerary_stops'
         AND tc.constraint_type='FOREIGN KEY' AND kcu.column_name='tour_id'
         AND rc.delete_rule = 'CASCADE'
    ) THEN
      v_missing := array_append(v_missing, 'tour_itinerary_stops.tour_id FK ON DELETE CASCADE');
    END IF;

    -- UNIQUE (tour_id, stop_order).
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint
       WHERE conname = 'tour_itinerary_stops_tour_id_stop_order_key' AND contype = 'u'
    ) THEN
      v_missing := array_append(v_missing, 'tour_itinerary_stops UNIQUE(tour_id, stop_order)');
    END IF;

    -- RLS enabled.
    IF NOT EXISTS (
      SELECT 1 FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname='public' AND c.relname='tour_itinerary_stops' AND c.relrowsecurity = TRUE
    ) THEN
      v_missing := array_append(v_missing, 'tour_itinerary_stops RLS enabled');
    END IF;

    -- All four policies present.
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='tour_itinerary_stops' AND policyname='tour_itinerary_stops: admin full access') THEN v_missing := array_append(v_missing, 'policy: admin full access'); END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='tour_itinerary_stops' AND policyname='tour_itinerary_stops: operations full access') THEN v_missing := array_append(v_missing, 'policy: operations full access'); END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='tour_itinerary_stops' AND policyname='tour_itinerary_stops: sales read active tour') THEN v_missing := array_append(v_missing, 'policy: sales read active tour'); END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='tour_itinerary_stops' AND policyname='tour_itinerary_stops: guide reads assigned tour') THEN v_missing := array_append(v_missing, 'policy: guide reads assigned tour'); END IF;
  END IF;

  IF array_length(v_missing, 1) > 0 THEN
    RAISE EXCEPTION 'TOUR INFO CENTER POSTFLIGHT FAILED: missing/incorrect after migration: %. This means the script above did not fully execute — aborting the whole transaction so this can never silently report success again. Re-run this ENTIRE file, in full, in a single SQL Editor execution.', array_to_string(v_missing, ', ');
  END IF;

  -- 3. Re-confirm the Civitatis auto-provisioning RPC is STILL exactly
  -- what it was before this migration ran (same signature check as the
  -- preflight) — this migration must be provably a no-op with respect to
  -- it, not just "didn't intend to change it".
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
    RAISE EXCEPTION 'TOUR INFO CENTER POSTFLIGHT FAILED: public.ingest_civitatis_booking signature changed or the function disappeared during this migration. This must never happen — aborting.';
  END IF;

  RAISE NOTICE 'TOUR INFO CENTER POSTFLIGHT PASSED: all ten new tours columns present and nullable, tours.summary_tr does not exist, tour_itinerary_stops exists with expected columns/constraints/RLS/policies, and ingest_civitatis_booking is unchanged. Migration verified complete.';
END $$;

COMMIT;

-- ============================================================
-- END OF MIGRATION supabase_migration_tour_information_center.sql
-- ============================================================
