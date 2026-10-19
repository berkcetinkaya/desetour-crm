-- ============================================================
-- DESE TOUR OPERATIONS CENTER
-- Migration: Acenteler (B2B Agency Acquisition) — Phase 1 Foundation
-- ============================================================
-- File:    supabase_migration_agencies.sql
-- Depends: supabase_schema.sql, supabase_rls_policies.sql (already applied)
-- Version: Phase 1 — October 2026
--
-- WHAT THIS ADDS
-- ─────────────────────────────────────────────────────────────
--   1. public.agencies        — B2B tourism-agency directory
--                                ("Acenteler" module), tracked
--                                through a 5-value acquisition
--                                status, not a sales pipeline.
--   2. public.agency_emails   — auditable outbound-email history
--                                for an agency. Created now, per
--                                the architecture audit, so later
--                                phases never need a schema change
--                                just to start logging email — but
--                                NO row is ever written by this
--                                phase. No email is sent, drafted,
--                                or otherwise generated here.
--
-- WHY A NEW TABLE, NOT public.customers OR public.leads
-- ─────────────────────────────────────────────────────────────
-- customers are individual travelers (nationality, personal
-- language, linked reservations/payments) — an agency is a B2B
-- company with none of that shape. leads/quotes are retired from
-- active navigation and, where quotes is concerned, NOT NULL-tied
-- to a lead_id — reusing either would misuse a booking-funnel
-- table for an unrelated acquisition workflow and risk coupling
-- two domains that must stay independent. Mirrors the same
-- reasoning supabase_migration_guides.sql already used for guides
-- vs. staff_users/customers.
--
-- WHY agency_emails IS A SEPARATE TABLE, NOT A JSON COLUMN
-- ─────────────────────────────────────────────────────────────
-- The product brief requires outbound communication to stay
-- auditable — a drafted-then-edited-then-approved email is a real,
-- timestamped event with its own author, not a mutable field on the
-- agency row. A dedicated child table with created_by/created_at
-- gives that for free and is consistent with this project's own
-- existing audit-trail precedent (activity_logs, email_ingestions).
--
-- WHY NO agency_contacts / deals / opportunities / campaign TABLES
-- ─────────────────────────────────────────────────────────────
-- Phase 1's product brief is deliberately minimal: one contact
-- person per agency (a plain column, not a child table), no deal/
-- opportunity objects, no lead scoring, no campaign grouping. Adding
-- any of those now would be exactly the "large sales CRM" the brief
-- explicitly says not to build.
--
-- SAFETY
-- ─────────────────────────────────────────────────────────────
--   • 100% additive: two new tables, zero existing tables altered.
--   • No DROP TABLE, no destructive rewrite, no data migration of
--     any existing rows. The only DROP statements in this file are
--     DROP TRIGGER IF EXISTS / DROP POLICY IF EXISTS immediately
--     followed by CREATE TRIGGER / CREATE POLICY, which redefine an
--     object's behavior but touch zero rows and delete no data.
--   • RLS is enabled on both new tables, reusing the EXISTING
--     is_admin()/is_sales()/is_operations()/is_guide() helper
--     functions from supabase_rls_policies.sql — no new role, no
--     new helper function, no change to staff_users or auth.
--   • Genuinely idempotent: every CREATE TABLE, CREATE INDEX,
--     CREATE TRIGGER, and CREATE POLICY statement in this file can
--     be run a second time without error and without changing the
--     end result.
--
-- HOW TO APPLY
-- ─────────────────────────────────────────────────────────────
-- Supabase Dashboard → SQL Editor → paste and run this file.
-- Run AFTER supabase_schema.sql and supabase_rls_policies.sql.
-- Safe to re-run in full, including triggers and policies.
-- NOT executed as part of this change — review, then apply by hand.
-- ============================================================


-- ──────────────────────────────────────────────────────────────────────────
-- TABLE: agencies
-- B2B tourism-agency directory — the "Acenteler" module.
-- ──────────────────────────────────────────────────────────────────────────

