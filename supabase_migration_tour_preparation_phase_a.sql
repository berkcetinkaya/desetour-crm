-- ============================================================
-- DESE TOUR OPERATIONS CENTER
-- Migration: Tour Preparation Intelligence — Phase A, Database Foundation
-- ============================================================
-- File:    supabase_migration_tour_preparation_phase_a.sql
-- NOT YET APPLIED to any database. Provided for manual review only.
--
-- SCOPE — WHAT THIS MIGRATION IS
-- ─────────────────────────────────────────────────────────────
-- Pure additive schema foundation for the "Tour Preparation Intelligence"
-- feature audited separately (chat-only architecture report, no files
-- created). This migration does ONLY the following:
--
--   1. Adds two new, nullable-or-safely-defaulted columns to
--      public.reservations: purchased_activity_raw (TEXT, nullable) and
--      meal_status (TEXT, NOT NULL DEFAULT 'unknown').
--   2. Creates public.civitatis_activity_modality_map — a deterministic,
--      data-driven lookup table for mapping a Civitatis Activity string
--      to a meal_status, by language. Seeded with exactly the two
--      user-confirmed real production examples (Portuguese "com almoço"
--      / "sem almoço") — no other language or phrase is seeded.
--   3. Creates public.tour_preparation_rules — explicit, manually
--      configured per-tour preparation requirements (entrance ticket,
--      meal, reservation, transport, special access, other). No row is
--      seeded — no Topkapı or any other rule is auto-created.
--   4. Creates public.reservation_preparations — per-reservation
--      materialized preparation instances, carrying their own
--      REQUIRED-vs-COMPLETED state, completed_at/completed_by for
--      auditability.
--
-- WHAT THIS MIGRATION DELIBERATELY DOES NOT DO
-- ─────────────────────────────────────────────────────────────
--   • Does NOT modify public.ingest_civitatis_booking (V12) or
--     public.cancel_civitatis_booking (V13.1) in any way — neither
--     their signature nor their body. Both are only read-only signature-
--     verified in preflight/postflight, the same discipline every prior
--     migration since Tour Information Center/WhatsApp Core has used.
--   • Does NOT modify api/_civitatis/parser.js, writeAdapter.js,
--     cancellationAdapter.js, or any other application code — this
--     migration is SQL only.
--   • Does NOT populate purchased_activity_raw or meal_status for any
--     reservation (new or historical) — every reservation, including
--     every future Civitatis booking ingested through the unmodified
--     V12 RPC, gets meal_status='unknown' (the column DEFAULT) and
--     purchased_activity_raw=NULL until a LATER, separate, additive
--     phase writes to these columns via its own code path. V12 itself
--     is never touched to populate them.
--   • Does NOT implement Activity-string normalization/matching logic —
--     civitatis_activity_modality_map is a plain data table; no trigger,
--     function, or application code reads or evaluates it yet.
--   • Does NOT infer any tour_preparation_rules row from
--     tour_itinerary_stops.place_name or any other free text. The table
--     is created empty of rules (only the modality map table itself is
--     seeded, per instruction, with the two confirmed Activity examples
--     — not with any preparation rule).
--   • Does NOT touch auth, staff_users, or any RLS helper function —
--     reuses is_admin()/is_operations()/is_guide()/set_updated_at()
--     exactly as they already exist.
--   • Does NOT touch the uncommitted WhatsApp Phase 1.2 files or any
--     object they reference (whatsapp_messages, whatsapp_destinations,
--     whatsapp_destination_recipients, tour_channels.review_url,
--     claim_whatsapp_outbox_batch) — none of those names appear
--     anywhere in this file.
--   • Does NOT modify the Tour Information Center's existing ten
--     tours columns or tour_itinerary_stops' existing columns — only
--     reads tour_itinerary_stops.id for an optional, nullable FK.
--
-- UNKNOWN AS THE SOLE CANONICAL UNRESOLVED STATE
-- ─────────────────────────────────────────────────────────────
-- meal_status is NOT NULL with DEFAULT 'unknown' — there is deliberately
-- no NULL-vs-'unknown' double representation of "not yet resolved".
-- Every existing reservation row becomes 'unknown' via this single
-- column default (PostgreSQL applies a DEFAULT to pre-existing rows as a
-- metadata-only operation on ADD COLUMN ... NOT NULL DEFAULT — no
-- separate UPDATE statement is needed or used). purchased_activity_raw
-- remains nullable on purpose: historical Activity-string extraction/
-- backfill has not happened yet (a later, separate phase), so NULL here
-- means "not yet extracted", a different, legitimate meaning from
-- meal_status's own single unresolved state.
--
-- SEED DATA — EXACTLY TWO ROWS, NO MORE
-- ─────────────────────────────────────────────────────────────
-- civitatis_activity_modality_map is seeded with exactly the two
-- user-confirmed real production Activity examples:
--   Portuguese, meal included:  Activity text contains "com almoço"
--   Portuguese, meal excluded:  Activity text contains "sem almoço"
-- Both confirmed real examples place these exact substrings in the
-- Activity line regardless of the preceding tour-name/"Tour"/"Tur"
-- wording (the two confirmed examples themselves already differ there:
-- "Tour com almoço" vs. "Tur sem almoço"), so match_type='contains' on
-- the minimal modality-bearing substring is the deterministic rule that
-- generalizes across both confirmed examples without assuming a fixed
-- surrounding phrase. No Spanish/Italian/French/English/Turkish phrase
-- is seeded — none has been user-confirmed from real production data
-- (the Tour Preparation Intelligence audit found zero meal-modality
-- evidence for any other language in this repo's fixtures).
--
-- NO FUZZY MATCHING, NO AI, NO EMBEDDINGS
-- ─────────────────────────────────────────────────────────────
-- match_type is restricted by CHECK to exactly 'suffix_exact' or
-- 'contains' — both plain, deterministic string operations. No
-- normalization/matching CODE is introduced by this migration at all
-- (see "WHAT THIS MIGRATION DELIBERATELY DOES NOT DO" above); this is
-- schema only, so there is nothing here that could evaluate a match in
-- the first place, fuzzy or otherwise.
--
-- SAFETY
-- ─────────────────────────────────────────────────────────────
-- Wrapped in BEGIN/COMMIT. Preflight verifies every dependency this
-- migration needs (reservations/tours/tour_itinerary_stops/staff_users
-- tables, is_admin()/is_operations()/is_guide()/set_updated_at(), and
-- the exact unchanged V12/V13.1 signatures) and RAISE EXCEPTIONs before
-- touching anything if any is missing or altered. Every CREATE TABLE/
-- ADD COLUMN uses IF NOT EXISTS; every ADD CONSTRAINT is preceded by its
-- own DROP CONSTRAINT IF EXISTS — safe to re-run. Postflight re-verifies
-- every object this migration creates AND that every object outside its
-- scope (V12/V13.1, WhatsApp Phase 1.2 objects, Tour Information Center
-- columns) remains exactly unchanged, aborting the whole transaction on
-- any discrepancy — the same discipline as every migration since V13.1.
--
-- HOW TO APPLY
-- ─────────────────────────────────────────────────────────────
-- Supabase Dashboard → SQL Editor → paste and run this file IN FULL, in
-- a single execution.
-- ============================================================


BEGIN;

-- ──────────────────────────────────────────────────────────────────────────
-- PREFLIGHT: confirm every table/column/function this migration depends
-- on is exactly what it's expected to be, BEFORE touching anything.
-- Read-only.
-- ──────────────────────────────────────────────────────────────────────────

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='reservations')
     OR NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='tours')
     OR NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='tour_itinerary_stops')
     OR NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='staff_users')
  THEN
    RAISE EXCEPTION 'TOUR PREPARATION PHASE A PREFLIGHT FAILED: one of public.reservations/tours/tour_itinerary_stops/staff_users does not exist. Apply supabase_schema.sql and supabase_migration_tour_information_center.sql BEFORE this migration. Aborting before touching anything.';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'is_admin')
     OR NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'is_operations')
     OR NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'is_guide')
  THEN
    RAISE EXCEPTION 'TOUR PREPARATION PHASE A PREFLIGHT FAILED: is_admin()/is_operations()/is_guide() do not exist. Apply supabase_rls_policies.sql BEFORE this migration. Aborting before touching anything.';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'set_updated_at') THEN
    RAISE EXCEPTION 'TOUR PREPARATION PHASE A PREFLIGHT FAILED: public.set_updated_at() does not exist. Apply supabase_schema.sql BEFORE this migration. Aborting before touching anything.';
  END IF;

  -- Read-only confirmation that the two stable Civitatis RPCs this
  -- migration must NEVER affect are present with their known signatures
  -- — never a write, never a replace. Same oidvector-vs-oidvector
  -- technique established by V12/V13.1 and reused by every migration
  -- since (Tour Information Center, WhatsApp Core, WhatsApp Outbox Claim).
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
    RAISE EXCEPTION 'TOUR PREPARATION PHASE A PREFLIGHT FAILED: public.ingest_civitatis_booking with the expected 26-parameter V12 signature was not found. This migration must never be applied against a schema where that function is missing/altered. Aborting before touching anything.';
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
    RAISE EXCEPTION 'TOUR PREPARATION PHASE A PREFLIGHT FAILED: public.cancel_civitatis_booking with the expected 7-parameter V13.1 signature was not found. This migration must never be applied against a schema where that function is missing/altered. Aborting before touching anything.';
  END IF;

  RAISE NOTICE 'TOUR PREPARATION PHASE A PREFLIGHT PASSED: all dependencies present. Proceeding — additive schema only, no RPC/auth/application code touched.';
