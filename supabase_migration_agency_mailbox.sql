-- ============================================================
-- DESE TOUR OPERATIONS CENTER
-- Migration: Agency Mailbox Phase A — Gmail send persistence + schema fix
-- ============================================================
-- File:    supabase_migration_agency_mailbox.sql
-- Depends: supabase_migration_agencies.sql, supabase_migration_aal2_enforcement.sql
--          (both already applied)
--
-- WHAT THIS DOES
-- ─────────────────────────────────────────────────────────────
--   1. Extends agency_emails with the provider-sync metadata needed to
--      record a real Gmail send and (in a later phase) match a reply to
--      it — provider, provider_message_id, provider_thread_id,
--      internet_message_id, in_reply_to, from_email, to_email,
--      received_at. All nullable — every existing row stays valid as-is.
--   2. Adds a partial UNIQUE index on provider_message_id (WHERE NOT
--      NULL) — the idempotency guard against the same Gmail message ever
--      being recorded twice, the exact same pattern email_ingestions'
--      own UNIQUE gmail_message_id column already uses.
--   3. Adds send_claimed_at — the minimal atomic "claim" column the send
--      endpoint uses to prevent a double-click/retry/duplicate POST from
--      sending the same draft twice. See api/agency-send-email.js for
--      the exact claim/release protocol; this column has no CHECK
--      constraint and is never read by RLS.
--   4. Widens agency_emails.status to additionally allow 'received' —
--      reserved for a future inbound-sync phase; Phase A itself never
--      writes this value. 'draft', 'sent', 'failed' remain exactly as
--      before.
--   5. Widens activity_logs.entity_type to add 'agency' and
--      'agency_email' — FIXES A PRE-EXISTING BUG found during the Agency
--      Mailbox architecture audit: DeseTourDashboard.jsx has already been
--      calling _sbLog('agency', ...) on every agency create/update since
--      Acenteler Phase 1, but 'agency' was never in this CHECK constraint
--      — every one of those activity_logs inserts has been silently
--      failing in production (_sbLog swallows the error into
--      console.error only). This migration adds 'agency' for that
--      reason, and 'agency_email' for this phase's own outreach_sent/
--      outreach_failed events. Every previously allowed value remains
--      allowed — purely additive, the same pattern tour_channels/guides/
--      reviews/civitatis_settlement_phase1 already established.
--
-- RLS: no policy text changes. agency_emails' existing admin/sales
-- SELECT/INSERT/UPDATE policies (supabase_migration_agencies.sql) are
-- row-level, not column-level — they already cover every new column
-- added here with no edit needed. The send endpoint's own persistence
-- write happens via the service_role key (bypasses RLS entirely, the
-- same established pattern as every Civitatis write path), never via an
-- authenticated staff session's own UPDATE.
--
-- VALIDATED in a disposable local PostgreSQL sandbox (never against
-- production) — see the implementation report for the exact scenarios
-- and results. NOT executed against Supabase by this phase; apply by
-- hand after review.
-- ============================================================


-- ──────────────────────────────────────────────────────────────────────────
-- STEP 1: agency_emails — provider-sync columns (all nullable, additive)
-- ──────────────────────────────────────────────────────────────────────────
ALTER TABLE public.agency_emails
  ADD COLUMN IF NOT EXISTS provider             TEXT,
  ADD COLUMN IF NOT EXISTS provider_message_id   TEXT,
  ADD COLUMN IF NOT EXISTS provider_thread_id    TEXT,
  ADD COLUMN IF NOT EXISTS internet_message_id   TEXT,
  ADD COLUMN IF NOT EXISTS in_reply_to            TEXT,
  ADD COLUMN IF NOT EXISTS from_email             TEXT,
  ADD COLUMN IF NOT EXISTS to_email               TEXT,
  ADD COLUMN IF NOT EXISTS received_at            TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS send_claimed_at         TIMESTAMPTZ;

