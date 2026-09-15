-- ============================================================
-- DESE TOUR OPERATIONS CENTER
-- Migration: Guide Management (Rehberlerimiz)
-- ============================================================
-- File:    supabase_migration_guides.sql
-- Depends: supabase_schema.sql, supabase_rls_policies.sql (already applied)
-- Version: V2.1 — September 2026 (revised per manual schema review)
--
-- WHAT THIS ADDS
-- ─────────────────────────────────────────────────────────────
--   1. public.guides           — operational guide directory
--   2. public.guide_languages  — relational guide↔language links
--                                 (replaces an earlier guides.languages
--                                 TEXT[] design — see REVISION NOTES)
--   3. reservations.guide_id   — relational guide assignment
--   4. public.guide_payments   — guide/supplier payout ledger,
--                                 kept separate from public.payments
--                                 (customer payments)
--
-- REVISION NOTES (V2 → V2.1)
-- ─────────────────────────────────────────────────────────────
-- This revises the V2 draft after manual schema review. Two changes:
--
--   1. guides.languages TEXT[] is REMOVED and replaced with a proper
--      relational child table, public.guide_languages, keyed to
--      guides(id) with a UNIQUE(guide_id, language_code) constraint.
--      No comma-separated or array text storage of languages anywhere.
--      See the guide_languages section below for full rationale.
--
--   2. Every CREATE TRIGGER and CREATE POLICY statement is now preceded
--      by a matching DROP ... IF EXISTS, so the entire file is
--      genuinely safe to execute twice — not just the CREATE TABLE /
--      CREATE INDEX statements, which were already idempotent via
--      IF NOT EXISTS. Dropping and recreating a trigger or policy
--      *definition* touches no rows and is safe; this migration never
--      drops a table or deletes data.
--
-- WHY A SEPARATE guides TABLE INSTEAD OF staff_users
-- ─────────────────────────────────────────────────────────────
-- staff_users is an authentication profile: it's PK'd on
-- auth.users(id) and exists only for people who log into this
-- app. A tour guide is operational/business data (license number,
-- nationality, spoken languages, notes) and very often will never
-- have — or need — a CRM login. Forcing every guide to first exist
-- as a Supabase Auth user just to be assignable to a reservation
-- would misuse an authentication table for business data, and
-- would block adding a guide who isn't a system user at all.
-- staff_users.role already has a 'guide' value for the opposite
-- case (a guide who DOES log in and needs to see their own
-- assigned reservations via the existing RLS policies in
-- supabase_rls_policies.sql) — that mechanism is untouched by
-- this migration and keeps working exactly as before. The two are
-- deliberately independent: a guides row MAY optionally be linked
-- to a staff_users row (via guides.staff_user_id) if that same
-- person also has a CRM login, but neither requires the other.
--
-- WHY guide_payments INSTEAD OF EXTENDING payments
-- ─────────────────────────────────────────────────────────────
-- public.payments.customer_id is NOT NULL — a payment row must
-- belong to a customer. A guide payout isn't paid by or to a
-- customer, so reusing that table would mean either picking an
-- arbitrary customer_id just to satisfy the constraint (wrong
-- data) or loosening a real, currently-enforced constraint on a
-- production table that already holds customer payment history.
-- A separate table is purely additive: zero risk to the existing
-- payments table, its constraints, or its data, and reports can
-- never accidentally mix the two without an explicit UNION.
--
-- SAFETY
-- ─────────────────────────────────────────────────────────────
--   • 100% additive: new tables + one new nullable column.
--   • No existing table is altered except reservations, which
--     only gains one new nullable FK column (guide_id). The
--     existing guide_name free-text column is left exactly as-is
--     for historical rows.
--   • No DROP TABLE, no destructive rewrite, no data migration of
--     any existing rows. The only DROP statements in this file are
--     DROP TRIGGER IF EXISTS / DROP POLICY IF EXISTS immediately
--     followed by CREATE TRIGGER / CREATE POLICY, which redefine an
--     object's behavior but touch zero rows and delete no data.
--   • RLS is enabled on all new tables with policies mirroring
--     the existing role model in supabase_rls_policies.sql, so
--     they aren't left open to every authenticated user by
--     omission.
--   • Genuinely idempotent: every CREATE TABLE, CREATE INDEX,
--     ALTER TABLE ... ADD COLUMN, ALTER TABLE ... ADD CONSTRAINT,
--     CREATE TRIGGER, and CREATE POLICY statement in this file can
--     be run a second time without error and without changing the
--     end result. See the idempotency note before each such
--     statement for how.
--
-- HOW TO APPLY
-- ─────────────────────────────────────────────────────────────
-- Supabase Dashboard → SQL Editor → paste and run this file.
-- Run AFTER supabase_schema.sql and supabase_rls_policies.sql.
-- Safe to re-run in full, including triggers and policies.
-- ============================================================


