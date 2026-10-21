'use strict';
/**
 * tests/dashboard/passwordRecovery.test.js
 * ─────────────────────────────────────────────────────────────────────────
 * Password recovery flow — regression coverage for the production bug
 * where a password reset email sent its link to localhost instead of the
 * real production CRM domain.
 *
 * ROOT CAUSE (proven from the code, not guessed): resetPasswordForEmail's
 * redirectTo was ALREADY dynamic (`window.location.origin + "/#/reset-
 * password"`), never hardcoded to localhost — so the bug is not in this
 * code at all. It is a Supabase Dashboard configuration gap: when a
 * requested redirectTo isn't in the project's allowlisted Redirect URLs,
 * Supabase silently falls back to the project's configured Site URL,
 * which was apparently still a local-development value. No code change
 * was made; this file exists to lock in, and prove, that the existing
 * redirect computation is already production-safe (dynamic, never a
 * literal localhost/other-domain string) so a future edit can't
 * regress it back into a hardcoded value.
 *
 * Every assertion here is a static source-text match against
 * DeseTourDashboard.jsx — no live Supabase call, no React rendering,
 * matching every other test file in this project.
 * ─────────────────────────────────────────────────────────────────────────
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.join(__dirname, '..', '..');
const SOURCE = fs.readFileSync(path.join(REPO_ROOT, 'DeseTourDashboard.jsx'), 'utf8');

// ── A. resetPasswordForEmail uses a dynamic, production-safe redirect ──

test('resetPasswordForEmail is called with an explicit redirectTo (never omitted)', () => {
  const idx = SOURCE.indexOf('sb.auth.resetPasswordForEmail(');
  assert.ok(idx !== -1, 'resetPasswordForEmail call not found');
  const callEnd = SOURCE.indexOf(');', idx);
  const call = SOURCE.slice(idx, callEnd);
  assert.match(call, /redirectTo\s*:/);
});

test('redirectTo is computed from window.location.origin, never a hardcoded literal', () => {
  const idx = SOURCE.indexOf('sb.auth.resetPasswordForEmail(');
  const callEnd = SOURCE.indexOf(');', idx);
  const call = SOURCE.slice(idx, callEnd);
  assert.match(call, /redirectTo:\s*window\.location\.origin\s*\+/, 'redirectTo must be derived from the current origin, not a fixed string');
});

test('the reset-password redirect path is exactly "/#/reset-password", matching the router', () => {
  const idx = SOURCE.indexOf('sb.auth.resetPasswordForEmail(');
  const callEnd = SOURCE.indexOf(');', idx);
  const call = SOURCE.slice(idx, callEnd);
  assert.match(call, /window\.location\.origin\s*\+\s*["']\/#\/reset-password["']/);
});

test('no literal localhost string appears anywhere in the resetPasswordForEmail call', () => {
  const idx = SOURCE.indexOf('sb.auth.resetPasswordForEmail(');
  const callEnd = SOURCE.indexOf(');', idx);
  const call = SOURCE.slice(idx, callEnd);
  assert.doesNotMatch(call, /localhost/i);
});

test('no literal production domain is hardcoded into the redirect either (dynamic origin, not a fixed domain)', () => {
  const idx = SOURCE.indexOf('sb.auth.resetPasswordForEmail(');
  const callEnd = SOURCE.indexOf(');', idx);
  const call = SOURCE.slice(idx, callEnd);
  assert.doesNotMatch(call, /desetour\.com/i, 'the redirect must stay origin-derived so it also works correctly from any non-production origin (dev/preview), not pinned to one hardcoded domain');
});

test('resetPasswordForEmail is called exactly once in the whole file (single source of truth for the redirect)', () => {
  const matches = SOURCE.match(/\.resetPasswordForEmail\(/g) || [];
  assert.equal(matches.length, 1);
});

// ── B. the router actually serves /#/reset-password with ResetPasswordPage ──

test('App() routes base === "reset-password" to <ResetPasswordPage/>', () => {
  assert.match(SOURCE, /if \(base === "reset-password"\) \{\s*\n\s*return <ResetPasswordPage\/>;/);
});

test('ResetPasswordPage is defined exactly once', () => {
  const matches = SOURCE.match(/function ResetPasswordPage\(/g) || [];
  assert.equal(matches.length, 1);
});

// ── C. PASSWORD_RECOVERY / updateUser behavior ──────────────────────────

test('ResetPasswordPage calls supabase.auth.updateUser({ password }) to actually change the password', () => {
  const idx = SOURCE.indexOf('function ResetPasswordPage(');
  const end = SOURCE.indexOf('\nfunction ', idx + 20);
  const body = SOURCE.slice(idx, end);
  assert.match(body, /sb\.auth\.updateUser\(\s*\{\s*password\s*\}\s*\)/);
});

test('ResetPasswordPage enforces a minimum password length client-side before calling updateUser', () => {
  const idx = SOURCE.indexOf('function ResetPasswordPage(');
  const end = SOURCE.indexOf('\nfunction ', idx + 20);
  const body = SOURCE.slice(idx, end);
  assert.match(body, /password\.length\s*<\s*8/);
});

test('ResetPasswordPage requires the two password fields to match before calling updateUser', () => {
  const idx = SOURCE.indexOf('function ResetPasswordPage(');
  const end = SOURCE.indexOf('\nfunction ', idx + 20);
  const body = SOURCE.slice(idx, end);
  assert.match(body, /password\s*!==\s*password2/);
});

// ── D. MFA is never bypassed just because the user arrived via recovery ──

test('ResetPasswordPage never navigates straight to /dashboard — it sends the user back to /login, which re-enters the normal AuthGuard/MFA gate', () => {
  const idx = SOURCE.indexOf('function ResetPasswordPage(');
  const end = SOURCE.indexOf('\nfunction ', idx + 20);
  const body = SOURCE.slice(idx, end);
  assert.doesNotMatch(body, /NAV_REF\.fn\(['"]\/dashboard['"]\)/);
  assert.match(body, /NAV_REF\.fn\(['"]\/login['"]\)/);
});

test('ResetPasswordPage contains no special-cased MFA/AAL bypass logic of its own', () => {
  const idx = SOURCE.indexOf('function ResetPasswordPage(');
  const end = SOURCE.indexOf('\nfunction ', idx + 20);
  const body = SOURCE.slice(idx, end);
  assert.doesNotMatch(body, /aal2|aal1|mfa|totp/i);
});

test('App() renders both "login" and "reset-password" routes BEFORE the <AuthGuard> wrapper, so neither route itself needs (or bypasses) AuthGuard — the MFA gate still applies the moment a session reaches any other route', () => {
  const appIdx = SOURCE.indexOf('function App() {');
  const loginIdx = SOURCE.indexOf('if (base === "login")', appIdx);
  const resetIdx = SOURCE.indexOf('if (base === "reset-password")', appIdx);
  const guardIdx = SOURCE.indexOf('<AuthGuard>', appIdx);
  assert.ok(loginIdx !== -1 && resetIdx !== -1 && guardIdx !== -1);
  assert.ok(loginIdx < guardIdx, '"login" branch must come before <AuthGuard>');
  assert.ok(resetIdx < guardIdx, '"reset-password" branch must come before <AuthGuard>');
});

// ── E. no new/weaker login method was introduced ────────────────────────

test('no Google OAuth exists anywhere (signInWithOAuth), consistent with the standing invariant', () => {
  assert.doesNotMatch(SOURCE, /signInWithOAuth/);
});

test('no magic-link / OTP login was introduced as a replacement login method', () => {
  assert.doesNotMatch(SOURCE, /signInWithOtp/);
});

test('email+password login() still exists, unchanged in shape, as the sole primary login method', () => {
  assert.match(SOURCE, /async function login\(email,\s*password\)/);
});
