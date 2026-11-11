-- ============================================================
-- DESE TOUR OPERATIONS CENTER
-- ROLLBACK: Guide operation cost overrides
-- ============================================================
-- Reverses supabase_migration_guide_operation_cost_overrides.sql.
--
-- SAFETY: refuses to run while any override exists — removing them would
-- silently change those operations back to the standard cost. Review /
-- remove them deliberately first. The activity_logs CHECK keeps
-- 'guide_operation_cost' if any log row uses it; otherwise only that one
-- value is removed and every other live value is kept.
-- ============================================================

BEGIN;

DO $$
DECLARE v_rows INT := 0;
BEGIN
  IF to_regclass('public.guide_operation_cost_overrides') IS NOT NULL THEN
    SELECT COUNT(*) INTO v_rows FROM public.guide_operation_cost_overrides;
  END IF;
  IF v_rows > 0 THEN
    RAISE EXCEPTION 'GUIDE COST OVERRIDE ROLLBACK REFUSED: % override(s) exist. Review and remove them deliberately first.', v_rows;
  END IF;
END $$;

DROP TABLE IF EXISTS public.guide_operation_cost_overrides;

DO $$
DECLARE
  v_def  TEXT;
  v_live TEXT[];
  v_new  TEXT[];
BEGIN
  IF EXISTS (SELECT 1 FROM public.activity_logs WHERE entity_type = 'guide_operation_cost') THEN
    RAISE NOTICE 'GUIDE COST OVERRIDE ROLLBACK: activity_logs rows use guide_operation_cost — leaving the CHECK widened.';
    RETURN;
  END IF;
  SELECT pg_get_constraintdef(oid) INTO v_def FROM pg_constraint
   WHERE conrelid = 'public.activity_logs'::regclass AND conname = 'activity_logs_entity_type_check';
  IF v_def IS NULL THEN RETURN; END IF;
  SELECT array_agg(DISTINCT btrim(v, '" ')) INTO v_live
    FROM regexp_matches(v_def, '''([^'']+)''', 'g') AS m,
         LATERAL unnest(CASE WHEN m[1] LIKE '{%}' THEN string_to_array(btrim(m[1], '{}'), ',') ELSE ARRAY[m[1]] END) AS v;
  IF v_live IS NULL OR NOT ('guide_operation_cost' = ANY (v_live)) THEN RETURN; END IF;
  SELECT array_agg(x) INTO v_new FROM unnest(v_live) AS x WHERE x <> 'guide_operation_cost';
  ALTER TABLE public.activity_logs DROP CONSTRAINT activity_logs_entity_type_check;
  EXECUTE format('ALTER TABLE public.activity_logs ADD CONSTRAINT activity_logs_entity_type_check CHECK (entity_type IN (%s))',
                 (SELECT string_agg(quote_literal(x), ',' ORDER BY x) FROM unnest(v_new) AS x));
END $$;

COMMIT;