END $$;


-- ──────────────────────────────────────────────────────────────────────────
-- STEP 1: reservations — purchased_activity_raw, meal_status.
-- Both nullable-or-defaulted, neither populated by this migration, V12
-- untouched.
-- ──────────────────────────────────────────────────────────────────────────

ALTER TABLE public.reservations
  ADD COLUMN IF NOT EXISTS purchased_activity_raw TEXT,
  ADD COLUMN IF NOT EXISTS meal_status             TEXT NOT NULL DEFAULT 'unknown';

COMMENT ON COLUMN public.reservations.purchased_activity_raw IS 'Verbatim copy of the purchased Activity/modality text (e.g. a Civitatis "Activity:" line) for auditability — never decomposed, normalized, or re-cased here. NULL for every reservation as of this migration, including new Civitatis bookings: ingest_civitatis_booking (V12) is NOT modified by this migration to populate it. A later, separate phase populates this column via its own additive code path, never by editing V12.';
COMMENT ON COLUMN public.reservations.meal_status             IS 'included | not_included | unknown — the CRM''s own resolved meal-inclusion determination for this reservation''s purchased tour activity. ''unknown'' is the single canonical unresolved state (there is deliberately no second NULL-shaped unresolved state) and is also the DEFAULT, so every existing reservation and every reservation ingested through the unmodified V12 RPC starts here. Never auto-derived by this migration; a later phase resolves it via public.civitatis_activity_modality_map and writes it through its own additive code path, never by editing V12.';

