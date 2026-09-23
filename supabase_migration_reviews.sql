-- ============================================================
-- DESE TOUR OPERATIONS CENTER
-- Migration: Reservation Reviews (Guide Performance Tracking)
-- ============================================================
-- File:    supabase_migration_reviews.sql
-- Depends: supabase_schema.sql, supabase_rls_policies.sql,
--          supabase_migration_guides.sql (all already applied)
-- Version: V1 — September 2026
--
-- WHAT THIS ADDS
-- ─────────────────────────────────────────────────────────────
--   1. public.reservation_reviews — one row per review received
--      for a reservation. Guide performance (rating averages,
--      5-star counts, etc.) is ALWAYS derived by querying this
--      table at read time — guides.average_rating,
--      guides.review_count and guides.five_star_count are
--      deliberately NOT added anywhere. No such columns exist
--      after this migration, and none should ever be added as
--      manually-maintained fields.
--   2. reservations.tour_language — nullable free-text column for
--      the language the tour was actually conducted in for that
--      specific booking. See rationale below.
--   3. activity_logs.entity_type widened to allow
--      'reservation_review', mirroring how 'guide'/'guide_payment'
--      were added in the previous migration.
--
-- WHY reservation_reviews.guide_id EXISTS ALONGSIDE reservation_id
-- ─────────────────────────────────────────────────────────────
-- reservation_id is the review's real relationship — a review
-- belongs to a reservation. guide_id is a SNAPSHOT of
-- reservations.guide_id at the moment the review was recorded,
-- captured by the application (not a trigger), and never updated
-- afterward. Without this, editing a reservation's guide
-- assignment later would silently move every historical review —
-- and every performance metric derived from it — from the
-- original guide to whoever the reservation now points to, with
-- no record that it ever happened. guide_payments already uses
-- this exact pattern (its own guide_id, independent of
-- reservation_id) — this mirrors that precedent. All guide
-- performance aggregates must read reservation_reviews.guide_id,
-- never re-derive it by joining through reservations.guide_id.
--
-- WHY WHOLE-STAR INTEGER, NOT FRACTIONAL
-- ─────────────────────────────────────────────────────────────
-- Every source in scope (Civitatis, Viator, TripAdvisor, Google,
-- direct feedback) collects one customer's own review as a whole
-- 1-5 star pick. Fractional figures on those platforms are always
-- a computed average across many reviews, never one review's own
-- value — storing a fractional number here would fabricate
-- precision the source data never had. Safe to widen to
-- NUMERIC(2,1) later if a real per-review half-star source ever
-- appears; not needed now.
--
-- WHY reservations.tour_language IS SEPARATE FROM customers.language
-- ─────────────────────────────────────────────────────────────
-- customers.language is the customer's own profile language.
-- tour_language is the language THIS SPECIFIC tour was actually
-- conducted in — a different concept that can diverge from the
-- customer's profile language (e.g. a mixed-language group, or a
-- guide conducting in a shared second language). Deriving one from
-- the other would silently assume they're always the same, which
-- is not reliably true. tour_language is nullable because every
-- existing reservation row predates this column and must remain
-- valid with no value. Its canonical value set is the application's
-- existing LANGUAGE_OPTIONS dataset (already used for customers and
-- guide_languages) — enforced at the application layer, not by a
-- database CHECK constraint, for the same reason customers.language
-- and guides' language names aren't CHECK-constrained either: it
-- keeps the canonical list a single source of truth in application
-- code rather than duplicating it into a second, harder-to-update
-- place in the database.
--
-- SAFETY
-- ─────────────────────────────────────────────────────────────
--   • 100% additive: one new table, one new nullable column on
--     reservations, one CHECK-constraint widening.
--   • No existing table is altered except reservations (one new
--     nullable column, default NULL — every existing row remains
--     valid with no data migration needed) and activity_logs
--     (constraint widening only, see idempotency note below).
--   • No DROP TABLE, no destructive rewrite, no existing row is
--     touched, updated, or reinterpreted by this migration.
--   • RLS is enabled on the new table with policies mirroring the
--     existing guides/guide_payments role model, so it is never
--     left open to every authenticated user by omission.
--   • Genuinely idempotent throughout: every CREATE TABLE, CREATE
--     INDEX, ALTER TABLE ... ADD COLUMN, ALTER TABLE ... ADD
--     CONSTRAINT, CREATE TRIGGER, and CREATE POLICY statement can
--     be run a second time without error and without changing the
--     end result — CREATE TRIGGER / CREATE POLICY are preceded by
--     a matching DROP ... IF EXISTS (these redefine only an object
--     definition, never touch a row), same convention as
--     supabase_migration_guides.sql.
--
-- HOW TO APPLY
-- ─────────────────────────────────────────────────────────────
-- Supabase Dashboard → SQL Editor → paste and run this file.
-- Run AFTER supabase_schema.sql, supabase_rls_policies.sql, and
-- supabase_migration_guides.sql.
-- Safe to re-run in full.
-- ============================================================


