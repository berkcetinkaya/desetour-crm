-- ============================================================
-- DESE TOUR OPERATIONS CENTER
-- Migration: Guide Management (Rehberlerimiz)
-- ============================================================
-- File:    supabase_migration_guides.sql
-- Depends: supabase_schema.sql, supabase_rls_policies.sql (already applied)
-- Version: V2 — September 2026
--
-- WHAT THIS ADDS
-- ─────────────────────────────────────────────────────────────
--   1. public.guides           — operational guide directory
--   2. reservations.guide_id   — relational guide assignment
--   3. public.guide_payments   — guide/supplier payout ledger,
--                                 kept separate from public.payments
--                                 (customer payments)
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
--   • No DROP, no destructive rewrite, no data migration of any
--     existing rows.
--   • RLS is enabled on both new tables with policies mirroring
--     the existing role model in supabase_rls_policies.sql, so
--     they aren't left open to every authenticated user by
--     omission.
--
-- HOW TO APPLY
-- ─────────────────────────────────────────────────────────────
-- Supabase Dashboard → SQL Editor → paste and run this file.
-- Run AFTER supabase_schema.sql and supabase_rls_policies.sql.
-- Safe to re-run (IF NOT EXISTS / idempotent throughout).
-- ============================================================


-- ──────────────────────────────────────────────────────────────────────────
-- TABLE: guides
-- Operational guide directory — the "Rehberlerimiz" module.
-- ──────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.guides (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  full_name       TEXT        NOT NULL,
  phone           TEXT,
  email           TEXT,
  nationality     TEXT,
  languages       TEXT[]      NOT NULL DEFAULT '{}',
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

COMMENT ON TABLE  public.guides               IS 'Operational tour-guide directory. Independent of staff_users (auth profiles) — see migration file header for rationale.';
COMMENT ON COLUMN public.guides.status        IS 'active (Aktif) | unavailable (Müsait Değil) | inactive (Pasif)';
COMMENT ON COLUMN public.guides.languages     IS 'Array of spoken languages, e.g. {Türkçe,İngilizce,Almanca}.';
COMMENT ON COLUMN public.guides.staff_user_id IS 'Optional — set only if this guide also has a CRM login (staff_users row).';

CREATE INDEX IF NOT EXISTS idx_guides_status      ON public.guides(status);
CREATE INDEX IF NOT EXISTS idx_guides_full_name   ON public.guides(full_name);
CREATE INDEX IF NOT EXISTS idx_guides_languages   ON public.guides USING GIN (languages);
CREATE INDEX IF NOT EXISTS idx_guides_staff_user_id ON public.guides(staff_user_id);

CREATE TRIGGER trg_guides_updated_at
  BEFORE UPDATE ON public.guides
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.guides ENABLE ROW LEVEL SECURITY;

-- Admin: full access
CREATE POLICY "guides: admin full access"
  ON public.guides FOR ALL TO authenticated
  USING   ( is_admin() )
  WITH CHECK ( is_admin() );

-- Operations: full read/write (they run day-to-day guide assignment)
CREATE POLICY "guides: operations full access"
  ON public.guides FOR ALL TO authenticated
  USING   ( is_operations() )
  WITH CHECK ( is_operations() );

-- Sales: read-only (need guide names/languages for reservation context)
CREATE POLICY "guides: sales read"
  ON public.guides FOR SELECT TO authenticated
  USING ( is_sales() );

-- Guide (a staff_users login of role='guide'): read-only, own directory
-- entry included — lets a logged-in guide see the roster same as sales.
CREATE POLICY "guides: guide role read"
  ON public.guides FOR SELECT TO authenticated
  USING ( is_guide() );


-- ──────────────────────────────────────────────────────────────────────────
-- reservations: add guide_id (relational guide assignment)
-- guide_name is left in place untouched for historical/free-text rows.
-- ──────────────────────────────────────────────────────────────────────────

ALTER TABLE public.reservations
  ADD COLUMN IF NOT EXISTS guide_id UUID REFERENCES public.guides(id) ON DELETE SET NULL;

COMMENT ON COLUMN public.reservations.guide_id IS 'Relational guide assignment — added V2. guide_name (free text) is kept for historical rows created before this column existed.';

CREATE INDEX IF NOT EXISTS idx_reservations_guide_id ON public.reservations(guide_id);


-- ──────────────────────────────────────────────────────────────────────────
-- TABLE: guide_payments
-- Guide/supplier payout ledger — deliberately separate from public.payments
-- (customer payments). See migration file header for rationale.
-- ──────────────────────────────────────────────────────────────────────────

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

CREATE INDEX IF NOT EXISTS idx_guide_payments_guide_id       ON public.guide_payments(guide_id);
CREATE INDEX IF NOT EXISTS idx_guide_payments_reservation_id ON public.guide_payments(reservation_id);
CREATE INDEX IF NOT EXISTS idx_guide_payments_status         ON public.guide_payments(status);
CREATE INDEX IF NOT EXISTS idx_guide_payments_payment_date   ON public.guide_payments(payment_date);

CREATE TRIGGER trg_guide_payments_updated_at
  BEFORE UPDATE ON public.guide_payments
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.guide_payments ENABLE ROW LEVEL SECURITY;

-- Admin: full access
CREATE POLICY "guide_payments: admin full access"
  ON public.guide_payments FOR ALL TO authenticated
  USING   ( is_admin() )
  WITH CHECK ( is_admin() );

-- Operations: full access (same as public.payments today)
CREATE POLICY "guide_payments: operations full access"
  ON public.guide_payments FOR ALL TO authenticated
  USING   ( is_operations() )
  WITH CHECK ( is_operations() );

-- Sales, Guide: no access — mirrors public.payments, which also excludes
-- both roles today. No policy for these roles = zero access under RLS.


-- ──────────────────────────────────────────────────────────────────────────
-- activity_logs: widen entity_type/action check constraints so guide
-- activity can be logged through the same audit trail as everything else.
-- Purely additive — existing allowed values are untouched.
-- ──────────────────────────────────────────────────────────────────────────

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