ALTER TABLE public.reservations DROP CONSTRAINT IF EXISTS reservations_meal_status_check;
ALTER TABLE public.reservations ADD CONSTRAINT reservations_meal_status_check
  CHECK (meal_status IN ('included', 'not_included', 'unknown'));


-- ──────────────────────────────────────────────────────────────────────────
-- STEP 2: civitatis_activity_modality_map — deterministic, data-driven
-- Activity-string → meal_status lookup, by language. A plain data table;
-- no matching/normalization logic exists yet anywhere (see header).
-- ──────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.civitatis_activity_modality_map (
  id                   UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  language_code        TEXT        NOT NULL,
  match_type           TEXT        NOT NULL
                                    CHECK (match_type IN ('suffix_exact', 'contains')),
  match_text           TEXT        NOT NULL,
  -- Normalized (lowercased, trimmed) copy of match_text, used ONLY as the
  -- uniqueness key below — deliberately NOT accent-folded: the Tour
  -- Preparation Intelligence audit found Civitatis itself sends both
  -- accented ("português") and unaccented ("portugues") variants of the
  -- same word as genuinely distinct raw strings, so collapsing accents
  -- here would hide, rather than surface, a case that may legitimately
  -- need its own explicit row.
  match_text_normalized TEXT       GENERATED ALWAYS AS (lower(btrim(match_text))) STORED,
  meal_status          TEXT        NOT NULL
                                    CHECK (meal_status IN ('included', 'not_included')),
  is_active            BOOLEAN     NOT NULL DEFAULT TRUE,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE  public.civitatis_activity_modality_map                      IS 'Deterministic, data-driven mapping from a substring/suffix of a purchased Activity string to a meal_status, scoped per language_code. Rows are DATA, added by a human as real phrases are confirmed from production — never hardcoded phrases in application code, and never evaluated by an LLM/fuzzy matcher. No matching/evaluation logic exists anywhere yet as of this migration (schema only); a later phase adds the deterministic lookup code that reads this table. meal_status here is intentionally a 2-value CHECK (included/not_included only, no ''unknown'') — ''unknown'' is what a reservation gets when NO active row here matches, never a row''s own value.';
COMMENT ON COLUMN public.civitatis_activity_modality_map.language_code        IS 'The Civitatis booking language this rule applies to (e.g. ''pt'', matching api/_civitatis/languageMap.js''s languageCode) — the same match_text may carry a different meaning, or simply not occur, in a different language, so rules are never evaluated across languages.';
COMMENT ON COLUMN public.civitatis_activity_modality_map.match_type           IS 'suffix_exact: match_text must be the exact trailing substring of the Activity string. contains: match_text may appear anywhere in the Activity string. Deliberately only these two plain, deterministic string operations — no fuzzy/edit-distance/embedding match_type value exists or is planned.';
COMMENT ON COLUMN public.civitatis_activity_modality_map.match_text           IS 'The literal phrase/substring to match, stored verbatim as entered (original casing preserved for human readability) — see match_text_normalized for the actual uniqueness comparison.';
COMMENT ON COLUMN public.civitatis_activity_modality_map.match_text_normalized IS 'Generated, lowercased+trimmed copy of match_text — exists solely to back uq_civitatis_activity_modality_map_active_rule below. Never written to directly.';
COMMENT ON COLUMN public.civitatis_activity_modality_map.is_active            IS 'Set false to retire a rule without deleting it (preserves history of what a past evaluation would have matched). Only is_active=TRUE rows participate in the uniqueness guarantee below and are intended to be read by a future matching implementation.';

-- Uniqueness: the same (language, match_type, normalized phrase) cannot
-- be simultaneously active twice — prevents two active rules from
-- silently duplicating or contradicting each other (e.g. one mapping
-- "com almoço" to included and a second, accidental row mapping the
-- same normalized phrase to not_included would otherwise both be
-- "active" at once with no way to know which a future matcher should
-- honor). Scoped to is_active=TRUE only (a partial unique index, the
-- same technique as uq_whatsapp_messages_provider_message_id) so a
-- retired (is_active=FALSE) rule never blocks re-adding or superseding
-- the same phrase later — historical rows are preserved, not deleted,
-- to satisfy that.
CREATE UNIQUE INDEX IF NOT EXISTS uq_civitatis_activity_modality_map_active_rule
  ON public.civitatis_activity_modality_map (language_code, match_type, match_text_normalized)
  WHERE is_active;

CREATE INDEX IF NOT EXISTS idx_civitatis_activity_modality_map_language_active
  ON public.civitatis_activity_modality_map (language_code)
  WHERE is_active;

DROP TRIGGER IF EXISTS trg_civitatis_activity_modality_map_updated_at ON public.civitatis_activity_modality_map;
CREATE TRIGGER trg_civitatis_activity_modality_map_updated_at
  BEFORE UPDATE ON public.civitatis_activity_modality_map
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.civitatis_activity_modality_map ENABLE ROW LEVEL SECURITY;

-- Admin + operations manage (FOR ALL) — same shape as whatsapp_destinations'
-- own admin+operations policies, since this is staff-configured
-- operational reference data, not customer-facing content. No sales/
-- guide policy: this data has no bearing on sales conversations or a
-- guide's own assigned-tour view (a guide sees the RESOLVED meal_status
-- on their assigned reservation, not this mapping table) — RLS
-- default-denies, zero rows back, not an error. The future server-side
-- ingestion/backfill code that actually EVALUATES this table runs via
-- the service_role key, which bypasses RLS entirely and is never
-- exposed to the browser — no policy here grants it anything, nor needs
-- to.
DROP POLICY IF EXISTS "civitatis_activity_modality_map: admin full access" ON public.civitatis_activity_modality_map;
CREATE POLICY "civitatis_activity_modality_map: admin full access"
  ON public.civitatis_activity_modality_map FOR ALL TO authenticated
  USING   ( is_admin() )
  WITH CHECK ( is_admin() );

