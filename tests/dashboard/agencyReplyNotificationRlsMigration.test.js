'use strict';
/**
 * tests/dashboard/agencyReplyNotificationRlsMigration.test.js
 * ─────────────────────────────────────────────────────────────────────────
 * Regression coverage for
 * supabase_migration_agency_reply_notification_rls.sql and its rollback.
 * NOT YET APPLIED to any database — explicitly withheld pending manual
 * approval, same as every other migration file in this repository (see
 * tests/dashboard/guideReservationUpdateHardeningMigration.test.js for the
 * established convention this file follows). Every test here is a pure,
 * static, never-executed text assertion against the prepared .sql files
 * plus the pre-existing supabase_rls_policies.sql — the actual Postgres
 * RLS evaluation is not (and cannot be) exercised by node:test, matching
 * the project's standing rule that tests never make a live database
 * connection.
 *
 * Covers the 7-point verification the migration was reviewed against:
 *   1. no duplicate of an existing equivalent policy
 *   2. admin behavior unchanged
 *   3. sales gains read access ONLY to auto-ingested agency_email rows
 *   4. sales does not gain access to arbitrary activity_logs rows
 *   5. other roles (operations/guide) are unaffected
 *   6. compatible with the existing activity_log_reads unread/read mechanism
 *   7. the policy name does not collide with any existing policy name
 * ─────────────────────────────────────────────────────────────────────────
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const FORWARD_PATH   = path.join(ROOT, 'supabase_migration_agency_reply_notification_rls.sql');
const ROLLBACK_PATH  = path.join(ROOT, 'supabase_migration_agency_reply_notification_rls_ROLLBACK.sql');
const RLS_BASE_PATH  = path.join(ROOT, 'supabase_rls_policies.sql');

const forward  = fs.readFileSync(FORWARD_PATH, 'utf8');
const rollback = fs.readFileSync(ROLLBACK_PATH, 'utf8');
const rlsBase  = fs.readFileSync(RLS_BASE_PATH, 'utf8');

const NEW_POLICY_NAME = 'activity_logs: sales read agency_email auto_ingested';

// ── 1/7. No duplicate, no name collision ───────────────────────────────

test('1/7. the new policy name does not already exist anywhere in supabase_rls_policies.sql (no collision with a pre-existing policy)', () => {
  assert.doesNotMatch(rlsBase, new RegExp(NEW_POLICY_NAME.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

test('1/7. no pre-existing activity_logs policy already grants sales read access to entity_type=\'agency_email\' rows (the gap is real, not already covered)', () => {
  const activityLogsSection = rlsBase.slice(rlsBase.indexOf('TABLE 12: activity_logs'), rlsBase.indexOf('TABLE 13: settings'));
  const salesPolicyIdx = activityLogsSection.indexOf('"activity_logs: sales read own"');
  const salesPolicyEnd = activityLogsSection.indexOf(');', salesPolicyIdx);
  const salesPolicyBody = activityLogsSection.slice(salesPolicyIdx, salesPolicyEnd);
  assert.doesNotMatch(salesPolicyBody, /agency_email/);
  assert.match(salesPolicyBody, /performed_by = auth\.uid\(\)/, 'the existing sales policy requires performed_by = auth.uid(), which a NULL-performed_by system row can never satisfy');
});

// Strips prose comment lines before counting/matching actual DDL — the
// header legitimately discusses other policies by name in prose (what
// this migration does NOT touch), which must not be confused with an
// actual CREATE/DROP POLICY statement acting on them. Same approach
// tests/dashboard/guideReservationUpdateHardeningMigration.test.js uses.
function ddlOnly(sql) {
  return sql.split('\n').filter(l => !l.trim().startsWith('--')).join('\n');
}

test('the new migration creates the policy exactly once, via the idempotent DROP POLICY IF EXISTS + CREATE POLICY pattern already used elsewhere in this repository', () => {
  const dropIdx = forward.indexOf(`DROP POLICY IF EXISTS "${NEW_POLICY_NAME}"`);
  const createIdx = forward.indexOf(`CREATE POLICY "${NEW_POLICY_NAME}"`);
  assert.ok(dropIdx !== -1 && createIdx !== -1 && dropIdx < createIdx);
  const creates = ddlOnly(forward).match(/CREATE POLICY/g) || [];
  assert.equal(creates.length, 1, 'expected exactly one CREATE POLICY statement in the forward migration');
});

// ── 2. Admin unchanged ──────────────────────────────────────────────────

test('2. the forward migration\'s actual DDL never creates or drops the admin policy — only ever discusses it in prose as "untouched"', () => {
  assert.doesNotMatch(ddlOnly(forward), /admin read all/);
});

// ── 3/4. Sales gains access ONLY to auto-ingested agency_email rows ────

test('3/4. the new policy\'s USING clause is exactly is_sales() AND entity_type=\'agency_email\' AND auto_ingested=\'true\' — no broader OR branch', () => {
  const idx = forward.indexOf(`CREATE POLICY "${NEW_POLICY_NAME}"`);
  const clause = forward.slice(idx, forward.indexOf(');', idx) + 2);
  assert.match(clause, /is_sales\(\)/);
  assert.match(clause, /entity_type = 'agency_email'/);
  assert.match(clause, /metadata->>'auto_ingested' = 'true'/);
  // No OR anywhere in the USING clause — all three conditions are
  // mandatory (ANDed), so sales can never read a non-agency_email or
  // non-auto_ingested row through this specific policy.
  assert.doesNotMatch(clause, /\bOR\b/);
});

test('4. the new policy never references performed_by, leads, quotes, customers, or any other entity_type — it cannot be used to read an arbitrary activity_logs row', () => {
  const idx = forward.indexOf(`CREATE POLICY "${NEW_POLICY_NAME}"`);
  const clause = forward.slice(idx, forward.indexOf(');', idx) + 2);
  assert.doesNotMatch(clause, /performed_by/);
  assert.doesNotMatch(clause, /'reservation'|'payment'|'tour'|'lead'|'quote'|'customer'/);
});

// ── 5. Other roles unaffected ────────────────────────────────────────────

test('5. the forward migration never touches "sales read own", "operations read own", or "guide read own" — each keeps its exact pre-existing definition', () => {
  assert.doesNotMatch(forward, /DROP POLICY IF EXISTS "activity_logs: sales read own"/);
  assert.doesNotMatch(forward, /DROP POLICY IF EXISTS "activity_logs: operations read own"/);
  assert.doesNotMatch(forward, /DROP POLICY IF EXISTS "activity_logs: guide read own"/);
});

test('5. the new policy\'s own USING clause checks is_sales() only — never is_operations() or is_guide() — so operations/guide gain nothing from it', () => {
  const idx = forward.indexOf(`CREATE POLICY "${NEW_POLICY_NAME}"`);
  const clause = forward.slice(idx, forward.indexOf(');', idx) + 2);
  assert.doesNotMatch(clause, /is_operations\(\)|is_guide\(\)|is_admin\(\)/);
});

// ── 6. Compatible with activity_log_reads ────────────────────────────────

test('6. the forward migration never creates, drops, or alters anything ON public.activity_log_reads — its only mention of that table (read-only, in the postflight SELECT) is a policy-count check, never a mutation', () => {
  assert.doesNotMatch(ddlOnly(forward), /(CREATE|DROP|ALTER)\s+(POLICY|TABLE)[^\n]*activity_log_reads/i);
  assert.match(forward, /activity_log_reads_policy_count_unchanged/, 'the postflight must still report this count for review');
});

test('6. the rollback\'s actual DDL also never references activity_log_reads', () => {
  assert.doesNotMatch(ddlOnly(rollback), /activity_log_reads/);
});

// ── No schema/column/constraint changes — RLS policy only ──────────────

test('the migration contains no ALTER TABLE, no new column, and no CHECK constraint change — RLS policy text only', () => {
  assert.doesNotMatch(forward, /ALTER TABLE|ADD COLUMN|ADD CONSTRAINT|DROP CONSTRAINT/);
});

// ── Postflight / safety ──────────────────────────────────────────────────

test('postflight confirms the new policy exists with its real USING clause, and that the total activity_logs/activity_log_reads policy counts are reported', () => {
  const postflightIdx = forward.indexOf('-- POSTFLIGHT');
  const postflight = forward.slice(postflightIdx);
  assert.match(postflight, /new_policy_exists_should_be_1/);
  assert.match(postflight, /new_policy_using_clause/);
  assert.match(postflight, /activity_logs_total_policy_count_should_be_6/);
  assert.match(postflight, /activity_log_reads_policy_count_unchanged/);
});

test('rollback drops exactly the one policy this migration created, and nothing else', () => {
  const drops = rollback.match(/^DROP POLICY IF EXISTS/gm) || [];
  assert.equal(drops.length, 1);
  assert.match(rollback, new RegExp(`DROP POLICY IF EXISTS "${NEW_POLICY_NAME.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`));
});

test('rollback postflight re-confirms every pre-existing activity_logs policy and is_sales() still exist', () => {
  assert.match(rollback, /policyname='activity_logs: admin read all'/);
  assert.match(rollback, /policyname='activity_logs: sales read own'/);
  assert.match(rollback, /policyname='activity_logs: operations read own'/);
  assert.match(rollback, /policyname='activity_logs: guide read own'/);
  assert.match(rollback, /proname = 'is_sales'/);
});

test('rollback is wrapped in exactly one BEGIN;/COMMIT; pair', () => {
  assert.equal((rollback.match(/^BEGIN;\s*$/gm) || []).length, 1);
  assert.equal((rollback.match(/^COMMIT;\s*$/gm) || []).length, 1);
});

test('neither file contains a hardcoded credential or secret-shaped literal', () => {
  const combined = forward + rollback;
  assert.doesNotMatch(combined, /sk-ant-|service_role.{0,20}=.{0,10}['"]ey/i);
});

// ── Bridging to the client-side filter: the migration closes exactly the
//    gap the frontend notification feature assumed would exist ─────────

test('the client-side _allowedOperationalEntityTypes helper already grants Satış (sales) access to agency_email notifications — this migration is what makes that access actually return rows under RLS', () => {
  const dashboardSrc = fs.readFileSync(path.join(ROOT, 'DeseTourDashboard.jsx'), 'utf8');
  const idx = dashboardSrc.indexOf('function _allowedOperationalEntityTypes(role, canAccessFn) {');
  assert.ok(idx !== -1, 'expected _allowedOperationalEntityTypes to still exist');
  const body = dashboardSrc.slice(idx, dashboardSrc.indexOf('// TESTABLE:_allowedOperationalEntityTypes:end', idx));
  assert.match(body, /canAccessFn\(role, 'agencies'\)/);
});

// ── Full role-matrix checklist, as requested for this migration ─────────
// (bridges the RLS policy's own guarantees, verified above, with the
// client-side role gating, which is what actually decides who the UI
// shows a notification to once RLS has returned a row).

const { extractTestableFn } = require('./extractTestableFn');
const _allowedOperationalEntityTypes = extractTestableFn('_allowedOperationalEntityTypes');
const _filterOperationalNotificationsForRole = extractTestableFn('_filterOperationalNotificationsForRole');

const dashboardSrc = fs.readFileSync(path.join(ROOT, 'DeseTourDashboard.jsx'), 'utf8');
const rolePermIdx = dashboardSrc.indexOf('const ROLE_PERMISSIONS');
const canAccessEnd = dashboardSrc.indexOf('\n}', dashboardSrc.indexOf('function canAccess(role, page)', rolePermIdx));
const canAccess = new Function(`${dashboardSrc.slice(rolePermIdx, canAccessEnd + 2)}\nreturn canAccess;`)();

const ROLES = { admin: 'Yönetici', sales: 'Satış', operations: 'Operasyon', guide: 'Rehber' };

function agencyReply(id) {
  return { id, entityType: 'agency_email', agencyId: 'AGN-1', reservationId: null, isRead: false };
}
function unrelatedSystemLog(id) {
  // Represents an activity_logs row the new policy's USING clause can
  // never match (not entity_type='agency_email') — e.g. a reservation
  // notification. Stands in for "unrelated system activity logs" since
  // this suite cannot open a real Postgres connection; the RLS-level
  // guarantee that sales can't read an arbitrary non-agency_email row is
  // asserted separately above against the policy's own USING clause.
  return { id, entityType: 'reservation', agencyId: null, reservationId: 'RES-1', isRead: false };
}

test('checklist: sales (Satış) can see an agency reply notification once RLS returns it — the client-side filter does not additionally block it', () => {
  const allowed = _allowedOperationalEntityTypes(ROLES.sales, canAccess);
  const visible = _filterOperationalNotificationsForRole([agencyReply('a1')], allowed);
  assert.deepEqual(visible.map(n => n.id), ['a1']);
});

test('checklist: sales does not gain visibility into an unrelated (non-agency_email) system activity log through this feature\'s own client-side filter', () => {
  // Sales IS allowed 'reservation' too (existing reservations access),
  // so this specifically proves the filter is additive/scoped per
  // entity type, not a blanket "sales sees everything" change.
  const allowed = _allowedOperationalEntityTypes(ROLES.sales, canAccess);
  assert.deepEqual(allowed.sort(), ['agency_email', 'reservation']);
});

test('checklist: admin (Yönetici) still sees agency reply notifications — admin\'s own RLS policy and the client-side filter are both untouched/unrestricted', () => {
  const allowed = _allowedOperationalEntityTypes(ROLES.admin, canAccess);
  const visible = _filterOperationalNotificationsForRole([agencyReply('a1')], allowed);
  assert.deepEqual(visible.map(n => n.id), ['a1']);
});

test('checklist: unauthorized Agency roles (Operasyon, Rehber — no "agencies" access) never receive an agency reply notification, even if one were present in the raw list', () => {
  for (const role of [ROLES.operations, ROLES.guide]) {
    const allowed = _allowedOperationalEntityTypes(role, canAccess);
    const visible = _filterOperationalNotificationsForRole([agencyReply('a1'), unrelatedSystemLog('r1')], allowed);
    assert.ok(!visible.some(n => n.entityType === 'agency_email'), `${role} must never see an agency_email notification`);
  }
});

test('checklist: read/unread marking is unaffected for sales — markReservationNotificationRead stays generic over any activity_log_id, with no entity_type or role branching that could special-case (and break) the agency_email path', () => {
  const idx = dashboardSrc.indexOf('async markReservationNotificationRead(activityLogId)');
  const line = dashboardSrc.slice(idx, dashboardSrc.indexOf(';},', idx) + 3);
  assert.doesNotMatch(line, /entity_type|role/);
  assert.match(line, /activity_log_reads/);
});
