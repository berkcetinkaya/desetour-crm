/**
 * api/_shared/requireAal2.js
 * ─────────────────────────────────────────────────────────────────────────
 * TOTP MFA follow-up — server-side Authenticator Assurance Level (AAL2)
 * enforcement for browser-called privileged endpoints.
 *
 * WHY THIS EXISTS: the frontend TOTP MFA work makes AAL2 mandatory for
 * operational CRM access in the UI (see AuthGuard's mfaEnrollmentRequired/
 * mfaVerificationRequired gating in DeseTourDashboard.jsx). But a browser-
 * callable serverless endpoint that only checks staff role/is_active — not
 * assurance level — can still be called directly (curl, dev tools) with a
 * still-valid AAL1 access token, completely bypassing that UI gate. This
 * module closes that gap the same way api/_shared/authorize.js and
 * api/_agencies/authorize.js already closed the "no real identity check at
 * all" gap in an earlier phase: one small, explicit, additive check, never
 * a new auth architecture.
 *
 * FLOW: given the SAME bearer access_token requireStaffRole()/
 * requireAgencyRole() already verified belongs to a real, currently valid
 * session, this calls supabase.auth.mfa.getAuthenticatorAssuranceLevel(token)
 * — the official Supabase MFA API (proven from the installed
 * @supabase/auth-js source: when given a jwt, it decodes that token's own
 * `aal` claim locally AND separately calls getUser(jwt) — an authenticated
 * call using that SAME token as its own bearer, exactly like the existing
 * anonClient.auth.getUser(token) identity check already does elsewhere in
 * this codebase). No service_role privilege is needed for this call — it
 * only ever asks "what does THIS token's own session currently look like",
 * never reads or writes any other user's data.
 *
 * FAIL CLOSED, unconditionally: a missing/unverifiable/null/'aal1' level,
 * or any error/exception from the lookup itself, all deny with the exact
 * same generic 403 — never silently treated as "AAL2 not required" or
 * downgraded to a weaker check. Never exposes the JWT's contents, the
 * raw Supabase error, or any MFA/factor internals in the response.
 * ─────────────────────────────────────────────────────────────────────────
 */
'use strict';

/**
 * @param {string} token - the same bearer access_token already extracted
 *   and verified by the caller (requireStaffRole/requireAgencyRole) — this
 *   function does not re-verify identity, only assurance level.
 * @param {{ url:string, anonKey:string }} env - from getSupabaseEnv()
 * @param {{ createClient?: Function }} [deps] - injectable for tests
 * @returns {Promise<{ok:true} | {ok:false, status:number, error:string}>}
 */
async function requireAal2(token, env, deps = {}) {
  const DENIED = { ok: false, status: 403, error: 'Multi-factor authentication is required for this action.' };
  try {
    const createClient = deps.createClient || require('@supabase/supabase-js').createClient;
    const anonClient = createClient(env.url, env.anonKey);
    const { data, error } = await anonClient.auth.mfa.getAuthenticatorAssuranceLevel(token);
    if (error) return DENIED;
    if (!data || data.currentLevel !== 'aal2') return DENIED;
    return { ok: true };
  } catch (e) {
    return DENIED;
  }
}

module.exports = { requireAal2 };