DROP POLICY IF EXISTS "civitatis_activity_modality_map: operations full access" ON public.civitatis_activity_modality_map;
CREATE POLICY "civitatis_activity_modality_map: operations full access"
  ON public.civitatis_activity_modality_map FOR ALL TO authenticated
  USING   ( is_operations() )
  WITH CHECK ( is_operations() );

-- Seed: EXACTLY the two user-confirmed real production examples. See
-- header "SEED DATA" for why 'contains' and why only these two rows.
-- ON CONFLICT targets the exact partial unique index above — a re-run of
-- this migration after a row was later deactivated (is_active=FALSE)
-- will correctly insert a fresh active row rather than erroring, since
-- a deactivated row no longer matches the partial index's predicate.
INSERT INTO public.civitatis_activity_modality_map (language_code, match_type, match_text, meal_status, is_active)
VALUES
  ('pt', 'contains', 'com almoço', 'included',     TRUE),
  ('pt', 'contains', 'sem almoço', 'not_included', TRUE)
ON CONFLICT (language_code, match_type, match_text_normalized) WHERE is_active
  DO NOTHING;


-- ──────────────────────────────────────────────────────────────────────────
-- STEP 3: tour_preparation_rules — explicit, manually configured
-- per-tour preparation requirements. No row is seeded; rules are
-- configured explicitly later, never inferred from itinerary stop names.
-- ──────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.tour_preparation_rules (
  id                 UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tour_id            UUID        NOT NULL REFERENCES public.tours(id) ON DELETE CASCADE,
  itinerary_stop_id  UUID        REFERENCES public.tour_itinerary_stops(id) ON DELETE SET NULL,
  preparation_type   TEXT        NOT NULL
                                  CHECK (preparation_type IN (
                                    'entrance_ticket', 'meal', 'reservation',
                                    'transport', 'special_access', 'other'
                                  )),
  label              TEXT        NOT NULL,
  quantity_rule      TEXT        NOT NULL DEFAULT 'per_guest'
                                  CHECK (quantity_rule IN ('per_guest', 'fixed', 'per_adult')),
  fixed_quantity     INTEGER,
  is_active          BOOLEAN     NOT NULL DEFAULT TRUE,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- fixed_quantity is required and positive exactly when quantity_rule=
  -- 'fixed', and must be NULL for every other quantity_rule — the same
  -- paired-nullable-column CHECK convention as
  -- whatsapp_destinations_group_mode_pair / reservations_retail_amount_
  -- currency_pair, applied here so a 'per_guest'/'per_adult' rule can
  -- never carry a stale/misleading fixed_quantity value.
  CONSTRAINT tour_preparation_rules_fixed_quantity_pair CHECK (
    (quantity_rule = 'fixed' AND fixed_quantity IS NOT NULL AND fixed_quantity > 0)
    OR (quantity_rule != 'fixed' AND fixed_quantity IS NULL)
  )
);

