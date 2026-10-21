-- ============================================================
-- DESE TOUR OPERATIONS CENTER
-- ROLLBACK for: supabase_migration_agency_mailbox.sql
-- ============================================================
-- File:    supabase_migration_agency_mailbox_ROLLBACK.sql
-- Restores agency_emails and activity_logs to their EXACT pre-migration
-- shape: drops every column this migration added, drops the unique
-- index, and restores both CHECK constraints to their exact prior
-- definitions (including re-dropping 'agency'/'agency_email' from
-- activity_logs.entity_type — i.e. the pre-existing logging bug this
-- migration fixed would be reintroduced by rolling back, which is
-- expected and correct: a rollback restores the exact PRIOR state, bug
-- included, not a hand-picked subset of the forward migration's changes).
--
-- NOT executed against production by this phase; apply by hand after
-- review, and only ever as a deliberate revert of
-- supabase_migration_agency_mailbox.sql.
--
-- OPERATIONAL CAVEAT, PROVEN IN THE DISPOSABLE SANDBOX (not a flaw in
-- this file — real PostgreSQL CHECK-constraint behavior): the
-- activity_logs.entity_type restoration below will FAIL if any row
-- already has entity_type IN ('agency','agency_email') at rollback
-- time — Postgres validates ADD CONSTRAINT against every existing row.
-- Once Phase A has actually run in production and logged even one real
-- outreach_sent event, this rollback can no longer apply cleanly as-is;
-- those rows would need to be deleted or re-typed first, or this one
-- statement skipped, accepting that the entity_type widening (unlike
-- every other change in this file) stays in place. Before Phase A's
-- send endpoint has ever been exercised against production (its
-- intended use — undoing a deployment that is not yet taking live
-- traffic), this rollback applies cleanly with no such row in existence.
-- ============================================================


-- ──────────────────────────────────────────────────────────────────────────
-- Reverse of STEP 2 — restore activity_logs.entity_type to its exact
-- pre-migration definition (without 'agency'/'agency_email').
-- ──────────────────────────────────────────────────────────────────────────
ALTER TABLE public.activity_logs DROP CONSTRAINT IF EXISTS activity_logs_entity_type_check;
ALTER TABLE public.activity_logs ADD CONSTRAINT activity_logs_entity_type_check
  CHECK (entity_type IN (
    'customer','lead','quote','reservation','payment',
    'task','reminder','tour','message','settings',
    'guide','guide_payment','reservation_review',
    'tour_language','tour_channel',
    'civitatis_settlement'
  ));


-- ──────────────────────────────────────────────────────────────────────────
-- Reverse of STEP 1c — restore agency_emails.status to its exact
-- pre-migration definition (without 'received').
-- ──────────────────────────────────────────────────────────────────────────
ALTER TABLE public.agency_emails DROP CONSTRAINT IF EXISTS agency_emails_status_check;
ALTER TABLE public.agency_emails ADD CONSTRAINT agency_emails_status_check
  CHECK (status IN ('draft','sent','failed'));


-- ──────────────────────────────────────────────────────────────────────────
-- Reverse of STEP 1b — drop the provider_message_id uniqueness guard.
-- ──────────────────────────────────────────────────────────────────────────
DROP INDEX IF EXISTS idx_agency_emails_provider_message_id;


-- ──────────────────────────────────────────────────────────────────────────
-- Reverse of STEP 1 — drop every column this migration added. Any row
-- written by Phase A (a real sent email's provider/provider_message_id/
-- etc.) loses that metadata permanently on rollback — acceptable for a
-- deliberate revert of an unreleased phase, exactly as every other
-- rollback file in this repository already accepts for its own
-- additions.
-- ──────────────────────────────────────────────────────────────────────────
ALTER TABLE public.agency_emails
  DROP COLUMN IF EXISTS provider,
  DROP COLUMN IF EXISTS provider_message_id,
  DROP COLUMN IF EXISTS provider_thread_id,
  DROP COLUMN IF EXISTS internet_message_id,
  DROP COLUMN IF EXISTS in_reply_to,
  DROP COLUMN IF EXISTS from_email,
  DROP COLUMN IF EXISTS to_email,
  DROP COLUMN IF EXISTS received_at,
  DROP COLUMN IF EXISTS send_claimed_at;


-- ──────────────────────────────────────────────────────────────────────────
-- POSTFLIGHT — read-only verification that every added column/index is
-- gone and both constraints are restored to their exact prior
-- definitions.
-- ──────────────────────────────────────────────────────────────────────────
SELECT
  (SELECT COUNT(*) FROM information_schema.columns
     WHERE table_schema='public' AND table_name='agency_emails'
       AND column_name IN ('provider','provider_message_id','provider_thread_id',
                            'internet_message_id','in_reply_to','from_email',
                            'to_email','received_at','send_claimed_at'))             AS agency_emails_new_columns_should_be_0,
  (SELECT COUNT(*) FROM pg_indexes
     WHERE schemaname='public' AND indexname='idx_agency_emails_provider_message_id') AS provider_message_id_index_should_be_0,
  (SELECT pg_get_constraintdef(oid) FROM pg_constraint
     WHERE conrelid = 'public.agency_emails'::regclass
       AND conname = 'agency_emails_status_check')                                    AS agency_emails_status_check_restored,
  (SELECT pg_get_constraintdef(oid) FROM pg_constraint
     WHERE conrelid = 'public.activity_logs'::regclass
       AND conname = 'activity_logs_entity_type_check')                               AS activity_logs_entity_type_check_restored;
