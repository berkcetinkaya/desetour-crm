-- ============================================================
-- DESE TOUR OPERATIONS CENTER
-- Migration: Reservation extra sales (ek satışlar)
-- ============================================================
-- File:    supabase_migration_reservation_extra_sales.sql
-- Rollback: supabase_migration_reservation_extra_sales_ROLLBACK.sql
-- Depends: supabase_schema.sql (reservations, staff_users, activity_logs,
--          set_updated_at), supabase_rls_policies.sql (is_admin,
--          is_operations), supabase_migration_aal2_enforcement.sql
--          (is_aal2), supabase_migration_finance_center.sql — all applied.
-- Version: CRM 13.10 — NOT YET APPROVED FOR PRODUCTION.
--
-- WHAT THIS DOES
-- ─────────────────────────────────────────────────────────────
--   1. public.reservation_extra_sales — income from products / services
--      sold to a reservation's guests during the tour (free-text
--      description, amount, original currency, sale date). Each row
--      belongs to exactly one reservation, so tour, date and customer are
--      always known. Amounts stay in their original currency.
--   2. RLS mirroring public.reservation_expenses: admin and operations
--      full access, both requiring is_aal2(); sales and guide get nothing.
--   3. activity_logs entity_type CHECK widened by exactly ONE value
--      ('reservation_extra_sale'): the live list is read and kept as-is,
--      only the new value is added — nothing can ever be dropped.
--
-- WHAT THIS DOES NOT DO
-- ─────────────────────────────────────────────────────────────
--   • Does NOT touch reservations, payments, expenses or any other data.
--   • Does NOT freeze FX: the CRM converts with the latest ECB rate, like
--     every other expected-revenue figure.
-- ============================================================

BEGIN;

-- ──────────────────────────────────────────────────────────────────────────
-- PREFLIGHT
-- ──────────────────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF to_regclass('public.reservations') IS NULL OR to_regclass('public.staff_users') IS NULL
     OR to_regclass('public.activity_logs') IS NULL THEN
    RAISE EXCEPTION 'EXTRA SALES MIGRATION FAILED: reservations / staff_users / activity_logs missing.';
  END IF;
  IF to_regprocedure('public.is_admin()') IS NULL OR to_regprocedure('public.is_operations()') IS NULL
     OR to_regprocedure('public.is_aal2()') IS NULL OR to_regprocedure('public.set_updated_at()') IS NULL THEN
    RAISE EXCEPTION 'EXTRA SALES MIGRATION FAILED: is_admin / is_operations / is_aal2 / set_updated_at missing.';
  END IF;
END $$;

-- ──────────────────────────────────────────────────────────────────────────
-- TABLE
-- ──────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.reservation_extra_sales (
  id              UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  reservation_id  UUID          NOT NULL REFERENCES public.reservations(id) ON DELETE RESTRICT,
  description     TEXT          NOT NULL CHECK (length(btrim(description)) > 0),
  amount          NUMERIC(12,2) NOT NULL CHECK (amount > 0),
  currency        TEXT          NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  sale_date       DATE          NOT NULL,
  notes           TEXT          NOT NULL DEFAULT '',
  created_by      UUID          REFERENCES public.staff_users(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE public.reservation_extra_sales IS 'Income from products / services sold to a reservation''s guests during the tour (ek satış). Original currency kept; added to expected net income and projected profit by the CRM Finance layer.';

CREATE INDEX IF NOT EXISTS idx_reservation_extra_sales_reservation ON public.reservation_extra_sales(reservation_id);
CREATE INDEX IF NOT EXISTS idx_reservation_extra_sales_date ON public.reservation_extra_sales(sale_date);

DROP TRIGGER IF EXISTS trg_reservation_extra_sales_updated_at ON public.reservation_extra_sales;
CREATE TRIGGER trg_reservation_extra_sales_updated_at
  BEFORE UPDATE ON public.reservation_extra_sales
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ──────────────────────────────────────────────────────────────────────────
-- RLS — same as reservation_expenses
-- ──────────────────────────────────────────────────────────────────────────
ALTER TABLE public.reservation_extra_sales ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "reservation_extra_sales: admin full access" ON public.reservation_extra_sales;
CREATE POLICY "reservation_extra_sales: admin full access" ON public.reservation_extra_sales FOR ALL TO authenticated USING ( is_admin() AND is_aal2() ) WITH CHECK ( is_admin() AND is_aal2() );
DROP POLICY IF EXISTS "reservation_extra_sales: operations full access" ON public.reservation_extra_sales;
CREATE POLICY "reservation_extra_sales: operations full access" ON public.reservation_extra_sales FOR ALL TO authenticated USING ( is_operations() AND is_aal2() ) WITH CHECK ( is_operations() AND is_aal2() );

-- ──────────────────────────────────────────────────────────────────────────
-- activity_logs entity_type — add ONE value, keep every live value
-- ──────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  v_def  TEXT;
  v_live TEXT[];
  v_new  TEXT[];
BEGIN
  SELECT pg_get_constraintdef(oid) INTO v_def FROM pg_constraint
   WHERE conrelid = 'public.activity_logs'::regclass AND conname = 'activity_logs_entity_type_check';
  IF v_def IS NULL THEN
    RAISE NOTICE 'activity_logs_entity_type_check not present — nothing to widen.';
    RETURN;
  END IF;
  -- Handles both renderings: ARRAY['a'::text, ...] and '{a,b}'::text[].
  SELECT array_agg(DISTINCT btrim(v, '" ')) INTO v_live
    FROM regexp_matches(v_def, '''([^'']+)''', 'g') AS m,
         LATERAL unnest(CASE WHEN m[1] LIKE '{%}' THEN string_to_array(btrim(m[1], '{}'), ',') ELSE ARRAY[m[1]] END) AS v;
  IF v_live IS NULL OR array_length(v_live, 1) < 10 THEN
    RAISE EXCEPTION 'EXTRA SALES MIGRATION FAILED: could not read the live activity_logs entity types (%). Refusing to rebuild the CHECK.', v_def;
  END IF;
  IF 'reservation_extra_sale' = ANY (v_live) THEN
    RAISE NOTICE 'activity_logs already allows reservation_extra_sale.';
    RETURN;
  END IF;
  v_new := v_live || ARRAY['reservation_extra_sale'];
  ALTER TABLE public.activity_logs DROP CONSTRAINT activity_logs_entity_type_check;
  EXECUTE format('ALTER TABLE public.activity_logs ADD CONSTRAINT activity_logs_entity_type_check CHECK (entity_type IN (%s))',
                 (SELECT string_agg(quote_literal(x), ',' ORDER BY x) FROM unnest(v_new) AS x));
END $$;

-- ──────────────────────────────────────────────────────────────────────────
-- POSTFLIGHT
-- ──────────────────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_class WHERE oid = 'public.reservation_extra_sales'::regclass AND relrowsecurity) THEN
    RAISE EXCEPTION 'EXTRA SALES POSTFLIGHT FAILED: RLS not enabled on reservation_extra_sales.';
  END IF;
  IF (SELECT COUNT(*) FROM pg_policies WHERE schemaname = 'public' AND tablename = 'reservation_extra_sales') <> 2 THEN
    RAISE EXCEPTION 'EXTRA SALES POSTFLIGHT FAILED: expected exactly 2 policies on reservation_extra_sales.';
  END IF;
  RAISE NOTICE 'EXTRA SALES POSTFLIGHT PASSED: reservation_extra_sales created with RLS (admin + operations, aal2).';
END $$;

COMMIT;