COMMENT ON TABLE  public.tour_preparation_rules                      IS 'Explicit, manually configured per-tour preparation requirement (e.g. "Topkapı Sarayı entrance ticket, per_guest"). Deliberately NOT inferred from tour_itinerary_stops.place_name text by this migration or any future automation this migration introduces — place_name remains free text with no canonicalization anywhere in this schema, so attaching a requirement automatically from it would be exactly the fuzzy/implicit matching this feature must avoid. No row is seeded by this migration; rules are entered explicitly, later, by a human. A rule is a REQUIREMENT TEMPLATE for a tour, not a per-reservation fact — see reservation_preparations for the per-reservation materialized instance that actually tracks completion.';
COMMENT ON COLUMN public.tour_preparation_rules.itinerary_stop_id    IS 'Optional link to the specific itinerary stop this requirement is associated with (e.g. the Topkapı Sarayı stop) — nullable because a requirement need not be tied to any one stop (e.g. a tour-wide meal requirement). ON DELETE SET NULL: deleting an itinerary stop must never delete the preparation rule itself, only loosen its stop reference.';
COMMENT ON COLUMN public.tour_preparation_rules.preparation_type     IS 'entrance_ticket | meal | reservation | transport | special_access | other. A small, stable, CHECK-constrained set per explicit instruction not to over-engineer this yet; extending it is a future schema migration, by design (unlike whatsapp_messages.event_type, this vocabulary is not expected to grow anywhere near as often).';
COMMENT ON COLUMN public.tour_preparation_rules.label                IS 'Human-readable requirement label as operations will see it (e.g. "Topkapı Sarayı giriş bileti") — entered explicitly by whoever configures the rule, never derived from place_name automatically.';
COMMENT ON COLUMN public.tour_preparation_rules.quantity_rule        IS 'per_guest (default) | fixed | per_adult — how a reservation''s required quantity for this rule is computed. per_guest/per_adult are evaluated against the reservation at materialization time by a later phase; fixed uses fixed_quantity verbatim regardless of guest count.';
COMMENT ON COLUMN public.tour_preparation_rules.fixed_quantity       IS 'Required and > 0 exactly when quantity_rule=''fixed''; NULL for every other quantity_rule — see tour_preparation_rules_fixed_quantity_pair.';
COMMENT ON COLUMN public.tour_preparation_rules.is_active            IS 'Set false to retire a rule (e.g. a tour no longer includes this requirement) without deleting its history or breaking any reservation_preparations row that already references it (preparation_rule_id there is ON DELETE SET NULL, not CASCADE, precisely so deactivating/removing a rule never deletes a reservation''s own historical preparation record).';

CREATE INDEX IF NOT EXISTS idx_tour_preparation_rules_tour_id
  ON public.tour_preparation_rules (tour_id);

DROP TRIGGER IF EXISTS trg_tour_preparation_rules_updated_at ON public.tour_preparation_rules;
CREATE TRIGGER trg_tour_preparation_rules_updated_at
  BEFORE UPDATE ON public.tour_preparation_rules
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.tour_preparation_rules ENABLE ROW LEVEL SECURITY;

-- Admin + operations manage (FOR ALL) — same shape as
-- tour_itinerary_stops' own admin+operations policies, since this is a
-- child configuration table of tours exactly like tour_itinerary_stops
-- itself. Guide: read-only, scoped EXACTLY like tour_itinerary_stops'
-- own "guide reads assigned tour" policy — a guide needs to see what
-- preparations a tour they are actually guiding requires, never the
-- general catalog. No sales policy: unlike tour_itinerary_stops (which
-- is tour-record CONTENT sales may reference with a customer), a
-- preparation rule is internal operational/logistics configuration with
-- no sales-facing purpose, the same reasoning email_ingestions/
-- whatsapp_messages already use to exclude sales from internal
-- operational data.
DROP POLICY IF EXISTS "tour_preparation_rules: admin full access" ON public.tour_preparation_rules;
CREATE POLICY "tour_preparation_rules: admin full access"
  ON public.tour_preparation_rules FOR ALL TO authenticated
  USING   ( is_admin() )
  WITH CHECK ( is_admin() );

DROP POLICY IF EXISTS "tour_preparation_rules: operations full access" ON public.tour_preparation_rules;
CREATE POLICY "tour_preparation_rules: operations full access"
  ON public.tour_preparation_rules FOR ALL TO authenticated
  USING   ( is_operations() )
  WITH CHECK ( is_operations() );

DROP POLICY IF EXISTS "tour_preparation_rules: guide reads assigned tour" ON public.tour_preparation_rules;
CREATE POLICY "tour_preparation_rules: guide reads assigned tour"
  ON public.tour_preparation_rules FOR SELECT TO authenticated
  USING (
    is_guide()
    AND EXISTS (
      SELECT 1 FROM public.reservations r
       WHERE r.tour_id     = tour_preparation_rules.tour_id
         AND r.assigned_to = auth.uid()
    )
  );


-- ──────────────────────────────────────────────────────────────────────────
-- STEP 4: reservation_preparations — per-reservation materialized
-- preparation instances. REQUIRED (auto-determined) is structurally
-- separate from COMPLETED (only ever set by an authenticated staff
-- action, never auto-claimed by this schema or any future ingestion).
-- ──────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.reservation_preparations (
  id                   UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  reservation_id       UUID        NOT NULL REFERENCES public.reservations(id) ON DELETE CASCADE,
  preparation_rule_id  UUID        REFERENCES public.tour_preparation_rules(id) ON DELETE SET NULL,
  preparation_type     TEXT        NOT NULL
                                    CHECK (preparation_type IN (
                                      'entrance_ticket', 'meal', 'reservation',
                                      'transport', 'special_access', 'other'
                                    )),
  label                TEXT        NOT NULL,
  required_quantity    INTEGER     NOT NULL,
  status               TEXT        NOT NULL DEFAULT 'pending'
                                    CHECK (status IN ('pending', 'completed', 'superseded', 'cancelled')),
  completed_at         TIMESTAMPTZ,
  completed_by         UUID        REFERENCES public.staff_users(id) ON DELETE SET NULL,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT reservation_preparations_required_quantity_positive CHECK (required_quantity > 0),
  -- status='completed' REQUIRES completed_at (and, by the same
  -- constraint, every non-completed status FORBIDS retaining a
  -- completed_at/completed_by from an earlier completion) — no existing
  -- repository convention argues for letting a reverted/superseded row
  -- keep a misleading completion timestamp, so this is enforced
  -- structurally rather than left to application discipline alone.
  CONSTRAINT reservation_preparations_completed_consistency CHECK (
    (status = 'completed' AND completed_at IS NOT NULL)
    OR (status != 'completed' AND completed_at IS NULL AND completed_by IS NULL)
  )
);

