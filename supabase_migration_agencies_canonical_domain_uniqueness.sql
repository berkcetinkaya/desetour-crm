-- ============================================================
-- DESE TOUR OPERATIONS CENTER
-- Migration: Acenteler (B2B Agency Acquisition) — Canonical Domain
--            Uniqueness (database-level race safety)
-- ============================================================
-- File:    supabase_migration_agencies_canonical_domain_uniqueness.sql
-- Depends: supabase_migration_agencies.sql (already applied — Phase 1)
-- Version: Agency CRM research workflow — database race-safety phase
--
-- WHAT THIS ADDS
-- ─────────────────────────────────────────────────────────────
-- Exactly two new database objects, both on the EXISTING public.agencies
-- table, neither touching any existing column, row, trigger, or policy:
--   1. public.canonical_agency_domain(url TEXT) — an IMMUTABLE SQL
--      function. Pure string transform of its own input parameter: trim
--      whitespace, lowercase, strip scheme (http://, https://, ...),
--      strip a literal "www." prefix ONLY (every other subdomain, e.g.
--      "booking.example.com", stays distinct from "example.com" — see
--      the design report's subdomain-policy rationale), strip path/
--      query-string/fragment, strip an explicit port, strip a trailing
--      dot, and return NULL for an empty result. Kept in byte-for-byte
--      step-order parity with api/_agencies/duplicateMatching.js's
--      normalizeWebsite and DeseTourDashboard.jsx's
--      _normalizeAgencyWebsiteDomain — see
--      tests/dashboard/agencyCanonicalDomainParity.test.js and
--      tests/dashboard/agencyCanonicalDomainMigration.test.js.
--   2. idx_agencies_canonical_domain_unique — a PARTIAL UNIQUE expression
--      index on canonical_agency_domain(website), WHERE
--      canonical_agency_domain(website) IS NOT NULL. This is the final,
--      race-safe authority: two truly concurrent inserts/updates for the
--      same canonical domain can no longer both succeed, closing the
--      TOCTOU window the application-level pre-check alone could not.
--
-- WHY OPTION C (FUNCTION + EXPRESSION INDEX), NOT A STORED COLUMN
-- ─────────────────────────────────────────────────────────────
-- Evaluated against a stored/generated canonical_domain column and a
-- trigger-maintained column (see the design report) — this is the
-- smallest footprint that provides the exact same guarantee: zero new
-- columns, nothing that can ever drift out of sync (there is nothing
-- stored to desync), nothing beyond one function and one index to
-- reason about or roll back.
--
-- WHY NOT CREATE INDEX CONCURRENTLY
-- ─────────────────────────────────────────────────────────────
-- CREATE INDEX CONCURRENTLY cannot run inside a transaction block, and
-- this repository's own established convention for exactly this class
-- of migration (preflight → DDL → postflight, atomic, all-or-nothing —
-- see supabase_migration_whatsapp_core.sql and others) wraps in an
-- explicit BEGIN/COMMIT. public.agencies is a small, internal B2B
-- directory on no customer-facing write path — a brief SHARE lock
-- during a normal (non-concurrent) index build is a fully acceptable,
-- low-risk cost during a planned, reviewed migration window, and it
-- preserves the all-or-nothing guarantee the BEGIN/COMMIT convention
-- exists for.
--
-- WHY NOT SECURITY DEFINER
-- ─────────────────────────────────────────────────────────────
-- canonical_agency_domain touches no table — it operates only on its own
-- input parameter. There is nothing for it to need elevated privilege to
-- bypass, same reasoning this codebase already established for
-- public.is_aal2() (supabase_migration_aal2_enforcement.sql). Not marked
-- SECURITY DEFINER; the postflight below explicitly verifies this.
--
-- WHY NO RLS CHANGE, NO NAME/EMAIL UNIQUENESS
-- ─────────────────────────────────────────────────────────────
-- A unique index is enforced at the storage layer, independently of and
-- in addition to RLS — the existing "agencies: admin/sales
-- select/insert/update" policies (requiring is_admin()/is_sales() AND
-- is_aal2()) are completely unaffected; this migration adds, drops, and
-- alters no policy. Uniqueness is deliberately scoped to website's
-- canonical domain ONLY — never company name (too prone to legitimate
-- collisions between unrelated businesses with similar names) and never
-- email (a secondary, app-level-only fallback signal, not promoted to a
-- database-level identity here).
--
-- PRODUCTION PREFLIGHT ALREADY RUN (read-only, outside this migration)
-- ─────────────────────────────────────────────────────────────
-- Confirmed zero canonical-domain collisions among existing agencies
-- (collision_group_count = 0, colliding_row_count = 0) and no invalid/
-- blank website records requiring attention. This migration's own
-- PREFLIGHT below re-checks this at execution time regardless — never
-- trusting an earlier, separately-run report alone, since data can
-- change between that check and this migration's actual execution.
--
-- EXISTING AGENCIES WITH NO WEBSITE ARE COMPLETELY UNAFFECTED
-- ─────────────────────────────────────────────────────────────
-- The index is PARTIAL (WHERE canonical_agency_domain(website) IS NOT
-- NULL) — an agency with a NULL or blank website, or one that does not
-- normalize to anything, is never constrained against any other row.
-- Historical agencies legitimately missing a website keep working
-- exactly as today, fully editable via AcenteDetailPage.
--
-- SAFETY
-- ─────────────────────────────────────────────────────────────
--   • 100% additive: one new function, one new partial unique index. No
--     DROP, no data migration, no change to any existing column,
--     CHECK constraint, trigger, or RLS policy on public.agencies.
--   • Idempotent: CREATE OR REPLACE FUNCTION and the postflight's own
--     checks make a second full run of this file safe (the index create
--     is not itself IF NOT EXISTS-guarded — a second run would fail
--     cleanly on "index already exists" inside the same transaction,
--     which is the correct, loud failure mode for a unique index rather
--     than a silent no-op).
--   • PREFLIGHT (before any write) and POSTFLIGHT (after every write,
--     before COMMIT) both RAISE EXCEPTION and abort the WHOLE
--     transaction on any unexpected state — nothing partial is ever left
--     committed, same discipline as every other BEGIN/COMMIT-wrapped
--     migration in this repository.
--   • No SQL in this file has been executed. No Supabase connection was
--     made to produce it.
--
-- HOW TO APPLY
-- ─────────────────────────────────────────────────────────────
-- Supabase Dashboard → SQL Editor → paste and run this file IN FULL, in
-- a single execution. Wrapped in an explicit BEGIN/COMMIT so a failed
-- preflight OR the postflight aborts the whole transaction rather than
-- leaving anything partial.
-- ============================================================


BEGIN;

-- ──────────────────────────────────────────────────────────────────────────
-- PREFLIGHT: confirm public.agencies/website exist, and re-check for
-- canonical-domain collisions AT THE MOMENT THIS MIGRATION RUNS, before
-- touching anything. Read-only.
-- ──────────────────────────────────────────────────────────────────────────

DO $$
DECLARE
  v_collision_count INT;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
     WHERE table_schema = 'public' AND table_name = 'agencies'
  ) THEN
    RAISE EXCEPTION 'AGENCIES CANONICAL DOMAIN PREFLIGHT FAILED: public.agencies does not exist. Apply supabase_migration_agencies.sql BEFORE this migration. Aborting before touching anything.';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='agencies' AND column_name='website'
  ) THEN
    RAISE EXCEPTION 'AGENCIES CANONICAL DOMAIN PREFLIGHT FAILED: public.agencies.website does not exist. Aborting before touching anything.';
  END IF;

  -- Re-check for collisions NOW, never trusting only the separately-run
  -- read-only report — the exact same normalization logic the function
  -- below will use, inlined here since the function does not exist yet.
  SELECT COUNT(*) INTO v_collision_count
  FROM (
    SELECT canonical_domain
    FROM (
      SELECT
        NULLIF(
          regexp_replace(
            regexp_replace(
              regexp_replace(
                regexp_replace(
                  regexp_replace(lower(trim(website)), '^[a-z][a-z0-9+.-]*://', ''),
                  '^www\.', ''
                ),
                '[/?#].*$', ''
              ),
              ':[0-9]+$', ''
            ),
            '\.$', ''
          ),
          ''
        ) AS canonical_domain
      FROM public.agencies
    ) normalized
    WHERE canonical_domain IS NOT NULL
    GROUP BY canonical_domain
    HAVING COUNT(*) > 1
  ) collision_groups;

  IF v_collision_count IS NOT NULL AND v_collision_count > 0 THEN
    RAISE EXCEPTION 'AGENCIES CANONICAL DOMAIN PREFLIGHT FAILED: % canonical-domain collision group(s) found among existing agencies at migration time. Re-run the read-only preflight report, resolve every collision by hand per the design report''s remediation workflow, and re-run this migration only once it reports zero. Aborting before touching anything.', v_collision_count;
  END IF;

  RAISE NOTICE 'AGENCIES CANONICAL DOMAIN PREFLIGHT PASSED: public.agencies.website exists, zero canonical-domain collisions at migration time. Proceeding.';