-- ──────────────────────────────────────────────────────────────────────────
-- reservations: add tour_language (nullable — see rationale above)
-- ──────────────────────────────────────────────────────────────────────────

-- Idempotent: ADD COLUMN IF NOT EXISTS.
ALTER TABLE public.reservations
  ADD COLUMN IF NOT EXISTS tour_language TEXT;

COMMENT ON COLUMN public.reservations.tour_language IS 'Language the tour was actually conducted in for this booking — distinct from customers.language (the customer''s own profile language). Nullable: existing rows predate this column. Application-level canonical values come from the app''s LANGUAGE_OPTIONS dataset, the same one used for customers and guide_languages.';

-- Idempotent: IF NOT EXISTS. Supports future "Guide × Tour Language"
-- reporting without a full table scan.
CREATE INDEX IF NOT EXISTS idx_reservations_tour_language ON public.reservations(tour_language);


-- ──────────────────────────────────────────────────────────────────────────
-- TABLE: reservation_reviews
-- ──────────────────────────────────────────────────────────────────────────

-- Idempotent: IF NOT EXISTS — a second run no-ops if the table already exists.
CREATE TABLE IF NOT EXISTS public.reservation_reviews (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  reservation_id      UUID        NOT NULL REFERENCES public.reservations(id) ON DELETE CASCADE,
  -- Snapshot of reservations.guide_id at review-creation time — see
  -- migration header for full rationale. Set by the application, never
  -- re-derived or auto-updated afterward.
  guide_id            UUID        REFERENCES public.guides(id) ON DELETE SET NULL,
  rating              INTEGER     NOT NULL CHECK (rating BETWEEN 1 AND 5),
  review_text         TEXT,
  -- Review platform (Civitatis, Google, TripAdvisor, ...) — reuses the
  -- same canonical sources table as customers.source_id / leads.source_id,
  -- but represents a DIFFERENT concept: where the review was posted, not
  -- which channel the booking came through. Add new rows to sources as
  -- needed for a new review platform; no schema change required.
  source_id           UUID        REFERENCES public.sources(id) ON DELETE SET NULL,
  external_review_id  TEXT,       -- the platform's own review id, where available
  review_date         DATE,       -- when the customer actually left the review
  reviewer_name       TEXT,       -- as shown on the source platform, if different from the customer record
  created_by          UUID        REFERENCES public.staff_users(id) ON DELETE SET NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- Prevents importing the exact same external review twice. Does NOT
  -- restrict manual entries: in PostgreSQL, NULL values in a UNIQUE
  -- constraint are never considered equal to each other, so any number of
  -- manual (external_review_id IS NULL) reviews for the same
  -- reservation/source pair remain allowed.
  CONSTRAINT uq_reservation_reviews_external UNIQUE (reservation_id, source_id, external_review_id)
);

COMMENT ON TABLE  public.reservation_reviews                    IS 'Reviews received for a reservation. Guide performance is always derived from this table at query time — never store average_rating/review_count/five_star_count on guides.';
COMMENT ON COLUMN public.reservation_reviews.reservation_id     IS 'The review''s primary relationship — a review belongs to a reservation. ON DELETE CASCADE: deleting a reservation removes its reviews (reservations are soft-cancelled by the app, never hard-deleted in normal operation).';
COMMENT ON COLUMN public.reservation_reviews.guide_id            IS 'Snapshot of reservations.guide_id at review-creation time — deliberately independent of the reservation''s current guide_id so a later reassignment cannot retroactively move historical reviews (and performance metrics) between guides. ON DELETE SET NULL: if a guides row is ever hard-deleted, the review and its rating survive with the attribution cleared, not removed.';
COMMENT ON COLUMN public.reservation_reviews.rating              IS 'Whole stars, 1-5. Individual reviews on every source in scope are whole-star; fractional values are always a computed average, never stored here.';
COMMENT ON COLUMN public.reservation_reviews.source_id           IS 'The platform the review was posted on (Civitatis, Google, TripAdvisor, ...) — distinct from customers.source_id, which is the booking channel. The two may coincide but are not the same concept.';
COMMENT ON COLUMN public.reservation_reviews.external_review_id  IS 'The source platform''s own review identifier, where available — enables safe re-import without duplicating (see uq_reservation_reviews_external).';

