-- ============================================================
-- DESE TOUR OPERATIONS CENTER
-- Migration: Monthly expenses (aylık harcamalar)
-- ============================================================
-- File:    supabase_migration_finance_monthly_expenses.sql
-- Rollback: supabase_migration_finance_monthly_expenses_ROLLBACK.sql
-- Depends: supabase_schema.sql (staff_users, activity_logs, set_updated_at),
--          supabase_rls_policies.sql (is_admin, is_operations),
--          supabase_migration_aal2_enforcement.sql (is_aal2) — all applied.
--
-- OWNER REQUEST (2026-11-15): business expenses that belong to a MONTH and
-- not to a reservation — e.g. Meta ads ₺10.000, Higgsfield ₺5.000 — typed
-- in by hand at month end for any month. They are shown in Finance and in
-- the monthly report, and reduce that month's profit.
--
-- WHAT THIS DOES
--   1. public.finance_monthly_expenses: month (first day of the month),
--      free-text name, positive amount in its original currency, note.
--   2. RLS: admin and operations full access, both requiring is_aal2().
--   3. activity_logs entity_type CHECK widened by exactly ONE value
--      ('finance_monthly_expense'); every live value is kept.
--
-- WHAT THIS DOES NOT DO
--   • Does NOT touch reservations, payments or any other table's data.
-- ============================================================

BEGIN;

DO $$
BEGIN
  IF to_regclass('public.staff_users') IS NULL OR to_regclass('public.activity_logs') IS NULL THEN
    RAISE EXCEPTION 'MONTHLY EXPENSES MIGRATION FAILED: staff_users / activity_logs missing.';
  END IF;
  IF to_regprocedure('public.is_admin()') IS NULL OR to_regprocedure('public.is_operations()') IS NULL
     OR to_regprocedure('public.is_aal2()') IS NULL OR to_regprocedure('public.set_updated_at()') IS NULL THEN
    RAISE EXCEPTION 'MONTHLY EXPENSES MIGRATION FAILED: is_admin / is_operations / is_aal2 / set_updated_at missing.';
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS public.finance_monthly_expenses (
  id          UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  month       DATE          NOT NULL CHECK (EXTRACT(DAY FROM month) = 1),
  label       TEXT          NOT NULL CHECK (length(btrim(label)) > 0),
  amount      NUMERIC(12,2) NOT NULL CHECK (amount > 0),
  currency    TEXT          NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  notes       TEXT          NOT NULL DEFAULT '',
  created_by  UUID          REFERENCES public.staff_users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE public.finance_monthly_expenses IS 'Business expenses of a month that belong to no reservation (e.g. Meta ads, Higgsfield). Original currency kept; subtracted from that month''s profit by the CRM Finance layer.';

CREATE INDEX IF NOT EXISTS idx_finance_monthly_expenses_month ON public.finance_monthly_expenses(month);

DROP TRIGGER IF EXISTS trg_finance_monthly_expenses_updated_at ON public.finance_monthly_expenses;
CREATE TRIGGER trg_finance_monthly_expenses_updated_at
  BEFORE UPDATE ON public.finance_monthly_expenses
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.finance_monthly_expenses ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "finance_monthly_expenses: admin full access" ON public.finance_monthly_expenses;
CREATE POLICY "finance_monthly_expenses: admin full access" ON public.finance_monthly_expenses FOR ALL TO authenticated USING ( is_admin() AND is_aal2() ) WITH CHECK ( is_admin() AND is_aal2() );
DROP POLICY IF EXISTS "finance_monthly_expenses: operations full access" ON public.finance_monthly_expenses;
CREATE POLICY "finance_monthly_expenses: operations full access" ON public.finance_monthly_expenses FOR ALL TO authenticated USING ( is_operations() AND is_aal2() ) WITH CHECK ( is_operations() AND is_aal2() );

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
  SELECT array_agg(DISTINCT btrim(v, '" ')) INTO v_live
    FROM regexp_matches(v_def, '''([^'']+)''', 'g') AS m,
         LATERAL unnest(CASE WHEN m[1] LIKE '{%}' THEN string_to_array(btrim(m[1], '{}'), ',') ELSE ARRAY[m[1]] END) AS v;
  IF v_live IS NULL OR array_length(v_live, 1) < 10 THEN
    RAISE EXCEPTION 'MONTHLY EXPENSES MIGRATION FAILED: could not read the live activity_logs entity types (%). Refusing to rebuild the CHECK.', v_def;
  END IF;
  IF 'finance_monthly_expense' = ANY (v_live) THEN
    RAISE NOTICE 'activity_logs already allows finance_monthly_expense.';
    RETURN;
  END IF;
  v_new := v_live || ARRAY['finance_monthly_expense'];
  ALTER TABLE public.activity_logs DROP CONSTRAINT activity_logs_entity_type_check;
  EXECUTE format('ALTER TABLE public.activity_logs ADD CONSTRAINT activity_logs_entity_type_check CHECK (entity_type IN (%s))',
                 (SELECT string_agg(quote_literal(x), ',' ORDER BY x) FROM unnest(v_new) AS x));
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_class WHERE oid = 'public.finance_monthly_expenses'::regclass AND relrowsecurity) THEN
    RAISE EXCEPTION 'MONTHLY EXPENSES POSTFLIGHT FAILED: RLS not enabled.';
  END IF;
  IF (SELECT COUNT(*) FROM pg_policies WHERE schemaname = 'public' AND tablename = 'finance_monthly_expenses') <> 2 THEN
    RAISE EXCEPTION 'MONTHLY EXPENSES POSTFLIGHT FAILED: expected exactly 2 policies.';
  END IF;
  RAISE NOTICE 'MONTHLY EXPENSES POSTFLIGHT PASSED: finance_monthly_expenses created with RLS (admin + operations, aal2).';
END $$;

COMMIT;
