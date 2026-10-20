'use strict';
/**
 * tests/dashboard/agencyAuthorizeActiveStaff.test.js
 * ─────────────────────────────────────────────────────────────────────────
 * Security Foundation Phase 1 follow-up — closes the one remaining gap
 * the audit found: api/_agencies/authorize.js verified identity and role
 * but never checked staff_users.is_active. An inactive admin or sales
 * staff member could previously still call the two Agency Phase 2
 * endpoints (api/agency-research.js, api/agency-draft-outreach.js).
 *
 * Every live network call inside requireAgencyRole (supabase.auth.getUser,
 * the staff_users lookup) is injected via a fake createClient — this
 * suite never makes a real network call, matching every other test file
 * in this project and the existing requireAgencyRole tests in
 * tests/dashboard/agenciesPhase2.test.js (which this file does not
 * duplicate — it adds exactly the is_active coverage that was missing).
 * ─────────────────────────────────────────────────────────────────────────
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { requireAgencyRole, ALLOWED_ROLES } = require('../../api/_agencies/authorize');

function fakeClientFor({ userId = 'u1', userError = null, staffRow, staffError = null }) {
  return () => ({
    auth: { getUser: async () => ({ data: userError ? null : { user: { id: userId } }, error: userError }) },
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: staffRow, error: staffError }) }) }) }),
  });
}

function withEnv(fn) {
  const prevUrl = process.env.SUPABASE_URL;
  const prevAnon = process.env.SUPABASE_ANON_KEY;
  const prevService = process.env.SUPABASE_SERVICE_ROLE_KEY;
  process.env.SUPABASE_URL = 'https://example.supabase.co';
  process.env.SUPABASE_ANON_KEY = 'anon-test-key';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-test-key';
  try { return fn(); }
  finally {
    process.env.SUPABASE_URL = prevUrl;
    process.env.SUPABASE_ANON_KEY = prevAnon;
    process.env.SUPABASE_SERVICE_ROLE_KEY = prevService;
  }
}

test('ALLOWED_ROLES is unchanged by this fix — still exactly [admin, sales], never broadened', () => {
  assert.deepEqual(ALLOWED_ROLES, ['admin', 'sales']);
});

test('[1] active admin is allowed', () => withEnv(async () => {
  const result = await requireAgencyRole(
    { headers: { authorization: 'Bearer faketoken' } },
    { createClient: fakeClientFor({ staffRow: { role: 'admin', is_active: true } }) }
  );
  assert.equal(result.ok, true);
  assert.equal(result.role, 'admin');
}));

test('[2] active sales is allowed', () => withEnv(async () => {
  const result = await requireAgencyRole(
    { headers: { authorization: 'Bearer faketoken' } },
    { createClient: fakeClientFor({ staffRow: { role: 'sales', is_active: true } }) }
  );
  assert.equal(result.ok, true);
  assert.equal(result.role, 'sales');
}));

test('[3] inactive admin is denied with 403, even though the role itself is allowed', () => withEnv(async () => {
  const result = await requireAgencyRole(
    { headers: { authorization: 'Bearer faketoken' } },
    { createClient: fakeClientFor({ staffRow: { role: 'admin', is_active: false } }) }
  );
  assert.equal(result.ok, false);
  assert.equal(result.status, 403);
  assert.match(result.error, /inactive/i);
}));

test('[4] inactive sales is denied with 403, even though the role itself is allowed', () => withEnv(async () => {
  const result = await requireAgencyRole(
    { headers: { authorization: 'Bearer faketoken' } },
    { createClient: fakeClientFor({ staffRow: { role: 'sales', is_active: false } }) }
  );
  assert.equal(result.ok, false);
  assert.equal(result.status, 403);
  assert.match(result.error, /inactive/i);
}));

test('[5] a missing staff row is denied with 403', () => withEnv(async () => {
  const result = await requireAgencyRole(
    { headers: { authorization: 'Bearer faketoken' } },
    { createClient: fakeClientFor({ staffRow: null }) }
  );
  assert.equal(result.ok, false);
  assert.equal(result.status, 403);
}));

test('[6] an unauthenticated request (no bearer token) is denied with 401', async () => {
  const result = await requireAgencyRole({ headers: {} });
  assert.equal(result.ok, false);
  assert.equal(result.status, 401);
});

test('[7] active operations is denied with 403 (role not in ALLOWED_ROLES)', () => withEnv(async () => {
  const result = await requireAgencyRole(
    { headers: { authorization: 'Bearer faketoken' } },
    { createClient: fakeClientFor({ staffRow: { role: 'operations', is_active: true } }) }
  );
  assert.equal(result.ok, false);
  assert.equal(result.status, 403);
}));

test('[8] active guide is denied with 403 (role not in ALLOWED_ROLES)', () => withEnv(async () => {
  const result = await requireAgencyRole(
    { headers: { authorization: 'Bearer faketoken' } },
    { createClient: fakeClientFor({ staffRow: { role: 'guide', is_active: true } }) }
  );
  assert.equal(result.ok, false);
  assert.equal(result.status, 403);
}));

// ── Boundary/edge cases around the new check ────────────────────────────

test('inactive operations and inactive guide are also denied (inactive wins regardless of role)', () => withEnv(async () => {
  for (const role of ['operations', 'guide']) {
    const result = await requireAgencyRole(
      { headers: { authorization: 'Bearer faketoken' } },
      { createClient: fakeClientFor({ staffRow: { role, is_active: false } }) }
    );
    assert.equal(result.ok, false);
    assert.equal(result.status, 403);
  }
}));

test('a staff row with is_active omitted entirely (not false) is treated as active — matches the real schema default (NOT NULL DEFAULT TRUE), never silently denies a well-formed row', () => withEnv(async () => {
  const result = await requireAgencyRole(
    { headers: { authorization: 'Bearer faketoken' } },
    { createClient: fakeClientFor({ staffRow: { role: 'admin' } }) }
  );
  assert.equal(result.ok, true);
}));

test('the query now selects is_active alongside role, in one single staff_users lookup — no second round trip', () => {
  const fs = require('fs');
  const path = require('path');
  const src = fs.readFileSync(path.join(__dirname, '..', '..', 'api', '_agencies', 'authorize.js'), 'utf8');
  assert.match(src, /\.select\('role, is_active'\)/);
  assert.equal((src.match(/\.from\('staff_users'\)/g) || []).length, 1, 'expected exactly one staff_users query');
});

test('identity is still resolved only by Auth user ID — never by email, browser-supplied role, or browser-supplied staff ID', () => {
  const fs = require('fs');
  const path = require('path');
  const src = fs.readFileSync(path.join(__dirname, '..', '..', 'api', '_agencies', 'authorize.js'), 'utf8');
  assert.doesNotMatch(src, /\.eq\(['"]email['"]/);
  assert.match(src, /\.eq\('id', userId\)/);
});
