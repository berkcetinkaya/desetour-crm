-- ============================================================
-- DESE TOUR OPERATIONS CENTER
-- Migration: Concurrency-Safe Reference Number Allocation
-- ============================================================
-- File:    supabase_migration_ref_number_counters.sql
-- Depends: supabase_schema.sql (public.next_ref_number(...) already
--          exists there and is already applied to production; this
--          migration only CREATE OR REPLACEs its body, plus adds one
--          new supporting table) — already applied to production.
-- Status:  NOT executed as part of producing this file. New migration,
--          not yet applied anywhere. Safe to re-run in full (every
--          statement is idempotent).
--
-- WHY THIS EXISTS
-- ─────────────────────────────────────────────────────────────
-- An external data-integrity audit proved public.next_ref_number(...)
-- (as it exists in the already-applied supabase_schema.sql) is NOT
-- concurrency-safe: it computes the next reference number as
-- COALESCE(MAX(...), 0) + 1 over the target table, with no sequence, no
-- advisory lock, no row/table lock, and no atomic counter. Two
-- concurrent callers can read the SAME max and compute the SAME
-- candidate number; whichever INSERT loses the resulting UNIQUE-
-- constraint race fails outright. This affects every existing caller —
-- reservations (including the future automated Civitatis write path),
-- leads, payments, guide_payments, and quotes — and is WORSE for the
-- manual JS creation path specifically: ReservationRepository.create
-- (and its four siblings) call next_ref_number(...) and the eventual
-- .insert(...) as TWO SEPARATE Supabase/PostgREST requests, each its own
-- auto-committing transaction, with a real network round-trip between
-- them — so a lock scoped to next_ref_number()'s own call cannot close
-- that gap; only an atomically-incremented, durably-committed counter
-- can (see below).
--
-- THE FIX
-- ─────────────────────────────────────────────────────────────
-- A new, tightly-locked-down table, public.ref_number_counters, holds
-- one row per (prefix, table_name, year) with the last numeric value
-- allocated for that combination. next_ref_number(...) is rewritten to:
--   1. Validate (prefix, table_name, number_col) against the exact
--      five known legitimate combinations (see SECURITY below) — never
--      trust a caller-supplied identifier triple blindly.
--   2. Look up an existing counter row for (prefix, table_name, year).
--      If found, skip straight to step 4 (the common case — no need to
--      ever re-scan the target table again after the first call).
--   3. If NOT found (this key has never been seen before), compute a
--      seed value from the HIGHEST existing valid reference already in
--      the target table for this prefix/year (the exact same dynamic
--      MAX(...) query the original function used) — so the very first
--      counter-backed call continues the existing numbering exactly
--      where manually-created history left off, never restarting at 1.
--   4. Atomically INSERT ... ON CONFLICT (prefix, table_name, year) DO
--      UPDATE SET last_value = last_value + 1 RETURNING last_value —
--      a single statement. See CONCURRENCY ANALYSIS below for exactly
--      why this one statement is safe under every interleaving,
--      including the "two concurrent first-ever callers" case.
--   5. Format and RETURN the SAME PREFIX-YYYY-NNNN string as before.
-- The function's name, 3-argument signature, argument types, and TEXT
-- return type are all UNCHANGED — CREATE OR REPLACE FUNCTION — so
-- every existing call site (the five sb.rpc('next_ref_number', {...})
-- call sites across DeseTourDashboard.jsx / app.js, and the two direct
-- SELECT public.next_ref_number(...) calls inside
-- ingest_civitatis_booking's CREATE branch and V7's own CREATE branch)
-- requires ZERO changes.
--
-- CONCURRENCY ANALYSIS — why the single UPSERT statement is safe
-- ─────────────────────────────────────────────────────────────
--   • Two concurrent LATER calls (a counter row already exists for this
--     key): both skip the seed computation (step 3) and both reach the
--     SAME atomic UPSERT (step 4). Postgres serializes any two
--     concurrent UPDATEs (or, here, ON CONFLICT DO UPDATEs) to the SAME
--     row via ordinary row-level locking: the second caller blocks
--     until the first commits, then reads the first's NEW committed
--     last_value and increments further. Never the same number twice.
--   • Two concurrent FIRST-EVER calls for a key with no existing counter
--     row: BOTH callers independently compute a seed from the target
--     table's historical MAX(...) (harmless, even if redundant — see
--     below) and BOTH attempt
--     INSERT ... VALUES (..., v_seed + 1) ON CONFLICT (...) DO UPDATE
--     SET last_value = last_value + 1. Whichever caller's INSERT
--     reaches the (prefix, table_name, year) PRIMARY KEY first actually
--     creates the row with ITS OWN v_seed + 1; Postgres blocks the
--     OTHER caller's conflicting INSERT on that same key until the
--     first commits (or rolls back). Once unblocked, the second
--     caller's own proposed VALUES row is DISCARDED ENTIRELY in favor
--     of its ON CONFLICT DO UPDATE branch, which increments the row the
--     FIRST caller just committed — regardless of what the second
--     caller's own (possibly identical) seed computation produced. The
--     seed value is therefore NEVER the source of truth for more than
--     the very first successful insert; every other caller, no matter
--     how it interleaves, is always routed through the atomic
--     increment path instead. Two concurrent first-ever callers can
--     therefore never receive the same number, and the redundant seed
--     computation the "losing" caller performs is wasted work, not a
--     correctness risk.
--   • This reasoning holds regardless of whether next_ref_number(...)
--     and the eventual target-table INSERT happen in the SAME
--     transaction (the Civitatis RPC's own pattern) or in two SEPARATE,
--     independently-committing transactions (the manual JS creation
--     pattern) — the counter's own increment is durably committed the
--     moment next_ref_number(...) itself returns, which is what closes
--     the cross-request gap the audit specifically flagged as unsafe
--     under a lock-only design.
--   • Gaps are an accepted, harmless side effect (explicitly authorized
--     by this task): a number can be claimed by a counter increment
--     whose caller then never actually inserts a row with it (e.g. the
--     JS layer's own try/catch silently falling back to a different,
--     Date.now()-based string on an unrelated RPC error). This is no
--     different in kind from the gap the ORIGINAL MAX+1 implementation
--     could already produce whenever a max-holding row's own
--     transaction rolled back.
--
-- SECURITY
-- ─────────────────────────────────────────────────────────────
--   • public.ref_number_counters is NOT directly accessible to anon or
--     authenticated roles: ROW LEVEL SECURITY is enabled with ZERO
--     policies (this schema's own established idiom for "nothing but
--     the table owner/service_role may touch this at all" — see
--     email_ingestions in supabase_migration_civitatis_ingestion.sql
--     for the same pattern applied to a different table), AND explicit
--     REVOKE ALL ... FROM PUBLIC/anon/authenticated statements are
--     added as a second, belt-and-suspenders layer independent of RLS.
--   • next_ref_number(...) itself is made SECURITY DEFINER (with
--     SET search_path = public, matching the established convention
--     used by ingest_civitatis_booking and the RLS predicate functions
--     in supabase_rls_policies.sql) so it can read/write the now-locked-
--     down counter table regardless of the calling role's own
--     privileges. This is the ONLY behavioral privilege change this
--     migration makes — the function's own EXECUTE grant is left
--     completely untouched (no REVOKE/GRANT statement for the function
--     itself is added or changed), so the application calls it through
--     Supabase exactly as it does today, with exactly the same
--     callers able to call it as before.
--   • (prefix, table_name, number_col) validated against an explicit
--     allow-list of the five known legitimate combinations before any
--     dynamic SQL touches the target table at all — this is misuse
--     prevention (stopping the function from ever being pointed at an
--     arbitrary table), not a SQL-injection fix per se: the original
--     function's use of format('%I', ...) / format('%L', ...) already
--     safely quotes identifiers and literals, so no injection was
--     actually possible through the dynamic EXECUTE before either —
--     this migration keeps that same safe-quoting pattern for the
--     (now much rarer, first-call-only) seed query, and adds the
--     allow-list purely as defense in depth.
--   • No existing table's schema, RLS policy, or GRANT is touched.
--
-- HOW TO APPLY (once reviewed and approved — NOT done as part of
-- producing this file)
-- ─────────────────────────────────────────────────────────────
-- Supabase Dashboard → SQL Editor → paste and run this file. Safe to
-- run directly against the current production schema (supabase_schema.
-- sql's original next_ref_number is what is currently live). Idempotent
-- — CREATE TABLE IF NOT EXISTS, CREATE OR REPLACE FUNCTION, and
-- REVOKE/GRANT are all safe to re-run.
-- ============================================================


-- ──────────────────────────────────────────────────────────────────────────
-- TABLE: ref_number_counters
-- One row per (prefix, table_name, year) — the durable, atomically-
-- incremented source of truth next_ref_number(...) allocates from.
-- ──────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.ref_number_counters (
  prefix      TEXT    NOT NULL,
  table_name  TEXT    NOT NULL,
  year        TEXT    NOT NULL,
  last_value  INTEGER NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (prefix, table_name, year)
);

COMMENT ON TABLE  public.ref_number_counters            IS 'Internal allocator state for public.next_ref_number(...). One row per (prefix, table_name, year); last_value is atomically incremented by that function via INSERT ... ON CONFLICT DO UPDATE. Never read or written directly by application code — always go through next_ref_number(...). Not accessible to anon/authenticated (RLS enabled with zero policies, plus explicit REVOKE ALL — see migration header).';
COMMENT ON COLUMN public.ref_number_counters.prefix      IS 'The human-readable prefix, e.g. R, LEAD, PAY, GP, Q — matches next_ref_number(prefix, ...)''s first argument exactly.';
COMMENT ON COLUMN public.ref_number_counters.table_name  IS 'The target table this counter allocates numbers for, e.g. reservations, leads — matches next_ref_number(...)''s second argument exactly.';
COMMENT ON COLUMN public.ref_number_counters.year        IS 'TO_CHAR(NOW(), ''YYYY'') at the time this counter key was first created — numbering resets per calendar year, matching the existing PREFIX-YYYY-NNNN format.';
COMMENT ON COLUMN public.ref_number_counters.last_value  IS 'The last numeric value allocated for this (prefix, table_name, year). Initialized from the highest existing valid reference already in the target table (never blindly from 0/1), then atomically incremented on every subsequent call.';
COMMENT ON COLUMN public.ref_number_counters.updated_at  IS 'When this counter was last incremented — operational/debugging visibility only, not read by next_ref_number(...) itself.';

ALTER TABLE public.ref_number_counters ENABLE ROW LEVEL SECURITY;
-- Deliberately ZERO policies: with RLS enabled and no policies, no row
-- is selectable/insertable/updatable/deletable by anon or authenticated
-- under any circumstance — this schema's own established idiom for a
-- table nothing but the owner/service_role/a SECURITY DEFINER function
-- running as the owner should ever touch (see email_ingestions in
-- supabase_migration_civitatis_ingestion.sql for the same pattern).

REVOKE ALL ON public.ref_number_counters FROM PUBLIC;
REVOKE ALL ON public.ref_number_counters FROM anon;
REVOKE ALL ON public.ref_number_counters FROM authenticated;
-- Belt-and-suspenders alongside RLS above: even if a future change ever
-- granted table-level privileges here (e.g. a broad "GRANT ALL ON ALL
-- TABLES" run against this schema), RLS with zero policies still blocks
-- every row. next_ref_number(...)'s own SECURITY DEFINER status (below)
-- is what actually lets IT read/write this table regardless of either
-- restriction — callers of that function never touch this table
-- directly, by construction.


-- ──────────────────────────────────────────────────────────────────────────
-- FUNCTION: next_ref_number (rewritten body, IDENTICAL public interface)
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
  -- The pragma above: every bare `prefix`/`table_name` reference below
  -- resolves to this function's own PARAMETERS, never to the
  -- identically-named columns on ref_number_counters (always referenced
  -- through the `rnc` alias instead) — this makes that resolution
  -- explicit and prevents Postgres's default "column reference is
  -- ambiguous" error.
  year_str    TEXT := TO_CHAR(NOW(), 'YYYY');
  pattern     TEXT;
  v_seed      INTEGER := 0;
  v_existing  INTEGER;
  v_next_num  INTEGER;
BEGIN
  -- Allow-list the exact (prefix, table_name, number_col) combinations
  -- this function is ever legitimately asked to allocate for — see
  -- migration header SECURITY section. Anything else is refused before
  -- any dynamic SQL is built at all.
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

  -- Common case: a counter row for this (prefix, table_name, year)
  -- already exists — skip the historical-MAX scan entirely and go
  -- straight to the atomic increment below. This SELECT is purely a
  -- performance short-circuit; it need not be race-free itself (see
  -- CONCURRENCY ANALYSIS in the migration header) — the INSERT ...
  -- ON CONFLICT DO UPDATE below is what actually guarantees safety,
  -- regardless of what this SELECT saw.
  SELECT rnc.last_value INTO v_existing
    FROM public.ref_number_counters rnc
   WHERE rnc.prefix = prefix
     AND rnc.table_name = table_name
     AND rnc.year = year_str;

  IF v_existing IS NULL THEN
    -- Possibly the first-ever call for this key: seed from the highest
    -- existing valid reference already in the target table, so numbering
    -- continues exactly where history (manual creation, or any row
    -- created before this migration was applied) left off — never
    -- blindly restarts at 1. Identical dynamic-SQL shape to the
    -- original implementation, safely quoted via format() %I/%L.
    pattern := prefix || '-' || year_str || '-%';
    EXECUTE format(
      'SELECT COALESCE(MAX(CAST(SPLIT_PART(%I, ''-'', 3) AS INTEGER)), 0) FROM %I WHERE %I LIKE %L',
      number_col, table_name, number_col, pattern
    ) INTO v_seed;
  END IF;

  -- The ONE atomic statement that makes allocation safe under any
  -- interleaving, including concurrent first-ever callers and callers
  -- whose eventual target-table INSERT happens in a wholly separate,
  -- later transaction (the manual JS creation path) — see migration
  -- header CONCURRENCY ANALYSIS for the full argument.
  INSERT INTO public.ref_number_counters (prefix, table_name, year, last_value, updated_at)
  VALUES (prefix, table_name, year_str, v_seed + 1, NOW())
  ON CONFLICT (prefix, table_name, year) DO UPDATE
    SET last_value = ref_number_counters.last_value + 1,
        updated_at = NOW()
  RETURNING last_value INTO v_next_num;

  RETURN prefix || '-' || year_str || '-' || LPAD(v_next_num::TEXT, 4, '0');
END;
$$;

COMMENT ON FUNCTION public.next_ref_number IS
  'Generates sequential human-readable IDs like LEAD-2026-0042, backed '
  'by an atomically-incremented counter table (public.ref_number_'
  'counters) rather than a MAX(...)+1 scan — safe under concurrent '
  'callers, including across two separate transactions (this function''s '
  'own call, and a later, independent INSERT of the numbered row). '
  'First call for a given (prefix, table_name, year) seeds from the '
  'highest existing valid reference already in the target table, never '
  'from 0. Restricted to the same five known prefix/table_name/'
  'number_col combinations the application has always used: '
  'R/reservations/reservation_number, LEAD/leads/lead_number, '
  'PAY/payments/payment_number, GP/guide_payments/payment_number, '
  'Q/quotes/quote_number. SECURITY DEFINER so it can read/write the '
  'internal, locked-down ref_number_counters table regardless of the '
  'calling role''s own privileges; its own EXECUTE grant is unchanged '
  'from before this migration, so every existing call site keeps '
  'working exactly as today. Same 3-argument signature and TEXT return '
  'format as always — callers require no changes.';


-- ──────────────────────────────────────────────────────────────────────────
-- VERIFICATION QUERIES (for manual review after applying — not executed
-- as part of producing this file)
-- ──────────────────────────────────────────────────────────────────────────

/*
-- 1. Confirm ref_number_counters has RLS enabled and zero policies, and
--    no anon/authenticated table-level privileges:
SELECT relrowsecurity FROM pg_class WHERE relname = 'ref_number_counters';
-- Expect true.
SELECT * FROM pg_policies WHERE tablename = 'ref_number_counters';
-- Expect zero rows.
SELECT grantee, privilege_type FROM information_schema.role_table_grants
 WHERE table_name = 'ref_number_counters';
-- Expect no rows for anon/authenticated/PUBLIC.

-- 2. Confirm next_ref_number is SECURITY DEFINER with a pinned search_path:
SELECT proname, prosecdef, proconfig FROM pg_proc WHERE proname = 'next_ref_number';
-- Expect prosecdef = true, proconfig containing 'search_path=public'.

-- 3. Spot-check output format and historical continuity after applying,
--    e.g. against a staging DB with existing reservations:
-- SELECT public.next_ref_number('R', 'reservations', 'reservation_number');
-- Expect R-<current year>-<4-digit number one greater than the highest
-- existing reservation_number for that year>.
*/

-- ── END OF MIGRATION ────────────────────────────────────────────────────────
