-- ============================================================
-- DESE TOUR OPERATIONS CENTER
-- Migration: Acenteler (B2B Agency Acquisition) — Phase 2 Research Evidence
-- ============================================================
-- File:    supabase_migration_agencies_phase2_research_evidence.sql
-- Depends: supabase_migration_agencies.sql (already applied — Phase 1)
-- Version: Phase 2 — October 2026
--
-- WHAT THIS ADDS
-- ─────────────────────────────────────────────────────────────
-- Exactly two nullable columns on the EXISTING public.agencies table:
--   1. research_evidence     TEXT — the factual evidence_summary a
--                             market-research candidate was found with
--                             (e.g. "Official website lists Istanbul
--                             and Cappadocia cultural tours...").
--   2. research_source_url   TEXT — the source_url the research
--                             candidate's evidence was found at.
--
-- WHY THESE ARE NEW FIRST-CLASS COLUMNS, NOT PACKED INTO fit_note
-- ─────────────────────────────────────────────────────────────
-- fit_note stays a short, human-readable "why this agency fits"
-- sentence — exactly what Phase 1 already uses it for. Overloading it
-- with raw source metadata (a URL, a verbatim evidence quote) would
-- make it harder to read and harder to later re-use the evidence
-- programmatically (e.g. as grounding context for an outreach draft,
-- which Phase 2 now does — see api/_agencies/outreachDraftProvider.js).
-- Keeping them separate, nullable TEXT columns is the smallest schema
-- change that satisfies both needs without touching fit_note's
-- existing meaning or any existing row.
--
-- THIS MIGRATION DOES NOT CREATE A NEW TABLE, DOES NOT ALTER ANY
-- EXISTING COLUMN, AND DOES NOT TOUCH public.agency_emails AT ALL.
--
-- SAFETY
-- ─────────────────────────────────────────────────────────────
--   • 100% additive: two new NULLABLE columns on one existing table.
--     No NOT NULL, no DEFAULT other than the implicit NULL, so every
--     existing row is completely unaffected — no backfill, no rewrite.
--   • No DROP, no data migration, no change to any existing column,
--     constraint, index, trigger, or RLS policy on public.agencies.
--   • Idempotent: ADD COLUMN IF NOT EXISTS can be run any number of
--     times without error and without changing the end result.
--   • Does not touch supabase_migration_agencies.sql's own objects in
--     any way other than adding these two columns to the table it
--     already created — that file is never re-run, never rewritten.
--
-- HOW TO APPLY
-- ─────────────────────────────────────────────────────────────
-- Supabase Dashboard → SQL Editor → paste and run this file.
-- Run AFTER supabase_migration_agencies.sql.
-- Safe to re-run in full.
-- NOT executed as part of this change — review, then apply by hand.
-- ============================================================


-- ──────────────────────────────────────────────────────────────────────────
-- ALTER TABLE: agencies — add research_evidence, research_source_url
-- ──────────────────────────────────────────────────────────────────────────

-- Idempotent: IF NOT EXISTS — a second run no-ops if the column already exists.
ALTER TABLE public.agencies ADD COLUMN IF NOT EXISTS research_evidence    TEXT;
ALTER TABLE public.agencies ADD COLUMN IF NOT EXISTS research_source_url  TEXT;

COMMENT ON COLUMN public.agencies.research_evidence   IS 'Factual evidence_summary from Acenteler Phase 2 market research (api/_agencies/researchProvider.js), copied onto the agency row only when the candidate is explicitly imported via "CRM''e Ekle". NULL for any agency added manually or imported before this column existed. Never overwritten automatically after import.';
COMMENT ON COLUMN public.agencies.research_source_url IS 'source_url from the same Phase 2 research candidate as research_evidence — the page the evidence was found on. NULL under the same conditions as research_evidence. Displayed as a clickable link on AcenteDetailPage.';


-- ──────────────────────────────────────────────────────────────────────────
-- POSTFLIGHT — confirms exactly these two columns were added, agencies'
-- existing shape and agency_emails are both untouched. Read-only SELECTs only.
-- ──────────────────────────────────────────────────────────────────────────
SELECT
  (SELECT COUNT(*) FROM information_schema.columns
     WHERE table_schema='public' AND table_name='agencies' AND column_name='research_evidence')    AS research_evidence_column_exists,
  (SELECT COUNT(*) FROM information_schema.columns
     WHERE table_schema='public' AND table_name='agencies' AND column_name='research_source_url')   AS research_source_url_column_exists,
  (SELECT COUNT(*) FROM information_schema.table_constraints
     WHERE table_schema='public' AND table_name='agencies' AND constraint_type='CHECK')             AS agencies_check_constraint_count_unchanged,
  (SELECT COUNT(*) FROM information_schema.tables
     WHERE table_schema='public' AND table_name='agency_emails')                                    AS agency_emails_table_still_exists;
