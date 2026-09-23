-- ============================================================
-- DESE TOUR OPERATIONS CENTER
-- Migration: tour_channels booking_language discriminator
-- ============================================================
-- File:    supabase_migration_tour_channels_v2_booking_language.sql
-- Depends: supabase_schema.sql, supabase_rls_policies.sql,
--          supabase_migration_guides.sql, supabase_migration_reviews.sql,
--          supabase_migration_tour_channels.sql (all already applied)
-- Version: V2 of tour_channels — proposed, NOT applied. Review and run
--          manually. This file makes no other change to any other table.
--
-- NOT EXECUTED BY THIS TASK. Provided for manual review and manual
-- execution only, per the explicit instruction that no migration is ever
-- run against Supabase from this session.
--
-- WHAT THIS ADDS AND WHY
-- ─────────────────────────────────────────────────────────────
-- Civitatis can sell the SAME product (matched today purely by
-- tour_channels.external_product_id, e.g. "Grand Bazaar Experience")
-- in multiple booking languages that must resolve to DIFFERENT internal
-- tours (a dedicated Spanish Grand Bazaar tour, a dedicated Italian
-- Grand Bazaar tour, etc.) — the existing tour_channels shape has no
-- field to express that distinction, so every language of one product
-- has always resolved to whichever single tour that product's one
-- tour_channels row happened to point to.
--
-- This adds exactly one nullable column:
--
--   tour_channels.booking_language TEXT
--
-- NULL (the default for every existing row) means "generic — applies
-- regardless of booking language", i.e. today's exact behavior,
-- unchanged. A non-null value scopes that ONE row to bookings whose
-- normalized language (reservations.tour_language / the parser's
-- canonical `tourLanguage` — see api/_civitatis/languageMap.js) matches
-- it exactly, e.g. "İtalyanca".
--
-- Deliberately a plain nullable TEXT column, not a new table and not a
-- new relationship to tour_languages:
--   - tour_channels already has exactly one row per (tour, source) —
--     see tour_channels_tour_id_source_id_key below, unchanged — so a
--     language-specific mapping is just "this tour's one Civitatis row,
--     scoped to one language", not a many-to-many relationship. No new
--     table is needed, and none is added.
--   - tour_languages (added by V1 of this migration) answers a
--     DIFFERENT question — "which languages does this tour offer" (a
--     capability set, potentially several per tour) — not "which one
--     booking language should route THIS external product code to THIS
--     tour". Reusing it here would reintroduce exactly the ambiguity
--     this migration exists to remove: two tours that both happen to
--     list the same language in tour_languages would again be
--     indistinguishable for routing purposes.
--   - reservations.tour_language (added by supabase_migration_reviews.sql)
--     already stores the canonical Turkish language NAME as a plain
--     TEXT column (e.g. "İtalyanca") for the exact same normalized
--     vocabulary — booking_language mirrors that precedent exactly,
--     storing the same canonical name string, not a code, not a new
--     vocabulary, and enforced at the application level only (no CHECK
--     constraint here), exactly like reservations.tour_language.
--
-- NAMING: "booking_language" (not "language" or "variant") to match the
-- exact field name given in the task's own proposed shape, and to read
-- unambiguously next to reservations.tour_language — one is the
-- CHANNEL-MAPPING's language scope (catalog/config, set once when
-- configuring a sales channel), the other is the actual per-booking
-- value captured from a specific reservation.
--
-- BACKWARD COMPATIBILITY
-- ─────────────────────────────────────────────────────────────
-- 100% additive. Every existing tour_channels row gets
-- booking_language = NULL, which the updated matching logic
-- (api/_civitatis/matching.js) treats as "generic — matches this
-- product regardless of language" — i.e. every product that maps to
-- exactly one tour today keeps matching exactly as it does today, with
-- zero behavior change and zero backfill required. See that file for
-- the full precedence rule (exact product+language match, else a
-- generic product-only match ONLY if no language-specific mapping
-- exists for that product at all, else fail closed) and its own
-- extensive comments on why a generic mapping is never allowed to
-- silently satisfy a booking once a language-specific mapping exists
-- for the same product.
--
-- No existing row is touched, no existing constraint is narrowed or
-- dropped, no existing table's meaning changes. Genuinely idempotent:
-- ADD COLUMN IF NOT EXISTS / CREATE UNIQUE INDEX IF NOT EXISTS can both
-- be run a second time with no error and no change in outcome.
--
-- SAFETY: DUPLICATE-MAPPING GUARD
-- ─────────────────────────────────────────────────────────────
-- A CONFIGURATION MISTAKE — two different tours both set up with a
-- Civitatis mapping for the same external_product_id AND the same
-- booking_language (e.g. two tours both claiming
-- "Grand Bazaar Experience" + "İtalyanca") — is exactly the ambiguous
-- case the application's matching logic already fails closed on at
-- ingestion time. This migration adds a second, independent guard at
-- the database level: a partial UNIQUE index that makes that specific
-- mistake impossible to save in the first place, for any row that sets
-- a non-null booking_language. Rows with booking_language IS NULL
-- (the generic/default case) are NOT covered by this index — Postgres
-- treats each NULL as distinct in a unique index, so multiple generic
-- rows for the same external_product_id across different tours remain
-- exactly as possible (and exactly as already flagged as an ambiguous
-- match by the application at ingestion time, unchanged) as they are
-- today, pre-migration.
-- ============================================================


