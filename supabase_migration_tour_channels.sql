-- ============================================================
-- DESE TOUR OPERATIONS CENTER
-- Migration: Tour Operations, Languages, Sales Channels
-- ============================================================
-- File:    supabase_migration_tour_channels.sql
-- Depends: supabase_schema.sql, supabase_rls_policies.sql,
--          supabase_migration_guides.sql, supabase_migration_reviews.sql
--          (all already applied)
-- Version: V2 — approved architecture. Never applied.
--
-- WHAT THIS ADDS
-- ─────────────────────────────────────────────────────────────
--   1. sources.is_sales_channel / sources.is_review_source —
--      independent capability flags, not a type classification.
--      The same real-world entity (e.g. Civitatis) can legitimately
--      be an acquisition source, a review source, and a sales
--      channel at once; a single "source_type" enum would force
--      picking one and would be wrong. Both default FALSE — no
--      existing source silently becomes a marketplace or review
--      platform. is_review_source is not consumed by application
--      code in this pass (reserved for a future small fix to the
--      review-source picker) but is added now rather than paying
--      for a third future migration touching sources for the same
--      underlying reason.
--
--   2. tours.status — the application already assumes a 3-state
--      Aktif/Taslak/Arşiv lifecycle (mock data includes a draft
--      tour, TourDetailPage has a status selector) that the live
--      schema never actually had — only is_active BOOLEAN exists.
--      status becomes the single AUTHORITATIVE lifecycle field;
--      is_active is kept, unchanged in type/position, as a
--      database-enforced MIRROR of status via
--      trg_tours_sync_status_is_active — see that trigger's
--      rationale below. This is deliberately not two independently
--      writable columns: that shape is exactly what would allow
--      status='active' + is_active=false (or the reverse), which
--      must be structurally impossible, not merely avoided by
--      application discipline.
--
--   3. tours.category CHECK widened to add 'gastronomy'. Every
--      previously allowed value remains allowed — this is a
--      superset, never a narrowing. Gastronomy tours are a real,
--      distinct part of the catalog (the existing mock data already
--      has one) that cannot honestly map to any of the 8 existing
--      enum values; forcing it into 'other' would erase real
--      category-level reporting rather than merely deferring it.
--
--   4. tours.tour_type / maximum_guest_capacity / meeting_point —
--      operational fields. tour_type is TEXT[], not a single enum:
--      a tour may legitimately run as both private and group, and
--      an enum can't represent that. maximum_guest_capacity and
--      meeting_point are plain nullable fields — not every tour
--      needs a hard capacity or a fixed meeting point.
--      tours.notes remains the single operational-notes field; no
--      duplicate column is added.
--
--   5. public.tour_languages — languages a tour is OFFERED in.
--      Structurally identical to the existing public.guide_languages
--      precedent (same shape, same RLS style, same reasoning against
--      a comma-separated/array column). Distinct from
--      reservations.tour_language, which is transactional (what one
--      specific booking was actually operated in, set per-
--      reservation) rather than catalog (what the tour offers,
--      set once when the product is configured). No FK between
--      them — deriving one from the other would be wrong in both
--      directions. reservations.tour_language is NOT touched by
--      this migration.
--
--   6. public.tour_channels — Tour x sales-channel relationship.
--      Reuses public.sources (see sources.is_sales_channel above)
--      rather than a new platforms table, for the same reason
--      reservation_reviews.source_id already reuses sources for a
--      third, distinct concept (review platform vs. booking
--      channel vs. now sales channel) — sources represents "an
--      external channel Dese Tour has a relationship through";
--      Civitatis is the same Civitatis in every one of those three
--      relationships, so a second table would just duplicate the
--      same real-world entities. price/currency are a PAIRED
--      nullable override: both NULL means "inherit tours.base_price
--      and tours.currency together", and a CHECK constraint makes
--      the mismatched case (a price without a currency, or a
--      currency without a price) structurally impossible — see
--      tour_channels_price_currency_pair below.
--
--   7. activity_logs.entity_type widened to allow
--      'tour_language' and 'tour_channel', mirroring how
--      'guide'/'guide_payment'/'reservation_review' were added in
--      the previous two migrations.
--
-- WHY reservations.source_id / tour_channel_id ARE DELIBERATELY
-- NOT ADDED HERE
-- ─────────────────────────────────────────────────────────────
-- Accurate platform-level revenue/reservation-count reporting will
-- eventually need reservations to snapshot which sales channel a
-- booking actually came through, captured once at booking-creation
-- time — the exact same snapshot pattern guide_payments.guide_id
-- and reservation_reviews.guide_id already use, and for the same
-- reason: a tour's channel list changes over time (channels get
-- added, removed, deactivated), so inferring "which platform sold
-- this" later by joining through tours -> tour_channels would
-- silently misattribute historical bookings whenever that
-- configuration later changes, exactly as un-snapshotted guide
-- attribution would. This is also a different fact from
-- customers.source_id (how the customer originally found Dese
-- Tour, which can differ from which platform listing they actually
-- booked through). Not required for tour_channels itself to be
-- useful today (browsing/managing what's published where works
-- without it), so it is intentionally left for a future migration
-- rather than spliced into this one.
--
-- SAFETY
-- ─────────────────────────────────────────────────────────────
--   • 100% additive: two new tables, new columns with safe
--     defaults/backfills, one CHECK widened (never narrowed, never
--     dropped-and-shrunk), one new trigger, one CHECK widened on
--     activity_logs. No existing column dropped, retyped, or
--     renamed. No existing row deleted. No existing table's
--     meaning changed.
--   • tours.base_price, tours.currency, tours.notes, and
--     reservations.tour_language are untouched by this migration.
--   • RLS is enabled on both new tables immediately (in the same
--     statement block that creates them), with policies mirroring
--     tours'/guide_languages' existing admin/operations/sales/guide
--     role split — never left open to every authenticated user by
--     omission.
--   • Genuinely idempotent throughout: every CREATE TABLE, CREATE
--     INDEX, ALTER TABLE ... ADD COLUMN, ALTER TABLE ... ADD
--     CONSTRAINT, CREATE OR REPLACE FUNCTION, CREATE TRIGGER, and
--     CREATE POLICY statement can be run a second time without
--     error and without changing the end result — CREATE TRIGGER /
--     CREATE POLICY are preceded by a matching DROP ... IF EXISTS
--     (these redefine only an object definition, never touch a
--     row), same convention as every prior migration in this repo.
--   • No SQL in this file has been executed. No Supabase connection
--     was made to produce it.
--
-- HOW TO APPLY
-- ─────────────────────────────────────────────────────────────
-- Supabase Dashboard → SQL Editor → paste and run this file.
-- Run AFTER supabase_schema.sql, supabase_rls_policies.sql,
-- supabase_migration_guides.sql, and supabase_migration_reviews.sql.
-- Safe to re-run in full.
-- ============================================================


