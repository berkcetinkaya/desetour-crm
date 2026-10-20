'use strict';
/**
 * tests/dashboard/sendEmailAuthorization.test.js
 * ─────────────────────────────────────────────────────────────────────────
 * Security Foundation Phase 1 — api/send-email.js now verifies a real
 * caller identity (via the new api/_shared/authorize.js, generalized from
 * the already-proven api/_agencies/authorize.js pattern) instead of
 * trusting the Origin header alone.
 *
 * Every live network call inside requireStaffRole (supabase.auth.getUser,
 * the staff_users lookup) is injected via a fake createClient — this
 * suite never makes a real network call, matching every other test file
 * in this project. The actual Resend send / HTTP handler plumbing is
 * covered by static source assertions, the same convention used
 * throughout this codebase for Vercel serverless handlers.
 * ─────────────────────────────────────────────────────────────────────────
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { requireStaffRole, ConfigurationError, extractBearerToken } = require('../../api/_shared/authorize');

const REPO_ROOT = path.join(__dirname, '..', '..');
const SEND_EMAIL_SOURCE = fs.readFileSync(path.join(REPO_ROOT, 'api', 'send-email.js'), 'utf8');
const DASHBOARD_SOURCE  = fs.readFileSync(path.join(REPO_ROOT, 'DeseTourDashboard.jsx'), 'utf8');

const ALLOWED_ROLES = ['admin', 'sales', 'operations'];

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

function fakeClientFor({ userId = 'u1', userError = null, staffRow, staffError = null }) {
  return () => ({
    auth: { getUser: async () => ({ data: userError ? null : { user: { id: userId } }, error: userError }) },
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: staffRow, error: staffError }) }) }) }),
  });
}

// ═══════════════════ api/_shared/authorize.js — requireStaffRole ═══════

test('[3] rejects an unauthenticated request — no Authorization header at all', async () => {
  const result = await requireStaffRole({ headers: {} }, ALLOWED_ROLES);
  assert.equal(result.ok, false);
  assert.equal(result.status, 401);
});

test('rejects a malformed/invalid bearer token (Supabase getUser errors)', () => withEnv(async () => {
  const result = await requireStaffRole(
    { headers: { authorization: 'Bearer not-a-real-token' } },
    ALLOWED_ROLES,
    { createClient: fakeClientFor({ userError: { message: 'invalid token' } }) }
  );
  assert.equal(result.ok, false);
  assert.equal(result.status, 401);
}));

test('[4] rejects an authenticated user with no staff_users row at all', () => withEnv(async () => {
  const result = await requireStaffRole(
    { headers: { authorization: 'Bearer faketoken' } },
    ALLOWED_ROLES,
    { createClient: fakeClientFor({ staffRow: null }) }
  );
  assert.equal(result.ok, false);
  assert.equal(result.status, 403);
  assert.match(result.error, /No staff profile/i);
}));

test('[5] rejects an inactive staff member, even with an otherwise-allowed role', () => withEnv(async () => {
  const result = await requireStaffRole(
    { headers: { authorization: 'Bearer faketoken' } },
    ALLOWED_ROLES,
    { createClient: fakeClientFor({ staffRow: { role: 'admin', is_active: false } }) }
  );
  assert.equal(result.ok, false);
  assert.equal(result.status, 403);
  assert.match(result.error, /inactive/i);
}));

test('[6] rejects an active staff member whose role is not in the allowed list (guide)', () => withEnv(async () => {
  const result = await requireStaffRole(
    { headers: { authorization: 'Bearer faketoken' } },
    ALLOWED_ROLES,
    { createClient: fakeClientFor({ staffRow: { role: 'guide', is_active: true } }) }
  );
  assert.equal(result.ok, false);
  assert.equal(result.status, 403);
}));

test('[7] accepts each of admin, sales, and operations — the three proven legitimate call-site roles', () => withEnv(async () => {
  for (const role of ALLOWED_ROLES) {
    const result = await requireStaffRole(
      { headers: { authorization: 'Bearer faketoken' } },
      ALLOWED_ROLES,
      { createClient: fakeClientFor({ staffRow: { role, is_active: true } }) }
    );
    assert.equal(result.ok, true, `role ${role} should be allowed`);
    assert.equal(result.role, role);
  }
}));

test('guide is never in the allowed-roles list for send-email — no current UI path reaches it', () => {
  assert.ok(!ALLOWED_ROLES.includes('guide'));
});

test('a staff-lookup query error (not "no row") surfaces as 502, distinct from "no row" (403)', () => withEnv(async () => {
  const result = await requireStaffRole(
    { headers: { authorization: 'Bearer faketoken' } },
    ALLOWED_ROLES,
    { createClient: fakeClientFor({ staffRow: null, staffError: { message: 'connection reset' } }) }
  );
  assert.equal(result.ok, false);
  assert.equal(result.status, 502);
}));

test('getSupabaseEnv throws ConfigurationError (never a crash) when SUPABASE_SERVICE_ROLE_KEY is missing', async () => {
  const prev = process.env.SUPABASE_SERVICE_ROLE_KEY;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  process.env.SUPABASE_URL = 'https://example.supabase.co';
  process.env.SUPABASE_ANON_KEY = 'anon-test-key';
  try {
    await assert.rejects(
      () => requireStaffRole({ headers: { authorization: 'Bearer x' } }, ALLOWED_ROLES),
      ConfigurationError
    );
  } finally {
    process.env.SUPABASE_SERVICE_ROLE_KEY = prev;
  }
});

test('extractBearerToken parses exactly "Bearer <token>", rejects anything else', () => {
  assert.equal(extractBearerToken('Bearer abc123'), 'abc123');
  assert.equal(extractBearerToken('bearer abc123'), null);
  assert.equal(extractBearerToken('abc123'), null);
  assert.equal(extractBearerToken(undefined), null);
  assert.equal(extractBearerToken(null), null);
});

test('identity is resolved only via the bearer token and the service-role staff_users lookup — never via an email comparison', () => {
  const src = fs.readFileSync(path.join(REPO_ROOT, 'api', '_shared', 'authorize.js'), 'utf8');
  assert.doesNotMatch(src, /\.eq\(['"]email['"]/);
  assert.match(src, /\.eq\('id', userId\)/);
});

// ═══════════════════ api/send-email.js wiring ═══════════════════════════

test('[2] api/send-email.js never logs the actual value of RESEND_API_KEY, a service-role key, or an Authorization header — only ever a string literal noting a var is unset', () => {
  // Existing, pre-phase line like console.error('[send-email] RESEND_API_KEY
  // not set') logs a fixed string that merely NAMES the variable — it never
  // prints the variable's own value. What must never appear is the bare
  // identifier (no surrounding quotes) passed as a console.* argument,
  // which WOULD print the live value.
  assert.doesNotMatch(SEND_EMAIL_SOURCE, /console\.(log|info|warn|error)\([^)]*,\s*RESEND_API_KEY\b/);
  assert.doesNotMatch(SEND_EMAIL_SOURCE, /console\.(log|info|warn|error)\([^)]*,\s*(SUPABASE_)?SERVICE_ROLE_KEY\b/);
  assert.doesNotMatch(SEND_EMAIL_SOURCE, /console\.(log|info|warn|error)\([^)]*req\.headers\[.authorization.\]/);
  assert.doesNotMatch(SEND_EMAIL_SOURCE, /console\.(log|info|warn|error)\([^)]*\bauth\.userId\b/);
});

test('api/send-email.js imports requireStaffRole/ConfigurationError from the new shared module, never touching api/_agencies/authorize.js', () => {
  assert.match(SEND_EMAIL_SOURCE, /require\(['"]\.\/_shared\/authorize['"]\)/);
  assert.doesNotMatch(SEND_EMAIL_SOURCE, /_agencies/);
});

test('ALLOWED_ROLES is exactly [admin, sales, operations] — proven from the one real call site, never expanded', () => {
  assert.match(SEND_EMAIL_SOURCE, /const ALLOWED_ROLES = \['admin', 'sales', 'operations'\];/);
});

test('the handler calls requireStaffRole before the RESEND_API_KEY / rate-limit / body-validation checks', () => {
  const authIdx   = SEND_EMAIL_SOURCE.indexOf('requireStaffRole(req, ALLOWED_ROLES)');
  const resendIdx = SEND_EMAIL_SOURCE.indexOf("if (!RESEND_API_KEY)");
  const rateIdx   = SEND_EMAIL_SOURCE.indexOf('!checkRate(ip)');
  assert.ok(authIdx !== -1 && resendIdx !== -1 && rateIdx !== -1);
  assert.ok(authIdx < resendIdx && authIdx < rateIdx, 'authorization must run before configuration/rate-limit checks');
});

test('an unauthorized result returns the exact status/error from requireStaffRole, with CORS headers still attached', () => {
  const idx = SEND_EMAIL_SOURCE.indexOf('if (!auth.ok)');
  const stmt = SEND_EMAIL_SOURCE.slice(idx, SEND_EMAIL_SOURCE.indexOf('\n', idx + 200));
  assert.match(SEND_EMAIL_SOURCE.slice(idx, idx + 150), /res\.status\(auth\.status\)\.set\(corsHeaders\)\.json\(\{ error: auth\.error \}\)/);
});

test('[1][7] the Resend send logic itself is byte-for-byte unchanged by this phase — same validation, same attachment handling, same success/error response shapes', () => {
  assert.match(SEND_EMAIL_SOURCE, /const resend = new Resend\(RESEND_API_KEY\);/);
  assert.match(SEND_EMAIL_SOURCE, /resend\.emails\.send\(emailPayload\)/);
  assert.match(SEND_EMAIL_SOURCE, /validateBody\(body\)/);
  assert.match(SEND_EMAIL_SOURCE, /validateAttachment\(att, index\)/);
  assert.match(SEND_EMAIL_SOURCE, /checkRate\(ip\)/);
});

// ═══════════════════ frontend call sites now send a bearer token ═══════

test('all three EmailService call sites (sendProposal/sendReminder/sendReviewRequest) now attach the current Supabase session token', () => {
  const providerIdx = DASHBOARD_SOURCE.indexOf('const ResendEmailProvider');
  assert.ok(providerIdx !== -1, 'ResendEmailProvider not found');
  const providerEnd = DASHBOARD_SOURCE.indexOf('\n(function() {', providerIdx);
  const providerBody = DASHBOARD_SOURCE.slice(providerIdx, providerEnd);

  const occurrences = providerBody.match(/fetch\(AppConfig\.emailEndpoint,/g) || [];
  assert.equal(occurrences.length, 3, `expected exactly 3 fetch(AppConfig.emailEndpoint, ...) call sites inside ResendEmailProvider, found ${occurrences.length}`);

  const tokenCalls = providerBody.match(/const token = await _getSupabaseAccessToken\(\);/g) || [];
  assert.equal(tokenCalls.length, 3, `expected exactly 3 call sites to resolve a token, found ${tokenCalls.length}`);

  const headerUsages = providerBody.match(/\.\.\.\(token \? \{ authorization: `Bearer \$\{token\}` \} : \{\}\)/g) || [];
  assert.equal(headerUsages.length, 3, `expected exactly 3 call sites to attach the Authorization header, found ${headerUsages.length}`);
});

test('_getSupabaseAccessToken reads the real current session, never a hardcoded or browser-supplied value', () => {
  const idx = DASHBOARD_SOURCE.indexOf('async function _getSupabaseAccessToken()');
  const body = DASHBOARD_SOURCE.slice(idx, DASHBOARD_SOURCE.indexOf('\n}', idx) + 2);
  assert.match(body, /sb\.auth\.getSession\(\)/);
  assert.match(body, /data\?\.session\?\.access_token \|\| null/);
});
