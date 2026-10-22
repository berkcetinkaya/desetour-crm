'use strict';
/**
 * tests/dashboard/passwordRecoveryErrorHandling.test.js
 * ─────────────────────────────────────────────────────────────────────────
 * Password recovery — Phase 1 fix for the production incident where a
 * user's password-reset link redirected to
 * crm.desetour.com/#error=access_denied&error_code=otp_expired&... and the
 * CRM silently showed the normal login screen instead of a recovery-
 * specific error.
 *
 * ROOT CAUSE (see the full audit): Supabase's recovery redirect, on
 * failure, replaces the ENTIRE hash with its own flat
 * "#error=...&error_code=..." fragment — never "/reset-password" — so the
 * SPA's hash router treated the whole thing as one unmatched route
 * segment and fell through to <AuthGuard> -> plain <LoginPage/>. On
 * success, the hash collision is the same problem in reverse: Supabase's
 * own token fragment also doesn't preserve "/reset-password", so relying
 * on that path string to route to ResetPasswordPage is unreliable; the
 * real PASSWORD_RECOVERY auth event is the only trustworthy signal.
 *
 * Fix: getRecoveryCallbackError() detects error/error_code in the hash
 * BEFORE the normal route fallback and renders a dedicated
 * RecoveryErrorPage with a fixed, safe Turkish message (never Supabase's
 * own error_description); the PASSWORD_RECOVERY event is explicitly
 * branched on inside onAuthStateChange and force-navigates to
 * "/reset-password", instead of ever relying on the hash string.
 * ResetPasswordPage additionally calls sb.auth.signOut() right after a
 * successful password update (see section H below) — a recovery session
 * is aal1 and persists across reloads, and left active could otherwise
 * reach AuthGuard's MFA gate (never bypassing it, but never requiring a
 * fresh login either) via manual navigation to any authenticated route.
 *
 * Every assertion here is a static source-text match against
 * DeseTourDashboard.jsx — no live Supabase call, no React rendering,
 * matching every other test file in this project (including the sibling
 * tests/dashboard/passwordRecovery.test.js, which this file does not
 * duplicate — it covers the earlier, unrelated redirectTo/localhost
 * incident and is left untouched).
 * ─────────────────────────────────────────────────────────────────────────
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.join(__dirname, '..', '..');
const SOURCE = fs.readFileSync(path.join(REPO_ROOT, 'DeseTourDashboard.jsx'), 'utf8');

/**
 * Finds the first `openChar` at or after `searchFrom` in `text` and
 * returns [start, end) of its depth-matched span (end is the index just
 * past the matching `closeChar`) — the SAME structural primitive the
 * fix's own balanced-bracket-scanning helpers use, applied here to source
 * text instead of a JSON payload. Every other helper below builds on
 * this instead of a fixed character window.
 */
function findBalancedRange(text, searchFrom, openChar, closeChar) {
  const start = text.indexOf(openChar, searchFrom);
  assert.ok(start !== -1, `no "${openChar}" found from offset ${searchFrom}`);
  let depth = 0, i = start;
  for (; i < text.length; i++) {
    if (text[i] === openChar) depth++;
    else if (text[i] === closeChar) { depth--; if (depth === 0) { i++; break; } }
  }
  assert.ok(depth === 0, `"${openChar}" at offset ${start} never balanced`);
  return [start, i];
}

function extractBalancedBlock(text, searchFrom, openChar, closeChar) {
  const [start, end] = findBalancedRange(text, searchFrom, openChar, closeChar);
  return text.slice(start, end);
}

/**
 * Extracts a top-level `function name(...) { ... }` declaration's full
 * body, by first skipping its parameter LIST via paren-depth (so a
 * destructured parameter like `({ errorCode })` — its own brace pair —
 * is never mistaken for the function body's opening brace) and then
 * balanced-brace-matching the real body from there.
 */
function fnBody(name) {
  const idx = SOURCE.indexOf(`function ${name}(`);
  assert.ok(idx !== -1, `function ${name} not found`);
  const [, parenEnd] = findBalancedRange(SOURCE, idx, '(', ')');
  return extractBalancedBlock(SOURCE, parenEnd, '{', '}');
}

function appBody() {
  return fnBody('App');
}

