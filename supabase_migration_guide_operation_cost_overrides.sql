-- ============================================================
-- DESE TOUR OPERATIONS CENTER
-- Migration: Guide operation cost overrides
-- ============================================================
-- File:    supabase_migration_guide_operation_cost_overrides.sql
-- Rollback: supabase_migration_guide_operation_cost_overrides_ROLLBACK.sql
-- Depends: supabase_schema.sql (reservations, tours, staff_users,
--          activity_logs, set_updated_at), supabase_rls_policies.sql
--          (is_admin, is_operations), supabase_migration_aal2_enforcement.sql
--          (is_aal2) — all applied. Independent of the extra-sales migration.
-- Version: CRM 13.11 — NOT YET APPROVED FOR PRODUCTION.
--
-- WHAT THIS DOES
-- ─────────────────────────────────────────────────────────────
--   1. public.guide_operation_cost_overrides — an optional, per-OPERATION
--      replacement for the standard guide operation cost (€150). An
--      operation is one tour date + tour + normalized booking language
--      (or one unresolved reservation); its key is computed by the CRM and
--      stored in operation_key (UNIQUE: one override per operation). No row
--      = the standard cost. amount may be 0 (no guide cost for that
--      operation). The reservation it was set from is kept for context.
--   2. RLS: admin and operations full access, both requiring is_aal2();
--      sales and guide get nothing (same as reservation_expenses).
--   3. activity_logs entity_type CHECK: keeps every live value and adds
--      only 'guide_operation_cost'.
--
-- WHAT THIS DOES NOT DO
-- ─────────────────────────────────────────────────────────────
--   • Does NOT change any reservation, guide payment or expense.
--   • Does NOT change the standard cost itself (that stays in the CRM).
-- ============================================================

BEGIN;

DO $$
BEGIN
  IF to_regclass('public.reservations') IS NULL OR to_regclass('public.tours') IS NULL
     OR to_regclass('public.staff_users') IS NULL OR to_regclass('public.activity_logs') IS NULL THEN
    RAISE EXCEPTION 'GUIDE COST OVERRIDE MIGRATION FAILED: reservations / tours / staff_users / activity_logs missing.';
  END IF;
  IF to_regprocedure('public.is_admin()') IS NULL OR to_regprocedure('public.is_operations()') IS NULL
     OR to_regprocedure('public.is_aal2()') IS NULL OR to_regprocedure('public.set_updated_at()') IS NULL THEN
    RAISE EXCEPTION 'GUIDE COST OVERRIDE MIGRATION FAILED: is_admin / is_operations / is_aal2 / set_updated_at missing.';
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS public.guide_operation_cost_overrides (
  id              UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  operation_key   TEXT          NOT NULL UNIQUE CHECK (length(btrim(operation_key)) > 0),
  tour_date       DATE          NOT NULL,
  tour_id         UUID          REFERENCES public.tours(id) ON DELETE SET NULL,
  language        TEXT,
  reservation_id  UUID          REFERENCES public.reservations(id) ON DELETE SET NULL,
  amount          NUMERIC(12,2) NOT NULL CHECK (amount >= 0),
  currency        TEXT          NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  reason          TEXT          NOT NULL DEFAULT '',
  created_by      UUID          REFERENCES public.staff_users(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE public.guide_operation_cost_overrides IS 'Optional per-operation replacement of the standard guide operation cost. One row per operation_key (tour date | tour id | normalized language, or unresolved:<reservation id>). No row = standard cost.';

CREATE INDEX IF NOT EXISTS idx_guide_operation_cost_overrides_date ON public.guide_operation_cost_overrides(tour_date);

DROP TRIGGER IF EXISTS trg_guide_operation_cost_overrides_updated_at ON public.guide_operation_cost_overrides;
CREATE TRIGGER trg_guide_operation_cost_overrides_updated_at
  BEFORE UPDATE ON public.guide_operation_cost_overrides
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.guide_operation_cost_overrides ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "guide_operation_cost_overrides: admin full access" ON public.guide_operation_cost_overrides;
CREATE POLICY "guide_operation_cost_overrides: admin full access" ON public.guide_operation_cost_overrides FOR ALL TO authenticated USING ( is_admin() AND is_aal2() ) WITH CHECK ( is_admin() AND is_aal2() );
DROP POLICY IF EXISTS "guide_operation_cost_overrides: operations full access" ON public.guide_operation_cost_overrides;
CREATE POLICY "guide_operation_cost_overrides: operations full access" ON public.guide_operation_cost_overrides FOR ALL TO authenticated USING ( is_operations() AND is_aal2() ) WITH CHECK ( is_operations() AND is_aal2() );

-- activity_logs entity_type — add ONE value, keep every live value
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
    RAISE EXCEPTION 'GUIDE COST OVERRIDE MIGRATION FAILED: could not read the live activity_logs entity types (%). Refusing to rebuild the CHECK.', v_def;
  END IF;
  IF 'guide_operation_cost' = ANY (v_live) THEN
    RAISE NOTICE 'activity_logs already allows guide_operation_cost.';
    RETURN;
  END IF;
  v_new := v_live || ARRAY['guide_operation_cost'];
  ALTER TABLE public.activity_logs DROP CONSTRAINT activity_logs_entity_type_check;
  EXECUTE format('ALTER TABLE public.activity_logs ADD CONSTRAINT activity_logs_entity_type_check CHECK (entity_type IN (%s))',
                 (SELECT string_agg(quote_literal(x), ',' ORDER BY x) FROM unnest(v_new) AS x));
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_class WHERE oid = 'public.guide_operation_cost_overrides'::regclass AND relrowsecurity) THEN
    RAISE EXCEPTION 'GUIDE COST OVERRIDE POSTFLIGHT FAILED: RLS not enabled.';
  END IF;
  IF (SELECT COUNT(*) FROM pg_policies WHERE schemaname = 'public' AND tablename = 'guide_operation_cost_overrides') <> 2 THEN
    RAISE EXCEPTION 'GUIDE COST OVERRIDE POSTFLIGHT FAILED: expected exactly 2 policies.';
  END IF;
  RAISE NOTICE 'GUIDE COST OVERRIDE POSTFLIGHT PASSED: guide_operation_cost_overrides created with RLS (admin + operations, aal2).';
END $$;

COMMIT;
