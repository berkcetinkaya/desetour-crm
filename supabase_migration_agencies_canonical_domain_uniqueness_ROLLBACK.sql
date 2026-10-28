-- ============================================================
-- DESE TOUR OPERATIONS CENTER
-- Rollback: Acenteler (B2B Agency Acquisition) — Canonical Domain
--           Uniqueness
-- ============================================================
-- File:    supabase_migration_agencies_canonical_domain_uniqueness_ROLLBACK.sql
-- Rolls back ONLY: supabase_migration_agencies_canonical_domain_uniqueness.sql
-- NOT executed. Provided for manual review and manual execution only.
--
-- SCOPE — WHAT THIS ROLLS BACK, AND NOTHING ELSE
-- ─────────────────────────────────────────────────────────────
-- Removes EXACTLY the two objects the forward migration added, in the
-- required order (the index must be dropped before the function it
-- depends on):
--   1. idx_agencies_canonical_domain_unique (the partial unique index)
--   2. public.canonical_agency_domain(TEXT) (the IMMUTABLE function)
--
-- THIS ROLLBACK DOES NOT TOUCH, AND MUST NEVER BE MADE TO TOUCH:
--   • public.agencies' own table, any of its columns (including
--     website), its CHECK constraint, its other indexes
--     (idx_agencies_status/country/name), its trigger, or its 6 RLS
--     policies — none of these were created by the forward migration,
--     none are altered here.
--   • Any agency row's data — the forward migration added no column and
--     wrote no row, so there is nothing to mutate on the way back.
--   • public.agency_emails or public.activity_logs — never referenced by
--     the forward migration or here.
--   • Any other existing table, function, index, or policy.
--
-- NO DATA MUTATION IS REQUIRED
-- ─────────────────────────────────────────────────────────────
-- Dropping a function and the one expression index built on it is a
-- purely structural change — no agency row's website, email, name, or
-- any other field is read, written, or otherwise touched by this
-- rollback.
--
-- SAFETY
-- ─────────────────────────────────────────────────────────────
-- DROP INDEX IF EXISTS / DROP FUNCTION IF EXISTS — safe to run even if
-- the forward migration was only partially applied (it either fully
-- committed or fully rolled back itself, per its own BEGIN/COMMIT +
-- preflight/postflight discipline, so "partially applied" should not be
-- reachable in practice) and safe to run twice (second run finds nothing
-- left to drop, no error).
--
-- HOW TO APPLY
-- ─────────────────────────────────────────────────────────────
-- Supabase Dashboard → SQL Editor → paste and run this file IN FULL, in
-- a single execution. Wrapped in an explicit BEGIN/COMMIT.
-- ============================================================

BEGIN;

-- Index first — PostgreSQL will not allow dropping a function that a
-- live index expression still depends on.
DROP INDEX IF EXISTS public.idx_agencies_canonical_domain_unique;
DROP FUNCTION IF EXISTS public.canonical_agency_domain(TEXT);

DO $$
DECLARE
  v_policy_count INT;
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_indexes
     WHERE schemaname='public' AND tablename='agencies' AND indexname='idx_agencies_canonical_domain_unique'
  ) THEN
    RAISE EXCEPTION 'AGENCIES CANONICAL DOMAIN ROLLBACK POSTFLIGHT FAILED: idx_agencies_canonical_domain_unique still exists after DROP. Aborting.';
  END IF;

  IF EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'canonical_agency_domain') THEN
    RAISE EXCEPTION 'AGENCIES CANONICAL DOMAIN ROLLBACK POSTFLIGHT FAILED: canonical_agency_domain still exists after DROP. Aborting.';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='agencies') THEN
    RAISE EXCEPTION 'AGENCIES CANONICAL DOMAIN ROLLBACK POSTFLIGHT FAILED: agencies table disappeared — out of scope, must never happen. Aborting.';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='agencies' AND column_name='website'
  ) THEN
    RAISE EXCEPTION 'AGENCIES CANONICAL DOMAIN ROLLBACK POSTFLIGHT FAILED: agencies.website column disappeared — out of scope, must never happen. Aborting.';
  END IF;

  SELECT COUNT(*) INTO v_policy_count FROM pg_policies WHERE schemaname='public' AND tablename='agencies';
  IF v_policy_count <> 6 THEN
    RAISE EXCEPTION 'AGENCIES CANONICAL DOMAIN ROLLBACK POSTFLIGHT FAILED: agencies RLS policy count changed (expected 6, got %) — must never happen in this rollback. Aborting.', v_policy_count;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname='public' AND tablename='agencies' AND indexname='idx_agencies_status') THEN
    RAISE EXCEPTION 'AGENCIES CANONICAL DOMAIN ROLLBACK POSTFLIGHT FAILED: idx_agencies_status (a pre-existing, unrelated index) disappeared — out of scope, must never happen. Aborting.';
  END IF;

  RAISE NOTICE 'AGENCIES CANONICAL DOMAIN ROLLBACK POSTFLIGHT PASSED: idx_agencies_canonical_domain_unique and canonical_agency_domain() both removed; agencies table/website/pre-existing indexes/all 6 RLS policies unchanged. No data was mutated by this rollback.';
END $$;

COMMIT;
