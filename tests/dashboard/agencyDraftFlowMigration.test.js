'use strict';
/**
 * tests/dashboard/agencyDraftFlowMigration.test.js
 * ─────────────────────────────────────────────────────────────────────────
 * Regression coverage for supabase_migration_agency_draft_flow.sql and its
 * rollback — fixes the pre-existing activity_logs.action gap discovered
 * while completing the Agency Draft Flow (api/agency-send-email.js has
 * been inserting action='outreach_sent' since v12.46, silently failing
 * against the CHECK constraint ever since). NOT YET APPLIED to any
 * database — explicitly withheld pending manual approval. Every test here
 * is a pure, static, never-executed text assertion against the prepared
 * .sql files (the actual constraint behavior is separately proven in a
 * disposable local PostgreSQL sandbox — see the implementation report;
 * that exercise is not re-run by this suite).
 * ─────────────────────────────────────────────────────────────────────────
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const FORWARD_PATH = path.join(ROOT, 'supabase_migration_agency_draft_flow.sql');
const ROLLBACK_PATH = path.join(ROOT, 'supabase_migration_agency_draft_flow_ROLLBACK.sql');

const forward = fs.readFileSync(FORWARD_PATH, 'utf8');
const rollback = fs.readFileSync(ROLLBACK_PATH, 'utf8');

const PRIOR_ACTIONS = [
  'created', 'updated', 'status_changed', 'deleted', 'note_added',
  'assigned', 'payment_received', 'quote_sent', 'quote_approved',
  'reservation_confirmed', 'converted', 'completed', 'cancelled',
  'call', 'reply', 'deposit', 'task', 'login', 'export',
];

test('activity_logs.action is widened to add outreach_sent/draft_created/draft_updated, preserving every prior value', () => {
  const idx = forward.lastIndexOf('ADD CONSTRAINT activity_logs_action_check');
  const stmt = forward.slice(idx, forward.indexOf(';', idx));
  for (const action of PRIOR_ACTIONS) {
    assert.match(stmt, new RegExp(`'${action}'`), `prior action dropped: ${action}`);
  }
  assert.match(stmt, /'outreach_sent'/);
  assert.match(stmt, /'draft_created'/);
  assert.match(stmt, /'draft_updated'/);
});

test('exactly 22 action values after this migration (19 prior + 3 new)', () => {
  const idx = forward.lastIndexOf('ADD CONSTRAINT activity_logs_action_check');
  const stmt = forward.slice(idx, forward.indexOf(';', idx));
  const matches = stmt.match(/'[a-z_]+'/g) || [];
  assert.equal(matches.length, 22);
});

test('the rollback restores activity_logs.action to exactly the prior 19 values, without the 3 new ones', () => {
  const idx = rollback.lastIndexOf('ADD CONSTRAINT activity_logs_action_check');
  const stmt = rollback.slice(idx, rollback.indexOf(';', idx));
  for (const action of PRIOR_ACTIONS) {
    assert.match(stmt, new RegExp(`'${action}'`));
  }
  assert.doesNotMatch(stmt, /'outreach_sent'/);
  assert.doesNotMatch(stmt, /'draft_created'/);
  assert.doesNotMatch(stmt, /'draft_updated'/);
  const matches = stmt.match(/'[a-z_]+'/g) || [];
  assert.equal(matches.length, 19);
});

test('this migration documents the pre-existing outreach_sent logging bug it fixes', () => {
  assert.match(forward, /FOUND DURING THIS PHASE'S AUDIT/);
  assert.match(forward, /outreach_sent/);
  assert.match(forward, /api\/agency-send-email\.js/);
});

test('the rollback documents the same operational caveat class as the agency_mailbox rollback', () => {
  assert.match(rollback, /OPERATIONAL CAVEAT/);
});

test('neither file touches the entity_type constraint, RLS policies, or any AAL2/role-helper function', () => {
  for (const text of [forward, rollback]) {
    assert.doesNotMatch(text, /activity_logs_entity_type_check/);
    assert.doesNotMatch(text, /CREATE POLICY|DROP POLICY|ALTER POLICY/);
    for (const fn of ['is_aal2', 'get_current_staff_role', 'is_admin', 'is_sales', 'is_operations', 'is_guide', 'is_staff']) {
      assert.doesNotMatch(text, new RegExp(`CREATE (OR REPLACE )?FUNCTION public\\.${fn}\\(`));
    }
  }
});

test('neither file contains a destructive DELETE/TRUNCATE/DROP TABLE statement', () => {
  for (const text of [forward, rollback]) {
    assert.doesNotMatch(text, /\bDELETE FROM\b|\bTRUNCATE\b|\bDROP TABLE\b/);
  }
});
