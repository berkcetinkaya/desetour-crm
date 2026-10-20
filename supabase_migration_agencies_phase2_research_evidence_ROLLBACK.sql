-- ============================================================
-- DESE TOUR OPERATIONS CENTER
-- Rollback: Acenteler (B2B Agency Acquisition) — Phase 2 Research Evidence
-- ============================================================
-- File:    supabase_migration_agencies_phase2_research_evidence_ROLLBACK.sql
-- Rolls back ONLY: supabase_migration_agencies_phase2_research_evidence.sql
-- NOT executed. Provided for manual review and manual execution only.
--
-- SCOPE — WHAT THIS ROLLS BACK, AND NOTHING ELSE
-- ─────────────────────────────────────────────────────────────
-- Removes EXACTLY the two columns the forward migration added to the
-- EXISTING public.agencies table:
--   1. research_evidence
--   2. research_source_url
--
-- THIS ROLLBACK DOES NOT TOUCH, AND MUST NEVER BE MADE TO TOUCH:
--   • public.agencies' own table, its other columns, its CHECK
--     constraint, its indexes, its trigger, or its RLS policies —
--     all created by supabase_migration_agencies.sql (Phase 1), never
--     re-created or altered here. DROP COLUMN removes only the named
--     column; every other column and every row's other data is
--     completely unaffected.
--   • Any row's name/country/city/website/contact_person/email/phone/
--     languages/fit_note/status/last_contact_at/internal_notes/
--     created_by/created_at/updated_at — untouched.
--   • public.agency_emails — never referenced by the forward migration
--     or here.
--   • Any other existing table, function, or policy.
--
-- SAFETY
-- ─────────────────────────────────────────────────────────────
-- DROP COLUMN IF EXISTS — safe to run even if the forward migration
-- was only partially applied, and safe to run twice (second run finds
-- nothing left to drop, no error). Dropping a nullable column with no
-- dependent index/constraint/view is a simple, non-destructive-to-
-- other-data operation.
--
-- HOW TO APPLY
-- ─────────────────────────────────────────────────────────────
-- Supabase Dashboard → SQL Editor → paste and run this file IN FULL, in
-- a single execution. Wrapped in an explicit BEGIN/COMMIT.
-- ============================================================

BEGIN;

ALTER TABLE public.agencies DROP COLUMN IF EXISTS research_evidence;
ALTER TABLE public.agencies DROP COLUMN IF EXISTS research_source_url;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='agencies' AND column_name='research_evidence') THEN
    RAISE EXCEPTION 'ACENTELER PHASE 2 RESEARCH-EVIDENCE ROLLBACK POSTFLIGHT FAILED: research_evidence still exists after DROP. Aborting.';
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='agencies' AND column_name='research_source_url') THEN
    RAISE EXCEPTION 'ACENTELER PHASE 2 RESEARCH-EVIDENCE ROLLBACK POSTFLIGHT FAILED: research_source_url still exists after DROP. Aborting.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='agencies') THEN
    RAISE EXCEPTION 'ACENTELER PHASE 2 RESEARCH-EVIDENCE ROLLBACK POSTFLIGHT FAILED: agencies table disappeared — out of scope, must never happen. Aborting.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='agency_emails') THEN
    RAISE EXCEPTION 'ACENTELER PHASE 2 RESEARCH-EVIDENCE ROLLBACK POSTFLIGHT FAILED: agency_emails table disappeared — out of scope, must never happen. Aborting.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='agencies' AND column_name='fit_note') THEN
    RAISE EXCEPTION 'ACENTELER PHASE 2 RESEARCH-EVIDENCE ROLLBACK POSTFLIGHT FAILED: agencies.fit_note disappeared — out of scope, must never happen. Aborting.';
  END IF;
  RAISE NOTICE 'ACENTELER PHASE 2 RESEARCH-EVIDENCE ROLLBACK POSTFLIGHT PASSED: research_evidence and research_source_url removed; agencies table, its other columns, and agency_emails untouched.';
END $$;

COMMIT;

-- ============================================================
-- END OF ROLLBACK supabase_migration_agencies_phase2_research_evidence_ROLLBACK.sql
-- ============================================================