/**
 * Given `text` containing a marker that ends with the literal opening
 * brace of an arrow-function body (e.g. "foo(() => {"), extracts that
 * body by balanced-brace matching from that exact brace — never a fixed
 * character window — so it always captures the FULL body regardless of
 * how long any comment inside or around it is.
 */
function arrowBodyAfter(text, marker) {
  assert.ok(marker.endsWith('{'), 'marker must end with the opening brace');
  const idx = text.indexOf(marker);
  assert.ok(idx !== -1, `marker not found: ${marker}`);
  return extractBalancedBlock(text, idx, '{', '}');
}

/**
 * Extracts the body of the `sb.auth.onAuthStateChange((ev, s) => { ... })`
 * callback the same way.
 */
function onAuthStateChangeCallbackBody() {
  return arrowBodyAfter(SOURCE, 'sb.auth.onAuthStateChange((ev, s) => {');
}

/**
 * Within `text`, extracts the body of an `if (<conditionSnippet>) { ... }`
 * block by balanced-brace matching from its own opening brace.
 */
function ifBlockBody(text, conditionSnippet) {
  const idx = text.indexOf(conditionSnippet);
  assert.ok(idx !== -1, `condition not found: ${conditionSnippet}`);
  return extractBalancedBlock(text, idx, '{', '}');
}

// ═══════════════ A. getRecoveryCallbackError — hash-error detection ═══════

test('getRecoveryCallbackError reads window.location.hash directly, independently of getHashPath/useHashRouter segment-splitting', () => {
  const body = fnBody('getRecoveryCallbackError');
  assert.match(body, /window\.location\.hash/);
  assert.match(body, /URLSearchParams/);
});

test('getRecoveryCallbackError returns null (never throws, never a fallback object) when there is no "error" param', () => {
  const body = fnBody('getRecoveryCallbackError');
  assert.match(body, /if \(!error\) return null;/);
});

test('getRecoveryCallbackError never reads or returns error_description — only error/errorCode', () => {
  const body = fnBody('getRecoveryCallbackError');
  assert.doesNotMatch(body, /error_description/);
  assert.match(body, /return \{ error, errorCode: params\.get\('error_code'\) \|\| '' \};/);
});

// ═══════════════ B. App() intercepts the hash error before the fallback ══

test('App() checks getRecoveryCallbackError() AFTER "login"/"reset-password" but BEFORE <AuthGuard> — i.e. before the normal route fallback', () => {
  const body = appBody();
  const resetIdx = body.indexOf('if (base === "reset-password")');
  const recoveryIdx = body.indexOf('getRecoveryCallbackError()');
  const guardIdx = body.indexOf('<AuthGuard>');
  assert.ok(resetIdx !== -1 && recoveryIdx !== -1 && guardIdx !== -1);
  assert.ok(resetIdx < recoveryIdx, 'recovery-error check must come after the reset-password route check');
  assert.ok(recoveryIdx < guardIdx, 'recovery-error check must come before the <AuthGuard> fallback');
});

test('App() renders RecoveryErrorPage (never LoginPage/NotFound404) when a recovery callback error is present', () => {
  const body = appBody();
  const block = ifBlockBody(body, 'if (recoveryCallbackError)');
  assert.match(block, /return <RecoveryErrorPage errorCode=\{recoveryCallbackError\.errorCode\}\/>;/);
});

// ═══════════════ C. RecoveryErrorPage — safe Turkish copy, no raw provider text ═

test('RecoveryErrorPage shows the exact required Turkish otp_expired copy when errorCode is "otp_expired"', () => {
  const body = fnBody('RecoveryErrorPage');
  assert.match(body, /Şifre sıfırlama bağlantısının süresi dolmuş veya bağlantı zaten kullanılmış\./);
  assert.match(body, /Güvenlik nedeniyle bu bağlantı yalnızca bir kez kullanılabilir\. Lütfen yeni bir şifre sıfırlama bağlantısı isteyin\./);
});

test('RecoveryErrorPage shows a distinct, safe generic Turkish message for any other/unknown errorCode', () => {
  const body = fnBody('RecoveryErrorPage');
  assert.match(body, /isExpired\s*\?\s*\n?\s*'Şifre sıfırlama bağlantısının süresi dolmuş veya bağlantı zaten kullanılmış\.'\s*\n?\s*:\s*'Şifre sıfırlama bağlantısıyla ilgili bir sorun oluştu\.'/);
  assert.match(body, /: 'Lütfen yeni bir şifre sıfırlama bağlantısı isteyin\.'/);
});

