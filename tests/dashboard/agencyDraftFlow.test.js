'use strict';
/**
 * tests/dashboard/agencyDraftFlow.test.js
 * ─────────────────────────────────────────────────────────────────────────
 * Agency Draft Flow completion — closes the gap where a generated outreach
 * draft only ever existed in local component state until a separate,
 * easy-to-miss "Taslağı Kaydet" click, which also meant the v12.46 Send
 * button (gated on editingEmailId, a real saved row) never appeared right
 * after generation — this is the root cause of "mail yaratmıyor" users
 * reported.
 *
 * Every assertion here is a static source-text match against
 * DeseTourDashboard.jsx — no live Supabase/network call, no React
 * rendering, matching every other test file in this project.
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

function fnBody(name) {
  const body = acenteDetailPageBody();
  const idx = body.indexOf(`async function ${name}(`);
  assert.ok(idx !== -1, `${name} not found`);
  // Matching brace depth so nested functions/blocks inside don't truncate early.
  let depth = 0, i = body.indexOf('{', idx), start = i;
  for (; i < body.length; i++) {
    if (body[i] === '{') depth++;
    else if (body[i] === '}') { depth--; if (depth === 0) { i++; break; } }
  }
  return body.slice(start, i);
}

// ── A. Root cause: generation now persists immediately ─────────────────

test('handleGenerateDraft calls api/agency-draft-outreach', () => {
  const body = fnBody('handleGenerateDraft');
  assert.match(body, /fetch\('\/api\/agency-draft-outreach'/);
});

test('handleGenerateDraft persists the draft via mutAgencyEmail("create", ...) immediately after a successful provider response — never leaves it as local-only state', () => {
  const body = fnBody('handleGenerateDraft');
  const respOkIdx = body.indexOf('if (!resp.ok)');
  const createIdx = body.indexOf('mutAgencyEmail("create"', respOkIdx);
  assert.ok(createIdx !== -1, 'expected a mutAgencyEmail("create", ...) call after the response-ok check');
});

test('the persisted row uses direction=outbound, status=draft (the repo\'s own fixed create() shape, unchanged)', () => {
  const repoIdx = SOURCE.indexOf('const SupabaseAgencyEmailRepo');
  assert.ok(repoIdx !== -1);
  const idx = SOURCE.indexOf('async create(d){', repoIdx);
  const end = SOURCE.indexOf('},', idx);
  const createFnBody = SOURCE.slice(idx, end);
  assert.match(createFnBody, /direction:\s*'outbound'/);
  assert.match(createFnBody, /status:\s*'draft'/);
});

test('created_by is derived from the authenticated staff context, never a browser-supplied override', () => {
  const body = fnBody('handleGenerateDraft');
  assert.match(body, /createdBy:\s*getAuthContext\(\)\?\.staff\?\.id\s*\|\|\s*null/);
});

test('generation failure (!resp.ok) returns before any create call — no empty/partial draft row is ever created', () => {
  const body = fnBody('handleGenerateDraft');
  const respOkIdx = body.indexOf('if (!resp.ok)');
  const returnIdx = body.indexOf('return;', respOkIdx);
  const createIdx = body.indexOf('mutAgencyEmail("create"');
  assert.ok(respOkIdx !== -1 && returnIdx !== -1 && createIdx !== -1);
  assert.ok(returnIdx < createIdx, 'the early return on failure must come before the create call');
});

test('persistence failure after a successful provider response is a DISTINCT error path — never silently treated as success, never faked', () => {
  const body = fnBody('handleGenerateDraft');
  assert.match(body, /createErr \|\| !createdRow/);
  assert.match(body, /CRM'e kaydedilemedi/);
});

test('handleGenerateDraft never calls agencies update — agency status/last_contact_at are never touched by draft creation', () => {
  const body = fnBody('handleGenerateDraft');
  assert.doesNotMatch(body, /mutAgency\(/);
});

test('handleGenerateDraft never calls the send endpoint — generation never auto-sends', () => {
  const body = fnBody('handleGenerateDraft');
  assert.doesNotMatch(body, /agency-send-email/);
});

test('handleGenerateDraft regenerates unconditionally into a NEW row every time — it never checks/reuses the previously open editingEmailId before creating', () => {
  const body = fnBody('handleGenerateDraft');
  // The create call must not be gated behind "if (editingEmailId)" or similar.
  assert.doesNotMatch(body, /if\s*\(\s*editingEmailId\s*\)/);
});

// ── B. Edit / save ───────────────────────────────────────────────────────

test('handleSaveDraft updates ONLY the currently selected draft row (editingEmailId) — no create branch remains reachable from it', () => {
  const body = fnBody('handleSaveDraft');
  assert.match(body, /mutAgencyEmail\("update",\s*editingEmailId/);
  assert.doesNotMatch(body, /mutAgencyEmail\("create"/);
});

test('handleSaveDraft refuses to run against a sent row', () => {
  const body = fnBody('handleSaveDraft');
  assert.match(body, /if\s*\(!editingEmailId\s*\|\|\s*editingEmailStatus === 'sent'\)\s*return;/);
});

test('the Kaydet/Güncelle button and the editable Konu/Gövde inputs are not rendered at all once editingEmailStatus is "sent"', () => {
  const body = acenteDetailPageBody();
  const idx = body.indexOf("editingEmailStatus !== 'sent' && (draftSubject || draftBody)");
  assert.ok(idx !== -1, 'expected an editingEmailStatus !== "sent" guard around the editable draft form');
});

test('a sent row is rendered as read-only plain text, never an editable input', () => {
  const body = acenteDetailPageBody();
  const idx = body.indexOf("editingEmailStatus === 'sent' && (draftSubject || draftBody)");
  assert.ok(idx !== -1);
  const panelEnd = body.indexOf(')}', idx);
  const panel = body.slice(idx, panelEnd);
  assert.doesNotMatch(panel, /<FText\b|<FTextArea\b/);
});

test('the Send button never renders once editingEmailStatus is "sent" (it only exists inside the non-sent branch)', () => {
  const body = acenteDetailPageBody();
  const sentBranchStart = body.indexOf("editingEmailStatus === 'sent' && (draftSubject || draftBody)");
  const sentBranchEnd = body.indexOf(')}', sentBranchStart);
  const sentBranch = body.slice(sentBranchStart, sentBranchEnd);
  assert.doesNotMatch(sentBranch, /E-postayı Gönder/);
});

// ── C. Draft selection / history preservation ───────────────────────────

test('opening history or generating a new draft never deletes any agency_emails row', () => {
  assert.doesNotMatch(acenteDetailPageBody(), /mutAgencyEmail\("delete"/);
  assert.doesNotMatch(SOURCE, /from\('agency_emails'\)\.delete\(/);
});

test('the most recent draft is auto-selected by default once email history loads, without overwriting an in-progress edit', () => {
  const body = acenteDetailPageBody();
  const idx = body.indexOf('useEffect(() => {\n    if (!editingEmailId && emailHistory');
  assert.ok(idx !== -1, 'expected a default-selection effect guarded on !editingEmailId');
  const effectEnd = body.indexOf('[emailHistory]);', idx);
  const effectBody = body.slice(idx, effectEnd);
  assert.match(effectBody, /emailHistory\[0\]/);
});

test('handleOpenHistoryItem lets the send flow operate on exactly the selected row, by id', () => {
  const body = acenteDetailPageBody();
  const idx = body.indexOf('function handleOpenHistoryItem(email)');
  const end = body.indexOf('\n  }', idx);
  const fn = body.slice(idx, end);
  assert.match(fn, /setEditingEmailId\(email\.id\)/);
  assert.match(fn, /setEditingEmailStatus\(email\.status/);
});

// ── D. Activity log events (optional, safe metadata only) ───────────────

test('_sbLog accepts an optional metadata parameter, backward compatible with every existing call site', () => {
  const idx = SOURCE.indexOf('async function _sbLog(');
  const sig = SOURCE.slice(idx, SOURCE.indexOf(')', idx) + 1);
  assert.match(sig, /\(type, id, action, desc, metadata\)/);
});

test('draft_created/draft_updated events carry only agency_id/agency_email_id/language — never the email body or subject', () => {
  // Scoped to each function's OWN body (brace-depth aware) rather than
  // naive whole-file ordinal search — handleReplyToEmail (Phase 7
  // hardened) also logs a 'draft_created' event with its own, different
  // payload shape (reply_to_agency_email_id instead of language), so a
  // "2nd occurrence in the file" assumption would wrongly pick that one
  // up instead of handleSaveDraft's 'draft_updated' call.
  const generateBody = fnBody('handleGenerateDraft');
  const createdIdx = generateBody.indexOf("_sbLog('agency_email'");
  assert.ok(createdIdx !== -1);
  const createdCall = generateBody.slice(createdIdx, generateBody.indexOf(');', createdIdx));
  assert.match(createdCall, /'draft_created'/);
  assert.match(createdCall, /agency_id: agency\.id/);
  assert.match(createdCall, /agency_email_id: createdRow\.id/);
  assert.match(createdCall, /language: draftLanguage/);
  assert.doesNotMatch(createdCall, /subject/i);
  assert.doesNotMatch(createdCall, /\bbody\b/);

  const saveBody = fnBody('handleSaveDraft');
  const updatedIdx = saveBody.indexOf("_sbLog('agency_email'");
  assert.ok(updatedIdx !== -1);
  const updatedCall = saveBody.slice(updatedIdx, saveBody.indexOf(');', updatedIdx));
  assert.match(updatedCall, /'draft_updated'/);
  assert.doesNotMatch(updatedCall, /subject/i);
});

test('handleReplyToEmail\'s own draft_created event carries only agency_id/agency_email_id/reply_to_agency_email_id — never the email body or subject', () => {
  const body = acenteDetailPageBody();
  const idx = body.indexOf('async function handleReplyToEmail(');
  const end = body.indexOf('\n  }', idx);
  const fn = body.slice(idx, end);
  const logIdx = fn.indexOf("_sbLog('agency_email'");
  assert.ok(logIdx !== -1);
  const call = fn.slice(logIdx, fn.indexOf(');', logIdx));
  assert.match(call, /'draft_created'/);
  assert.match(call, /agency_id: agency\.id/);
  assert.match(call, /agency_email_id: createdRow\.id/);
  assert.match(call, /reply_to_agency_email_id: inboundEmail\.id/);
  assert.doesNotMatch(call, /subject/i);
  assert.doesNotMatch(call, /\bbody\b/);
});

// ── E. No regression on auth/send/MFA ───────────────────────────────────

test('the existing v12.46 send flow (handleSendEmail -> /api/agency-send-email) is untouched in shape', () => {
  const body = fnBody('handleSendEmail');
  assert.match(body, /fetch\('\/api\/agency-send-email'/);
  assert.match(body, /agency_email_id: editingEmailId/);
});

test('a successful send marks the locally-tracked status as sent immediately, consistent with the read-only rendering above', () => {
  const body = fnBody('handleSendEmail');
  assert.match(body, /setEditingEmailStatus\('sent'\)/);
});

test('no Google OAuth was introduced by this phase', () => {
  assert.doesNotMatch(SOURCE, /signInWithOAuth/);
});

test('CRM login remains the single async function login(email, password) — unchanged', () => {
  const matches = SOURCE.match(/async function login\(/g) || [];
  assert.equal(matches.length, 1);
});
