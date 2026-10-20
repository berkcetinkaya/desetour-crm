/**
 * api/_agencies/authorize.js
 * ─────────────────────────────────────────────────────────────────────────
 * Acenteler Phase 2 — server-side role check for the two new browser-called
 * endpoints (api/agency-research.js, api/agency-draft-outreach.js).
 *
 * WHY THIS EXISTS: the project's one existing browser-called endpoint
 * (api/send-email.js) only checks the request's Origin header — it never
 * verifies WHO is calling or what role they have. That's adequate for a
 * generic "send this email" relay, but these two new endpoints must be
 * restricted to Yönetici/Satış only (Operasyon/Rehber must not be able to
 * trigger agency research or drafting even by calling the endpoint
 * directly, bypassing the UI). Per the brief: "Server-side endpoints must
 * not rely only on hidden frontend buttons for security."
 *
 * THIS IS NOT A NEW AUTH ARCHITECTURE. It reuses the exact two pieces
 * already in place: the browser's existing Supabase session (the SAME
 * access_token the frontend's own supabase-js client already holds after
 * login — nothing new is issued or stored) and the existing
 * staff_users.role column (the SAME column RLS policies already read via
 * get_current_staff_role()/is_admin()/is_sales()). No new table, no new
 * role, no new login flow, no change to supabase_rls_policies.sql.
 *
 * FLOW:
 *   1. Browser sends `Authorization: Bearer <access_token>` (the token
 *      from its own sb.auth.getSession() call — the frontend already
 *      holds this for every other Supabase call it makes).
 *   2. This module verifies that token against Supabase Auth
 *      (supabase.auth.getUser(token)) to resolve a real, currently-valid
 *      user id — never trusts a client-supplied id directly.
 *   3. Looks up that user's role AND is_active in staff_users using the
 *      service_role client (the same elevated-privilege pattern already
 *      used by api/_civitatis/supabaseAdmin.js and api/_fx/supabaseAdmin.js).
 *   4. Returns ok:true only if a staff row exists, is_active is not
 *      false, AND that role is 'admin' or 'sales'.
 *
 * SECURITY FOUNDATION FOLLOW-UP (is_active check): the Security
 * Foundation Phase 1 audit found this module verified identity and role
 * but never checked is_active — an admin/sales staff member deactivated
 * via staff_users.is_active=false could still call these two endpoints.
 * Fixed here with the smallest possible change: one extra selected
 * column, one extra early-return, same status code (403) and the same
 * overall shape every existing caller already handles. ALLOWED_ROLES is
 * unchanged — this does not broaden who may call these endpoints, it
 * only narrows who counts as a valid admin/sales staff member.
 * api/_shared/authorize.js (built for api/send-email.js in the same
 * phase) already does this is_active check in its own generalized
 * module, but is deliberately NOT reused here: swapping this file for
 * that one would change the exact error-message text returned for each
 * failure case (this file's own, more specific "Agency research/
 * outreach is restricted to Yönetici/Satış." vs. the shared module's
 * generic messages), which is a visible behavior change this phase was
 * explicitly asked to avoid for the two already-shipped Agency endpoints.
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
      `Agency endpoints are not configured: missing environment variable(s): ${missing.join(', ')}. ` +
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

const ALLOWED_ROLES = ['admin', 'sales'];

/**
 * @param {{ headers: Record<string,string> }} req
 * @param {{ createClient?: Function }} [deps] - injectable for tests
 * @returns {Promise<{ok:true, role:string, userId:string} | {ok:false, status:number, error:string}>}
 */
async function requireAgencyRole(req, deps = {}) {
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
    return { ok: false, status: 403, error: 'Agency research/outreach is restricted to Yönetici/Satış.' };
  }
  if (staffRow.is_active === false) {
    return { ok: false, status: 403, error: 'Staff account is inactive.' };
  }
  const role = staffRow.role;
  if (!role || !ALLOWED_ROLES.includes(role)) {
    return { ok: false, status: 403, error: 'Agency research/outreach is restricted to Yönetici/Satış.' };
  }

  return { ok: true, role, userId };
}

module.exports = {
  ConfigurationError,
  ALLOWED_ROLES,
  extractBearerToken,
  requireAgencyRole,
};
