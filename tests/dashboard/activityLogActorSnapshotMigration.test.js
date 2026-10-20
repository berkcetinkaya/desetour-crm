'use strict';
/**
 * tests/dashboard/activityLogActorSnapshotMigration.test.js
 * ─────────────────────────────────────────────────────────────────────────
 * Regression coverage for supabase_migration_activity_logs_actor_snapshot.sql
 * and its rollback (Security Foundation Phase 1). NOT YET APPLIED to any
 * database — explicitly withheld pending manual approval, exactly like
 * every prior migration's own test file in this repo. Every test here is
 * a pure, static, never-executed text assertion against the prepared
 * .sql files. Nothing in this file connects to a database or runs any SQL.
 * ─────────────────────────────────────────────────────────────────────────
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const FORWARD_PATH  = path.join(ROOT, 'supabase_migration_activity_logs_actor_snapshot.sql');
const ROLLBACK_PATH = path.join(ROOT, 'supabase_migration_activity_logs_actor_snapshot_ROLLBACK.sql');

const forward  = fs.readFileSync(FORWARD_PATH, 'utf8');
const rollback = fs.readFileSync(ROLLBACK_PATH, 'utf8');

// ── A. Forward migration is 100% additive — no row ever touched ────────

test('forward migration contains zero UPDATE/DELETE/INSERT statements — only ALTER TABLE/COMMENT/SELECT', () => {
  const codeLines = forward.split('\n').filter(l => !l.trim().startsWith('--'));
  const code = codeLines.join('\n');
  assert.doesNotMatch(code, /\bUPDATE\s+public\./i);
  assert.doesNotMatch(code, /\bDELETE\s+FROM\s+public\./i);
  assert.doesNotMatch(code, /\bINSERT\s+INTO\s+public\./i);
});

test('all three new columns are added with ADD COLUMN IF NOT EXISTS (idempotent) and no DEFAULT expression', () => {
  assert.match(forward, /ALTER TABLE public\.activity_logs ADD COLUMN IF NOT EXISTS actor_name TEXT;/);
  assert.match(forward, /ALTER TABLE public\.activity_logs ADD COLUMN IF NOT EXISTS actor_role TEXT;/);
  assert.match(forward, /ALTER TABLE public\.activity_logs ADD COLUMN IF NOT EXISTS source\s+TEXT;/);
  assert.doesNotMatch(forward, /actor_name TEXT[^\n;]*DEFAULT/i);
  assert.doesNotMatch(forward, /actor_role TEXT[^\n;]*DEFAULT/i);
});

test('the source CHECK constraint explicitly allows NULL and exactly the four stated values, no others', () => {
  const idx = forward.indexOf('ADD CONSTRAINT activity_logs_source_check');
  assert.ok(idx !== -1);
  const stmt = forward.slice(idx, forward.indexOf(';', idx) + 1);
  assert.match(stmt, /source IS NULL OR source IN \('crm_user','civitatis','system','api'\)/);
});

test('the source constraint is guarded by DROP CONSTRAINT IF EXISTS first, for idempotent re-runs', () => {
  const dropIdx = forward.indexOf('DROP CONSTRAINT IF EXISTS activity_logs_source_check');
  const addIdx  = forward.indexOf('ADD CONSTRAINT activity_logs_source_check');
  assert.ok(dropIdx !== -1 && addIdx !== -1 && dropIdx < addIdx);
});

// ── B. Never touches the append-only guarantee or any existing RLS ─────

test('forward migration never mentions DROP RULE, CREATE POLICY, or ALTER POLICY — the append-only rules and existing RLS policies are untouched', () => {
  assert.doesNotMatch(forward, /DROP RULE/i);
  assert.doesNotMatch(forward, /CREATE POLICY/i);
  assert.doesNotMatch(forward, /ALTER POLICY/i);
  assert.doesNotMatch(forward, /DROP POLICY/i);
});

test('postflight explicitly re-verifies both append-only rules and the unchanged policy count', () => {
  const postflightIdx = forward.indexOf('-- POSTFLIGHT');
  assert.ok(postflightIdx !== -1, 'POSTFLIGHT section header not found');
  const postflight = forward.slice(postflightIdx);
  assert.match(postflight, /activity_logs_no_delete.*activity_logs_no_update|activity_logs_no_update.*activity_logs_no_delete/s);
  assert.match(postflight, /activity_logs_policy_count_unchanged/);
});

test('forward migration never touches old_value, new_value, metadata, or performed_by', () => {
  assert.doesNotMatch(forward, /ALTER TABLE public\.activity_logs[^\n]*\b(old_value|new_value|metadata|performed_by)\b/i);
});

// ── C. No backfill performed; narrow deterministic backfill only proposed ──

test('forward migration performs no backfill of any kind — only the proposal is documented in a comment, never executed', () => {
  const codeLines = forward.split('\n').filter(l => !l.trim().startsWith('--'));
  const code = codeLines.join('\n');
  assert.doesNotMatch(code, /UPDATE\s+public\.activity_logs/i);
  assert.match(forward, /PROPOSED \(NOT PERFORMED\) BACKFILL/);
});

// ── D. Rollback removes exactly these three columns, nothing else ──────

test('rollback drops exactly actor_name, actor_role, source via DROP COLUMN IF EXISTS', () => {
  assert.match(rollback, /ALTER TABLE public\.activity_logs DROP COLUMN IF EXISTS actor_name;/);
  assert.match(rollback, /ALTER TABLE public\.activity_logs DROP COLUMN IF EXISTS actor_role;/);
  assert.match(rollback, /ALTER TABLE public\.activity_logs DROP COLUMN IF EXISTS source;/);
});

test('rollback never touches any other existing column, rule, or policy', () => {
  assert.doesNotMatch(rollback, /DROP COLUMN IF EXISTS (id|entity_type|entity_id|action|description|old_value|new_value|metadata|performed_by|created_at)\b/);
  assert.doesNotMatch(rollback, /DROP RULE|DROP POLICY|DROP TABLE/i);
});

test('rollback postflight re-confirms performed_by and both append-only rules are still present', () => {
  assert.match(rollback, /column_name='performed_by'/);
  assert.match(rollback, /activity_logs_no_delete/);
  assert.match(rollback, /activity_logs_no_update/);
});

test('rollback is wrapped in exactly one BEGIN;/COMMIT; pair', () => {
  assert.equal((rollback.match(/^BEGIN;\s*$/gm) || []).length, 1);
  assert.equal((rollback.match(/^COMMIT;\s*$/gm) || []).length, 1);
});

// ── E. No implementation-detail leak / no secret ────────────────────────

test('neither file contains a hardcoded credential or secret-shaped literal', () => {
  const combined = forward + rollback;
  assert.doesNotMatch(combined, /sk-ant-|service_role.{0,20}=.{0,10}['"]ey/i);
});
