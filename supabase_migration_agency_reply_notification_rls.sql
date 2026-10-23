-- ============================================================
-- DESE TOUR OPERATIONS CENTER
-- Migration: Agency Reply Notification RLS Gap (Operational Notifications)
-- ============================================================
-- File:    supabase_migration_agency_reply_notification_rls.sql
-- Depends: supabase_rls_policies.sql, supabase_migration_agency_mailbox.sql
--          (both already applied — the latter is what first allowed
--          entity_type='agency_email' into activity_logs)
--
-- WHY THIS EXISTS — A REAL, PROVEN RLS GAP
-- ─────────────────────────────────────────────────────────────
-- The operational notification feature widened
-- SupabaseActivityRepo.getReservationNotifications() (DeseTourDashboard.jsx)
-- to also read entity_type='agency_email' rows — the ones
-- api/_agencies/gmailInboundSync.js's logInboundReply() writes on every
-- genuinely new inbound Agency reply. Those rows are written with
-- performed_by: null (a system/service-role event, not a staff action),
-- exactly like the pre-existing Civitatis reservation-notification rows.
--
-- The CURRENT activity_logs SELECT policies (supabase_rls_policies.sql:
-- 638-675) are:
--   • "activity_logs: admin read all"       -> is_admin() (unrestricted)
--   • "activity_logs: sales read own"       -> is_sales() AND performed_by = auth.uid()
--   • "activity_logs: operations read own"  -> is_operations() AND
--         (performed_by = auth.uid() OR entity_type IN ('reservation','payment','tour'))
--   • "activity_logs: guide read own"       -> is_guide() AND performed_by = auth.uid()
--
-- Sales (role 'sales', displayed as "Satış") is the one non-admin role
-- with genuine, existing application access to the Agencies module
-- (ROLE_PERMISSIONS["Satış"] includes "agencies" — DeseTourDashboard.jsx).
-- But "activity_logs: sales read own" requires performed_by = auth.uid(),
-- which a system-generated row with performed_by = NULL can never
-- satisfy. No other existing policy covers entity_type='agency_email'
-- either. The practical effect, proven by reading the policies above: a
-- sales-role user gets ZERO rows back for Agency reply notifications —
-- not because of a bug in the application code, but because no RLS
-- policy grants it. Operations and guide are UNAFFECTED by this gap:
-- neither role has "agencies" access in the application at all
-- (ROLE_PERMISSIONS), so they were never expected to see these rows.
--
-- WHAT THIS DOES — ONE NEW, MINIMAL, ADDITIVE POLICY
-- ─────────────────────────────────────────────────────────────
-- Adds exactly one new SELECT policy, scoped as narrowly as the gap
-- itself: sales may read an activity_logs row ONLY when it is a
-- system-generated ("auto_ingested") agency_email event. It does NOT
-- grant sales any broader read access to activity_logs — an arbitrary
-- lead/quote/payment/task row, or a staff-authored agency_email row
-- (e.g. a future manual note logged with performed_by set), remains
-- outside this policy and is not newly readable by it. Mirrors the
-- EXACT existing pattern "activity_logs: operations read own" already
-- uses for its own entity_type special-case (an additional OR branch on
-- top of the same base policy, not a weakening of it).
--
-- WHAT THIS DOES NOT DO
-- ─────────────────────────────────────────────────────────────
--   • Does NOT touch "activity_logs: admin read all" — admin continues
--     to read every row, including these, exactly as before.
--   • Does NOT touch "activity_logs: sales read own", "activity_logs:
--     operations read own", or "activity_logs: guide read own" — each
--     keeps its exact existing USING clause, unmodified.
--   • Does NOT touch "activity_logs: all staff insert", or any INSERT/
--     UPDATE/DELETE behavior on activity_logs.
--   • Does NOT touch activity_log_reads or its own RLS policies at all
--     — the read/unread mechanism (a staff member's own row in
--     activity_log_reads, scoped by "activity_log_reads: staff read
--     own"/"staff insert own") is completely independent of which
--     activity_logs rows a role can see; this migration only widens
--     the SET of agency_email rows sales can see, and activity_log_reads
--     already works identically for ANY activity_logs row a role is
--     permitted to read, Agency-reply rows included.
--   • Does NOT grant operations or guide any new access — neither role
--     has "agencies" application access, and this policy's USING clause
--     checks is_sales() specifically, nothing broader.
--
-- SAFETY
-- ─────────────────────────────────────────────────────────────
--   • Purely additive: a new SELECT policy only ever WIDENS what a role
--     can read (RLS policies are OR'd together per role) — it can never
--     make any existing read narrower for any role, including sales'
--     own pre-existing access to its own activity.
--   • Idempotent: DROP POLICY IF EXISTS + CREATE POLICY, the same
--     pattern every other policy-adding migration in this repository
--     uses (e.g. supabase_migration_civitatis_settlement_phase1.sql).
--   • No table, column, index, or CHECK constraint is touched — no
--     schema change at all, RLS policy text only.
--
-- VALIDATED by static review against the real policy/application logic
-- described above. NOT executed against Supabase by this change — apply
-- by hand after review.
-- ============================================================


-- ──────────────────────────────────────────────────────────────────────────
-- STEP 1: activity_logs — add the missing sales SELECT policy for
-- auto-ingested Agency reply notifications.
-- ──────────────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "activity_logs: sales read agency_email auto_ingested" ON public.activity_logs;
CREATE POLICY "activity_logs: sales read agency_email auto_ingested"
  ON public.activity_logs FOR SELECT TO authenticated
  USING (
    is_sales()
    AND entity_type = 'agency_email'
    AND metadata->>'auto_ingested' = 'true'
  );


-- ──────────────────────────────────────────────────────────────────────────
-- POSTFLIGHT — read-only verification that the new policy exists with
-- the exact intended definition, and that every pre-existing
-- activity_logs/activity_log_reads policy is still present and unchanged
-- in count. Does not inspect row data, does not modify anything.
-- ──────────────────────────────────────────────────────────────────────────
SELECT
  (SELECT COUNT(*) FROM pg_policies
     WHERE schemaname='public' AND tablename='activity_logs'
       AND policyname='activity_logs: sales read agency_email auto_ingested')  AS new_policy_exists_should_be_1,
  (SELECT pg_get_expr(polqual, polrelid) FROM pg_policy
     WHERE polrelid = 'public.activity_logs'::regclass
       AND polname = 'activity_logs: sales read agency_email auto_ingested')  AS new_policy_using_clause,
  (SELECT COUNT(*) FROM pg_policies
     WHERE schemaname='public' AND tablename='activity_logs')                AS activity_logs_total_policy_count_should_be_6,
  (SELECT COUNT(*) FROM pg_policies
     WHERE schemaname='public' AND tablename='activity_log_reads')           AS activity_log_reads_policy_count_unchanged;
