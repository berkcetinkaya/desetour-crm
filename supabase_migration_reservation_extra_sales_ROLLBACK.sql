-- ============================================================
-- DESE TOUR OPERATIONS CENTER
-- ROLLBACK: Reservation extra sales (ek satışlar)
-- ============================================================
-- Reverses supabase_migration_reservation_extra_sales.sql.
--
-- SAFETY: refuses to run while reservation_extra_sales holds any row —
-- recorded sales income must never be destroyed by a rollback. Export /
-- remove them deliberately first. The activity_logs entity_type CHECK keeps
-- 'reservation_extra_sale' if any log row already uses it; otherwise only
-- that one value is removed and every other live value is kept.
-- ============================================================

BEGIN;

DO $$
DECLARE v_rows INT := 0;
BEGIN
  IF to_regclass('public.reservation_extra_sales') IS NOT NULL THEN
    SELECT COUNT(*) INTO v_rows FROM public.reservation_extra_sales;
  END IF;
  IF v_rows > 0 THEN
    RAISE EXCEPTION 'EXTRA SALES ROLLBACK REFUSED: reservation_extra_sales holds % row(s) of sales history. Export and remove them deliberately first.', v_rows;
  END IF;
END $$;

DROP TABLE IF EXISTS public.reservation_extra_sales;

DO $$
DECLARE
  v_def  TEXT;
  v_live TEXT[];
  v_new  TEXT[];
BEGIN
  IF EXISTS (SELECT 1 FROM public.activity_logs WHERE entity_type = 'reservation_extra_sale') THEN
    RAISE NOTICE 'EXTRA SALES ROLLBACK: activity_logs rows use reservation_extra_sale — leaving the CHECK widened.';
    RETURN;
  END IF;
  SELECT pg_get_constraintdef(oid) INTO v_def FROM pg_constraint
   WHERE conrelid = 'public.activity_logs'::regclass AND conname = 'activity_logs_entity_type_check';
  IF v_def IS NULL THEN RETURN; END IF;
  SELECT array_agg(DISTINCT btrim(v, '" ')) INTO v_live
    FROM regexp_matches(v_def, '''([^'']+)''', 'g') AS m,
         LATERAL unnest(CASE WHEN m[1] LIKE '{%}' THEN string_to_array(btrim(m[1], '{}'), ',') ELSE ARRAY[m[1]] END) AS v;
  IF v_live IS NULL OR NOT ('reservation_extra_sale' = ANY (v_live)) THEN RETURN; END IF;
  SELECT array_agg(x) INTO v_new FROM unnest(v_live) AS x WHERE x <> 'reservation_extra_sale';
  ALTER TABLE public.activity_logs DROP CONSTRAINT activity_logs_entity_type_check;
  EXECUTE format('ALTER TABLE public.activity_logs ADD CONSTRAINT activity_logs_entity_type_check CHECK (entity_type IN (%s))',
                 (SELECT string_agg(quote_literal(x), ',' ORDER BY x) FROM unnest(v_new) AS x));
END $$;

COMMIT;
