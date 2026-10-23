'use strict';
/**
 * tests/dashboard/mfaTotp.test.js
 * ─────────────────────────────────────────────────────────────────────────
 * TOTP MFA — mandatory email+password -> TOTP -> CRM access.
 *
 * Core invariant proven throughout: Google OAuth does not exist anywhere
 * in this codebase (it was fully removed in an earlier phase, and this
 * phase never reintroduces it — no signInWithOAuth, no Gmail scopes). The
 * new authorization chain is auth.users -> staff_users.id -> is_active ->
 * role -> MFA (verified TOTP factor + session at aal2) -> RLS, exactly as
 * specified; no step short-circuits the others, and nothing is cached in
 * a one-time React flag or localStorage — MFA state is re-derived fresh,
 * via the official Supabase MFA API, on every mount/session change.
 *
 * Every assertion here is either a pure-function test (_resolveMfaState,
 * _findStaleUnverifiedTotpFactor, _computeMfaGate — all directly
 * extracted and run with fake Supabase MFA API shapes matching the real
 * installed SDK's return values) or a static source assertion — no live
 * Supabase/network call, no React rendering, matching every other test
 * file in this project.
 * ─────────────────────────────────────────────────────────────────────────
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.join(__dirname, '..', '..');
const SOURCE_PATH = path.join(REPO_ROOT, 'DeseTourDashboard.jsx');
const SOURCE = fs.readFileSync(SOURCE_PATH, 'utf8');

function extractCombined(names) {
  let body = '';
  for (const name of names) {
    const startMarker = `// TESTABLE:${name}:start`;
    const endMarker = `// TESTABLE:${name}:end`;
    const startIdx = SOURCE.indexOf(startMarker);
    const endIdx = SOURCE.indexOf(endMarker);
    assert.ok(startIdx !== -1 && endIdx !== -1 && endIdx > startIdx, `markers for "${name}" not found`);
    body += SOURCE.slice(startIdx + startMarker.length, endIdx) + '\n';
  }
  const lastName = names[names.length - 1];
  // eslint-disable-next-line no-new-func
  return new Function(`${body}\nreturn ${lastName};`)();
}

function body(name, nextMarker) {
  const idx = SOURCE.indexOf(`function ${name}(`);
  assert.ok(idx !== -1, `could not find function ${name}`);
  return SOURCE.slice(idx, SOURCE.indexOf(nextMarker, idx));
}

const resolveMfaState = extractCombined(['_resolveMfaState']);
const findStaleUnverifiedTotpFactor = extractCombined(['_findStaleUnverifiedTotpFactor']);
const computeMfaGate = extractCombined(['_computeMfaGate']);

const USE_AUTH_BODY = body('useAuth', '\nconst AuthContext');
const AUTH_GUARD_BODY = body('AuthGuard', '\nfunction getAuthContext');
const LOGIN_PAGE_BODY = body('LoginPage', '\nfunction AccessDenied');
const MFA_ENROLLMENT_BODY = body('MfaEnrollmentScreen', '\nfunction AuthGuard');
const MFA_VERIFICATION_BODY = body('MfaVerificationScreen', '\n// CASE B');

function stripComments(text) {
  return text.split('\n').filter(line => !line.trim().startsWith('//')).join('\n');
}

function fakeSb({ aalData, aalError, factorsData, factorsError } = {}) {
  return {
    auth: {
      mfa: {
        getAuthenticatorAssuranceLevel: async () => (aalError ? { data: null, error: aalError } : { data: aalData, error: null }),
        listFactors: async () => (factorsError ? { data: null, error: factorsError } : { data: factorsData, error: null }),
      },
    },
  };
}

// ═══════════════ [1] Google OAuth does not exist ════════════════════════

test('[1] Google OAuth does not exist anywhere in this codebase', () => {
  assert.doesNotMatch(SOURCE, /signInWithOAuth/);
  assert.doesNotMatch(SOURCE, /loginWithGoogle/);
  assert.doesNotMatch(SOURCE, /_isGoogleSession/);
  assert.doesNotMatch(SOURCE, /linkIdentity/);
  assert.doesNotMatch(SOURCE, /provider:\s*'google'/);
});

// ═══════════════ [2] signInWithPassword remains the login method ════════

test('[2] login() still delegates to the real, unmodified _signInWithPassword', () => {
  const idx = SOURCE.indexOf('async function login(email, password)');
  const loginBody = SOURCE.slice(idx, SOURCE.indexOf('\n}', idx));
  assert.match(loginBody, /return _signInWithPassword\(sb, email, password\);/);
  assert.match(SOURCE, /sb\.auth\.signInWithPassword\(\{ email, password \}\)/);
});

// ═══════════════ [3] Active staff, no verified TOTP -> enrollment ═══════

test('[3] active staff with no verified TOTP factor is routed to enrollment, never straight to CRM content', () => {
  const mfaState = { mfaLoading: false, mfaCurrentLevel: null, mfaNextLevel: null, mfaVerifiedTotpFactors: [], mfaQueryError: null };
  const gate = computeMfaGate(mfaState, true, false);
  assert.equal(gate.mfaEnrollmentRequired, true);
  assert.equal(gate.mfaVerificationRequired, false);
});

// ═══════════════ [4] Enrollment uses factorType totp ═════════════════════

test('[4] MfaEnrollmentScreen enrolls with factorType "totp" via the real installed SDK signature', () => {
  assert.match(MFA_ENROLLMENT_BODY, /sb\.auth\.mfa\.enroll\(\{ factorType: 'totp', issuer: 'DeseTour CRM' \}\)/);
});

// ═══════════════ [5] Enrollment QR comes from Supabase MFA data ═════════

test('[5] the displayed QR code and secret come directly from the enroll() response, never invented or hardcoded', () => {
  assert.match(MFA_ENROLLMENT_BODY, /setQrCodeUri\(\(enrollData\.totp && enrollData\.totp\.qr_code\) \|\| null\)/);
  assert.match(MFA_ENROLLMENT_BODY, /setFactorId\(enrollData\.id\)/);
  assert.doesNotMatch(MFA_ENROLLMENT_BODY, /data:image\/svg/, 'the QR data URI must come from Supabase\'s own response, never be constructed here');
});

// ═══════════════ [6] TOTP secret never persisted ════════════════════════

test('[6] the TOTP secret is never written to any repository, table, or storage — only held in local component state', () => {
  assert.doesNotMatch(MFA_ENROLLMENT_BODY, /\.insert\(|\.upsert\(|\.update\(/);
  assert.doesNotMatch(MFA_ENROLLMENT_BODY, /localStorage|sessionStorage/);
  assert.doesNotMatch(SOURCE, /staff_users['"]\)[^;]*secret/i, 'secret must never appear near a staff_users write');
  assert.doesNotMatch(SOURCE, /activity_logs['"]\)[^;]*secret/i, 'secret must never appear near an activity_logs write');
});

// ═══════════════ [7] TOTP secret never logged ═══════════════════════════

test('[7] the TOTP secret/QR is never passed to console.log/console.error/console.warn', () => {
  const consoleCalls = MFA_ENROLLMENT_BODY.match(/console\.(log|error|warn)\([^)]*\)/g) || [];
  for (const call of consoleCalls) {
    assert.doesNotMatch(call, /\bsecret\b/i);
    assert.doesNotMatch(call, /qrCodeUri/i);
  }
  // Every console call in this screen must log only a fixed string and/or
  // e.message (an Auth error's own message, e.g. "Invalid TOTP code") —
  // never the enrollment data object itself.
  assert.doesNotMatch(MFA_ENROLLMENT_BODY, /console\.(log|error|warn)\([^)]*enrollData/);
});

// ═══════════════ [8] Unverified factor does not count as completed MFA ═

test('[8] a factor that exists but is not status==="verified" never satisfies MFA — listFactors already filters this, proven end to end', async () => {
  // Mirrors the REAL installed SDK's _listFactors: only verified factors
  // land in the per-type bucket; an unverified one would only ever appear
  // in `.all` (which _resolveMfaState does not read for gating purposes).
  const sb = fakeSb({
    aalData: { currentLevel: 'aal1', nextLevel: 'aal1', currentAuthenticationMethods: [] },
    factorsData: { all: [{ id: 'f1', factor_type: 'totp', status: 'unverified' }], totp: [], phone: [], webauthn: [], recovery_code: [] },
  });
  const patch = await resolveMfaState(sb, { access_token: 'jwt' });
  assert.equal(patch.mfaVerifiedTotpFactors.length, 0);
  const gate = computeMfaGate(patch, true, false);
  assert.equal(gate.mfaEnrollmentRequired, true, 'an unverified factor must still route to enrollment, not verification');
  assert.equal(gate.mfaVerificationRequired, false);
});

test('_findStaleUnverifiedTotpFactor finds exactly the abandoned enrollment attempt, never a verified factor', () => {
  const all = [
    { id: 'verified-1', factor_type: 'totp', status: 'verified' },
    { id: 'unverified-1', factor_type: 'totp', status: 'unverified' },
  ];
  const stale = findStaleUnverifiedTotpFactor(all);
  assert.equal(stale.id, 'unverified-1');
  assert.equal(findStaleUnverifiedTotpFactor([{ id: 'verified-1', factor_type: 'totp', status: 'verified' }]), null);
  assert.equal(findStaleUnverifiedTotpFactor([]), null);
  assert.equal(findStaleUnverifiedTotpFactor(undefined), null);
});

test('MfaEnrollmentScreen discards a stale unverified factor before enrolling a fresh one, preventing accumulation', () => {
  assert.match(MFA_ENROLLMENT_BODY, /_findStaleUnverifiedTotpFactor\(listData && listData\.all\)/);
  assert.match(MFA_ENROLLMENT_BODY, /sb\.auth\.mfa\.unenroll\(\{ factorId: stale\.id \}\)/);
});

// ═══════════════ [9] Active staff + verified TOTP + aal1 -> verification ═

test('[9] active staff with a verified TOTP factor and currentLevel aal1 is routed to verification, never straight to CRM content', () => {
  const mfaState = { mfaLoading: false, mfaCurrentLevel: 'aal1', mfaNextLevel: 'aal2', mfaVerifiedTotpFactors: [{ id: 'f1', status: 'verified' }], mfaQueryError: null };
  const gate = computeMfaGate(mfaState, true, false);
  assert.equal(gate.mfaEnrollmentRequired, false);
  assert.equal(gate.mfaVerificationRequired, true);
});

test('a null currentLevel (no aal claim at all) with a verified factor still requires verification — never treated as already satisfied', () => {
  const mfaState = { mfaLoading: false, mfaCurrentLevel: null, mfaNextLevel: 'aal2', mfaVerifiedTotpFactors: [{ id: 'f1', status: 'verified' }], mfaQueryError: null };
  assert.equal(computeMfaGate(mfaState, true, false).mfaVerificationRequired, true);
});

// ═══════════════ [10] Operational CRM inaccessible at AAL1 ══════════════

test('[10] AuthGuard checks mfaLoading/mfaQueryError/mfaEnrollmentRequired/mfaVerificationRequired strictly BEFORE ever rendering children', () => {
  const orderMarkers = ['if (auth.mfaLoading)', 'if (auth.mfaQueryError)', 'if (auth.mfaEnrollmentRequired)', 'if (auth.mfaVerificationRequired)', '<AuthContext.Provider value={auth}>'];
  const indices = orderMarkers.map(m => AUTH_GUARD_BODY.indexOf(m));
  for (const idx of indices) assert.ok(idx !== -1, 'expected marker not found in AuthGuard');
  for (let i = 1; i < indices.length; i++) {
    assert.ok(indices[i] > indices[i - 1], `expected "${orderMarkers[i]}" to appear after "${orderMarkers[i - 1]}"`);
  }
});

test('MfaEnrollmentScreen/MfaVerificationScreen render INSTEAD OF children, never alongside them', () => {
  const enrollmentIdx = AUTH_GUARD_BODY.indexOf('if (auth.mfaEnrollmentRequired)');
  const enrollmentBlock = AUTH_GUARD_BODY.slice(enrollmentIdx, enrollmentIdx + 120);
  assert.match(enrollmentBlock, /return <MfaEnrollmentScreen auth=\{auth\}\/>;/);
  const verificationIdx = AUTH_GUARD_BODY.indexOf('if (auth.mfaVerificationRequired)');
  const verificationBlock = AUTH_GUARD_BODY.slice(verificationIdx, verificationIdx + 120);
  assert.match(verificationBlock, /return <MfaVerificationScreen auth=\{auth\}\/>;/);
});

// ═══════════════ [11] Correct verification leads to AAL2 authorization ═

test('[11] once currentLevel is aal2, neither enrollment nor verification is required — the gate opens', () => {
  const mfaState = { mfaLoading: false, mfaCurrentLevel: 'aal2', mfaNextLevel: 'aal2', mfaVerifiedTotpFactors: [{ id: 'f1', status: 'verified' }], mfaQueryError: null };
  const gate = computeMfaGate(mfaState, true, false);
  assert.equal(gate.mfaEnrollmentRequired, false);
  assert.equal(gate.mfaVerificationRequired, false);
});

test('MfaVerificationScreen and MfaEnrollmentScreen both call the real challengeAndVerify — never a hand-rolled verification shortcut', () => {
  assert.match(MFA_VERIFICATION_BODY, /sb\.auth\.mfa\.challengeAndVerify\(\{ factorId, code \}\)/);
  assert.match(MFA_ENROLLMENT_BODY, /sb\.auth\.mfa\.challengeAndVerify\(\{ factorId, code \}\)/);
});

// ═══════════════ [12] Incorrect code does not authorize ═════════════════

test('[12] a challengeAndVerify error sets a Turkish error and returns — no state transition toward authorization occurs', () => {
  const idx = MFA_VERIFICATION_BODY.indexOf('challengeAndVerify');
  const errBlock = MFA_VERIFICATION_BODY.slice(idx, idx + 400);
  assert.match(errBlock, /if \(err\) \{/);
  assert.match(errBlock, /setError\("Kod doğrulanamadı\. Lütfen tekrar deneyin\."\);/);
  assert.match(errBlock, /return;/);
});

test('no code path anywhere sets a literal mfaVerified-style flag to true', () => {
  assert.doesNotMatch(SOURCE, /mfaVerified\s*=\s*true/);
  assert.doesNotMatch(SOURCE, /setMfaVerified/);
});

// ═══════════════ [13] Missing staff row remains blocked ═════════════════

test('[13] the "Personel Profili Bağlı Değil" (missing staff) branch is checked strictly before any MFA branch', () => {
  const missingStaffIdx = AUTH_GUARD_BODY.indexOf('if (!auth.staffLinked) {');
  const mfaLoadingIdx = AUTH_GUARD_BODY.indexOf('if (auth.mfaLoading)');
  assert.ok(missingStaffIdx !== -1 && mfaLoadingIdx !== -1);
  assert.ok(missingStaffIdx < mfaLoadingIdx);
});

test('_computeMfaGate never requires enrollment/verification when staffLinked is false', () => {
  const mfaState = { mfaLoading: false, mfaCurrentLevel: null, mfaNextLevel: null, mfaVerifiedTotpFactors: [], mfaQueryError: null };
  const gate = computeMfaGate(mfaState, false, false);
  assert.equal(gate.mfaEnrollmentRequired, false);
  assert.equal(gate.mfaVerificationRequired, false);
});

// ═══════════════ [14] Inactive staff remains blocked ════════════════════

test('[14] the "Hesap Pasif" (inactive staff) branch is checked strictly before any MFA branch', () => {
  const inactiveIdx = AUTH_GUARD_BODY.indexOf('if (!auth.staffLinked && auth.staffInactive) {');
  const mfaLoadingIdx = AUTH_GUARD_BODY.indexOf('if (auth.mfaLoading)');
  assert.ok(inactiveIdx !== -1 && mfaLoadingIdx !== -1);
  assert.ok(inactiveIdx < mfaLoadingIdx);
});

test('_computeMfaGate never requires enrollment/verification when staffInactive is true, even with a verified factor', () => {
  const mfaState = { mfaLoading: false, mfaCurrentLevel: 'aal1', mfaNextLevel: 'aal2', mfaVerifiedTotpFactors: [{ id: 'f1', status: 'verified' }], mfaQueryError: null };
  const gate = computeMfaGate(mfaState, true, true);
  assert.equal(gate.mfaEnrollmentRequired, false);
  assert.equal(gate.mfaVerificationRequired, false);
});

// ═══════════════ [15]-[18] Roles unchanged after MFA ════════════════════

test('[15-18] ROLE_MAP (DB role -> Turkish display role) is byte-for-byte unchanged by this phase', () => {
  assert.match(SOURCE, /const ROLE_MAP = \{\s*\n\s*'admin':\s*'Yönetici',\s*\n\s*'sales':\s*'Satış',\s*\n\s*'operations':\s*'Operasyon',\s*\n\s*'guide':\s*'Rehber',\s*\n\s*\};/);
});

test('ROLE_PERMISSIONS is byte-for-byte unchanged by this phase', () => {
  // Updated by the later Son Hareketler phase, which additively granted
  // every role "activity" access — MFA gating itself is untouched;
  // this just tracks the current literal shape.
  assert.match(SOURCE, /const ROLE_PERMISSIONS = \{\n  "Yönetici": null, \/\/ null = all pages\n  "Satış":    \["dashboard","customers","reservations","guides","leads","quotes","reminders","agencies","messages","reports","more","changelog","activity"\],\n  "Operasyon":\["dashboard","reservations","calendar","tours","guides","leads","quotes","reminders","payments","reports","more","changelog","activity"\],\n  "Rehber":   \["dashboard","calendar","reservations","more","changelog","activity"\],\n\};/);
});

test('MFA resolution/gating never reads or writes `role` — role stays sourced only from staff.role, same as before this phase', () => {
  const mfaEffectIdx = USE_AUTH_BODY.indexOf('useEffect(() => {\n    const sb = getSB();\n    if (!sb || !session?.access_token || !staff || staffInactive)');
  assert.ok(mfaEffectIdx !== -1, 'MFA resolution effect not found at expected shape');
  const mfaEffectEndIdx = USE_AUTH_BODY.indexOf('}, [session?.access_token, !!staff, staffInactive]);', mfaEffectIdx);
  const mfaEffectBody = stripComments(USE_AUTH_BODY.slice(mfaEffectIdx, mfaEffectEndIdx));
  assert.doesNotMatch(mfaEffectBody, /\brole\b/);
  const gateSrc = SOURCE.slice(SOURCE.indexOf('// TESTABLE:_computeMfaGate:start'), SOURCE.indexOf('// TESTABLE:_computeMfaGate:end'));
  assert.doesNotMatch(stripComments(gateSrc), /\brole\b/);
});

// ═══════════════ [19] Password reset remains intact ═════════════════════

test('[19] password reset is untouched — resetPasswordForEmail and the reset UI are both still present', () => {
  assert.match(LOGIN_PAGE_BODY, /sb\.auth\.resetPasswordForEmail\(resetEmail/);
  assert.match(LOGIN_PAGE_BODY, /Şifremi unuttum/);
});

// ═══════════════ [20] Logout remains intact ══════════════════════════════

test('[20] logout() still signs out of Supabase and clears the auth cache, unchanged', () => {
  const idx = SOURCE.indexOf('async function logout()');
  const logoutBody = SOURCE.slice(idx, SOURCE.indexOf('\n  }', idx));
  assert.match(logoutBody, /sb\.auth\.signOut\(\)/);
  assert.match(logoutBody, /updateAuth\(\{ session:null, staff:null/);
});

test('both MFA screens offer logout as their only secondary action — never a "skip MFA" action', () => {
  assert.match(MFA_ENROLLMENT_BODY, /onClick=\{auth\.logout\}/);
  assert.match(MFA_VERIFICATION_BODY, /onClick=\{auth\.logout\}/);
  assert.doesNotMatch(MFA_ENROLLMENT_BODY, /[Ss]kip|[Ş]imdi değil|sonra hatırlat/);
  assert.doesNotMatch(MFA_VERIFICATION_BODY, /[Ss]kip|[Ş]imdi değil|sonra hatırlat/);
});

// ═══════════════ [21] Session restoration checks MFA state ══════════════

test('[21] MFA state is a fresh component-local useState starting at mfaLoading:true — never read from the module-level _authCache', () => {
  assert.match(USE_AUTH_BODY, /const \[mfaState, setMfaState\] = useState\(\{\s*\n\s*mfaLoading: true,/);
});

test('the MFA resolution effect re-runs whenever the session access token, staff linkage, or active status changes', () => {
  assert.match(USE_AUTH_BODY, /\}, \[session\?\.access_token, !!staff, staffInactive\]\);/);
});

// ═══════════════ [22] Refresh cannot bypass MFA ═════════════════════════

test('[22] no localStorage/sessionStorage is used anywhere in the MFA resolution, gating, or screens', () => {
  for (const block of [USE_AUTH_BODY, MFA_ENROLLMENT_BODY, MFA_VERIFICATION_BODY]) {
    assert.doesNotMatch(stripComments(block), /localStorage|sessionStorage/);
  }
});

test('_resolveMfaState always calls the live Supabase MFA API — it never returns a result without awaiting getAuthenticatorAssuranceLevel/listFactors', () => {
  const startMarker = '// TESTABLE:_resolveMfaState:start';
  const endMarker = '// TESTABLE:_resolveMfaState:end';
  const fnSource = SOURCE.slice(SOURCE.indexOf(startMarker), SOURCE.indexOf(endMarker));
  assert.match(fnSource, /sb\.auth\.mfa\.getAuthenticatorAssuranceLevel\(session\.access_token\)/);
  assert.match(fnSource, /sb\.auth\.mfa\.listFactors\(\)/);
});

// ═══════════════ [23] No public signup exists ════════════════════════════

test('[23] no public sign-up path exists anywhere — no auth.signUp call, no sign-up UI', () => {
  assert.doesNotMatch(SOURCE, /auth\.signUp\(/);
  assert.doesNotMatch(LOGIN_PAGE_BODY, /Kayıt Ol|Hesap Oluştur|Sign ?Up/i);
});

// ═══════════════ [24] No signInWithOAuth exists ══════════════════════════

test('[24] signInWithOAuth does not exist anywhere (duplicate-proofing [1] at the exact API-call level)', () => {
  assert.doesNotMatch(SOURCE, /\.signInWithOAuth\(/);
});

// ═══════════════ [25] No Gmail scopes exist ══════════════════════════════

test('[25] no Gmail/mail scope string, and no `scopes` option at all, exists anywhere in the MFA code', () => {
  for (const block of [MFA_ENROLLMENT_BODY, MFA_VERIFICATION_BODY]) {
    assert.doesNotMatch(block, /gmail/i);
    assert.doesNotMatch(block, /mail\.google/i);
    assert.doesNotMatch(block, /scopes\s*:/);
  }
});

// ═══════════════ [26] MFA API errors fail closed ════════════════════════

test('[26] a getAuthenticatorAssuranceLevel error fails closed: mfaQueryError is set, no verified factors are assumed, levels stay null', async () => {
  const sb = fakeSb({ aalError: { message: 'network error' }, factorsData: { all: [], totp: [], phone: [], webauthn: [], recovery_code: [] } });
  const patch = await resolveMfaState(sb, { access_token: 'jwt' });
  assert.equal(patch.mfaQueryError, 'network error');
  assert.equal(patch.mfaVerifiedTotpFactors.length, 0);
  assert.equal(patch.mfaCurrentLevel, null);
  const gate = computeMfaGate(patch, true, false);
  assert.equal(gate.mfaEnrollmentRequired, false, 'a query error must route to AuthGuard\'s own error screen, never to enrollment');
  assert.equal(gate.mfaVerificationRequired, false, 'a query error must route to AuthGuard\'s own error screen, never to verification (which would imply a known-good state)');
});

test('[26] a listFactors error fails closed the same way', async () => {
  const sb = fakeSb({ aalData: { currentLevel: 'aal1', nextLevel: 'aal1', currentAuthenticationMethods: [] }, factorsError: { message: 'listFactors failed' } });
  const patch = await resolveMfaState(sb, { access_token: 'jwt' });
  assert.equal(patch.mfaQueryError, 'listFactors failed');
  assert.equal(patch.mfaVerifiedTotpFactors.length, 0);
});

test('[26] a thrown/rejected MFA call fails closed, never propagating uncaught', async () => {
  const sb = { auth: { mfa: {
    getAuthenticatorAssuranceLevel: async () => { throw new Error('network down'); },
    listFactors: async () => ({ data: { all: [], totp: [] }, error: null }),
  } } };
  const patch = await resolveMfaState(sb, { access_token: 'jwt' });
  assert.equal(patch.mfaQueryError, 'network down');
});

test('AuthGuard shows the fail-closed MFA-query-error screen with retry, never exposing the raw error message', () => {
  assert.match(AUTH_GUARD_BODY, /Doğrulama Durumu Kontrol Edilemedi/);
  assert.match(AUTH_GUARD_BODY, /onClick=\{auth\.retryMfaResolution\}/);
  const idx = AUTH_GUARD_BODY.indexOf('Doğrulama Durumu Kontrol Edilemedi');
  const screen = AUTH_GUARD_BODY.slice(Math.max(0, idx - 300), idx + 600);
  assert.doesNotMatch(screen, /\{auth\.mfaQueryError\}/, 'the raw Supabase error text must never be interpolated into the UI');
});

// ═══════════════ [27] Operational CRM rendered only after final state ══

test('[27] children render only in the final, unconditional branch — after every blocking check has already returned', () => {
  const returnChildrenIdx = AUTH_GUARD_BODY.lastIndexOf('{children}');
  assert.ok(returnChildrenIdx !== -1);
  const beforeChildren = AUTH_GUARD_BODY.slice(0, returnChildrenIdx);
  // Every blocking branch must appear (and thus have already had the
  // chance to return) before this point in the function body.
  for (const marker of ['auth.authLoading', '!auth.isLoggedIn', '!auth.staffLinked', 'auth.mfaLoading', 'auth.mfaQueryError', 'auth.mfaEnrollmentRequired', 'auth.mfaVerificationRequired']) {
    assert.ok(beforeChildren.includes(marker), `expected "${marker}" to be checked before children render`);
  }
});

// ═══════════════ Visual language / copy — exact strings requested ══════

test('MfaVerificationScreen uses the exact requested Turkish copy', () => {
  assert.match(MFA_VERIFICATION_BODY, /Doğrulama Kodu/);
  assert.match(MFA_VERIFICATION_BODY, /Kimlik doğrulama uygulamanızdaki 6 haneli kodu girin\./);
  assert.match(MFA_VERIFICATION_BODY, /"Doğrula"/);
});

test('MfaEnrollmentScreen uses the exact requested Turkish copy and mentions Google Authenticator only as an example', () => {
  assert.match(MFA_ENROLLMENT_BODY, /İki Aşamalı Doğrulama/);
  assert.match(MFA_ENROLLMENT_BODY, /DeseTour CRM hesabınızı korumak için bir kimlik doğrulama uygulamasıyla iki aşamalı doğrulamayı etkinleştirin\./);
  assert.match(MFA_ENROLLMENT_BODY, /"Doğrulamayı Etkinleştir"/);
  assert.match(MFA_ENROLLMENT_BODY, /Google Authenticator veya uyumlu bir kimlik doğrulama uygulamasıyla/);
  assert.doesNotMatch(MFA_ENROLLMENT_BODY, /Google (ile )?[Gg]iriş/, 'must never be called "Google login"');
});

test('the 6-digit input requires numeric, one-time-code semantics', () => {
  assert.match(SOURCE, /inputMode="numeric" autoComplete="one-time-code" maxLength=\{6\}/);
});