-- ──────────────────────────────────────────────────────────────────────────
-- sources: capability flags
-- ──────────────────────────────────────────────────────────────────────────

-- Idempotent: ADD COLUMN IF NOT EXISTS.
ALTER TABLE public.sources
  ADD COLUMN IF NOT EXISTS is_sales_channel BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS is_review_source BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN public.sources.is_sales_channel IS 'TRUE if this source can be used as a tour_channels publishing platform (e.g. Civitatis, Viator). Defaults FALSE for every existing row — an admin must explicitly opt a source in. Independent of is_review_source and of being a lead/customer acquisition source: the same row can be any combination of the three.';
COMMENT ON COLUMN public.sources.is_review_source IS 'TRUE if this source is a legitimate review platform, for filtering the review-source picker. Not consumed by application code as of this migration — reserved for a future fix to that picker.';

-- Idempotent: IF NOT EXISTS. Partial index — most source rows are expected
-- to stay FALSE, so this stays small and cheap for the New Tour channel
-- picker's WHERE is_sales_channel = TRUE lookup.
CREATE INDEX IF NOT EXISTS idx_sources_is_sales_channel ON public.sources(is_sales_channel) WHERE is_sales_channel = TRUE;


-- ──────────────────────────────────────────────────────────────────────────
-- tours: status (authoritative) + is_active (database-enforced mirror)
-- ──────────────────────────────────────────────────────────────────────────