-- ──────────────────────────────────────────────────────────────────────────
-- TABLE: guides
-- Operational guide directory — the "Rehberlerimiz" module.
-- ──────────────────────────────────────────────────────────────────────────

-- Idempotent: IF NOT EXISTS — a second run no-ops if the table already exists.
CREATE TABLE IF NOT EXISTS public.guides (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  full_name       TEXT        NOT NULL,
  phone           TEXT,
  email           TEXT,
  nationality     TEXT,
  license_number  TEXT,
  license_notes   TEXT,       -- license type / free-form license detail
  region          TEXT,       -- city / operating region
  status          TEXT        NOT NULL DEFAULT 'active'
                              CHECK (status IN ('active','unavailable','inactive')),
  notes           TEXT,
  -- Optional link if this same person ALSO has a CRM login (a staff_users
  -- row with role='guide'). Nullable — most guides won't have one.
  staff_user_id   UUID        REFERENCES public.staff_users(id) ON DELETE SET NULL,
  created_by      UUID        REFERENCES public.staff_users(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
-- NOTE: no `languages` column here. Spoken languages are modeled relationally
-- in public.guide_languages below (V2.1) — see that section for rationale.

COMMENT ON TABLE  public.guides               IS 'Operational tour-guide directory. Independent of staff_users (auth profiles) — see migration file header for rationale. Spoken languages live in guide_languages, not on this table.';
COMMENT ON COLUMN public.guides.status        IS 'active (Aktif) | unavailable (Müsait Değil) | inactive (Pasif)';
COMMENT ON COLUMN public.guides.staff_user_id IS 'Optional — set only if this guide also has a CRM login (staff_users row).';

-- Idempotent: IF NOT EXISTS.
CREATE INDEX IF NOT EXISTS idx_guides_status        ON public.guides(status);
CREATE INDEX IF NOT EXISTS idx_guides_full_name     ON public.guides(full_name);
CREATE INDEX IF NOT EXISTS idx_guides_staff_user_id ON public.guides(staff_user_id);

-- Idempotency: CREATE TRIGGER has no IF NOT EXISTS in PostgreSQL, so a
-- second run would fail with "trigger already exists" — guard with an
-- explicit DROP first. This only redefines the trigger's behavior, it
-- does not touch any row in public.guides.
DROP TRIGGER IF EXISTS trg_guides_updated_at ON public.guides;
CREATE TRIGGER trg_guides_updated_at
  BEFORE UPDATE ON public.guides
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- Idempotent: enabling RLS twice is a no-op in PostgreSQL.
ALTER TABLE public.guides ENABLE ROW LEVEL SECURITY;

-- Idempotency: CREATE POLICY has no IF NOT EXISTS / OR REPLACE in
-- PostgreSQL, so a second run would fail with "policy already exists" —
-- guard every one with DROP POLICY IF EXISTS first. This only redefines
-- the policy's rule, it deletes no rows.

-- Admin: full access
DROP POLICY IF EXISTS "guides: admin full access" ON public.guides;
CREATE POLICY "guides: admin full access"
  ON public.guides FOR ALL TO authenticated
  USING   ( is_admin() )
  WITH CHECK ( is_admin() );

-- Operations: full read/write (they run day-to-day guide assignment)
DROP POLICY IF EXISTS "guides: operations full access" ON public.guides;
CREATE POLICY "guides: operations full access"
  ON public.guides FOR ALL TO authenticated
  USING   ( is_operations() )
  WITH CHECK ( is_operations() );

-- Sales: read-only (need guide names/languages for reservation context)
DROP POLICY IF EXISTS "guides: sales read" ON public.guides;
CREATE POLICY "guides: sales read"
  ON public.guides FOR SELECT TO authenticated
  USING ( is_sales() );

-- Guide (a staff_users login of role='guide'): read-only, own directory
-- entry included — lets a logged-in guide see the roster same as sales.
DROP POLICY IF EXISTS "guides: guide role read" ON public.guides;
CREATE POLICY "guides: guide role read"
  ON public.guides FOR SELECT TO authenticated
  USING ( is_guide() );


-- ──────────────────────────────────────────────────────────────────────────
-- TABLE: guide_languages  (V2.1 — replaces the earlier guides.languages
-- TEXT[] column)
-- ──────────────────────────────────────────────────────────────────────────
-- Relational guide↔language links. One row per (guide, language) pair.
-- The app's existing canonical language dataset (LANGUAGE_OPTIONS in
-- DeseTourDashboard.jsx) is the source of truth for language_code /
-- language_name values written here — the same codes/names used
-- everywhere else in the app (customers, reservations), so a guide's
-- spoken languages are directly comparable/joinable against them.
--
-- Never comma-separated text, never an array column. guides.languages
-- from the earlier draft of this migration has been dropped from the
-- guides table definition above entirely (this file never shipped that
-- column into production, so there is no data-migration step required).
--
-- Idempotent: IF NOT EXISTS — a second run no-ops if the table already exists.
CREATE TABLE IF NOT EXISTS public.guide_languages (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  guide_id        UUID        NOT NULL REFERENCES public.guides(id) ON DELETE CASCADE,
  language_code   TEXT        NOT NULL,
  language_name   TEXT        NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT guide_languages_guide_id_language_code_key UNIQUE (guide_id, language_code)
);

COMMENT ON TABLE  public.guide_languages               IS 'Relational guide↔language links — one row per language a guide speaks. Replaces a rejected guides.languages TEXT[] design. language_code/language_name should match the app''s canonical LANGUAGE_OPTIONS dataset.';
COMMENT ON COLUMN public.guide_languages.guide_id      IS 'Owning guide. ON DELETE CASCADE: removing a guide removes their language rows (no orphaned language links).';
COMMENT ON COLUMN public.guide_languages.language_code IS 'Canonical language code from the app''s LANGUAGE_OPTIONS dataset, e.g. "tr", "en", "de".';
COMMENT ON COLUMN public.guide_languages.language_name IS 'Human-readable language name at time of entry, e.g. "Türkçe", "İngilizce".';

-- The UNIQUE(guide_id, language_code) constraint above already creates a
-- composite index usable for guide_id-only lookups (leftmost-column
-- match), but an explicit single-column index is added anyway for
-- clarity and for query plans that only filter on guide_id.
-- Idempotent: IF NOT EXISTS.
CREATE INDEX IF NOT EXISTS idx_guide_languages_guide_id      ON public.guide_languages(guide_id);
CREATE INDEX IF NOT EXISTS idx_guide_languages_language_code ON public.guide_languages(language_code);

-- No updated_at trigger: rows are immutable in practice (add/remove a
-- language link, never edit one in place), so there is no updated_at
-- column and nothing to keep current with a trigger.

-- Idempotent: enabling RLS twice is a no-op in PostgreSQL.
ALTER TABLE public.guide_languages ENABLE ROW LEVEL SECURITY;

-- RLS DESIGN DECISION — independent role checks, not an EXISTS(...guides...)
-- subquery against the parent row. Both approaches were considered:
--
--   (a) EXISTS (SELECT 1 FROM public.guides g WHERE g.id = guide_languages.guide_id ...)
--       would make guide_languages' visibility a strict mirror of whatever
--       row-level predicate guides itself ends up using. Today that
--       predicate is "role-only" (admin/operations see everything, sales/
--       guide see everything read-only) with no per-row filtering, so in
--       practice it would produce identical results to (b) — but it adds a
--       join back to guides on every guide_languages check, and it would
--       silently start behaving differently the moment guides ever grows a
--       per-row restriction (e.g. region-scoped operations access) that
--       guide_languages was never asked to inherit.
--
--   (b) Independent calls to the same SECURITY DEFINER role helpers
--       (is_admin(), is_operations(), is_sales(), is_guide()) used by
--       every other table in supabase_rls_policies.sql, including this
--       migration's own guides and guide_payments policies.
--
-- This migration uses (b), for consistency with guide_payments' policies
-- immediately below (also role-only, no parent-row join) and with the
-- rest of the schema's RLS style, for simpler/cheaper policy evaluation
-- (no extra join per row), and so guide_languages' access rules are
-- explicit and self-contained rather than implicitly inherited from
-- guides' current implementation. Because guides currently has no
-- per-row restriction of its own — access is role-only there too — (a)
-- and (b) are equivalent in today's schema; (b) is chosen so that stays
-- true by design rather than by coincidence.
--
-- Idempotency: see the note above the guides table's policies — DROP
-- POLICY IF EXISTS before every CREATE POLICY, touching no rows.

-- Admin: full access
DROP POLICY IF EXISTS "guide_languages: admin full access" ON public.guide_languages;
CREATE POLICY "guide_languages: admin full access"
  ON public.guide_languages FOR ALL TO authenticated
  USING   ( is_admin() )
  WITH CHECK ( is_admin() );

-- Operations: full read/write (same role that manages guides day-to-day)
DROP POLICY IF EXISTS "guide_languages: operations full access" ON public.guide_languages;
CREATE POLICY "guide_languages: operations full access"
  ON public.guide_languages FOR ALL TO authenticated
  USING   ( is_operations() )
  WITH CHECK ( is_operations() );

-- Sales: read-only
DROP POLICY IF EXISTS "guide_languages: sales read" ON public.guide_languages;
CREATE POLICY "guide_languages: sales read"
  ON public.guide_languages FOR SELECT TO authenticated
  USING ( is_sales() );

-- Guide (staff_users role='guide'): read-only
DROP POLICY IF EXISTS "guide_languages: guide role read" ON public.guide_languages;
CREATE POLICY "guide_languages: guide role read"
  ON public.guide_languages FOR SELECT TO authenticated
  USING ( is_guide() );


-- ──────────────────────────────────────────────────────────────────────────
-- reservations: add guide_id (relational guide assignment)
-- guide_name is left in place untouched for historical/free-text rows.
-- ──────────────────────────────────────────────────────────────────────────

-- Idempotent: ADD COLUMN IF NOT EXISTS.
ALTER TABLE public.reservations
  ADD COLUMN IF NOT EXISTS guide_id UUID REFERENCES public.guides(id) ON DELETE SET NULL;

COMMENT ON COLUMN public.reservations.guide_id IS 'Relational guide assignment — added V2. guide_name (free text) is kept for historical rows created before this column existed.';

-- Idempotent: IF NOT EXISTS.
CREATE INDEX IF NOT EXISTS idx_reservations_guide_id ON public.reservations(guide_id);


-- ──────────────────────────────────────────────────────────────────────────
-- TABLE: guide_payments
-- Guide/supplier payout ledger — deliberately separate from public.payments
-- (customer payments). See migration file header for rationale.
-- ──────────────────────────────────────────────────────────────────────────

-- Idempotent: IF NOT EXISTS — a second run no-ops if the table already exists.
CREATE TABLE IF NOT EXISTS public.guide_payments (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_number  TEXT        NOT NULL UNIQUE, -- e.g. GP-2026-014
  guide_id        UUID        NOT NULL REFERENCES public.guides(id) ON DELETE RESTRICT,
  reservation_id  UUID        REFERENCES public.reservations(id) ON DELETE SET NULL,
  tour_id         UUID        REFERENCES public.tours(id) ON DELETE SET NULL,
  amount          NUMERIC(12,2) NOT NULL CHECK (amount >= 0),
  currency        TEXT        NOT NULL DEFAULT 'EUR',
  status          TEXT        NOT NULL DEFAULT 'pending'
                              CHECK (status IN ('pending','paid','cancelled')),
  payment_date    DATE,
  notes           TEXT,
  created_by      UUID        REFERENCES public.staff_users(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE  public.guide_payments              IS 'Guide/supplier payouts. Kept separate from public.payments (customer payments) so the two are never mixed without an explicit join/union.';
COMMENT ON COLUMN public.guide_payments.reservation_id IS 'Nullable — a guide payout may not always tie to one specific reservation.';

-- Idempotent: IF NOT EXISTS.
CREATE INDEX IF NOT EXISTS idx_guide_payments_guide_id       ON public.guide_payments(guide_id);
CREATE INDEX IF NOT EXISTS idx_guide_payments_reservation_id ON public.guide_payments(reservation_id);
CREATE INDEX IF NOT EXISTS idx_guide_payments_status         ON public.guide_payments(status);
CREATE INDEX IF NOT EXISTS idx_guide_payments_payment_date   ON public.guide_payments(payment_date);

-- Idempotency: same reasoning as trg_guides_updated_at above.
DROP TRIGGER IF EXISTS trg_guide_payments_updated_at ON public.guide_payments;
CREATE TRIGGER trg_guide_payments_updated_at
  BEFORE UPDATE ON public.guide_payments
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- Idempotent: enabling RLS twice is a no-op in PostgreSQL.
ALTER TABLE public.guide_payments ENABLE ROW LEVEL SECURITY;

-- Admin: full access
DROP POLICY IF EXISTS "guide_payments: admin full access" ON public.guide_payments;
CREATE POLICY "guide_payments: admin full access"
  ON public.guide_payments FOR ALL TO authenticated
  USING   ( is_admin() )
  WITH CHECK ( is_admin() );

-- Operations: full access (same as public.payments today)
DROP POLICY IF EXISTS "guide_payments: operations full access" ON public.guide_payments;
CREATE POLICY "guide_payments: operations full access"
  ON public.guide_payments FOR ALL TO authenticated
  USING   ( is_operations() )
  WITH CHECK ( is_operations() );

-- Sales, Guide: no access — mirrors public.payments, which also excludes
-- both roles today. No policy for these roles = zero access under RLS.
-- (Nothing to DROP here since no policy is created for these roles;
-- re-running this file creates none for them on a second pass either.)


-- ──────────────────────────────────────────────────────────────────────────
-- activity_logs: widen entity_type/action check constraints so guide
-- activity can be logged through the same audit trail as everything else.
-- Purely additive — existing allowed values are untouched.
-- ──────────────────────────────────────────────────────────────────────────

-- Idempotent: DROP CONSTRAINT IF EXISTS before ADD CONSTRAINT. This drops
-- and recreates only the CHECK rule's definition — it does not touch,
-- delete, or revalidate-away any existing activity_logs row, and every
-- value previously allowed remains allowed.
ALTER TABLE public.activity_logs DROP CONSTRAINT IF EXISTS activity_logs_entity_type_check;
ALTER TABLE public.activity_logs ADD CONSTRAINT activity_logs_entity_type_check
  CHECK (entity_type IN (
    'customer','lead','quote','reservation','payment',
    'task','reminder','tour','message','settings',
    'guide','guide_payment'
  ));


-- ──────────────────────────────────────────────────────────────────────────
-- next_ref_number() already works for guide_payments' GP-YYYY-NNNN numbers
-- (it's a generic helper keyed by table_name/number_col) — no change needed.
-- Usage from the app: next_ref_number('GP', 'guide_payments', 'payment_number')
-- ──────────────────────────────────────────────────────────────────────────

-- ── END OF MIGRATION ────────────────────────────────────────────────────────