COMMENT ON COLUMN public.agency_emails.provider             IS 'Which provider actually sent/received this message, e.g. ''gmail''. NULL for rows that predate this migration (draft-only, never sent).';
COMMENT ON COLUMN public.agency_emails.provider_message_id  IS 'The provider''s own message id (Gmail''s message id). Unique where not null — see idx_agency_emails_provider_message_id below; the idempotency guard against recording the same provider message twice.';
COMMENT ON COLUMN public.agency_emails.provider_thread_id   IS 'The provider''s own conversation/thread id (Gmail''s threadId). Reserved for the Phase B reply-matching hierarchy''s first, most reliable tier.';
COMMENT ON COLUMN public.agency_emails.internet_message_id  IS 'The RFC 2822 Message-ID header value Gmail actually assigned on send, fetched back from Gmail after send — never fabricated client-side. NULL if that follow-up fetch itself failed; sendability/sent status never depends on this value.';
COMMENT ON COLUMN public.agency_emails.in_reply_to          IS 'Reserved for Phase B: an inbound reply''s In-Reply-To header, for the reply-matching hierarchy''s second tier. Never written by Phase A.';
COMMENT ON COLUMN public.agency_emails.from_email           IS 'The actual sender address used for this specific message (hello@desetour.com for every Phase A outbound send).';
COMMENT ON COLUMN public.agency_emails.to_email             IS 'The actual recipient address this specific message was sent to (the agency''s own contact email at send time, captured verbatim rather than relying on a later join to agencies.email, which may change).';
COMMENT ON COLUMN public.agency_emails.received_at          IS 'Reserved for Phase B: when an inbound message was actually received, per the provider''s own timestamp. Never written by Phase A (outbound-only).';
COMMENT ON COLUMN public.agency_emails.send_claimed_at      IS 'Set atomically by api/agency-send-email.js the instant it begins a real send attempt on a draft row, and used as the sole guard against a double-click/browser retry/duplicate POST sending the same draft twice. Cleared back to NULL only if Gmail itself never accepted the message (safe to retry); left set if Gmail accepted it but something afterward failed (the dangerous partial-success case — never auto-retried). Not part of any CHECK constraint and not read by any RLS policy.';

-- STEP 1b: idempotency guard — the same Gmail message can never be
-- recorded on two different agency_emails rows. Partial index so the
-- many pre-existing (and future draft) rows with NULL provider_message_id
-- are completely unaffected.
CREATE UNIQUE INDEX IF NOT EXISTS idx_agency_emails_provider_message_id
  ON public.agency_emails (provider_message_id)
  WHERE provider_message_id IS NOT NULL;

-- STEP 1c: status widened to add 'received' (reserved for Phase B).
-- 'draft'/'sent'/'failed' remain exactly as before — purely additive.
ALTER TABLE public.agency_emails DROP CONSTRAINT IF EXISTS agency_emails_status_check;
ALTER TABLE public.agency_emails ADD CONSTRAINT agency_emails_status_check
  CHECK (status IN ('draft','sent','failed','received'));


-- ──────────────────────────────────────────────────────────────────────────
-- STEP 2: activity_logs.entity_type — fix the pre-existing 'agency' gap,
-- add 'agency_email' for this phase's own events. Purely additive; every
-- previously allowed value (customer, lead, quote, reservation, payment,
-- task, reminder, tour, message, settings, guide, guide_payment,
-- reservation_review, tour_language, tour_channel, civitatis_settlement)
-- remains allowed, exactly as the same pattern every prior migration that
-- has touched this constraint has done.
-- ──────────────────────────────────────────────────────────────────────────
ALTER TABLE public.activity_logs DROP CONSTRAINT IF EXISTS activity_logs_entity_type_check;
ALTER TABLE public.activity_logs ADD CONSTRAINT activity_logs_entity_type_check
  CHECK (entity_type IN (
    'customer','lead','quote','reservation','payment',
    'task','reminder','tour','message','settings',
    'guide','guide_payment','reservation_review',
    'tour_language','tour_channel',
    'civitatis_settlement',
    'agency','agency_email'
  ));


-- ──────────────────────────────────────────────────────────────────────────
-- POSTFLIGHT — read-only verification that every new column/index/
-- constraint exists and no previously allowed value was dropped. Does
-- not inspect row data beyond information_schema/pg_catalog, does not
-- modify anything.
-- ──────────────────────────────────────────────────────────────────────────
SELECT
  (SELECT COUNT(*) FROM information_schema.columns
     WHERE table_schema='public' AND table_name='agency_emails'
       AND column_name IN ('provider','provider_message_id','provider_thread_id',
                            'internet_message_id','in_reply_to','from_email',
                            'to_email','received_at','send_claimed_at'))             AS agency_emails_new_columns_count_should_be_9,
  (SELECT COUNT(*) FROM pg_indexes
     WHERE schemaname='public' AND indexname='idx_agency_emails_provider_message_id') AS provider_message_id_unique_index_exists,
  (SELECT pg_get_constraintdef(oid) FROM pg_constraint
     WHERE conrelid = 'public.agency_emails'::regclass
       AND conname = 'agency_emails_status_check')                                    AS agency_emails_status_check_definition,
  (SELECT pg_get_constraintdef(oid) FROM pg_constraint
     WHERE conrelid = 'public.activity_logs'::regclass
       AND conname = 'activity_logs_entity_type_check')                               AS activity_logs_entity_type_check_definition;
