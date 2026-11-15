-- ============================================================
-- DESE TOUR OPERATIONS CENTER
-- ROLLBACK: Monthly expenses (aylık harcamalar)
-- ============================================================
-- Reverses supabase_migration_finance_monthly_expenses.sql.
-- SAFETY: refuses to run while any expense row exists — review / remove
-- them deliberately first. The activity_logs CHECK keeps
-- 'finance_monthly_expense' if any log row uses it.
-- ============================================================

BEGIN;

DO $$
DECLARE v_rows INT := 0;
BEGIN
  IF to_regclass('public.finance_monthly_expenses') IS NOT NULL THEN
    SELECT COUNT(*) INTO v_rows FROM public.finance_monthly_expenses;
  END IF;
  IF v_rows > 0 THEN
    RAISE EXCEPTION 'MONTHLY EXPENSES ROLLBACK REFUSED: % expense row(s) exist. Review and remove them deliberately first.', v_rows;
  END IF;
END $$;

DROP TABLE IF EXISTS public.finance_monthly_expenses;

DO $$
DECLARE
  v_def  TEXT;
  v_live TEXT[];
  v_new  TEXT[];
BEGIN
  IF EXISTS (SELECT 1 FROM public.activity_logs WHERE entity_type = 'finance_monthly_expense') THEN
    RAISE NOTICE 'MONTHLY EXPENSES ROLLBACK: activity_logs rows use finance_monthly_expense — leaving the CHECK widened.';
    RETURN;
  END IF;
  SELECT pg_get_constraintdef(oid) INTO v_def FROM pg_constraint
   WHERE conrelid = 'public.activity_logs'::regclass AND conname = 'activity_logs_entity_type_check';
  IF v_def IS NULL THEN RETURN; END IF;
  SELECT array_agg(DISTINCT btrim(v, '" ')) INTO v_live
    FROM regexp_matches(v_def, '''([^'']+)''', 'g') AS m,
         LATERAL unnest(CASE WHEN m[1] LIKE '{%}' THEN string_to_array(btrim(m[1], '{}'), ',') ELSE ARRAY[m[1]] END) AS v;
  IF v_live IS NULL OR NOT ('finance_monthly_expense' = ANY (v_live)) THEN RETURN; END IF;
  SELECT array_agg(x) INTO v_new FROM unnest(v_live) AS x WHERE x <> 'finance_monthly_expense';
  ALTER TABLE public.activity_logs DROP CONSTRAINT activity_logs_entity_type_check;
  EXECUTE format('ALTER TABLE public.activity_logs ADD CONSTRAINT activity_logs_entity_type_check CHECK (entity_type IN (%s))',
                 (SELECT string_agg(quote_literal(x), ',' ORDER BY x) FROM unnest(v_new) AS x));
END $$;

COMMIT;
