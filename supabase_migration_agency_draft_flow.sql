-- ============================================================
-- DESE TOUR OPERATIONS CENTER
-- Migration: Agency Draft Flow completion — activity_logs.action fix
-- ============================================================
-- File:    supabase_migration_agency_draft_flow.sql
-- Depends: supabase_migration_agency_mailbox.sql (already applied in
--          production — widened activity_logs.entity_type to include
--          'agency'/'agency_email', which this migration relies on but
--          does not touch again)
--
-- WHY THIS EXISTS
-- ─────────────────────────────────────────────────────────────
-- FOUND DURING THIS PHASE'S AUDIT OF THE DRAFT-CREATION FLOW: the
-- released v12.46 Agency Mailbox Phase A send endpoint
-- (api/agency-send-email.js) has, since release, been inserting an
-- activity_logs row with action = 'outreach_sent' on every successful
-- send — but activity_logs.action's CHECK constraint (defined inline in
-- supabase_schema.sql, never once widened by any prior migration, unlike
-- entity_type) only ever allowed:
--   created, updated, status_changed, deleted, note_added, assigned,
--   payment_received, quote_sent, quote_approved, reservation_confirmed,
--   converted, completed, cancelled, call, reply, deposit, task, login,
--   export
-- 'outreach_sent' is not in that list. Exactly like the pre-existing
-- 'agency' entity_type gap fixed in supabase_migration_agency_mailbox.sql,
-- this has been silently failing in production ever since v12.46 shipped
-- — logOutreachSent() in api/agency-send-email.js wraps the insert in a
-- try/catch that only logs to console.error, never surfaces the failure,
-- so every real send to date has recorded NO activity_logs row at all,
-- even though the send itself succeeded correctly. This migration fixes
-- that, and additively allows the two new draft-flow events this same
-- phase introduces client-side (DeseTourDashboard.jsx's _sbLog calls):
-- 'draft_created' and 'draft_updated'.
--
-- WHAT THIS DOES
-- ─────────────────────────────────────────────────────────────
-- Widens activity_logs.action to add exactly 'outreach_sent',
-- 'draft_created', 'draft_updated' — purely additive, every previously
-- allowed action value remains allowed, the exact same pattern every
-- prior widening of activity_logs.entity_type in this schema has used
-- (tour_channels/guides/reviews/civitatis_settlement_phase1/
-- agency_mailbox), applied here to the action column instead.
--
-- RLS: untouched — this column has no RLS-relevant role check anywhere;
-- the CHECK constraint is a data-shape rule, not an authorization rule.
--
-- VALIDATED in a disposable local PostgreSQL sandbox (never against
-- production) — see the implementation report for the exact scenarios
-- and results. NOT executed against Supabase by this phase; apply by
-- hand after review.
-- ============================================================


-- ──────────────────────────────────────────────────────────────────────────
-- STEP 1: activity_logs.action — add outreach_sent, draft_created,
-- draft_updated. Every previously allowed value preserved exactly.
-- ──────────────────────────────────────────────────────────────────────────
ALTER TABLE public.activity_logs DROP CONSTRAINT IF EXISTS activity_logs_action_check;
ALTER TABLE public.activity_logs ADD CONSTRAINT activity_logs_action_check
  CHECK (action IN (
    'created','updated','status_changed','deleted','note_added',
    'assigned','payment_received','quote_sent','quote_approved',
    'reservation_confirmed','converted','completed','cancelled',
    'call','reply','deposit','task','login','export',
    'outreach_sent','draft_created','draft_updated'
  ));


-- ──────────────────────────────────────────────────────────────────────────
-- POSTFLIGHT — read-only verification that the constraint now includes
-- the three new values and nothing else was touched.
-- ──────────────────────────────────────────────────────────────────────────
SELECT
  (SELECT pg_get_constraintdef(oid) FROM pg_constraint
     WHERE conrelid = 'public.activity_logs'::regclass
       AND conname = 'activity_logs_action_check')  AS activity_logs_action_check_definition;