-- Idempotent: ADD COLUMN IF NOT EXISTS. Nullable at first so the backfill
-- below can distinguish "already migrated" rows from new ones on a re-run.
ALTER TABLE public.tours ADD COLUMN IF NOT EXISTS status TEXT;

-- Backfill only rows that don't have a value yet — safe to re-run; a second
-- pass finds nothing left with status IS NULL and updates zero rows. Every
-- existing row's current is_active value is preserved exactly (TRUE ->
-- 'active', FALSE -> 'archived'); no row's effective state changes.
UPDATE public.tours SET status = CASE WHEN is_active THEN 'active' ELSE 'archived' END
  WHERE status IS NULL;

ALTER TABLE public.tours ALTER COLUMN status SET DEFAULT 'active';
ALTER TABLE public.tours ALTER COLUMN status SET NOT NULL;

-- Idempotent: DROP CONSTRAINT IF EXISTS before ADD CONSTRAINT.
ALTER TABLE public.tours DROP CONSTRAINT IF EXISTS tours_status_check;
ALTER TABLE public.tours ADD CONSTRAINT tours_status_check
  CHECK (status IN ('active','draft','archived'));

COMMENT ON COLUMN public.tours.status IS 'Authoritative lifecycle field: active | draft | archived. is_active is a database-enforced mirror (see trg_tours_sync_status_is_active) kept only so every existing is_active-based query/RLS/index keeps working unchanged. The application must always write status going forward, never is_active directly — any is_active value sent on insert/update is silently overwritten to match status by the trigger below, by design.';

CREATE INDEX IF NOT EXISTS idx_tours_status ON public.tours(status);

-- Enforces the status/is_active invariant at the database level rather than
-- relying on application discipline: is_active is unconditionally recomputed
-- from status on every insert/update, so status='active' + is_active=false
-- (or the reverse) can never exist as a stored row, regardless of what any
-- caller — present or future — tries to write to is_active.
CREATE OR REPLACE FUNCTION public.sync_tour_status_is_active()
RETURNS TRIGGER AS $$
BEGIN
  NEW.is_active := (NEW.status = 'active');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Idempotency: CREATE TRIGGER has no IF NOT EXISTS in PostgreSQL, so a
-- second run would fail with "trigger already exists" — guard with an
-- explicit DROP first. This only redefines the trigger's behavior, it does
-- not touch any row in public.tours by itself (it only fires on future
-- writes).
DROP TRIGGER IF EXISTS trg_tours_sync_status_is_active ON public.tours;
CREATE TRIGGER trg_tours_sync_status_is_active
  BEFORE INSERT OR UPDATE ON public.tours
  FOR EACH ROW EXECUTE FUNCTION public.sync_tour_status_is_active();


-- ──────────────────────────────────────────────────────────────────────────
-- tours: category widening — additive only, nothing removed
-- ──────────────────────────────────────────────────────────────────────────

-- Idempotent: DROP CONSTRAINT IF EXISTS before ADD CONSTRAINT. This drops
-- and recreates only the CHECK rule's definition — it does not touch,
-- delete, or revalidate-away any existing tours row, and every value
-- previously allowed remains allowed (superset, not a replacement).
ALTER TABLE public.tours DROP CONSTRAINT IF EXISTS tours_category_check;
ALTER TABLE public.tours ADD CONSTRAINT tours_category_check
  CHECK (category IN ('cultural','nature','sea','religious','city','custom','transfer','gastronomy','other'));


