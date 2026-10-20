'use strict';
/**
 * tests/dashboard/activityLogActorSnapshot.test.js
 * ─────────────────────────────────────────────────────────────────────────
 * Security Foundation Phase 1 — activity_logs actor snapshot.
 *
 * Proves: _actorSnapshotFromStaff is a pure function (no network, no auth
 * lookup of its own); _sbLog / autoLog / SupabaseActivityRepo.create /
 * mapActivityFromDB all read/write the new actor_name/actor_role/source
 * fields using ONLY the already-resolved staff identity (never re-resolve
 * by email, never a second network call); and no write path in this
 * phase ever logs a secret-shaped value.
 * ─────────────────────────────────────────────────────────────────────────
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { extractTestableFn } = require('./extractTestableFn');

const REPO_ROOT = path.join(__dirname, '..', '..');
const SOURCE = fs.readFileSync(path.join(REPO_ROOT, 'DeseTourDashboard.jsx'), 'utf8');

function body(name, nextMarker) {
  const idx = SOURCE.indexOf(`function ${name}(`);
  assert.ok(idx !== -1, `could not find function ${name}`);
  return SOURCE.slice(idx, SOURCE.indexOf(nextMarker, idx));
}

const _actorSnapshotFromStaff = extractTestableFn('_actorSnapshotFromStaff');

// ── 1. _actorSnapshotFromStaff is pure and correct ──────────────────────

test('[1] _actorSnapshotFromStaff returns actor_name/actor_role straight from the given staff object, no transformation', () => {
  const result = _actorSnapshotFromStaff({ id: 'u1', full_name: 'Test Admin', role: 'admin' });
  assert.deepEqual(result, { actorName: 'Test Admin', actorRole: 'admin' });
});

test('_actorSnapshotFromStaff returns the RAW db role value, never the Turkish display label', () => {
  const result = _actorSnapshotFromStaff({ full_name: 'Test Guide', role: 'guide' });
  assert.equal(result.actorRole, 'guide');
  assert.notEqual(result.actorRole, 'Rehber');
});

test('_actorSnapshotFromStaff returns nulls (never an invented value) when no staff is given', () => {
  assert.deepEqual(_actorSnapshotFromStaff(null), { actorName: null, actorRole: null });
  assert.deepEqual(_actorSnapshotFromStaff(undefined), { actorName: null, actorRole: null });
});

test('_actorSnapshotFromStaff returns null fields (not a crash) for a staff row missing full_name/role', () => {
  assert.deepEqual(_actorSnapshotFromStaff({}), { actorName: null, actorRole: null });
});

// ── 2. _sbLog populates actor_name/actor_role/source='crm_user' ─────────

const SBLOG_BODY = body('_sbLog', '\n\nfunction mapCustomerFromDB');

test('[2] _sbLog reads the actor snapshot from the already-cached _authCache.staff — never a new network call for identity', () => {
  assert.match(SBLOG_BODY, /_actorSnapshotFromStaff\(_authCache\?\.staff\)/);
  assert.match(SBLOG_BODY, /actor_name:actorName,\s*actor_role:actorRole,\s*source:'crm_user'/);
});

test('_sbLog never resolves identity by email — only by the auth session user id, exactly as before this phase', () => {
  assert.doesNotMatch(SBLOG_BODY, /\.eq\(['"]email['"]/);
  assert.match(SBLOG_BODY, /_authCache\?\.session\?\.user\?\.id/);
});

// ── 3. autoLog populates performed_by (previously never set) + snapshot ──

const AUTOLOG_BODY = body('autoLog', '\n\nfunction getActiveRepo');

test('[3] autoLog now resolves performedBy/actorName/actorRole from the cached staff identity and passes source=crm_user', () => {
  assert.match(AUTOLOG_BODY, /const performedBy = _authCache\?\.session\?\.user\?\.id \|\| null;/);
  assert.match(AUTOLOG_BODY, /_actorSnapshotFromStaff\(_authCache\?\.staff\)/);
  assert.match(AUTOLOG_BODY, /performedBy,actorName,actorRole,source:'crm_user'/);
});

test('autoLog never resolves identity by email — only by the auth session user id', () => {
  // The function's own comment legitimately mentions "email" while
  // documenting that it does NOT do this — check for the actual pattern
  // (a lookup/comparison keyed on an email field) rather than the word.
  assert.doesNotMatch(AUTOLOG_BODY, /\.eq\(['"]email['"]/);
  assert.doesNotMatch(AUTOLOG_BODY, /staff\?\.email|session\?\.user\?\.email/);
  assert.match(AUTOLOG_BODY, /_authCache\?\.session\?\.user\?\.id/);
});

// ── 4. SupabaseActivityRepo.create maps the new fields ──────────────────

const ACTIVITY_REPO_BODY = (() => {
  const idx = SOURCE.indexOf('const SupabaseActivityRepo');
  assert.ok(idx !== -1, 'SupabaseActivityRepo not found');
  return SOURCE.slice(idx, idx + 2000);
})();

test('[4] SupabaseActivityRepo.create maps actorName/actorRole/source onto the real DB columns', () => {
  const createIdx = ACTIVITY_REPO_BODY.indexOf('async create(d)');
  assert.ok(createIdx !== -1, 'create(d) not found on SupabaseActivityRepo');
  const createBody = ACTIVITY_REPO_BODY.slice(createIdx, ACTIVITY_REPO_BODY.indexOf('\n', createIdx) + 1);
  assert.match(createBody, /actor_name:d\.actorName\|\|null/);
  assert.match(createBody, /actor_role:d\.actorRole\|\|null/);
  assert.match(createBody, /source:d\.source\|\|null/);
});

// ── 5. mapActivityFromDB prefers the permanent snapshot over the live join ──

test('[5] mapActivityFromDB prefers actor_name over the live staff_users join, old rows fall through unchanged', () => {
  const idx = SOURCE.indexOf('function mapActivityFromDB(r)');
  const mapBody = SOURCE.slice(idx, SOURCE.indexOf('\n}', idx) + 2);
  assert.match(mapBody, /who:r\.actor_name\|\|r\.performer\?\.full_name\|\|r\.performed_by\|\|.—./);
  assert.match(mapBody, /actorName:r\.actor_name\|\|null, actorRole:r\.actor_role\|\|null, source:r\.source\|\|null/);
});

// ── 6. No secret-shaped value is ever logged by any of these write paths ──

test('[6] no password/token/API key/Authorization header/env var/session object is ever written into an activity_logs row', () => {
  const combined = [SBLOG_BODY, AUTOLOG_BODY, ACTIVITY_REPO_BODY].join('\n');
  assert.doesNotMatch(combined, /password/i);
  assert.doesNotMatch(combined, /access_token|refresh_token/i);
  assert.doesNotMatch(combined, /api[_-]?key/i);
  assert.doesNotMatch(combined, /authorization/i);
  assert.doesNotMatch(combined, /process\.env/);
  // The only "session"-shaped read is the user id off the session object,
  // never the session object itself being passed into an insert.
  assert.doesNotMatch(combined, /insert\(\{[^}]*session[^}]*\}/is);
});

test('old_value/new_value are NOT populated by this phase — that is explicitly deferred', () => {
  assert.doesNotMatch(SBLOG_BODY, /old_value\s*:/);
  assert.doesNotMatch(AUTOLOG_BODY, /oldValue|old_value/);
});