-- Idempotent: IF NOT EXISTS — a second run no-ops if the table already exists.
CREATE TABLE IF NOT EXISTS public.agencies (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  name            TEXT        NOT NULL,
  country         TEXT,
  city            TEXT,
  website         TEXT,
  contact_person  TEXT,
  email           TEXT,
  phone           TEXT,
  -- Plain array, not a relational child table — Phase 1's brief asks for
  -- "languages" as one of several short descriptive fields on the agency
  -- itself, unlike guides' spoken languages (which needed join/lookup
  -- behavior against reservation language requirements). No join is ever
  -- needed here, so a TEXT[] is the smaller, equally-clean model.
  languages       TEXT[],
  -- Why this agency may be a suitable DeseTour partner — free text, set
  -- manually in Phase 1 (no AI/discovery writes this field yet).
  fit_note        TEXT,
  status          TEXT        NOT NULL DEFAULT 'Aday'
                              CHECK (status IN ('Aday','İletişime Geçildi','Görüşülüyor','Partner','Uygun Değil')),
  -- NULL until a real outreach phase sets it — Phase 1 never writes this
  -- column itself (see file header "LAST CONTACT" note in the audit).
  last_contact_at TIMESTAMPTZ,
  internal_notes  TEXT,
  created_by      UUID        REFERENCES public.staff_users(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE  public.agencies         IS 'B2B tourism-agency acquisition directory ("Acenteler"). Tracks a 5-value acquisition status, never a sales pipeline/deal object. Independent of customers (individual travelers) and leads/quotes (retired booking funnel).';
COMMENT ON COLUMN public.agencies.status  IS 'Exactly one of: Aday | İletişime Geçildi | Görüşülüyor | Partner | Uygun Değil. Enforced by CHECK constraint — do not add stages without a matching migration.';
COMMENT ON COLUMN public.agencies.languages IS 'Plain text array of languages this agency operates in, e.g. {"İngilizce","İspanyolca"}. Not a relational child table — see migration file header.';
COMMENT ON COLUMN public.agencies.last_contact_at IS 'NULL until real outreach exists. Never auto-set by Phase 1 — becomes meaningful once email sending (a later phase) updates it.';

-- Idempotent: IF NOT EXISTS.
CREATE INDEX IF NOT EXISTS idx_agencies_status  ON public.agencies(status);
CREATE INDEX IF NOT EXISTS idx_agencies_country ON public.agencies(country);
CREATE INDEX IF NOT EXISTS idx_agencies_name    ON public.agencies(name);

-- Idempotency: CREATE TRIGGER has no IF NOT EXISTS in PostgreSQL, so a
-- second run would fail with "trigger already exists" — guard with an
-- explicit DROP first. This only redefines the trigger's behavior, it
-- does not touch any row in public.agencies. Reuses the EXISTING
-- set_updated_at() function already used by guides/reservations/etc. —
-- no new trigger function is introduced.
DROP TRIGGER IF EXISTS trg_agencies_updated_at ON public.agencies;
CREATE TRIGGER trg_agencies_updated_at
  BEFORE UPDATE ON public.agencies
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- Idempotent: enabling RLS twice is a no-op in PostgreSQL.
ALTER TABLE public.agencies ENABLE ROW LEVEL SECURITY;

-- Idempotency: CREATE POLICY has no IF NOT EXISTS / OR REPLACE in
-- PostgreSQL, so a second run would fail with "policy already exists" —
-- guard every one with DROP POLICY IF EXISTS first. This only redefines
-- the policy's rule, it deletes no rows.
--
-- Role model (per the architecture audit, reusing the EXISTING
-- is_admin()/is_sales()/is_operations()/is_guide() helpers from
-- supabase_rls_policies.sql — no new role, no new helper function):
--   Yönetici (admin)      → full access
--   Satış (sales)         → full access (view/create/edit agencies)
--   Operasyon (operations)→ no access at all
--   Rehber (guide)        → no access at all
-- Unlike guides (where sales/guide both get read-only access because
-- they need guide names for reservation context), there is no symmetric
-- reason for operations or guide to ever see B2B agency-acquisition
-- data, so this table intentionally has no policy for them — RLS with
-- no matching policy denies by default, the same fail-closed posture
-- every other table in this schema already relies on.

-- SELECT/INSERT/UPDATE only, per role — Phase 1 has no delete/archive
-- feature anywhere (AgencyRepository/SupabaseAgencyRepo expose no
-- delete method at all), so DELETE is deliberately left ungranted
-- rather than reached for "for consistency" with FOR ALL. Narrower
-- than guides'/guide_payments' FOR ALL policies on purpose: nothing
-- in this product brief calls for removing an agency row yet, and
-- the smallest working privilege is the safer default until it does.
-- PostgreSQL's CREATE POLICY ... FOR clause takes exactly one command
-- (ALL | SELECT | INSERT | UPDATE | DELETE) — not a comma list — so
-- each allowed command gets its own policy per role, below.

DROP POLICY IF EXISTS "agencies: admin select" ON public.agencies;
CREATE POLICY "agencies: admin select" ON public.agencies FOR SELECT TO authenticated USING ( is_admin() );
DROP POLICY IF EXISTS "agencies: admin insert" ON public.agencies;
CREATE POLICY "agencies: admin insert" ON public.agencies FOR INSERT TO authenticated WITH CHECK ( is_admin() );
DROP POLICY IF EXISTS "agencies: admin update" ON public.agencies;
CREATE POLICY "agencies: admin update" ON public.agencies FOR UPDATE TO authenticated USING ( is_admin() ) WITH CHECK ( is_admin() );

-- Sales: same three commands (view/create/edit — the only staff role
-- that actually runs B2B agency acquisition in Phase 1).
DROP POLICY IF EXISTS "agencies: sales select" ON public.agencies;
CREATE POLICY "agencies: sales select" ON public.agencies FOR SELECT TO authenticated USING ( is_sales() );
DROP POLICY IF EXISTS "agencies: sales insert" ON public.agencies;
CREATE POLICY "agencies: sales insert" ON public.agencies FOR INSERT TO authenticated WITH CHECK ( is_sales() );
DROP POLICY IF EXISTS "agencies: sales update" ON public.agencies;
CREATE POLICY "agencies: sales update" ON public.agencies FOR UPDATE TO authenticated USING ( is_sales() ) WITH CHECK ( is_sales() );


-- ──────────────────────────────────────────────────────────────────────────
-- TABLE: agency_emails
-- Auditable outbound-email history for an agency. Created now so a later
-- phase never needs a schema change just to start logging outreach — but
-- THIS MIGRATION WRITES NO ROWS and Phase 1's application code never
-- calls into this table. No email is sent, drafted, or generated here.
-- ──────────────────────────────────────────────────────────────────────────

-- Idempotent: IF NOT EXISTS — a second run no-ops if the table already exists.
CREATE TABLE IF NOT EXISTS public.agency_emails (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  agency_id   UUID        NOT NULL REFERENCES public.agencies(id) ON DELETE CASCADE,
  direction   TEXT        NOT NULL DEFAULT 'outbound' CHECK (direction IN ('outbound','inbound')),
  subject     TEXT,
  body        TEXT,
  status      TEXT        NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','sent','failed')),
  sent_at     TIMESTAMPTZ,
  created_by  UUID        REFERENCES public.staff_users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE  public.agency_emails        IS 'Auditable outbound-email history for an agency. Phase 1 creates this table but never writes to it — email drafting/sending is a later phase. direction defaults to outbound; inbound is reserved for a possible future reply-tracking phase.';
COMMENT ON COLUMN public.agency_emails.status IS 'draft (prepared, not yet approved/sent) | sent | failed. No automatic follow-up sequences — each row is one human-reviewed, human-approved send.';

-- Idempotent: IF NOT EXISTS.
CREATE INDEX IF NOT EXISTS idx_agency_emails_agency_id ON public.agency_emails(agency_id);
CREATE INDEX IF NOT EXISTS idx_agency_emails_status    ON public.agency_emails(status);

-- No updated_at trigger/column: an outreach email, once logged, is never
-- edited in place — a draft is replaced by a fresh row or transitions
-- status (draft -> sent/failed) in a later phase, never silently rewritten.

-- Idempotent: enabling RLS twice is a no-op in PostgreSQL.
ALTER TABLE public.agency_emails ENABLE ROW LEVEL SECURITY;

-- Same role-only pattern as guide_languages' own policies (see
-- supabase_migration_guides.sql for the full rationale this migration
-- follows): independent calls to the existing role helpers, not an
-- EXISTS(...agencies...) subquery against the parent row, for simpler/
-- cheaper policy evaluation and no inherited coupling to agencies' own
-- predicate if it ever changes.

-- Same SELECT/INSERT/UPDATE-only, per-command-policy shape as agencies
-- above, and the same reasoning: no delete/archive feature exists yet.
DROP POLICY IF EXISTS "agency_emails: admin select" ON public.agency_emails;
CREATE POLICY "agency_emails: admin select" ON public.agency_emails FOR SELECT TO authenticated USING ( is_admin() );
DROP POLICY IF EXISTS "agency_emails: admin insert" ON public.agency_emails;
CREATE POLICY "agency_emails: admin insert" ON public.agency_emails FOR INSERT TO authenticated WITH CHECK ( is_admin() );
DROP POLICY IF EXISTS "agency_emails: admin update" ON public.agency_emails;
CREATE POLICY "agency_emails: admin update" ON public.agency_emails FOR UPDATE TO authenticated USING ( is_admin() ) WITH CHECK ( is_admin() );

DROP POLICY IF EXISTS "agency_emails: sales select" ON public.agency_emails;
CREATE POLICY "agency_emails: sales select" ON public.agency_emails FOR SELECT TO authenticated USING ( is_sales() );
DROP POLICY IF EXISTS "agency_emails: sales insert" ON public.agency_emails;
CREATE POLICY "agency_emails: sales insert" ON public.agency_emails FOR INSERT TO authenticated WITH CHECK ( is_sales() );
DROP POLICY IF EXISTS "agency_emails: sales update" ON public.agency_emails;
CREATE POLICY "agency_emails: sales update" ON public.agency_emails FOR UPDATE TO authenticated USING ( is_sales() ) WITH CHECK ( is_sales() );


-- ──────────────────────────────────────────────────────────────────────────
-- POSTFLIGHT — confirms both tables exist with the expected shape and that
-- nothing else in the schema was touched. Read-only SELECTs only.
-- ──────────────────────────────────────────────────────────────────────────
SELECT
  (SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='public' AND table_name='agencies')       AS agencies_table_exists,
  (SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='public' AND table_name='agency_emails')  AS agency_emails_table_exists,
  (SELECT COUNT(*) FROM information_schema.table_constraints
     WHERE table_schema='public' AND table_name='agencies' AND constraint_type='CHECK')                        AS agencies_check_constraint_count;