-- ──────────────────────────────────────────────────────────────────────────
-- tours: operational fields
-- ──────────────────────────────────────────────────────────────────────────

-- Idempotent: ADD COLUMN IF NOT EXISTS.
ALTER TABLE public.tours
  ADD COLUMN IF NOT EXISTS tour_type TEXT[],
  ADD COLUMN IF NOT EXISTS maximum_guest_capacity INTEGER,
  ADD COLUMN IF NOT EXISTS meeting_point TEXT;

-- Idempotent: DROP CONSTRAINT IF EXISTS before ADD CONSTRAINT.
ALTER TABLE public.tours DROP CONSTRAINT IF EXISTS tours_tour_type_check;
ALTER TABLE public.tours ADD CONSTRAINT tours_tour_type_check
  CHECK (tour_type IS NULL OR tour_type <@ ARRAY['private','group']::TEXT[]);

ALTER TABLE public.tours DROP CONSTRAINT IF EXISTS tours_max_capacity_check;
ALTER TABLE public.tours ADD CONSTRAINT tours_max_capacity_check
  CHECK (maximum_guest_capacity IS NULL OR maximum_guest_capacity > 0);

COMMENT ON COLUMN public.tours.tour_type              IS 'Zero or more of {private, group} — a tour may legitimately run as both, so this is an array, not a single enum. NULL/empty = unspecified.';
COMMENT ON COLUMN public.tours.maximum_guest_capacity IS 'Nullable — not every product needs a hard capacity. Must be > 0 when set.';
COMMENT ON COLUMN public.tours.meeting_point          IS 'Nullable free text. tours.notes remains the single operational-notes field; this is a distinct, more specific field, not a duplicate.';


-- ──────────────────────────────────────────────────────────────────────────
-- TABLE: tour_languages
-- ──────────────────────────────────────────────────────────────────────────

-- Idempotent: IF NOT EXISTS — a second run no-ops if the table already exists.
CREATE TABLE IF NOT EXISTS public.tour_languages (
  id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tour_id        UUID        NOT NULL REFERENCES public.tours(id) ON DELETE CASCADE,
  language_code  TEXT        NOT NULL,
  language_name  TEXT        NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT tour_languages_tour_id_language_code_key UNIQUE (tour_id, language_code)
);

COMMENT ON TABLE  public.tour_languages               IS 'Languages a tour is OFFERED in — relational, one row per (tour, language), mirroring the existing guide_languages precedent. Distinct from reservations.tour_language (what one specific booking was actually operated in). language_code/language_name should match the app''s canonical LANGUAGE_OPTIONS dataset.';
COMMENT ON COLUMN public.tour_languages.tour_id       IS 'Owning tour. ON DELETE CASCADE: removing a tour removes its language rows (no orphaned language links).';
COMMENT ON COLUMN public.tour_languages.language_code IS 'Canonical language code from the app''s LANGUAGE_OPTIONS dataset, e.g. "tr", "en", "es".';
COMMENT ON COLUMN public.tour_languages.language_name IS 'Human-readable language name at time of entry, e.g. "İngilizce", "İspanyolca".';

-- The UNIQUE(tour_id, language_code) constraint above already creates a
-- composite index usable for tour_id-only lookups (leftmost-column match),
-- but an explicit single-column index is added anyway for clarity and for
-- query plans that only filter on tour_id. Idempotent: IF NOT EXISTS.
CREATE INDEX IF NOT EXISTS idx_tour_languages_tour_id      ON public.tour_languages(tour_id);
CREATE INDEX IF NOT EXISTS idx_tour_languages_language_code ON public.tour_languages(language_code);

-- No updated_at trigger: rows are immutable in practice (add/remove a
-- language link, never edit one in place), same as guide_languages.

-- Idempotent: enabling RLS twice is a no-op in PostgreSQL. Enabled
-- immediately alongside table creation — never left unprotected.
ALTER TABLE public.tour_languages ENABLE ROW LEVEL SECURITY;

