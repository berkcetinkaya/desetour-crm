-- ══════════════════════════════════════════════════════════════════════════
-- DESE TOUR OPERATIONS CENTER
-- next_ref_number ON CONFLICT arbiter ambiguity — regression test plan
-- ══════════════════════════════════════════════════════════════════════════
-- File: tests/civitatis/sql/next_ref_number_on_conflict_ambiguity_manual_tests.sql
-- STATUS: NOT executed as part of producing this file.
--
-- WHY THIS FILE EXISTS
-- ─────────────────────────────────────────────────────────────
-- The real production failure on booking A41629692's second controlled
-- write attempt ("there is no unique or exclusion constraint matching
-- the ON CONFLICT specification", SQLSTATE 42P10) was root-caused to
-- public.next_ref_number(...)'s own
-- "INSERT ... ON CONFLICT (prefix, table_name, year) DO UPDATE"
-- statement: its parameters are named prefix/table_name/number_col —
-- identical to two of public.ref_number_counters' own column names —
-- and the function's #variable_conflict use_variable pragma silently
-- resolved the bare prefix/table_name entries in that ON CONFLICT
-- arbiter's column list as the PL/pgSQL PARAMETERS, not the table
-- columns, so unique-index inference failed despite
-- ref_number_counters_pkey (a genuine, non-partial unique index over
-- exactly those three columns) existing all along. See
-- supabase_migration_ref_number_counters_v3_on_conflict_arbiter_fix.sql
-- for the full incident writeup and the fix
-- (ON CONFLICT ON CONSTRAINT ref_number_counters_pkey DO UPDATE).
--
-- PART A below is entirely self-contained — it creates and drops its
-- own throwaway table/functions, distinctly named so they can never
-- collide with or affect public.ref_number_counters or
-- public.next_ref_number. It requires nothing pre-applied and proves
-- the underlying PostgreSQL/PL/pgSQL semantics point in isolation, in
-- ANY PostgreSQL 12+ database. PART B tests the REAL, currently-applied
-- public.next_ref_number(...) and public.ref_number_counters directly,
-- wrapped in BEGIN/ROLLBACK so it leaves no trace either way.
-- ══════════════════════════════════════════════════════════════════════════


-- ══════════════════════════════════════════════════════════════════════════
-- PART A — isolated proof of the PostgreSQL/PL/pgSQL mechanism, using
-- throwaway objects. Distinctly named (_claude_repro_ prefix) so this
-- can never be confused with or affect any real table/function.
-- ══════════════════════════════════════════════════════════════════════════
DROP TABLE IF EXISTS _claude_repro_ref_number_counters CASCADE;
DROP FUNCTION IF EXISTS _claude_repro_next_ref_number_old(text, text, text);
DROP FUNCTION IF EXISTS _claude_repro_next_ref_number_fixed(text, text, text);

CREATE TABLE _claude_repro_ref_number_counters (
  prefix      TEXT    NOT NULL,
  table_name  TEXT    NOT NULL,
  year        TEXT    NOT NULL,
  last_value  INTEGER NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (prefix, table_name, year)
);

-- Byte-for-byte reproduction of the OLD (V1/V2-era, currently-live)
-- next_ref_number shape: same parameter names, same
-- #variable_conflict use_variable pragma, same bare-column-list
-- ON CONFLICT clause.
CREATE FUNCTION _claude_repro_next_ref_number_old(
  prefix      TEXT,
  table_name  TEXT,
  number_col  TEXT
) RETURNS TEXT
LANGUAGE plpgsql
AS $$
#variable_conflict use_variable
DECLARE
  year_str    TEXT := '2026';
  v_seed      INTEGER := 0;
  v_next_num  INTEGER;
BEGIN
  INSERT INTO _claude_repro_ref_number_counters (prefix, table_name, year, last_value, updated_at)
  VALUES (prefix, table_name, year_str, v_seed + 1, NOW())
  ON CONFLICT (prefix, table_name, year) DO UPDATE
    SET last_value = _claude_repro_ref_number_counters.last_value + 1,
        updated_at = NOW()
  RETURNING last_value INTO v_next_num;

  RETURN prefix || '-' || year_str || '-' || v_next_num::TEXT;
END;
$$;

DO $$
BEGIN
  PERFORM _claude_repro_next_ref_number_old('R', 'reservations', 'reservation_number');
  RAISE EXCEPTION 'PART A TEST 1: FAILED — expected SQLSTATE 42P10 from the old ambiguous ON CONFLICT clause, but no error was raised at all';
EXCEPTION
  WHEN OTHERS THEN
    IF SQLSTATE <> '42P10' THEN
      RAISE EXCEPTION 'PART A TEST 1: FAILED — expected SQLSTATE 42P10, got sqlstate=% message=%', SQLSTATE, SQLERRM;
    END IF;
    RAISE NOTICE 'PART A TEST 1: PASSED — reproduced SQLSTATE 42P10 ("%") from the old ambiguous ON CONFLICT (prefix, table_name, year) clause, despite the matching PRIMARY KEY existing', SQLERRM;
END $$;

-- The FIX: only the ON CONFLICT clause changes (ON CONSTRAINT by name);
-- parameter names and the pragma are UNCHANGED, proving the fix does
-- not require the parameter-rename alternative that would have broken
-- next_ref_number's five real JS callers (which bind by parameter name
-- via supabase.rpc('next_ref_number', {prefix, table_name, number_col})).
CREATE FUNCTION _claude_repro_next_ref_number_fixed(
  prefix      TEXT,
  table_name  TEXT,
  number_col  TEXT
) RETURNS TEXT
LANGUAGE plpgsql
AS $$
#variable_conflict use_variable
DECLARE
  year_str    TEXT := '2026';
  v_seed      INTEGER := 0;
  v_next_num  INTEGER;
