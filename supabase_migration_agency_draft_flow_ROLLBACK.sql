-- ============================================================
-- DESE TOUR OPERATIONS CENTER
-- ROLLBACK for: supabase_migration_agency_draft_flow.sql
-- ============================================================
-- File:    supabase_migration_agency_draft_flow_ROLLBACK.sql
-- Restores activity_logs.action to its exact pre-migration definition
-- (without 'outreach_sent'/'draft_created'/'draft_updated') — i.e. the
-- same pre-existing silent-failure behavior for 'outreach_sent' logging
-- the forward migration fixed. As with every other rollback in this
-- repository, a deliberate revert restores the exact PRIOR state,
-- including whatever gap it closed.
--
-- OPERATIONAL CAVEAT (same class as
-- supabase_migration_agency_mailbox_ROLLBACK.sql's own): this rollback
-- will fail if any activity_logs row already has action IN
-- ('outreach_sent','draft_created','draft_updated') at rollback time —
-- Postgres validates ADD CONSTRAINT against every existing row. Applies
-- cleanly only before any such row has actually been written.
--
-- NOT executed against production by this phase; apply by hand after
-- review, and only ever as a deliberate revert of
-- supabase_migration_agency_draft_flow.sql.
-- ============================================================

ALTER TABLE public.activity_logs DROP CONSTRAINT IF EXISTS activity_logs_action_check;
ALTER TABLE public.activity_logs ADD CONSTRAINT activity_logs_action_check
  CHECK (action IN (
    'created','updated','status_changed','deleted','note_added',
    'assigned','payment_received','quote_sent','quote_approved',
    'reservation_confirmed','converted','completed','cancelled',
    'call','reply','deposit','task','login','export'
  ));


-- ──────────────────────────────────────────────────────────────────────────
-- POSTFLIGHT — read-only verification that the constraint is restored.
-- ──────────────────────────────────────────────────────────────────────────
SELECT
  (SELECT pg_get_constraintdef(oid) FROM pg_constraint
     WHERE conrelid = 'public.activity_logs'::regclass
       AND conname = 'activity_logs_action_check')  AS activity_logs_action_check_restored;