-- Idempotency: CREATE POLICY has no IF NOT EXISTS / OR REPLACE in
-- PostgreSQL, so a second run would fail with "policy already exists" —
-- guard every one with DROP POLICY IF EXISTS first. This only redefines
-- the policy's rule, it deletes no rows.

-- Admin: full access
DROP POLICY IF EXISTS "tour_languages: admin full access" ON public.tour_languages;
CREATE POLICY "tour_languages: admin full access"
  ON public.tour_languages FOR ALL TO authenticated
  USING   ( is_admin() )
  WITH CHECK ( is_admin() );

-- Operations: full access — they manage the tour catalog
DROP POLICY IF EXISTS "tour_languages: operations full access" ON public.tour_languages;
CREATE POLICY "tour_languages: operations full access"
  ON public.tour_languages FOR ALL TO authenticated
  USING   ( is_operations() )
  WITH CHECK ( is_operations() );

-- Sales: read-only — needs language context for quotes/lead forms
DROP POLICY IF EXISTS "tour_languages: sales read" ON public.tour_languages;
CREATE POLICY "tour_languages: sales read"
  ON public.tour_languages FOR SELECT TO authenticated
  USING ( is_sales() );

-- Guide: read-only — useful context for a tour they're running. Guide role
-- deliberately gets NO access to tour_channels below (pricing/listing data
-- has no operational purpose for a guide).
DROP POLICY IF EXISTS "tour_languages: guide read" ON public.tour_languages;
CREATE POLICY "tour_languages: guide read"
  ON public.tour_languages FOR SELECT TO authenticated
  USING ( is_guide() );


-- ──────────────────────────────────────────────────────────────────────────
-- TABLE: tour_channels
-- ──────────────────────────────────────────────────────────────────────────

-- Idempotent: IF NOT EXISTS — a second run no-ops if the table already exists.
CREATE TABLE IF NOT EXISTS public.tour_channels (
  id                    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tour_id               UUID        NOT NULL REFERENCES public.tours(id) ON DELETE CASCADE,
  -- RESTRICT, not SET NULL: unlike reservation_reviews.source_id (a
  -- historical record that should survive its source being removed), an
  -- orphaned sales-channel listing with no platform is meaningless data,
  -- not a degraded-but-valid one — block the delete instead.
  source_id             UUID        NOT NULL REFERENCES public.sources(id) ON DELETE RESTRICT,
  external_product_id   TEXT,
  -- price/currency are a PAIRED nullable override — see the CHECK below.
  -- Both NULL = inherit tours.base_price and tours.currency together.
  price                 NUMERIC(12,2),
  currency              TEXT,
  is_active             BOOLEAN     NOT NULL DEFAULT TRUE,
  listing_url           TEXT,
  notes                 TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT tour_channels_tour_id_source_id_key UNIQUE (tour_id, source_id),
  -- Makes "price without currency" and "currency without price" both
  -- structurally impossible — never a price silently inherited in the
  -- wrong currency, and never a currency set with no price to pair it with.
  CONSTRAINT tour_channels_price_currency_pair CHECK (
    (price IS NULL AND currency IS NULL) OR (price IS NOT NULL AND currency IS NOT NULL)
  )
);

COMMENT ON TABLE  public.tour_channels                     IS 'Tour x sales-channel relationship — one row per platform a tour is published on. Reuses public.sources (see sources.is_sales_channel) rather than a separate platforms table — the same real-world entity (e.g. Civitatis) can be an acquisition source, a review source, and a sales channel at once; a second table would just duplicate those entities.';
COMMENT ON COLUMN public.tour_channels.tour_id             IS 'Owning tour. ON DELETE CASCADE: removing a tour removes its channel listings.';
COMMENT ON COLUMN public.tour_channels.source_id           IS 'The sales platform (Civitatis, Viator, direct, ...) — must already exist in sources; never fabricated by this migration or by application code. ON DELETE RESTRICT: see table-level note.';
COMMENT ON COLUMN public.tour_channels.external_product_id IS 'The platform''s own product/listing ID, where applicable.';
COMMENT ON COLUMN public.tour_channels.price               IS 'Platform-specific price override. NULL = inherit tours.base_price. Paired with currency — see tour_channels_price_currency_pair.';
COMMENT ON COLUMN public.tour_channels.currency             IS 'NULL exactly when price is NULL (inherit tours.currency together with the price); otherwise required alongside an explicit price.';