COMMENT ON TABLE  public.reservation_preparations                       IS 'Per-reservation materialized preparation instance (e.g. "Topkapı Sarayı entrance ticket x5 for reservation R-00123"). This table alone tracks REQUIRED (auto-determined by a later reconciliation phase from tour_preparation_rules + the reservation''s guest count) vs. COMPLETED (status=''completed'', completed_at/completed_by set) — the CRM may determine something is required, but NEVER auto-sets status=''completed''; that is exclusively a staff action, enforced by this schema having no trigger, default, or automation anywhere that writes status=''completed''. No reconciliation/materialization logic exists yet as of this migration (schema only) — a later, separate phase writes these rows via its own additive code path, triggered after (never by modifying) ingest_civitatis_booking/cancel_civitatis_booking.';
COMMENT ON COLUMN public.reservation_preparations.preparation_rule_id    IS 'The rule this instance was materialized from, where applicable. ON DELETE SET NULL (not CASCADE): deleting or deactivating a tour_preparation_rules row must never delete a reservation''s own historical preparation record — the instance keeps its own preparation_type/label/required_quantity captured at materialization time regardless of what happens to the originating rule afterward.';
COMMENT ON COLUMN public.reservation_preparations.required_quantity      IS 'The quantity required for this reservation, computed from the rule''s quantity_rule against the reservation''s guest count (or taken from fixed_quantity) at materialization/reconciliation time — snapshotted here, not recomputed live, so a later guest-count change requires an explicit reconciliation pass rather than silently redefining history.';
COMMENT ON COLUMN public.reservation_preparations.status                 IS 'pending (default — required, not yet done) | completed (a staff member marked it done) | superseded (a reconciliation pass replaced this instance, e.g. after a tour/date change — kept for audit history, never deleted) | cancelled (the owning reservation was cancelled, or the rule no longer applies). completed/cancelled/superseded are each a one-way terminal move from pending in the intended workflow; this schema does not itself forbid other transitions, deferring that to the (not-yet-built) reconciliation/UI layer.';
COMMENT ON COLUMN public.reservation_preparations.completed_at           IS 'Set only when status=''completed'', by the authenticated mutation that performs the completion — never inferred, backfilled, or set by any ingestion/automation path. See reservation_preparations_completed_consistency.';
COMMENT ON COLUMN public.reservation_preparations.completed_by           IS 'The staff_users row that marked this complete. ON DELETE SET NULL: a deactivated/removed staff account must never delete the historical completion record itself, only lose its attribution.';

CREATE INDEX IF NOT EXISTS idx_reservation_preparations_reservation_id
  ON public.reservation_preparations (reservation_id);

-- "Pending preparations" is the one access pattern named explicitly as
-- an anticipated query (dashboard/reservation-detail surfacing of
-- outstanding work) — a partial index keyed to exactly that predicate,
-- rather than a general index on the full status column, per the
-- explicit "avoid speculative index bloat" instruction.
CREATE INDEX IF NOT EXISTS idx_reservation_preparations_pending
  ON public.reservation_preparations (reservation_id)
  WHERE status = 'pending';

-- Idempotency / safe-reconciliation guarantee: at most one LIVE
-- (pending or completed) instance may exist per (reservation, rule) at
-- a time. A reconciliation pass that needs to replace an instance (e.g.
-- after a tour/date change) marks the old row 'superseded' FIRST, which
-- moves it outside this partial index's predicate, and can then safely
-- insert a new live row for the same (reservation_id, preparation_rule_id)
-- pair without a conflict — so re-running reconciliation is always safe
-- and idempotent, and historical superseded/cancelled rows are never
-- deleted just to satisfy this constraint (they simply fall outside the
-- predicate once their status changes). Scoped to
-- preparation_rule_id IS NOT NULL only — an ad hoc instance with no
-- originating rule has no natural dedup key and is not constrained here.
CREATE UNIQUE INDEX IF NOT EXISTS uq_reservation_preparations_live_rule_instance
  ON public.reservation_preparations (reservation_id, preparation_rule_id)
  WHERE status IN ('pending', 'completed') AND preparation_rule_id IS NOT NULL;

DROP TRIGGER IF EXISTS trg_reservation_preparations_updated_at ON public.reservation_preparations;
CREATE TRIGGER trg_reservation_preparations_updated_at
  BEFORE UPDATE ON public.reservation_preparations
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.reservation_preparations ENABLE ROW LEVEL SECURITY;