test('RecoveryErrorPage branches on errorCode === "otp_expired" specifically — not on error === "access_denied" alone, so other error_code values correctly fall to the generic state', () => {
  const body = fnBody('RecoveryErrorPage');
  assert.match(body, /const isExpired = errorCode === 'otp_expired';/);
});

test('RecoveryErrorPage never renders error_description, errorDescription, or any raw Supabase-provided text — only the two fixed Turkish strings', () => {
  const body = fnBody('RecoveryErrorPage');
  assert.doesNotMatch(body, /error_description/i);
  assert.doesNotMatch(body, /errorDescription/);
  // The component only ever destructures errorCode in its signature (see
  // the dedicated signature test below) — it never even receives the raw
  // `error` value or description text as a prop to begin with.
});

test('RecoveryErrorPage\'s own function signature only ever takes errorCode as a prop — never the raw error or description', () => {
  assert.match(SOURCE, /function RecoveryErrorPage\(\{ errorCode \}\) \{/);
});

test('access_denied (the error value Supabase actually sends alongside otp_expired) never silently falls through — RecoveryErrorPage renders unconditionally once getRecoveryCallbackError() returns non-null, regardless of which error/error_code combination it is', () => {
  const appSrc = appBody();
  // No condition narrower than "truthy recoveryCallbackError" gates the
  // RecoveryErrorPage return — it is not re-checking error==="access_denied"
  // or errorCode==="otp_expired" at the App() level (that branching is
  // RecoveryErrorPage's own job, for copy only, never for whether to show
  // the error state at all).
  assert.match(appSrc, /if \(recoveryCallbackError\) \{\s*\n\s*return <RecoveryErrorPage/);
});

test('RecoveryErrorPage provides an action back to the login screen with the reset-password flow pre-opened via LOGIN_INTENT_REF', () => {
  const body = fnBody('RecoveryErrorPage');
  assert.match(body, /LOGIN_INTENT_REF\.openReset = true;/);
  assert.match(body, /NAV_REF\.fn\('\/login'\);/);
});

// ═══════════════ D. PASSWORD_RECOVERY — explicit event-based routing ═════

test('onAuthStateChange explicitly branches on ev === "PASSWORD_RECOVERY" and force-navigates to "/reset-password"', () => {
  const callback = onAuthStateChangeCallbackBody();
  assert.match(callback, /if \(ev === 'PASSWORD_RECOVERY'\) \{/);
  assert.match(callback, /NAV_REF\.fn\('\/reset-password'\);/);
});

test('the PASSWORD_RECOVERY branch returns immediately — it never falls into the ordinary staff-bootstrap/dedup logic below it', () => {
  const callback = onAuthStateChangeCallbackBody();
  const condIdx = callback.indexOf("if (ev === 'PASSWORD_RECOVERY')");
  assert.ok(condIdx !== -1);
  const [, branchEnd] = findBalancedRange(callback, condIdx, '{', '}');
  const branchBody = callback.slice(condIdx, branchEnd);
  assert.match(branchBody, /return;/);
  // Whatever comes next, skipping only whitespace, must be the ordinary
  // bootstrap path's own first statement — proving this is a true early-
  // return guard placed in front of it, never a change to it, regardless
  // of how long the branch's own comment is.
  const afterBranch = callback.slice(branchEnd).replace(/^\s+/, '');
  assert.match(afterBranch, /^bootstrapped = true;/);
});

test('this is the ONLY place ev is compared to PASSWORD_RECOVERY — no second, conflicting branch was introduced elsewhere', () => {
  const matches = SOURCE.match(/ev === 'PASSWORD_RECOVERY'/g) || [];
  assert.equal(matches.length, 1);
});

test('ordinary event handling (dedup short-circuit for an already-verified identity, the deferred staff_users lookup) is textually unchanged and still reachable for every non-PASSWORD_RECOVERY event', () => {
  const callback = onAuthStateChangeCallbackBody();
  assert.match(callback, /if \(newUserId && newUserId === prevUserId && prevCache\?\.staff\) \{/);
  assert.match(callback, /_resolveStaffState\(s, undefined, \(\) => reqId !== _authReqSeq, diagId\);/);
});

// ═══════════════ E. LoginPage consumes LOGIN_INTENT_REF once ═════════════

test('LoginPage reads LOGIN_INTENT_REF.openReset once for its initial resetMode state and resets the flag immediately (consume-once, same shape as SESSION._prefill)', () => {
  const body = fnBody('LoginPage');
  const block = arrowBodyAfter(body, 'const [resetMode,  setResetMode]  = useState(() => {');
  assert.match(block, /const open = LOGIN_INTENT_REF\.openReset;/);
  assert.match(block, /LOGIN_INTENT_REF\.openReset = false;/);
  assert.match(block, /return open;/);
});

test('LOGIN_INTENT_REF is declared once, in the SAME contiguous block of module-level one-shot refs as NAV_REF/TOAST_REF — nothing unrelated sits between them', () => {
  const matches = SOURCE.match(/const LOGIN_INTENT_REF = \{ openReset: false \};/g) || [];
  assert.equal(matches.length, 1);
  const navIdx = SOURCE.indexOf('const NAV_REF');
  const introIdx = SOURCE.indexOf('const LOGIN_INTENT_REF', navIdx);
  assert.ok(navIdx !== -1 && introIdx !== -1 && navIdx < introIdx);
  // Structural, not distance-based: every non-blank line between NAV_REF
  // and LOGIN_INTENT_REF must be one of the two sibling ref declarations
  // themselves or a '//' comment — never a function, another unrelated
  // const, or any executable statement. This holds regardless of how long
  // any comment in between grows.
  const between = SOURCE.slice(navIdx, introIdx);
  const lines = between.split('\n').map(l => l.trim()).filter(Boolean);
  for (const line of lines) {
    assert.ok(
      /^const NAV_REF\s*=/.test(line) ||
      /^const TOAST_REF\s*=/.test(line) ||
      line.startsWith('//'),
      `unexpected statement between NAV_REF and LOGIN_INTENT_REF: "${line}"`
    );
  }
});

// ═══════════════ F. Security behavior preserved — AuthGuard/MFA/AAL2 ═════

test('RecoveryErrorPage and getRecoveryCallbackError contain no AuthGuard bypass, no MFA/AAL logic, and never touch a session directly', () => {
  const pageBody = fnBody('RecoveryErrorPage');
  const helperBody = fnBody('getRecoveryCallbackError');
  assert.doesNotMatch(pageBody, /aal2|aal1|mfa|totp|getSession|updateUser|signOut/i);
  assert.doesNotMatch(helperBody, /aal2|aal1|mfa|totp|getSession|updateUser|signOut/i);
});

test('App() still renders "login" and "reset-password" (and now the recovery-error check) all BEFORE <AuthGuard> — none of them wraps or replaces the AuthGuard/MFA gate for any other route', () => {
  const body = appBody();
  const loginIdx = body.indexOf('if (base === "login")');
  const resetIdx = body.indexOf('if (base === "reset-password")');
  const recoveryIdx = body.indexOf('const recoveryCallbackError = getRecoveryCallbackError();');
  const guardIdx = body.indexOf('<AuthGuard>');
  assert.ok(loginIdx < guardIdx && resetIdx < guardIdx && recoveryIdx < guardIdx);
});

test('the PASSWORD_RECOVERY branch never calls getAuthenticatorAssuranceLevel, mfa.challengeAndVerify, or any MFA API — it only ever navigates', () => {
  const callback = onAuthStateChangeCallbackBody();
  const condIdx = callback.indexOf("if (ev === 'PASSWORD_RECOVERY')");
  assert.ok(condIdx !== -1);
  const [, branchEnd] = findBalancedRange(callback, condIdx, '{', '}');
  const branchBody = callback.slice(condIdx, branchEnd);
  assert.doesNotMatch(branchBody, /mfa\.|getAuthenticatorAssuranceLevel|aal/i);
});

test('ResetPasswordPage (reached via the new PASSWORD_RECOVERY routing) is unchanged: still returns to /login (never /dashboard) and still contains no AAL/MFA bypass of its own', () => {
  const body = fnBody('ResetPasswordPage');
  assert.doesNotMatch(body, /NAV_REF\.fn\(['"]\/dashboard['"]\)/);
  assert.match(body, /NAV_REF\.fn\(['"]\/login['"]\)/);
  assert.doesNotMatch(body, /aal2|aal1|mfa|totp/i);
});

// ═══════════════ G. No regression on the original redirectTo fix ═════════

test('resetPasswordForEmail\'s redirectTo is still computed from window.location.origin, unchanged by this phase', () => {
  const idx = SOURCE.indexOf('sb.auth.resetPasswordForEmail(');
  const callEnd = SOURCE.indexOf(');', idx);
  const call = SOURCE.slice(idx, callEnd);
  assert.match(call, /redirectTo:\s*window\.location\.origin\s*\+\s*["']\/#\/reset-password["']/);
});

test('resetPasswordForEmail is still called exactly once in the whole file', () => {
  const matches = SOURCE.match(/\.resetPasswordForEmail\(/g) || [];
  assert.equal(matches.length, 1);
});

// ═══════════════ H. Explicit sign-out after a successful password reset ══
//
// Security conclusion this covers: a PASSWORD_RECOVERY session is aal1
// (possession of the one-time email link only, never a second factor) and
// is persisted (persistSession:true) across reloads/new tabs. AuthGuard's
// MFA gate (mfaEnrollmentRequired / mfaVerificationRequired, "mandatory,
// no skip for now") is never bypassed by it — but left active, that
// session could still be used, via manual navigation to any authenticated
// route, to reach and pass that gate (or complete first-time enrollment)
// without the user ever re-entering email+password. signOut() right after
// the password update succeeds (never before — a failed update must still
// return before reaching it) closes that specific gap: it cannot affect
// the update response itself, which already completed, and it forces the
// success screen's "Giriş Yap" to require a genuinely fresh login before
// any authenticated route (including the same MFA gate) is reachable again.

test('ResetPasswordPage calls sb.auth.signOut() after a successful updateUser, before the success state is shown', () => {
  const body = fnBody('ResetPasswordPage');
  const updateIdx = body.indexOf('sb.auth.updateUser({ password })');
  const signOutIdx = body.indexOf('sb.auth.signOut()', updateIdx);
  const doneIdx = body.indexOf('setDone(true);', updateIdx);
  assert.ok(updateIdx !== -1, 'updateUser call not found');
  assert.ok(signOutIdx !== -1, 'expected an explicit sb.auth.signOut() call after updateUser');
  assert.ok(doneIdx !== -1, 'setDone(true) not found');
  assert.ok(updateIdx < signOutIdx && signOutIdx < doneIdx, 'signOut must run strictly after the password update and before the success state is shown');
});

test('signOut is reached only on the SUCCESS path — a failed updateUser still returns before ever reaching it', () => {
  const body = fnBody('ResetPasswordPage');
  const errCheckIdx = body.indexOf("if (err) { setError('Şifre güncellenemedi: ' + err.message); setLoading(false); return; }");
  const signOutIdx = body.indexOf('sb.auth.signOut()');
  assert.ok(errCheckIdx !== -1 && signOutIdx !== -1);
  assert.ok(errCheckIdx < signOutIdx, 'the failure early-return must be textually before signOut, so a failed update never reaches it');
});

test('signOut is called only inside the real-Supabase branch (if (sb) {...}) — never in the demo-mode fallback', () => {
  const body = fnBody('ResetPasswordPage');
  const sbCheckIdx = body.indexOf('if (sb) {');
  assert.ok(sbCheckIdx !== -1);
  const [, sbBlockEnd] = findBalancedRange(body, sbCheckIdx, '{', '}');
  const sbBlockBody = body.slice(sbCheckIdx, sbBlockEnd);
  assert.match(sbBlockBody, /sb\.auth\.signOut\(\)/);
  const elseIdx = body.indexOf('} else {', sbCheckIdx);
  assert.ok(elseIdx !== -1);
  // The if(sb) block's own matched closing '}' must be the SAME '}' that
  // opens "} else {" — i.e. signOut is inside the if-branch, not spilled
  // into or past the else branch.
  assert.equal(sbBlockEnd, elseIdx + 1, 'signOut must be inside the if(sb) branch, not the demo-mode else branch');
});

test('ResetPasswordPage still contains no AAL/MFA bypass of its own, and signOut does not alter that', () => {
  const body = fnBody('ResetPasswordPage');
  assert.doesNotMatch(body, /aal2|aal1|mfa|totp/i);
});
