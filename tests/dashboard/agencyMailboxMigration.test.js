'use strict';
/**
 * tests/dashboard/agencyMailboxMigration.test.js
 * ─────────────────────────────────────────────────────────────────────────
 * Regression coverage for supabase_migration_agency_mailbox.sql and its
 * rollback (Agency Mailbox Phase A). NOT YET APPLIED to any database —
 * explicitly withheld pending manual approval. Every test here is a pure,
 * static, never-executed text assertion against the prepared .sql files
 * (the actual schema behavior is separately proven in a disposable local
 * PostgreSQL sandbox — see the implementation report; that exercise is
 * not re-run by this suite, matching the project's standing rule that
 * tests never make a live database connection).
 * ─────────────────────────────────────────────────────────────────────────
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const FORWARD_PATH = path.join(ROOT, 'supabase_migration_agency_mailbox.sql');
const ROLLBACK_PATH = path.join(ROOT, 'supabase_migration_agency_mailbox_ROLLBACK.sql');

const forward = fs.readFileSync(FORWARD_PATH, 'utf8');
const rollback = fs.readFileSync(ROLLBACK_PATH, 'utf8');

const NEW_COLUMNS = [
  'provider', 'provider_message_id', 'provider_thread_id', 'internet_message_id',
  'in_reply_to', 'from_email', 'to_email', 'received_at', 'send_claimed_at',
];

const PRIOR_ENTITY_TYPES = [
  'customer', 'lead', 'quote', 'reservation', 'payment', 'task', 'reminder',
  'tour', 'message', 'settings', 'guide', 'guide_payment', 'reservation_review',
  'tour_language', 'tour_channel', 'civitatis_settlement',
];

// ── A. agency_emails new columns ────────────────────────────────────────

test('every new agency_emails column is added nullable (no NOT NULL, no DEFAULT forcing a value)', () => {
  const idx = forward.indexOf('ALTER TABLE public.agency_emails');
  const end = forward.indexOf(';', idx);
  const stmt = forward.slice(idx, end);
  for (const col of NEW_COLUMNS) {
    assert.match(stmt, new RegExp(`ADD COLUMN IF NOT EXISTS ${col}\\s`), `missing column: ${col}`);
  }
  assert.doesNotMatch(stmt, /NOT NULL/);
});

test('the forward migration touches no column outside the documented 9', () => {
  const idx = forward.indexOf('ALTER TABLE public.agency_emails');
  const end = forward.indexOf(';', idx);
  const stmt = forward.slice(idx, end);
  const matches = stmt.match(/ADD COLUMN IF NOT EXISTS (\w+)/g) || [];
  assert.equal(matches.length, NEW_COLUMNS.length);
});

// ── B. idempotency guard ─────────────────────────────────────────────────

test('provider_message_id gets a partial UNIQUE index, WHERE NOT NULL', () => {
  assert.match(forward, /CREATE UNIQUE INDEX IF NOT EXISTS idx_agency_emails_provider_message_id\s*\n\s*ON public\.agency_emails \(provider_message_id\)\s*\n\s*WHERE provider_message_id IS NOT NULL;/);
});

test('the rollback drops exactly that index', () => {
  assert.match(rollback, /DROP INDEX IF EXISTS idx_agency_emails_provider_message_id;/);
});

// ── C. status widened to add 'received', existing values preserved ─────

test('agency_emails.status CHECK is widened to draft/sent/failed/received, dropping and recreating the exact constraint name', () => {
  assert.match(forward, /DROP CONSTRAINT IF EXISTS agency_emails_status_check/);
  const idx = forward.lastIndexOf('ADD CONSTRAINT agency_emails_status_check');
  const stmt = forward.slice(idx, forward.indexOf(';', idx));
  assert.match(stmt, /'draft'/);
  assert.match(stmt, /'sent'/);
  assert.match(stmt, /'failed'/);
  assert.match(stmt, /'received'/);
});

test('the rollback restores agency_emails.status to exactly draft/sent/failed, without received', () => {
  const idx = rollback.lastIndexOf('ADD CONSTRAINT agency_emails_status_check');
  const stmt = rollback.slice(idx, rollback.indexOf(';', idx));
  assert.match(stmt, /'draft'/);
  assert.match(stmt, /'sent'/);
  assert.match(stmt, /'failed'/);
  assert.doesNotMatch(stmt, /'received'/);
});

// ── D. activity_logs.entity_type — the pre-existing 'agency' bug fix ────

test('activity_logs.entity_type is widened to add agency and agency_email, preserving every prior value', () => {
  const idx = forward.lastIndexOf('ADD CONSTRAINT activity_logs_entity_type_check');
  const stmt = forward.slice(idx, forward.indexOf(';', idx));
  for (const type of PRIOR_ENTITY_TYPES) {
    assert.match(stmt, new RegExp(`'${type}'`), `prior entity_type dropped: ${type}`);
  }
  assert.match(stmt, /'agency'/);
  assert.match(stmt, /'agency_email'/);
});

test('exactly 18 entity_type values after this migration (16 prior + agency + agency_email)', () => {
  const idx = forward.lastIndexOf('ADD CONSTRAINT activity_logs_entity_type_check');
  const stmt = forward.slice(idx, forward.indexOf(';', idx));
  const matches = stmt.match(/'[a-z_]+'/g) || [];
  assert.equal(matches.length, 18);
});

test('the rollback restores activity_logs.entity_type to exactly the prior 16 values, without agency/agency_email', () => {
  const idx = rollback.lastIndexOf('ADD CONSTRAINT activity_logs_entity_type_check');
  const stmt = rollback.slice(idx, rollback.indexOf(';', idx));
  for (const type of PRIOR_ENTITY_TYPES) {
    assert.match(stmt, new RegExp(`'${type}'`));
  }
  assert.doesNotMatch(stmt, /'agency'/);
  assert.doesNotMatch(stmt, /'agency_email'/);
  const matches = stmt.match(/'[a-z_]+'/g) || [];
  assert.equal(matches.length, 16);
});

test('this migration documents the pre-existing agency logging bug it fixes', () => {
  assert.match(forward, /PRE-EXISTING BUG/);
  assert.match(forward, /_sbLog\('agency'/);
});

// ── E. RLS untouched ─────────────────────────────────────────────────────

test('the forward migration contains no CREATE POLICY / DROP POLICY / ALTER POLICY statement at all', () => {
  assert.doesNotMatch(forward, /CREATE POLICY|DROP POLICY|ALTER POLICY/);
});

test('the rollback contains no CREATE POLICY / DROP POLICY / ALTER POLICY statement at all', () => {
  assert.doesNotMatch(rollback, /CREATE POLICY|DROP POLICY|ALTER POLICY/);
});

// ── F. no destructive statement beyond the documented column drops ─────

test('the forward migration contains no DELETE/TRUNCATE/DROP TABLE statement', () => {
  assert.doesNotMatch(forward, /\bDELETE FROM\b|\bTRUNCATE\b|\bDROP TABLE\b/);
});

test('the rollback contains no DELETE/TRUNCATE/DROP TABLE statement — only the documented DROP COLUMN/INDEX/CONSTRAINT reversals', () => {
  assert.doesNotMatch(rollback, /\bDELETE FROM\b|\bTRUNCATE\b|\bDROP TABLE\b/);
});

test('the rollback drops exactly the 9 columns the forward migration added, no more, no fewer', () => {
  const idx = rollback.lastIndexOf('ALTER TABLE public.agency_emails');
  const stmt = rollback.slice(idx, rollback.indexOf(';', idx));
  const matches = stmt.match(/DROP COLUMN IF EXISTS (\w+)/g) || [];
  assert.equal(matches.length, NEW_COLUMNS.length);
  for (const col of NEW_COLUMNS) assert.match(stmt, new RegExp(`DROP COLUMN IF EXISTS ${col}\\b`));
});

// ── G. rollback caveat is documented honestly ───────────────────────────

test('the rollback file documents the proven operational caveat about pre-existing agency/agency_email activity rows', () => {
  assert.match(rollback, /OPERATIONAL CAVEAT/);
  assert.match(rollback, /PROVEN IN THE DISPOSABLE SANDBOX/);
});

// ── H. this migration never touches is_aal2\(\)/get_current_staff_role\(\)/
//      staff_users self-update guard from the prior security phase ──────

test('this migration never redefines any AAL2/role-helper function from the prior security phase', () => {
  for (const fn of ['is_aal2', 'get_current_staff_role', 'is_admin', 'is_sales', 'is_operations', 'is_guide', 'is_staff', 'enforce_staff_self_update_columns']) {
    assert.doesNotMatch(forward, new RegExp(`CREATE (OR REPLACE )?FUNCTION public\\.${fn}\\(`));
  }
});