-- Admin + operations manage (FOR ALL) — operations is the role that
-- actually performs/records completion day to day, same "manage"
-- capability tour_channels/tour_itinerary_stops/reservation_guests/
-- whatsapp_destinations already grant it elsewhere; no narrower
-- column-scoped policy is introduced in this schema-only phase since no
-- application code writes to this table yet. Guide: read-only, scoped
-- EXACTLY like reservation_guests' own "guide reads assigned" policy
-- (assigned_to = auth.uid() AND status NOT IN ('cancelled')) — a guide
-- sees preparation requirements only for a reservation actually assigned
-- to them, and never for one already cancelled. No sales policy:
-- preparation/completion state is operational logistics, not
-- sales-facing information, the same reasoning already applied to
-- tour_preparation_rules above.
DROP POLICY IF EXISTS "reservation_preparations: admin full access" ON public.reservation_preparations;
CREATE POLICY "reservation_preparations: admin full access"
  ON public.reservation_preparations FOR ALL TO authenticated
  USING   ( is_admin() )
  WITH CHECK ( is_admin() );

DROP POLICY IF EXISTS "reservation_preparations: operations full access" ON public.reservation_preparations;
CREATE POLICY "reservation_preparations: operations full access"
  ON public.reservation_preparations FOR ALL TO authenticated
  USING   ( is_operations() )
  WITH CHECK ( is_operations() );

DROP POLICY IF EXISTS "reservation_preparations: guide reads assigned" ON public.reservation_preparations;
CREATE POLICY "reservation_preparations: guide reads assigned"
  ON public.reservation_preparations FOR SELECT TO authenticated
  USING (
    is_guide()
    AND EXISTS (
      SELECT 1 FROM public.reservations r
       WHERE r.id          = reservation_preparations.reservation_id
         AND r.assigned_to = auth.uid()
         AND r.status NOT IN ('cancelled')
    )
  );


-- ──────────────────────────────────────────────────────────────────────────
-- POSTFLIGHT: verify every object this migration was supposed to create
-- actually exists, with the expected shape, and that nothing outside
-- this migration's explicit scope was touched. RAISE EXCEPTION aborts
-- the WHOLE transaction if anything is wrong.
-- ──────────────────────────────────────────────────────────────────────────

DO $$
DECLARE
  v_missing TEXT[] := '{}';
