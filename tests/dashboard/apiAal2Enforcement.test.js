'use strict';
/**
 * tests/dashboard/apiAal2Enforcement.test.js
 * ─────────────────────────────────────────────────────────────────────────
 * TOTP MFA follow-up — server-side AAL2 enforcement for browser-callable
 * privileged endpoints (api/send-email.js, api/agency-research.js,
 * api/agency-draft-outreach.js), closing the exact bypass a still-valid
 * AAL1 access token would otherwise have against the frontend's new
 * mandatory-MFA gate (calling the endpoint directly — curl, dev tools —
 * skips the UI entirely, but never the server check added here).
 *
 * requireAal2() is shared by both api/_shared/authorize.js's
 * requireStaffRole and api/_agencies/authorize.js's requireAgencyRole,
 * called AFTER their existing identity/role/is_active checks — this file
 * tests it directly, and tests both call sites end-to-end with fake
 * Supabase clients (same dependency-injection pattern as every other
 * authorize test in this project). No live network call anywhere.
 * ─────────────────────────────────────────────────────────────────────────
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');

const REPO_ROOT = path.join(__dirname, '..', '..');
const { requireAal2 } = require(path.join(REPO_ROOT, 'api', '_shared', 'requireAal2'));
const sharedAuthorize = require(path.join(REPO_ROOT, 'api', '_shared', 'authorize'));
const agencyAuthorize = require(path.join(REPO_ROOT, 'api', '_agencies', 'authorize'));

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

function fakeClientFor({ userId = 'u1', userError = null, staffRow, staffError = null, aalLevel = 'aal2', aalError = null }) {
  return () => ({
    auth: {
      getUser: async () => ({ data: userError ? null : { user: { id: userId } }, error: userError }),
      mfa: { getAuthenticatorAssuranceLevel: async () => (aalError ? { data: null, error: aalError } : { data: { currentLevel: aalLevel, nextLevel: aalLevel, currentAuthenticationMethods: [] }, error: null }) },
    },
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: staffRow, error: staffError }) }) }) }),
  });
}

const req = (extra = {}) => ({ headers: { authorization: 'Bearer faketoken' }, ...extra });

// ═══════════════ requireAal2() direct tests ═══════════════════════════

test('requireAal2 allows exactly currentLevel === "aal2"', async () => {
  const createClient = () => ({ auth: { mfa: { getAuthenticatorAssuranceLevel: async () => ({ data: { currentLevel: 'aal2' }, error: null }) } } });
  const result = await requireAal2('tok', { url: 'u', anonKey: 'k' }, { createClient });
  assert.equal(result.ok, true);
});

test('requireAal2 denies currentLevel "aal1"', async () => {
  const createClient = () => ({ auth: { mfa: { getAuthenticatorAssuranceLevel: async () => ({ data: { currentLevel: 'aal1' }, error: null }) } } });
  const result = await requireAal2('tok', { url: 'u', anonKey: 'k' }, { createClient });
  assert.equal(result.ok, false);
  assert.equal(result.status, 403);
});

test('requireAal2 denies a missing/null currentLevel (no aal claim at all)', async () => {
  const createClient = () => ({ auth: { mfa: { getAuthenticatorAssuranceLevel: async () => ({ data: { currentLevel: null }, error: null }) } } });
  const result = await requireAal2('tok', { url: 'u', anonKey: 'k' }, { createClient });
  assert.equal(result.ok, false);
});

test('requireAal2 denies when the assurance-level lookup itself errors', async () => {
  const createClient = () => ({ auth: { mfa: { getAuthenticatorAssuranceLevel: async () => ({ data: null, error: { message: 'network error' } }) } } });
  const result = await requireAal2('tok', { url: 'u', anonKey: 'k' }, { createClient });
  assert.equal(result.ok, false);
  assert.equal(result.status, 403);
});

test('requireAal2 denies (never throws) if the MFA call itself rejects/throws', async () => {
  const createClient = () => ({ auth: { mfa: { getAuthenticatorAssuranceLevel: async () => { throw new Error('down'); } } } });
  await assert.doesNotReject(requireAal2('tok', { url: 'u', anonKey: 'k' }, { createClient }));
  const result = await requireAal2('tok', { url: 'u', anonKey: 'k' }, { createClient });
  assert.equal(result.ok, false);
});

test('requireAal2 denies (never throws) if auth.mfa does not even exist on the client', async () => {
  const createClient = () => ({ auth: {} });
  const result = await requireAal2('tok', { url: 'u', anonKey: 'k' }, { createClient });
  assert.equal(result.ok, false);
});

test('requireAal2 never exposes the raw Supabase error or JWT contents in its own error message', async () => {
  const createClient = () => ({ auth: { mfa: { getAuthenticatorAssuranceLevel: async () => ({ data: null, error: { message: 'super secret internal detail' } }) } } });
  const result = await requireAal2('tok', { url: 'u', anonKey: 'k' }, { createClient });
  assert.doesNotMatch(result.error, /super secret internal detail/);
});

// ═══════════════ send-email (requireStaffRole) end to end ═══════════════

test('[send-email] rejects AAL1 for an otherwise fully authorized role', () => withEnv(async () => {
  const createClient = fakeClientFor({ staffRow: { role: 'admin', is_active: true }, aalLevel: 'aal1' });
  const result = await sharedAuthorize.requireStaffRole(req(), ['admin', 'sales', 'operations'], { createClient });
  assert.equal(result.ok, false);
  assert.equal(result.status, 403);
}));

test('[send-email] accepts AAL2 for each existing allowed role (admin/sales/operations)', () => withEnv(async () => {
  for (const role of ['admin', 'sales', 'operations']) {
    const createClient = fakeClientFor({ staffRow: { role, is_active: true }, aalLevel: 'aal2' });
    const result = await sharedAuthorize.requireStaffRole(req(), ['admin', 'sales', 'operations'], { createClient });
    assert.equal(result.ok, true, `expected ${role} at AAL2 to be allowed`);
    assert.equal(result.role, role);
  }
}));

test('[send-email] inactive staff is denied before AAL2 is ever checked (is_active takes priority)', () => withEnv(async () => {
  const createClient = fakeClientFor({ staffRow: { role: 'admin', is_active: false }, aalLevel: 'aal2' });
  const result = await sharedAuthorize.requireStaffRole(req(), ['admin'], { createClient });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'Staff account is inactive.');
}));

test('[send-email] a disallowed role is still rejected at AAL2 — AAL2 never substitutes for role authorization', () => withEnv(async () => {
  const createClient = fakeClientFor({ staffRow: { role: 'guide', is_active: true }, aalLevel: 'aal2' });
  const result = await sharedAuthorize.requireStaffRole(req(), ['admin', 'sales', 'operations'], { createClient });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'Not authorized for this action.');
}));

// ═══════════════ Agency research/draft outreach (requireAgencyRole) ═════

test('[agency] rejects AAL1 for admin', () => withEnv(async () => {
  const createClient = fakeClientFor({ staffRow: { role: 'admin', is_active: true }, aalLevel: 'aal1' });
  const result = await agencyAuthorize.requireAgencyRole(req(), { createClient });
  assert.equal(result.ok, false);
  assert.equal(result.status, 403);
}));

test('[agency] active admin at AAL2 is allowed', () => withEnv(async () => {
  const createClient = fakeClientFor({ staffRow: { role: 'admin', is_active: true }, aalLevel: 'aal2' });
  const result = await agencyAuthorize.requireAgencyRole(req(), { createClient });
  assert.equal(result.ok, true);
  assert.equal(result.role, 'admin');
}));

test('[agency] active sales at AAL2 is allowed', () => withEnv(async () => {
  const createClient = fakeClientFor({ staffRow: { role: 'sales', is_active: true }, aalLevel: 'aal2' });
  const result = await agencyAuthorize.requireAgencyRole(req(), { createClient });
  assert.equal(result.ok, true);
  assert.equal(result.role, 'sales');
}));

test('[agency] operations remains denied even at AAL2 — AAL2 never broadens ALLOWED_ROLES', () => withEnv(async () => {
  const createClient = fakeClientFor({ staffRow: { role: 'operations', is_active: true }, aalLevel: 'aal2' });
  const result = await agencyAuthorize.requireAgencyRole(req(), { createClient });
  assert.equal(result.ok, false);
  assert.equal(result.status, 403);
}));

test('[agency] guide remains denied even at AAL2', () => withEnv(async () => {
  const createClient = fakeClientFor({ staffRow: { role: 'guide', is_active: true }, aalLevel: 'aal2' });
  const result = await agencyAuthorize.requireAgencyRole(req(), { createClient });
  assert.equal(result.ok, false);
  assert.equal(result.status, 403);
}));

test('[agency] a missing aal claim (null currentLevel) is denied even for an otherwise-valid admin', () => withEnv(async () => {
  const createClient = fakeClientFor({ staffRow: { role: 'admin', is_active: true }, aalLevel: null });
  const result = await agencyAuthorize.requireAgencyRole(req(), { createClient });
  assert.equal(result.ok, false);
}));

test('[agency] an assurance-lookup error is denied, never silently treated as satisfied', () => withEnv(async () => {
  const createClient = fakeClientFor({ staffRow: { role: 'admin', is_active: true }, aalError: { message: 'lookup failed' } });
  const result = await agencyAuthorize.requireAgencyRole(req(), { createClient });
  assert.equal(result.ok, false);
}));

test('[agency] inactive staff is denied before AAL2 is ever checked', () => withEnv(async () => {
  const createClient = fakeClientFor({ staffRow: { role: 'admin', is_active: false }, aalLevel: 'aal2' });
  const result = await agencyAuthorize.requireAgencyRole(req(), { createClient });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'Staff account is inactive.');
}));

// ═══════════════ No browser-supplied AAL claim can bypass the real check ═

test('a request body or header claiming AAL2 is completely ignored — only the verified token (via the official MFA API) decides', () => withEnv(async () => {
  const createClient = fakeClientFor({ staffRow: { role: 'admin', is_active: true }, aalLevel: 'aal1' });
  const spoofedReq = {
    headers: { authorization: 'Bearer faketoken', 'x-aal': 'aal2', 'x-mfa-verified': 'true' },
    body: { aal: 'aal2', mfaVerified: true, currentLevel: 'aal2' },
  };
  const result = await agencyAuthorize.requireAgencyRole(spoofedReq, { createClient });
  assert.equal(result.ok, false, 'a spoofed AAL2 claim in headers/body must never substitute for the real, verified check');
}));

test('requireAal2 itself never reads req.headers/req.body — it only ever receives the already-extracted bearer token', () => {
  const REPO_ROOT_SRC = fs.readFileSync(path.join(REPO_ROOT, 'api', '_shared', 'requireAal2.js'), 'utf8');
  assert.doesNotMatch(REPO_ROOT_SRC, /req\.headers|req\.body/);
});

// ═══════════════ Cron / Civitatis service-role flows are unaffected ══════

test('cron/Civitatis ingestion endpoints never call requireStaffRole/requireAgencyRole/requireAal2 — they use their own scheduler-secret check instead', () => {
  const candidateFiles = ['cron-ingest-civitatis-write.js', 'ingest-civitatis.js', 'ingest-civitatis-write.js'];
  for (const file of candidateFiles) {
    const p = path.join(REPO_ROOT, 'api', file);
    if (!fs.existsSync(p)) continue;
    const src = fs.readFileSync(p, 'utf8');
    assert.doesNotMatch(src, /requireStaffRole|requireAgencyRole|requireAal2/, `${file} must not depend on staff-bearer-token AAL2 enforcement`);
  }
});

test('the cron endpoint authorizes via a static scheduler secret, not a staff session at all — AAL2 is not applicable to it', () => {
  const src = fs.readFileSync(path.join(REPO_ROOT, 'api', 'cron-ingest-civitatis-write.js'), 'utf8');
  assert.match(src, /CRON_SECRET|configuredSecret/);
});

// ═══════════════ The three browser-callable endpoints are all wired ═════

test('all three browser-callable endpoints route through an authorize module that now includes requireAal2', () => {
  const sendEmailSrc = fs.readFileSync(path.join(REPO_ROOT, 'api', 'send-email.js'), 'utf8');
  const researchSrc = fs.readFileSync(path.join(REPO_ROOT, 'api', 'agency-research.js'), 'utf8');
  const draftSrc = fs.readFileSync(path.join(REPO_ROOT, 'api', 'agency-draft-outreach.js'), 'utf8');
  assert.match(sendEmailSrc, /requireStaffRole\(req, ALLOWED_ROLES\)/);
  assert.match(researchSrc, /requireAgencyRole\(req\)/);
  assert.match(draftSrc, /requireAgencyRole\(req\)/);

  const sharedAuthorizeSrc = fs.readFileSync(path.join(REPO_ROOT, 'api', '_shared', 'authorize.js'), 'utf8');
  const agencyAuthorizeSrc = fs.readFileSync(path.join(REPO_ROOT, 'api', '_agencies', 'authorize.js'), 'utf8');
  assert.match(sharedAuthorizeSrc, /requireAal2\(token, \{ url, anonKey \}, deps\)/);
  assert.match(agencyAuthorizeSrc, /requireAal2\(token, \{ url, anonKey \}, deps\)/);
});

test('requireAal2 is called strictly AFTER the existing role/is_active checks in both authorize modules, never before', () => {
  const sharedAuthorizeSrc = fs.readFileSync(path.join(REPO_ROOT, 'api', '_shared', 'authorize.js'), 'utf8');
  const roleCheckIdx = sharedAuthorizeSrc.indexOf("if (!allowedRoles.includes(staffRow.role))");
  const aalCallIdx = sharedAuthorizeSrc.indexOf('const aal = await requireAal2(');
  assert.ok(roleCheckIdx !== -1 && aalCallIdx !== -1 && aalCallIdx > roleCheckIdx);

  const agencyAuthorizeSrc = fs.readFileSync(path.join(REPO_ROOT, 'api', '_agencies', 'authorize.js'), 'utf8');
  const agencyRoleCheckIdx = agencyAuthorizeSrc.indexOf('if (!role || !ALLOWED_ROLES.includes(role))');
  const agencyAalCallIdx = agencyAuthorizeSrc.indexOf('const aal = await requireAal2(');
  assert.ok(agencyRoleCheckIdx !== -1 && agencyAalCallIdx !== -1 && agencyAalCallIdx > agencyRoleCheckIdx);
});