-- Idempotent: IF NOT EXISTS.
CREATE INDEX IF NOT EXISTS idx_tour_channels_tour_id   ON public.tour_channels(tour_id);
CREATE INDEX IF NOT EXISTS idx_tour_channels_source_id ON public.tour_channels(source_id);
CREATE INDEX IF NOT EXISTS idx_tour_channels_is_active ON public.tour_channels(is_active);

-- Idempotency: CREATE TRIGGER has no IF NOT EXISTS in PostgreSQL — guard
-- with DROP TRIGGER IF EXISTS first. Reuses the existing set_updated_at()
-- helper function (already defined by supabase_schema.sql and used by
-- customers/tours/reservation_reviews/etc.) rather than defining a new one.
DROP TRIGGER IF EXISTS trg_tour_channels_updated_at ON public.tour_channels;
CREATE TRIGGER trg_tour_channels_updated_at
  BEFORE UPDATE ON public.tour_channels
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- Idempotent: enabling RLS twice is a no-op in PostgreSQL. Enabled
-- immediately alongside table creation — never left unprotected.
ALTER TABLE public.tour_channels ENABLE ROW LEVEL SECURITY;

-- Admin: full access
DROP POLICY IF EXISTS "tour_channels: admin full access" ON public.tour_channels;
CREATE POLICY "tour_channels: admin full access"
  ON public.tour_channels FOR ALL TO authenticated
  USING   ( is_admin() )
  WITH CHECK ( is_admin() );

-- Operations: full access — they manage the tour catalog and its channels
DROP POLICY IF EXISTS "tour_channels: operations full access" ON public.tour_channels;
CREATE POLICY "tour_channels: operations full access"
  ON public.tour_channels FOR ALL TO authenticated
  USING   ( is_operations() )
  WITH CHECK ( is_operations() );

-- Sales: read-only — needs channel/price context for quotes
DROP POLICY IF EXISTS "tour_channels: sales read" ON public.tour_channels;
CREATE POLICY "tour_channels: sales read"
  ON public.tour_channels FOR SELECT TO authenticated
  USING ( is_sales() );

-- No guide policy, deliberately: a guide has no operational need to see
-- channel pricing/listing data (unlike tour_languages above). A guide
-- querying tour_channels gets zero rows back, not an error — RLS default-
-- denies any role with no matching policy.


-- ──────────────────────────────────────────────────────────────────────────
-- activity_logs: widen entity_type check constraint so tour_languages/
-- tour_channels activity can be logged through the same audit trail as
-- everything else. Purely additive — every previously allowed value
-- remains allowed.
-- ──────────────────────────────────────────────────────────────────────────

-- Idempotent: DROP CONSTRAINT IF EXISTS before ADD CONSTRAINT. This drops
-- and recreates only the CHECK rule's definition — it does not touch,
-- delete, or revalidate-away any existing activity_logs row, and every
-- value previously allowed (including 'guide', 'guide_payment', and
-- 'reservation_review' from the prior two migrations) remains allowed.
ALTER TABLE public.activity_logs DROP CONSTRAINT IF EXISTS activity_logs_entity_type_check;
ALTER TABLE public.activity_logs ADD CONSTRAINT activity_logs_entity_type_check
  CHECK (entity_type IN (
    'customer','lead','quote','reservation','payment',
    'task','reminder','tour','message','settings',
    'guide','guide_payment','reservation_review',
    'tour_language','tour_channel'
  ));


-- ── END OF MIGRATION ────────────────────────────────────────────────────────