BEGIN
  -- 1. reservations.purchased_activity_raw / meal_status.
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='reservations'
       AND column_name='purchased_activity_raw' AND is_nullable='YES'
  ) THEN
    v_missing := array_append(v_missing, 'reservations.purchased_activity_raw (nullable TEXT)');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='reservations'
       AND column_name='meal_status' AND is_nullable='NO' AND column_default LIKE '%unknown%'
  ) THEN
    v_missing := array_append(v_missing, 'reservations.meal_status (NOT NULL DEFAULT ''unknown'')');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'reservations_meal_status_check' AND contype = 'c') THEN
    v_missing := array_append(v_missing, 'reservations_meal_status_check CHECK');
  END IF;

  -- Every existing reservation must read as 'unknown' — no row was left
  -- NULL or any other value by this migration.
  IF EXISTS (SELECT 1 FROM public.reservations WHERE meal_status IS DISTINCT FROM 'unknown') THEN
    -- Not necessarily a failure on a re-run against a database where a
    -- later phase has already started resolving rows — but on a FIRST
    -- application this must never happen, so this is reported as a
    -- notice, not aborted, to keep this migration safely re-runnable.
    RAISE NOTICE 'TOUR PREPARATION PHASE A POSTFLIGHT: at least one reservation already has a non-unknown meal_status — expected on a re-run after a later phase has started resolving rows, unexpected on a first application.';
  END IF;

  -- 2. civitatis_activity_modality_map exists with expected shape + seed.
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='civitatis_activity_modality_map') THEN
    v_missing := array_append(v_missing, 'table civitatis_activity_modality_map');
  ELSE
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='civitatis_activity_modality_map' AND column_name='language_code' AND is_nullable='NO') THEN v_missing := array_append(v_missing, 'civitatis_activity_modality_map.language_code NOT NULL'); END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'civitatis_activity_modality_map_match_type_check' AND contype = 'c') THEN v_missing := array_append(v_missing, 'civitatis_activity_modality_map match_type CHECK'); END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname='public' AND tablename='civitatis_activity_modality_map' AND indexname='uq_civitatis_activity_modality_map_active_rule') THEN v_missing := array_append(v_missing, 'uq_civitatis_activity_modality_map_active_rule index'); END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname='civitatis_activity_modality_map' AND c.relrowsecurity = TRUE) THEN v_missing := array_append(v_missing, 'civitatis_activity_modality_map RLS enabled'); END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='civitatis_activity_modality_map' AND policyname='civitatis_activity_modality_map: admin full access') THEN v_missing := array_append(v_missing, 'policy: civitatis_activity_modality_map admin full access'); END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='civitatis_activity_modality_map' AND policyname='civitatis_activity_modality_map: operations full access') THEN v_missing := array_append(v_missing, 'policy: civitatis_activity_modality_map operations full access'); END IF;
    IF (SELECT COUNT(*) FROM public.civitatis_activity_modality_map) != 2 THEN
      v_missing := array_append(v_missing, format('civitatis_activity_modality_map must have exactly 2 seed rows, found %s', (SELECT COUNT(*) FROM public.civitatis_activity_modality_map)));
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.civitatis_activity_modality_map WHERE language_code='pt' AND match_text='com almoço' AND meal_status='included') THEN
      v_missing := array_append(v_missing, 'seed row: pt / com almoço / included');
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.civitatis_activity_modality_map WHERE language_code='pt' AND match_text='sem almoço' AND meal_status='not_included') THEN
      v_missing := array_append(v_missing, 'seed row: pt / sem almoço / not_included');
    END IF;
  END IF;

  -- 3. tour_preparation_rules exists with expected shape, and NO row.
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='tour_preparation_rules') THEN
    v_missing := array_append(v_missing, 'table tour_preparation_rules');
  ELSE
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.table_constraints tc
        JOIN information_schema.referential_constraints rc ON rc.constraint_name = tc.constraint_name
        JOIN information_schema.key_column_usage kcu ON kcu.constraint_name = tc.constraint_name
       WHERE tc.table_schema='public' AND tc.table_name='tour_preparation_rules'
         AND tc.constraint_type='FOREIGN KEY' AND kcu.column_name='tour_id' AND rc.delete_rule='CASCADE'
    ) THEN v_missing := array_append(v_missing, 'tour_preparation_rules.tour_id FK ON DELETE CASCADE'); END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tour_preparation_rules_fixed_quantity_pair' AND contype = 'c') THEN v_missing := array_append(v_missing, 'tour_preparation_rules_fixed_quantity_pair CHECK'); END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname='tour_preparation_rules' AND c.relrowsecurity = TRUE) THEN v_missing := array_append(v_missing, 'tour_preparation_rules RLS enabled'); END IF;
    IF EXISTS (SELECT 1 FROM public.tour_preparation_rules) THEN
      v_missing := array_append(v_missing, 'tour_preparation_rules must have zero rows — this migration seeds none, no Topkapı or any other rule');
    END IF;
  END IF;

  -- 4. reservation_preparations exists with expected shape, and NO row.
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='reservation_preparations') THEN
    v_missing := array_append(v_missing, 'table reservation_preparations');
  ELSE
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.table_constraints tc
        JOIN information_schema.referential_constraints rc ON rc.constraint_name = tc.constraint_name
        JOIN information_schema.key_column_usage kcu ON kcu.constraint_name = tc.constraint_name
       WHERE tc.table_schema='public' AND tc.table_name='reservation_preparations'
         AND tc.constraint_type='FOREIGN KEY' AND kcu.column_name='reservation_id' AND rc.delete_rule='CASCADE'
    ) THEN v_missing := array_append(v_missing, 'reservation_preparations.reservation_id FK ON DELETE CASCADE'); END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'reservation_preparations_required_quantity_positive' AND contype = 'c') THEN v_missing := array_append(v_missing, 'reservation_preparations_required_quantity_positive CHECK'); END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'reservation_preparations_completed_consistency' AND contype = 'c') THEN v_missing := array_append(v_missing, 'reservation_preparations_completed_consistency CHECK'); END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname='public' AND tablename='reservation_preparations' AND indexname='uq_reservation_preparations_live_rule_instance') THEN v_missing := array_append(v_missing, 'uq_reservation_preparations_live_rule_instance index'); END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname='reservation_preparations' AND c.relrowsecurity = TRUE) THEN v_missing := array_append(v_missing, 'reservation_preparations RLS enabled'); END IF;
    IF EXISTS (SELECT 1 FROM public.reservation_preparations) THEN
      v_missing := array_append(v_missing, 'reservation_preparations must have zero rows — no materialization logic exists yet');
    END IF;
  END IF;

  -- 5. Out-of-scope objects must remain exactly as they were.
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='tour_itinerary_stops' AND column_name='place_name') THEN
    v_missing := array_append(v_missing, 'tour_itinerary_stops.place_name was removed — out of scope, must never happen');
  END IF;
  IF to_regclass('public.whatsapp_messages') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='whatsapp_messages')
  THEN
    v_missing := array_append(v_missing, 'whatsapp_messages was removed — out of scope, must never happen');
  END IF;

  IF array_length(v_missing, 1) > 0 THEN
    RAISE EXCEPTION 'TOUR PREPARATION PHASE A POSTFLIGHT FAILED: %. Aborting — re-run this ENTIRE file in a single execution.', array_to_string(v_missing, ', ');
  END IF;

  -- Re-confirm both Civitatis RPCs are STILL exactly what they were
  -- before this migration ran — never touched.
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
    RAISE EXCEPTION 'TOUR PREPARATION PHASE A POSTFLIGHT FAILED: public.ingest_civitatis_booking signature changed or the function disappeared during this migration. This must never happen — aborting.';
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
    RAISE EXCEPTION 'TOUR PREPARATION PHASE A POSTFLIGHT FAILED: public.cancel_civitatis_booking signature changed or the function disappeared during this migration. This must never happen — aborting.';
  END IF;

  RAISE NOTICE 'TOUR PREPARATION PHASE A POSTFLIGHT PASSED: reservations.purchased_activity_raw/meal_status added; civitatis_activity_modality_map created with exactly 2 seed rows (pt/com almoço/included, pt/sem almoço/not_included); tour_preparation_rules and reservation_preparations created empty; RLS/indexes/triggers confirmed on all three new tables; both Civitatis RPCs confirmed unchanged.';
END $$;

COMMIT;

-- ============================================================
-- END OF MIGRATION supabase_migration_tour_preparation_phase_a.sql
-- ============================================================