BEGIN
  INSERT INTO _claude_repro_ref_number_counters (prefix, table_name, year, last_value, updated_at)
  VALUES (prefix, table_name, year_str, v_seed + 1, NOW())
  ON CONFLICT ON CONSTRAINT _claude_repro_ref_number_counters_pkey DO UPDATE
    SET last_value = _claude_repro_ref_number_counters.last_value + 1,
        updated_at = NOW()
  RETURNING last_value INTO v_next_num;

  RETURN prefix || '-' || year_str || '-' || v_next_num::TEXT;
END;
$$;

DO $$
DECLARE
  v_first  TEXT;
  v_second TEXT;
BEGIN
  -- First call exercises the plain INSERT path.
  v_first := _claude_repro_next_ref_number_fixed('R', 'reservations', 'reservation_number');
  IF v_first <> 'R-2026-1' THEN
    RAISE EXCEPTION 'PART A TEST 2: FAILED — expected R-2026-1 on first call, got %', v_first;
  END IF;
  -- Second call exercises the ON CONFLICT ... DO UPDATE increment path
  -- specifically — proving arbiter inference itself now succeeds, not
  -- merely that the INSERT half of the statement is reachable.
  v_second := _claude_repro_next_ref_number_fixed('R', 'reservations', 'reservation_number');
  IF v_second <> 'R-2026-2' THEN
    RAISE EXCEPTION 'PART A TEST 2: FAILED — expected R-2026-2 on second (ON CONFLICT DO UPDATE) call, got %', v_second;
  END IF;
  RAISE NOTICE 'PART A TEST 2: PASSED — ON CONFLICT ON CONSTRAINT ref_number_counters_pkey succeeds on both the INSERT and the DO UPDATE increment path, with the SAME parameter names and pragma the old, broken version used';
END $$;

DROP FUNCTION _claude_repro_next_ref_number_old(text, text, text);
DROP FUNCTION _claude_repro_next_ref_number_fixed(text, text, text);
DROP TABLE _claude_repro_ref_number_counters CASCADE;


-- ══════════════════════════════════════════════════════════════════════════
-- PART B — the REAL public.next_ref_number(...) and
-- public.ref_number_counters, wrapped in BEGIN/ROLLBACK so this leaves
-- no trace regardless of outcome. Run this BEFORE applying V3 to
-- confirm the live bug still reproduces exactly as diagnosed; run it
-- again AFTER applying V3 to confirm the fix.
-- ══════════════════════════════════════════════════════════════════════════
BEGIN;
DO $$
DECLARE
  v_result TEXT;
BEGIN
  v_result := public.next_ref_number('R', 'reservations', 'reservation_number');
  RAISE NOTICE 'PART B: public.next_ref_number SUCCEEDED (expected AFTER V3 is applied): %', v_result;
EXCEPTION
  WHEN OTHERS THEN
    IF SQLSTATE = '42P10' THEN
      RAISE NOTICE 'PART B: public.next_ref_number reproduced the LIVE bug (SQLSTATE 42P10) — expected BEFORE V3 is applied. Apply supabase_migration_ref_number_counters_v3_on_conflict_arbiter_fix.sql and re-run this block.';
    ELSE
      RAISE EXCEPTION 'PART B: UNEXPECTED FAILURE — sqlstate=% message=% (expected either success, post-V3, or SQLSTATE 42P10, pre-V3)', SQLSTATE, SQLERRM;
    END IF;
END $$;
ROLLBACK;  -- always rolls back: the counter increment (if the call
           -- succeeded) and everything else this block touched are
           -- both undone — this test never persists anything.

-- ── END OF MANUAL TEST PLAN ─────────────────────────────────────────────────
