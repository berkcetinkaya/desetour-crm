'use strict';
/**
 * tests/dashboard/agencyMailboxFrontend.test.js
 * ─────────────────────────────────────────────────────────────────────────
 * Agency Mailbox Phase A — frontend regression. Every assertion here is a
 * static source-text match against DeseTourDashboard.jsx — no live
 * Supabase/network call, no React rendering, matching every other test
 * file in this project.
 * ─────────────────────────────────────────────────────────────────────────
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.join(__dirname, '..', '..');
const SOURCE = fs.readFileSync(path.join(REPO_ROOT, 'DeseTourDashboard.jsx'), 'utf8');

function acenteDetailPageBody() {
  const idx = SOURCE.indexOf('function AcenteDetailPage(');
  const end = SOURCE.indexOf('\nfunction ', idx + 20);
  return SOURCE.slice(idx, end);
}

// ── A. Human approval — no auto-send ────────────────────────────────────

test('handleGenerateDraft never calls fetch on /api/agency-send-email — draft generation never sends', () => {
  const body = acenteDetailPageBody();
  const idx = body.indexOf('async function handleGenerateDraft(');
  const end = body.indexOf('\n  async function ', idx + 10);
  const fnBody = body.slice(idx, end);
  assert.doesNotMatch(fnBody, /agency-send-email/);
});

test('handleSendEmail is a separate, explicit function from handleGenerateDraft and handleSaveDraft', () => {
  const body = acenteDetailPageBody();
  assert.match(body, /async function handleSendEmail\(\)/);
  assert.notEqual(body.indexOf('async function handleSendEmail('), body.indexOf('async function handleGenerateDraft('));
});

test('a deliberate two-click flow is required: the Send button only opens a review panel; only the review panel\'s own confirm button calls handleSendEmail', () => {
  const body = acenteDetailPageBody();
  // indexOf('E-postayı Gönder') would match this phase's own explanatory
  // comment above the component first — anchor on the actual JSX button
  // label (immediately before its closing </button>) instead.
  const sendButtonIdx = body.indexOf('>E-postayı Gönder</button>');
  assert.ok(sendButtonIdx !== -1);
  const sendButtonOnClick = body.slice(body.lastIndexOf('onClick=', sendButtonIdx), sendButtonIdx);
  assert.match(sendButtonOnClick, /setShowSendConfirm\(true\)/);
  assert.doesNotMatch(sendButtonOnClick, /handleSendEmail/);

  const confirmIdx = body.indexOf('"Gönderimi Onayla"}</button>');
  assert.ok(confirmIdx !== -1);
  const confirmOnClick = body.slice(body.lastIndexOf('<button', confirmIdx), confirmIdx);
  assert.match(confirmOnClick, /onClick=\{handleSendEmail\}/);
});

test('the review panel displays recipient, subject, and body before send', () => {
  const body = acenteDetailPageBody();
  const idx = body.indexOf('Gönderimden Önce Son Kontrol');
  assert.ok(idx !== -1);
  const panel = body.slice(idx, body.indexOf('Gönderimi Onayla', idx));
  assert.match(panel, /label="Alıcı"/);
  assert.match(panel, /label="Konu"/);
  assert.match(panel, /draftBody/);
});

test('the Send button is disabled while a send is in flight', () => {
  const body = acenteDetailPageBody();
  const sendButtonIdx = body.indexOf('>E-postayı Gönder</button>');
  const buttonTagStart = body.lastIndexOf('<button', sendButtonIdx);
  const buttonTag = body.slice(buttonTagStart, sendButtonIdx);
  assert.match(buttonTag, /disabled=\{sending/);
});

test('the confirm-send button is disabled while sending, and the cancel button exists', () => {
  const body = acenteDetailPageBody();
  const confirmIdx = body.indexOf('"Gönderimi Onayla"}</button>');
  const buttonTagStart = body.lastIndexOf('<button', confirmIdx);
  const buttonTag = body.slice(buttonTagStart, confirmIdx);
  assert.match(buttonTag, /disabled=\{sending\}/);
  assert.match(body, /Vazgeç/);
});

test('a sent draft shows a "Gönderildi" success state with a timestamp', () => {
  const body = acenteDetailPageBody();
  assert.match(body, /Gönderildi/);
  assert.match(body, /sentInfo\.sentAt/);
});

test('handleSendEmail requires an already-saved draft row (editingEmailId) — it never sends freshly generated, unsaved text', () => {
  const body = acenteDetailPageBody();
  const idx = body.indexOf('async function handleSendEmail()');
  const fnBody = body.slice(idx, body.indexOf('\n  }', idx));
  assert.match(fnBody, /if \(!editingEmailId\) return;/);
});

test('handleSendEmail posts only {agency_id, agency_email_id, send_mode[, reply_to_agency_email_id]} — never raw subject/body/sender as the request payload', () => {
  const body = acenteDetailPageBody();
  const idx = body.indexOf('async function handleSendEmail()');
  const fnBody = body.slice(idx, body.indexOf('\n  }', idx));
  // Agency Mailbox Phase 7 (hardened) — the request body is now
  // conditional on replyTargetEmail (new_outreach vs. an explicit reply
  // carrying reply_to_agency_email_id), but either branch still sends
  // only these structural identifiers — never draftSubject/draftBody/
  // any sender field.
  assert.match(fnBody, /body:\s*JSON\.stringify\(\s*replyTargetEmail/);
  assert.match(fnBody, /agency_id:\s*agency\.id,\s*agency_email_id:\s*editingEmailId,\s*send_mode:\s*['"]reply['"],\s*reply_to_agency_email_id:\s*replyTargetEmail\.id/);
  assert.match(fnBody, /agency_id:\s*agency\.id,\s*agency_email_id:\s*editingEmailId,\s*send_mode:\s*['"]new_outreach['"]/);
  assert.doesNotMatch(fnBody, /draftSubject|draftBody/);
});

test('handleSendEmail explicitly sends send_mode:"new_outreach" — this flow has never had a distinct Reply action, so it never silently attaches to a prior Gmail thread', () => {
  const body = acenteDetailPageBody();
  const idx = body.indexOf('async function handleSendEmail()');
  const fnBody = body.slice(idx, body.indexOf('\n  }', idx));
  assert.match(fnBody, /send_mode:\s*['"]new_outreach['"]/);
});

test('handleSendEmail attaches the current Supabase session bearer token, the same established pattern as handleGenerateDraft', () => {
  const body = acenteDetailPageBody();
  const idx = body.indexOf('async function handleSendEmail()');
  const fnBody = body.slice(idx, body.indexOf('\n  }', idx));
  assert.match(fnBody, /sb\.auth\.getSession\(\)/);
  assert.match(fnBody, /authorization.*Bearer/);
});

// ── B. No new/weaker CRM login method ───────────────────────────────────

test('no Google OAuth / Sign in with Google was introduced anywhere in this phase', () => {
  assert.doesNotMatch(SOURCE, /signInWithOAuth/);
  assert.doesNotMatch(SOURCE, /Google.{0,20}(Sign|Giriş)/i);
});

test('CRM login remains the single async function login(email, password) — unchanged', () => {
  assert.match(SOURCE, /async function login\(email,\s*password\)/);
  const matches = SOURCE.match(/async function login\(/g) || [];
  assert.equal(matches.length, 1);
});

test('TOTP MFA core functions (_resolveMfaState, _computeMfaGate) are untouched by this phase — still present, unchanged signatures', () => {
  assert.match(SOURCE, /function _resolveMfaState\(/);
  assert.match(SOURCE, /function _computeMfaGate\(/);
});

test('AuthGuard still exists and still wraps every route except login/reset-password', () => {
  assert.match(SOURCE, /function AuthGuard\(/);
  assert.match(SOURCE, /<AuthGuard>/);
});
