/**
 * api/_shared/authorize.js
 * ─────────────────────────────────────────────────────────────────────────
 * Security Foundation Phase 1 — generic real-identity authorization for
 * browser-called serverless endpoints. Reuses the exact pattern proven by
 * api/_agencies/authorize.js (the one endpoint pair in this codebase that
 * already verifies a real caller identity instead of trusting the Origin
 * header or any browser-supplied role/staff-id), generalized so a second
 * endpoint (api/send-email.js) can reuse it without touching that
 * already-shipped, already-tested module at all.
 *
 * WHY api/send-email.js NEEDED THIS: the security audit of this CRM found
 * that api/send-email.js relied ONLY on an Origin-header allowlist —
 * identity-blind, trivially spoofable by any non-browser caller that sets
 * its own Origin header. This module closes that gap the same way
 * api/_agencies/authorize.js already closed it for the Agency endpoints.
 *
 * FLOW (identical to api/_agencies/authorize.js):
 *   1. Browser sends `Authorization: Bearer <access_token>` — the SAME
 *      token the frontend's own supabase-js client already holds after
 *      login via sb.auth.getSession(). Nothing new is issued or stored.
 *   2. This module verifies that token against Supabase Auth
 *      (supabase.auth.getUser(token)) to resolve a real, currently-valid
 *      user id — never trusts a client-supplied id or role.
 *   3. Looks up that user's role AND is_active in staff_users using the
 *      service_role client (the same elevated-privilege pattern already
 *      used by api/_agencies/authorize.js, api/_civitatis/supabaseAdmin.js,
 *      api/_fx/supabaseAdmin.js).
 *   4. Returns ok:true only if a staff row exists, is_active is not
 *      false, and its role is in the caller-supplied allowedRoles list.
 *
 * NOT A NEW AUTH ARCHITECTURE — same two existing pieces as every other
 * server-side identity check in this codebase: the browser's existing
 * Supabase session, and the existing staff_users.role/is_active columns.
 * No new table, no new role, no new login flow, no RLS change.
 *
 * Identity is resolved by Auth user ID throughout — never by email, per
 * the project's own stated security requirement that email/domain must
 * never be an authorization signal.
 * ─────────────────────────────────────────────────────────────────────────
 */
'use strict';

class ConfigurationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConfigurationError';
  }
}

function getSupabaseEnv() {
  const url = process.env.SUPABASE_URL;
  const anonKey = process.env.SUPABASE_ANON_KEY;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const missing = [
    !url && 'SUPABASE_URL',
    !anonKey && 'SUPABASE_ANON_KEY',
    !serviceRoleKey && 'SUPABASE_SERVICE_ROLE_KEY',
  ].filter(Boolean);
  if (missing.length > 0) {
    throw new ConfigurationError(
      `This endpoint is not configured: missing environment variable(s): ${missing.join(', ')}. ` +
      'Set these as server-side Vercel environment variables — never in browser-reachable config.'
    );
  }
  return { url, anonKey, serviceRoleKey };
}

function extractBearerToken(authorizationHeader) {
  if (typeof authorizationHeader !== 'string') return null;
  const match = /^Bearer\s+(.+)$/.exec(authorizationHeader.trim());
  return match ? match[1] : null;
}

/**
 * @param {{ headers: Record<string,string> }} req
 * @param {string[]} allowedRoles - e.g. ['admin','sales','operations']
 * @param {{ createClient?: Function }} [deps] - injectable for tests
 * @returns {Promise<{ok:true, role:string, userId:string} | {ok:false, status:number, error:string}>}
 */
async function requireStaffRole(req, allowedRoles, deps = {}) {
  const token = extractBearerToken(req.headers && req.headers['authorization']);
  if (!token) {
    return { ok: false, status: 401, error: 'Missing Authorization bearer token.' };
  }

  const { url, anonKey, serviceRoleKey } = getSupabaseEnv();
  const createClient = deps.createClient || require('@supabase/supabase-js').createClient;

  const anonClient = createClient(url, anonKey);
  const { data: userData, error: userError } = await anonClient.auth.getUser(token);
  if (userError || !userData || !userData.user) {
    return { ok: false, status: 401, error: 'Invalid or expired session.' };
  }
  const userId = userData.user.id;

  const adminClient = createClient(url, serviceRoleKey);
  const { data: staffRow, error: staffError } = await adminClient
    .from('staff_users')
    .select('role, is_active')
    .eq('id', userId)
    .maybeSingle();
  if (staffError) {
    return { ok: false, status: 502, error: 'Failed to resolve staff role.' };
  }
  if (!staffRow) {
    return { ok: false, status: 403, error: 'No staff profile linked to this account.' };
  }
  if (staffRow.is_active === false) {
    return { ok: false, status: 403, error: 'Staff account is inactive.' };
  }
  if (!allowedRoles.includes(staffRow.role)) {
    return { ok: false, status: 403, error: 'Not authorized for this action.' };
  }

  return { ok: true, role: staffRow.role, userId };
}

module.exports = {
  ConfigurationError,
  extractBearerToken,
  requireStaffRole,
};