-- Idempotent: IF NOT EXISTS.
CREATE INDEX IF NOT EXISTS idx_reservation_reviews_reservation_id ON public.reservation_reviews(reservation_id);
CREATE INDEX IF NOT EXISTS idx_reservation_reviews_guide_id       ON public.reservation_reviews(guide_id);
CREATE INDEX IF NOT EXISTS idx_reservation_reviews_source_id      ON public.reservation_reviews(source_id);
CREATE INDEX IF NOT EXISTS idx_reservation_reviews_review_date    ON public.reservation_reviews(review_date);
CREATE INDEX IF NOT EXISTS idx_reservation_reviews_rating         ON public.reservation_reviews(rating);

-- Idempotency: CREATE TRIGGER has no IF NOT EXISTS in PostgreSQL, so a
-- second run would fail with "trigger already exists" — guard with an
-- explicit DROP first. This only redefines the trigger's behavior, it
-- does not touch any row in public.reservation_reviews.
DROP TRIGGER IF EXISTS trg_reservation_reviews_updated_at ON public.reservation_reviews;
CREATE TRIGGER trg_reservation_reviews_updated_at
  BEFORE UPDATE ON public.reservation_reviews
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- Idempotent: enabling RLS twice is a no-op in PostgreSQL.
ALTER TABLE public.reservation_reviews ENABLE ROW LEVEL SECURITY;

-- Idempotency: CREATE POLICY has no IF NOT EXISTS / OR REPLACE in
-- PostgreSQL, so a second run would fail with "policy already exists" —
-- guard every one with DROP POLICY IF EXISTS first. This only redefines
-- the policy's rule, it deletes no rows.

-- Admin: full access
DROP POLICY IF EXISTS "reservation_reviews: admin full access" ON public.reservation_reviews;
CREATE POLICY "reservation_reviews: admin full access"
  ON public.reservation_reviews FOR ALL TO authenticated
  USING   ( is_admin() )
  WITH CHECK ( is_admin() );

-- Operations: full access — they run day-to-day guide/review management,
-- same role that manages guides and guide_payments.
DROP POLICY IF EXISTS "reservation_reviews: operations full access" ON public.reservation_reviews;
CREATE POLICY "reservation_reviews: operations full access"
  ON public.reservation_reviews FOR ALL TO authenticated
  USING   ( is_operations() )
  WITH CHECK ( is_operations() );

-- Sales: read-only — same visibility they already have on guides, useful
-- context when talking to a customer about a past tour.
DROP POLICY IF EXISTS "reservation_reviews: sales read" ON public.reservation_reviews;
CREATE POLICY "reservation_reviews: sales read"
  ON public.reservation_reviews FOR SELECT TO authenticated
  USING ( is_sales() );

-- Guide role: read-only, mirrors "guides: guide role read" for schema-level
-- consistency. Currently moot in practice — ROLE_PERMISSIONS in the app
-- does not grant the Rehber role access to the guides/guide-detail pages
-- at all today — included so the DB-level policy is already correct if
-- that ever opens up, rather than needing its own future migration.
DROP POLICY IF EXISTS "reservation_reviews: guide role read" ON public.reservation_reviews;
CREATE POLICY "reservation_reviews: guide role read"
  ON public.reservation_reviews FOR SELECT TO authenticated
  USING ( is_guide() );


-- ──────────────────────────────────────────────────────────────────────────
-- activity_logs: widen entity_type check constraint so review activity can
-- be logged through the same audit trail as everything else. Purely
-- additive — every previously allowed value remains allowed.
-- ──────────────────────────────────────────────────────────────────────────

-- Idempotent: DROP CONSTRAINT IF EXISTS before ADD CONSTRAINT. This drops
-- and recreates only the CHECK rule's definition — it does not touch,
-- delete, or revalidate-away any existing activity_logs row, and every
-- value previously allowed (including 'guide' and 'guide_payment' from the
-- prior migration) remains allowed.
ALTER TABLE public.activity_logs DROP CONSTRAINT IF EXISTS activity_logs_entity_type_check;
ALTER TABLE public.activity_logs ADD CONSTRAINT activity_logs_entity_type_check
  CHECK (entity_type IN (
    'customer','lead','quote','reservation','payment',
    'task','reminder','tour','message','settings',
    'guide','guide_payment','reservation_review'
  ));


-- ── END OF MIGRATION ────────────────────────────────────────────────────────
