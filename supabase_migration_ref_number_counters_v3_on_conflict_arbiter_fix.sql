-- ============================================================
-- DESE TOUR OPERATIONS CENTER
-- Migration: Reference Number Allocation — Fix the ON CONFLICT Arbiter's
--            PL/pgSQL Parameter/Column Name Collision
-- ============================================================
-- File:    supabase_migration_ref_number_counters_v3_on_conflict_arbiter_fix.sql
-- Depends: supabase_migration_ref_number_counters.sql (V1 — ALREADY
--          APPLIED TO PRODUCTION; creates public.ref_number_counters,
--          live-catalog-confirmed to have a genuine, non-partial unique
--          btree index ref_number_counters_pkey over exactly
--          (prefix, table_name, year); and the CURRENTLY-LIVE
--          public.next_ref_number(...) body this file replaces).
--
-- Version: V3 of the ref_number_counters migration lineage (there is no
--          V3 of the separate public.ingest_civitatis_booking migration
--          chain — that function's own SQL, V6 through V9, is NOT
--          touched by this file at all; next_ref_number is a dependency
--          ingest_civitatis_booking calls, not part of its own file).
--
-- *** SUPERSEDES AND RETRACTS
-- supabase_migration_ref_number_counters_v2_unique_constraint_guard.sql
-- ("V2"), WHICH HAS BEEN REMOVED FROM THIS REPOSITORY. V2 diagnosed the
-- real production failure as a missing unique index on
-- ref_number_counters and proposed adding CREATE UNIQUE INDEX IF NOT
-- EXISTS. Live Supabase catalog evidence
-- (SELECT indexname, indexdef FROM pg_indexes WHERE tablename =
-- 'ref_number_counters') PROVED that diagnosis wrong: the index
-- (ref_number_counters_pkey, a genuine non-partial unique btree index
-- over exactly prefix, table_name, year) has existed all along. V2 was
-- never applied, per explicit operator instruction, and must never be
-- applied — it would have added a harmless-but-useless redundant index
-- without fixing anything, since the real defect was never a missing
-- index at all. ***
--
-- WHY THIS MIGRATION EXISTS — THE PROVEN ROOT CAUSE
-- ─────────────────────────────────────────────────────────────
-- A V9 diagnostic-instrumentation retry against the real A41629692
-- booking conclusively identified the failing statement:
--   stage:    reference_number_allocation
--   sqlstate: 42P10
--   PG_EXCEPTION_CONTEXT:
--     SQL statement "INSERT INTO public.ref_number_counters (...)
--       ... ON CONFLICT (prefix, table_name, year) DO UPDATE ..."
--     PL/pgSQL function next_ref_number(text,text,text) line 63
--     SQL statement "SELECT public.next_ref_number('R','reservations','reservation_number')"
--     PL/pgSQL function ingest_civitatis_booking(...) line 387
-- This pinpoints the EXACT statement: next_ref_number(...)'s own
-- INSERT ... ON CONFLICT (prefix, table_name, year) DO UPDATE.
--
-- next_ref_number(...)'s parameters are named prefix, table_name,
-- number_col — IDENTICAL to three of public.ref_number_counters' own
-- column names (prefix, table_name — the function's number_col does
-- not collide with anything) — and the function body opens with the
-- pragma #variable_conflict use_variable, which tells PL/pgSQL: when a
-- bare identifier inside an embedded SQL command is ambiguous between a
-- declared PL/pgSQL variable (a parameter counts) and a table column of
-- the same name, silently prefer the VARIABLE. This pragma is genuinely
-- REQUIRED elsewhere in this same function (the seed lookup
-- "SELECT rnc.last_value ... WHERE rnc.prefix = prefix AND
-- rnc.table_name = table_name" NEEDS the bare right-hand prefix/
-- table_name to resolve to the parameters, not to the aliased rnc
-- columns — there is no other way to write "compare this column to the
-- parameter of the same name" without either this pragma or explicit
-- qualification of every single reference).
--
-- THE ONE PLACE this pragma became actively harmful is the ON CONFLICT
-- (prefix, table_name, year) arbiter's bare column-name list. This
-- migration's author's own working assumption — and V6/V7/V8/V9's own
-- comments referencing this file — was that a conflict_target column
-- list is a "plain column name reference", immune to PL/pgSQL's
-- expression-level variable substitution the same way e.g. an INSERT's
-- target column list is. THIS ASSUMPTION WAS WRONG, and was empirically
-- disproven (not merely reasoned about) using an isolated, disposable
-- local PostgreSQL 16 instance with a byte-for-byte reproduction of the
-- live table shape and function body:
--   • The exact live-shaped function (same parameter names, same
--     #variable_conflict use_variable pragma, same
--     ON CONFLICT (prefix, table_name, year) clause), run against a
--     table with the EXACT SAME PRIMARY KEY (prefix, table_name, year)
--     that live Supabase has — FAILED with
--     SQLSTATE 42P10: "there is no unique or exclusion constraint
--     matching the ON CONFLICT specification" — reproducing the real
--     production error exactly, on demand, despite the matching index
--     genuinely existing.
--   • The SAME reproduction with the pragma REMOVED (default
--     #variable_conflict error) instead failed differently, at
--     SQLSTATE 42702: "column reference \"prefix\" is ambiguous" —
--     confirming the ambiguity is real and would normally be caught
--     LOUDLY; #variable_conflict use_variable is specifically what
--     silenced it and caused it to resolve (incorrectly, for this one
--     clause) to the parameter instead of the column.
--   • The SAME reproduction with ONLY the ON CONFLICT clause changed to
--     ON CONFLICT ON CONSTRAINT ref_number_counters_pkey DO UPDATE
--     (parameter names and the pragma left completely untouched)
--     SUCCEEDED, on both the first (INSERT) call and a second
--     (ON CONFLICT DO UPDATE increment) call — proving this is both
--     necessary and sufficient.
-- See tests/civitatis/sql/next_ref_number_on_conflict_ambiguity_manual_
-- tests.sql for this exact reproduction, committed as a permanent
-- regression test (not executed as part of producing this migration).
--
-- MECHANISM, PRECISELY: unique-index arbiter inference for
-- ON CONFLICT (col1, col2, ...) requires every item in that list to
-- resolve to an actual COLUMN of the target relation, so Postgres can
-- match the full resolved column set against a candidate index's own
-- column set. Once #variable_conflict use_variable causes prefix and
-- table_name inside that list to resolve to the PL/pgSQL PARAMETER
-- VALUES ('R' and 'reservations', as scalar text values) rather than to
-- column references, the arbiter specification no longer names actual
-- columns for inference to match against at all — it is left holding a
-- mix of two substituted scalar parameters and one genuine column
-- reference (year, which collides with no variable — the local
-- variable is named year_str, not year). Inference then correctly
-- reports that NO existing index matches this (malformed) specification
-- — not because ref_number_counters_pkey doesn't exist, but because the
-- specification Postgres actually received no longer describes it.
--
-- THE FIX, AND WHY IT IS THE SAFEST OF THE OPTIONS CONSIDERED
-- ─────────────────────────────────────────────────────────────
-- Three structural fixes were evaluated:
--   1. Rename parameters (e.g. p_prefix/p_table_name/p_number_col) —
--      removes the ambiguity at its root and would let the pragma be
--      dropped entirely. REJECTED as the primary fix: PostgREST's RPC
--      calling convention binds a supabase.rpc(fnName, argsObject)
--      call's JSON keys to the target function's PARAMETER NAMES, not
--      positionally. Every one of next_ref_number's five real callers
--      — SupabaseLeadRepo.create, SupabaseReservationRepo.create,
--      SupabasePaymentRepo.create, SupabaseGuidePaymentRepo.create, and
--      the quotes repo's create (all in DeseTourDashboard.jsx, compiled
--      to app.js) — calls
--      sb.rpc('next_ref_number', {prefix:..., table_name:...,
--      number_col:...}) with these EXACT three key names. Renaming the
--      SQL parameters would silently break EVERY ONE of these five
--      call sites (PostgREST would report the function does not exist
--      for that argument shape) unless all five were also updated in
--      lockstep — a much larger, riskier, multi-file change for an
--      equivalent result.
--   2. Remove #variable_conflict use_variable entirely — REJECTED: this
--      pragma is genuinely required by the SAME function's seed-lookup
--      SELECT (rnc.prefix = prefix / rnc.table_name = table_name);
--      removing it would turn THAT statement into a hard "ambiguous
--      column reference" error (SQLSTATE 42702, empirically confirmed
--      above) on every very-first call for a new (prefix, table_name,
--      year) key, which is worse, not better — trading one bug for
--      another, in a well-established, load-bearing statement.
--   3. ON CONFLICT ON CONSTRAINT ref_number_counters_pkey DO UPDATE —
--      ADOPTED. Targets the exact, already-existing PRIMARY KEY
--      constraint BY NAME, which sidesteps the bare-column-list
--      ambiguity entirely (there is no PL/pgSQL variable that could
--      ever collide with a CONSTRAINT name). Touches nothing else:
--      same parameter names, same pragma (still correctly needed
--      elsewhere), same table, same PRIMARY KEY, same DO UPDATE SET
--      clause, same RETURNING clause, same return format, same
--      SECURITY DEFINER / search_path=public / EXECUTE-grant posture
--      (unchanged from V1 — next_ref_number's own EXECUTE grant was
--      never restricted, by design, so it remains callable exactly as
--      today by every existing caller, browser sessions included).
--      This is the smallest possible change that removes the ambiguity
--      structurally rather than adding another (redundant) index, and
--      is the ONLY one of the three options with zero impact on any
--      existing caller.
--
-- Relies on ref_number_counters_pkey being the constraint's actual
-- live name — confirmed directly from the operator's own live query
-- (CREATE UNIQUE INDEX ref_number_counters_pkey ON
-- public.ref_number_counters USING btree (prefix, table_name, year)),
-- and consistent with PostgreSQL's default naming for an inline
-- PRIMARY KEY (prefix, table_name, year) declared exactly as V1's
-- CREATE TABLE statement does (no explicit CONSTRAINT name given,
-- so PostgreSQL names it <table>_pkey).
--
-- STATUS: NOT executed against any database as part of producing this
-- file. Safe to apply directly over the currently-live V1 function —
-- CREATE OR REPLACE FUNCTION with the identical signature. No table,
-- column, index, or constraint is created, altered, or dropped by this
-- migration; ref_number_counters itself is completely untouched.
--
-- HOW TO APPLY (once reviewed and approved — NOT done as part of
-- producing this file)
-- ─────────────────────────────────────────────────────────────
-- Supabase Dashboard → SQL Editor → paste and run this file. Safe to
-- re-run any number of times — CREATE OR REPLACE FUNCTION is
-- idempotent, and the function signature is byte-for-byte identical to
-- what is already live, so every existing caller (the five JS call
-- sites, and ingest_civitatis_booking's own CREATE-branch call)
-- continues working with zero changes required anywhere else in this
-- repository.
-- ============================================================


-- ──────────────────────────────────────────────────────────────────────────
-- FUNCTION: next_ref_number (ON CONFLICT arbiter changed from a bare
-- column list to ON CONSTRAINT — everything else byte-for-byte
-- identical to the already-applied V1 body)
-- ──────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.next_ref_number(
  prefix      TEXT,
  table_name  TEXT,
  number_col  TEXT
) RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
#variable_conflict use_variable
DECLARE
  -- Unchanged from V1 — this pragma is still genuinely required by the
  -- seed-lookup SELECT below (rnc.prefix = prefix / rnc.table_name =
  -- table_name); it was never the problem by itself — see this
  -- migration's header for the full proof of exactly which ONE clause
  -- it broke, and why removing it entirely would trade one bug for a
  -- worse one.
  year_str    TEXT := TO_CHAR(NOW(), 'YYYY');
  pattern     TEXT;
  v_seed      INTEGER := 0;
  v_existing  INTEGER;
  v_next_num  INTEGER;
BEGIN
  IF (prefix, table_name, number_col) NOT IN (
    ('R',    'reservations',    'reservation_number'),
    ('LEAD', 'leads',           'lead_number'),
    ('PAY',  'payments',        'payment_number'),
    ('GP',   'guide_payments',  'payment_number'),
    ('Q',    'quotes',          'quote_number')
  ) THEN
    RAISE EXCEPTION 'next_ref_number: unrecognized prefix/table_name/number_col combination: %/%/%',
      prefix, table_name, number_col;
  END IF;

  SELECT rnc.last_value INTO v_existing
    FROM public.ref_number_counters rnc
   WHERE rnc.prefix = prefix
     AND rnc.table_name = table_name
     AND rnc.year = year_str;

  IF v_existing IS NULL THEN
    pattern := prefix || '-' || year_str || '-%';
    EXECUTE format(
      'SELECT COALESCE(MAX(CAST(SPLIT_PART(%I, ''-'', 3) AS INTEGER)), 0) FROM %I WHERE %I LIKE %L',
      number_col, table_name, number_col, pattern
    ) INTO v_seed;
  END IF;

  -- V3 FIX: ON CONFLICT ON CONSTRAINT ref_number_counters_pkey DO UPDATE
  -- — was ON CONFLICT (prefix, table_name, year) DO UPDATE, which
  -- #variable_conflict use_variable silently resolved as the two
  -- PL/pgSQL PARAMETERS prefix/table_name (not the identically-named
  -- table columns), leaving Postgres unable to infer ANY matching
  -- index for the arbiter — see this migration's header for the full,
  -- empirically-proven mechanism. Naming the constraint directly
  -- sidesteps the ambiguity entirely: there is no PL/pgSQL variable
  -- that could ever collide with a CONSTRAINT name. Every other line
  -- of this statement — the INSERT target/columns/VALUES, the DO
  -- UPDATE SET clause, RETURNING — is unchanged from V1.
  INSERT INTO public.ref_number_counters (prefix, table_name, year, last_value, updated_at)
  VALUES (prefix, table_name, year_str, v_seed + 1, NOW())
  ON CONFLICT ON CONSTRAINT ref_number_counters_pkey DO UPDATE
    SET last_value = ref_number_counters.last_value + 1,
        updated_at = NOW()
  RETURNING last_value INTO v_next_num;

  RETURN prefix || '-' || year_str || '-' || LPAD(v_next_num::TEXT, 4, '0');
END;
$$;

COMMENT ON FUNCTION public.next_ref_number IS
  'Generates sequential human-readable IDs like LEAD-2026-0042, backed '
  'by an atomically-incremented counter table (public.ref_number_'
  'counters). Allocates via INSERT ... ON CONFLICT ON CONSTRAINT '
  'ref_number_counters_pkey DO UPDATE (V3) — targets the PRIMARY KEY by '
  'NAME rather than by a bare (prefix, table_name, year) column list, '
  'because #variable_conflict use_variable (required elsewhere in this '
  'function) silently resolved that bare list''s prefix/table_name '
  'entries as this function''s own PARAMETERS rather than the '
  'identically-named table columns, making unique-index arbiter '
  'inference fail with SQLSTATE 42P10 despite the matching index '
  'genuinely existing (V1/V2 both predate this fix; V2 misdiagnosed the '
  'failure as a missing index and must not be applied — see this '
  'migration file''s header for the full, empirically-proven root '
  'cause). First call for a given (prefix, table_name, year) seeds from '
  'the highest existing valid reference already in the target table, '
  'never from 0. Restricted to the same five known prefix/table_name/'
  'number_col combinations the application has always used: '
  'R/reservations/reservation_number, LEAD/leads/lead_number, '
  'PAY/payments/payment_number, GP/guide_payments/payment_number, '
  'Q/quotes/quote_number. SECURITY DEFINER so it can read/write the '
  'internal, locked-down ref_number_counters table regardless of the '
  'calling role''s own privileges; its own EXECUTE grant is unchanged '
  'from V1, so every existing call site (five JS RPC call sites using '
  'named parameters prefix/table_name/number_col, plus '
  'ingest_civitatis_booking''s own CREATE-branch call) keeps working '
  'with zero changes required. Same 3-argument signature (prefix, '
  'table_name, number_col) and TEXT return format as always.';


-- ──────────────────────────────────────────────────────────────────────────
-- VERIFICATION QUERIES (for manual review after applying — not executed
-- as part of producing this file)
-- ──────────────────────────────────────────────────────────────────────────

/*
-- 1. Confirm the new function body actually uses ON CONFLICT ON
--    CONSTRAINT (not the old bare column list):
SELECT pg_get_functiondef(p.oid)
FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public' AND p.proname = 'next_ref_number';
-- Expect to see: ON CONFLICT ON CONSTRAINT ref_number_counters_pkey DO UPDATE

-- 2. Spot-check allocation now actually completes (only run this AFTER
--    confirming you are comfortable allocating one real reference
--    number — it durably increments the counter, per this function's
--    own documented, accepted "gaps are harmless" contract):
-- SELECT public.next_ref_number('R', 'reservations', 'reservation_number');

-- 3. Confirm SECURITY DEFINER / search_path / signature are unchanged:
SELECT proname, prosecdef, proconfig, pg_get_function_identity_arguments(oid)
FROM pg_proc WHERE proname = 'next_ref_number';
-- Expect prosecdef = true, proconfig containing 'search_path=public',
-- identity arguments unchanged: prefix text, table_name text, number_col text.
*/

-- ── END OF MIGRATION ────────────────────────────────────────────────────────