-- ──────────────────────────────────────────────────────────────────────────
-- tour_channels: booking_language discriminator column
-- ──────────────────────────────────────────────────────────────────────────

-- Idempotent: ADD COLUMN IF NOT EXISTS. Nullable, no default beyond SQL's
-- own implicit NULL — no existing row is affected; every existing
-- tour_channels row simply has NULL here, which is the correct,
-- permanent "generic mapping" state for any channel configured before
-- this column existed, not a value to be backfilled.
ALTER TABLE public.tour_channels
  ADD COLUMN IF NOT EXISTS booking_language TEXT;

COMMENT ON COLUMN public.tour_channels.booking_language IS
  'Optional: scopes this Civitatis (or any future channel) external_product_id mapping to ONE specific booking language, using the same canonical Turkish language name reservations.tour_language stores (e.g. "İtalyanca", "İspanyolca") — never a code, never free text. NULL (the default) means this mapping is generic and applies regardless of booking language, which is the exact pre-existing behavior for every row created before this column existed. See api/_civitatis/matching.js (matchTourChannel) for the full precedence rule between language-specific and generic mappings for the same external_product_id.';

-- tour_channels_tour_id_source_id_key UNIQUE (tour_id, source_id) — from
-- V1 of this migration — is UNCHANGED and NOT relaxed: a tour still gets
-- at most one Civitatis (or any source) mapping row. Two language
-- variants of the same Civitatis product are two DIFFERENT tours (e.g.
-- the existing Grand Bazaar tour and the new Italian Grand Bazaar tour),
-- each with its own single tour_channels row — exactly how the existing
-- Tour Detail "Satış Kanalları" editor already only ever allows one row
-- per platform per tour. This migration does not need, and does not
-- make, any change to that constraint.

-- Idempotent: IF NOT EXISTS. Database-level backstop (see "SAFETY" above)
-- against two different tours both being configured with the same
-- (source, external_product_id, booking_language) — the exact
-- "duplicate language mapping" misconfiguration the application layer
-- must otherwise catch at ingestion time. Scoped to booking_language IS
-- NOT NULL only, so it can never conflict with any existing (or future
-- generic) row, and can be applied without touching a single existing
-- row.
CREATE UNIQUE INDEX IF NOT EXISTS uq_tour_channels_source_product_language
  ON public.tour_channels (source_id, external_product_id, booking_language)
  WHERE booking_language IS NOT NULL;


-- ── END OF MIGRATION ────────────────────────────────────────────────────────