END $$;


-- ──────────────────────────────────────────────────────────────────────────
-- STEP 1: canonical_agency_domain(url) — IMMUTABLE, no table access, never
-- SECURITY DEFINER. Same 6-step normalization as the JS implementations.
-- ──────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.canonical_agency_domain(url TEXT)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
AS $$
  WITH step0 AS (SELECT lower(trim(url)) AS s),                                           -- lowercase + trim whitespace
       step1 AS (SELECT regexp_replace(s, '^[a-z][a-z0-9+.-]*://', '') AS s FROM step0),  -- strip scheme (http://, https://, ...)
       step2 AS (SELECT regexp_replace(s, '^www\.', '') AS s FROM step1),                 -- strip a leading "www." only
       step3 AS (SELECT regexp_replace(s, '[/?#].*$', '') AS s FROM step2),               -- strip path, query string, fragment
       step4 AS (SELECT regexp_replace(s, ':[0-9]+$', '') AS s FROM step3),               -- strip an explicit port
       step5 AS (SELECT regexp_replace(s, '\.$', '') AS s FROM step4)                     -- strip a trailing dot (FQDN form)
  SELECT NULLIF(s, '') FROM step5;
$$;

COMMENT ON FUNCTION public.canonical_agency_domain(TEXT) IS 'Deterministic canonical-domain normalization for Agency duplicate detection: trim, lowercase, strip scheme, strip a literal "www." prefix ONLY (other subdomains stay distinct, e.g. booking.example.com != example.com), strip path/query/fragment, strip an explicit port, strip a trailing dot, NULL for an empty result. Kept in exact parity with api/_agencies/duplicateMatching.js normalizeWebsite and DeseTourDashboard.jsx _normalizeAgencyWebsiteDomain. Pure string transform of its own input parameter only — touches no table, so never SECURITY DEFINER.';


-- ──────────────────────────────────────────────────────────────────────────
-- STEP 2: partial UNIQUE expression index — the final race-safe authority.
-- An agency with no usable website (NULL/blank/unparseable) is never
-- constrained against any other row.
-- ──────────────────────────────────────────────────────────────────────────

CREATE UNIQUE INDEX idx_agencies_canonical_domain_unique
  ON public.agencies (public.canonical_agency_domain(website))
  WHERE public.canonical_agency_domain(website) IS NOT NULL;

COMMENT ON INDEX public.idx_agencies_canonical_domain_unique IS 'Database-level race-safe duplicate prevention for Agencies: two concurrent inserts/updates for the same canonical website domain can no longer both succeed. Partial — an agency with no website, or an unparseable one, is never constrained. No uniqueness on name or email.';


-- ──────────────────────────────────────────────────────────────────────────
-- POSTFLIGHT: verify every object this migration was supposed to create
-- exists with exactly the expected properties, and nothing outside this
-- migration's explicit scope was touched. RAISE EXCEPTION aborts the
-- whole transaction (COMMIT below never runs) on any mismatch.
-- ──────────────────────────────────────────────────────────────────────────

DO $$
DECLARE
  v_function_volatility CHAR;
  v_function_secdef     BOOLEAN;
  v_index_unique         BOOLEAN;
  v_index_def             TEXT;
  v_policy_count           INT;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'canonical_agency_domain') THEN
    RAISE EXCEPTION 'AGENCIES CANONICAL DOMAIN POSTFLIGHT FAILED: public.canonical_agency_domain was not created. Aborting.';
  END IF;

  SELECT provolatile, prosecdef INTO v_function_volatility, v_function_secdef
  FROM pg_proc WHERE proname = 'canonical_agency_domain';

  IF v_function_volatility <> 'i' THEN
    RAISE EXCEPTION 'AGENCIES CANONICAL DOMAIN POSTFLIGHT FAILED: canonical_agency_domain is not IMMUTABLE (volatility=%). Aborting.', v_function_volatility;
  END IF;

  IF v_function_secdef THEN
    RAISE EXCEPTION 'AGENCIES CANONICAL DOMAIN POSTFLIGHT FAILED: canonical_agency_domain is SECURITY DEFINER, which this design explicitly avoids. Aborting.';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
     WHERE schemaname='public' AND tablename='agencies' AND indexname='idx_agencies_canonical_domain_unique'
  ) THEN
    RAISE EXCEPTION 'AGENCIES CANONICAL DOMAIN POSTFLIGHT FAILED: idx_agencies_canonical_domain_unique was not created. Aborting.';
  END IF;

  SELECT ix.indisunique INTO v_index_unique
  FROM pg_index ix
  JOIN pg_class c ON c.oid = ix.indexrelid
  WHERE c.relname = 'idx_agencies_canonical_domain_unique';

  IF NOT v_index_unique THEN
    RAISE EXCEPTION 'AGENCIES CANONICAL DOMAIN POSTFLIGHT FAILED: idx_agencies_canonical_domain_unique is not a UNIQUE index. Aborting.';
  END IF;

  SELECT indexdef INTO v_index_def
  FROM pg_indexes
  WHERE schemaname='public' AND tablename='agencies' AND indexname='idx_agencies_canonical_domain_unique';

  IF v_index_def IS NULL
     OR v_index_def NOT ILIKE '%canonical_agency_domain%'
     OR v_index_def NOT ILIKE '%WHERE%'
     OR v_index_def ILIKE '%CONCURRENTLY%'
  THEN
    RAISE EXCEPTION 'AGENCIES CANONICAL DOMAIN POSTFLIGHT FAILED: index definition does not match the expected partial expression index on canonical_agency_domain(website): %. Aborting.', v_index_def;
  END IF;

  -- Confirm nothing outside this migration's explicit scope was touched.
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='agencies' AND column_name='website'
  ) THEN
    RAISE EXCEPTION 'AGENCIES CANONICAL DOMAIN POSTFLIGHT FAILED: agencies.website column disappeared — out of scope, must never happen. Aborting.';
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='agencies' AND column_name='canonical_domain'
  ) THEN
    RAISE EXCEPTION 'AGENCIES CANONICAL DOMAIN POSTFLIGHT FAILED: a canonical_domain COLUMN exists — this design (Option C) must never add one. Aborting.';
  END IF;

  SELECT COUNT(*) INTO v_policy_count FROM pg_policies WHERE schemaname='public' AND tablename='agencies';
  IF v_policy_count <> 6 THEN
    RAISE EXCEPTION 'AGENCIES CANONICAL DOMAIN POSTFLIGHT FAILED: agencies RLS policy count changed (expected 6: admin/sales x select/insert/update, got %) — this migration must never touch RLS. Aborting.', v_policy_count;
  END IF;

  RAISE NOTICE 'AGENCIES CANONICAL DOMAIN POSTFLIGHT PASSED: canonical_agency_domain() is IMMUTABLE and NOT SECURITY DEFINER; idx_agencies_canonical_domain_unique exists, is UNIQUE, and is a partial (non-CONCURRENTLY) expression index on canonical_agency_domain(website); no canonical_domain column was added; agencies.website and all 6 RLS policies are unchanged. Migration verified complete.';
END $$;

COMMIT;
