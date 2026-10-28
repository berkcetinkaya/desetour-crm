'use strict';
/**
 * tests/dashboard/agencyOutreachSenderName.test.js
 * ─────────────────────────────────────────────────────────────────────────
 * Agency Outreach Draft — real sender name, never a "[Name]" placeholder.
 *
 * Production symptom this follows up on: a staff member edits the "[Name]"
 * placeholder in a generated draft to their real name, approves, and sends
 * — the email still goes out reading "[Name]". Root cause (confirmed by
 * reading AcenteDetailPage's handleSendEmail and api/agency-send-email.js):
 * the review/confirm panel renders the LOCAL unsaved draftBody/draftSubject
 * state, but the send itself is authorized and composed from the SAVED
 * agency_emails row (by design — the server never trusts raw subject/body
 * text handed to it fresh). If the local edit was never persisted via
 * "Taslağı Güncelle" before "Gönderimi Onayla", the confirm panel shows the
 * corrected text while the actual send still uses the stale, un-edited row.
 *
 * Fix, at the root: the draft generator never produces an unresolved
 * placeholder in the first place.
 *   1. buildSystemPrompt now explicitly instructs the model to sign every
 *      draft with the real sender's name, OUTREACH_SENDER_NAME ("Deniz
 *      Bulut"), never a bracketed placeholder.
 *   2. fillSenderNamePlaceholder is a deterministic, mechanical safety net
 *      — same "don't just hope the prompt works" discipline as
 *      BANNED_PHRASES/emoji enforcement elsewhere in this module — applied
 *      to both subject and body in draftOutreach() after the provider
 *      response is validated, so a draft can never ship with "[Name]",
 *      "[Your Name]", "[Nombre]", "[Su Nombre]", "[Nome]" or similar, even
 *      if the model doesn't follow the prompt instruction.
 *
 * This does not touch, and does not need to touch, AcenteDetailPage's
 * save/send flow — removing the placeholder at generation time removes the
 * need for the user to ever hand-edit a name into the draft at all.
 * ─────────────────────────────────────────────────────────────────────────
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const REPO_ROOT = path.join(__dirname, '..', '..');
const outreachDraftProvider = require(path.join(REPO_ROOT, 'api', '_agencies', 'outreachDraftProvider'));

const { OUTREACH_SENDER_NAME, fillSenderNamePlaceholder, draftOutreach } = outreachDraftProvider;

// ── OUTREACH_SENDER_NAME ────────────────────────────────────────────────

test('OUTREACH_SENDER_NAME is the real sender name requested: "Deniz Bulut"', () => {
  assert.equal(OUTREACH_SENDER_NAME, 'Deniz Bulut');
});

// ── fillSenderNamePlaceholder (pure function) ───────────────────────────

test('fillSenderNamePlaceholder replaces "[Name]" and common English variants with the real sender name', () => {
  assert.equal(fillSenderNamePlaceholder('Best regards,\n[Name]\nDeseTour'), 'Best regards,\nDeniz Bulut\nDeseTour');
  assert.equal(fillSenderNamePlaceholder('Best regards,\n[Your Name]\nDeseTour'), 'Best regards,\nDeniz Bulut\nDeseTour');
  assert.equal(fillSenderNamePlaceholder('Sincerely,\n[Full Name]\nDeseTour'), 'Sincerely,\nDeniz Bulut\nDeseTour');
});

test('fillSenderNamePlaceholder replaces the Spanish and Portuguese/Italian placeholder forms too (all 4 ALLOWED_LANGUAGES)', () => {
  assert.equal(fillSenderNamePlaceholder('Atentamente,\n[Nombre]\nDeseTour'), 'Atentamente,\nDeniz Bulut\nDeseTour');
  assert.equal(fillSenderNamePlaceholder('Atentamente,\n[Su Nombre]\nDeseTour'), 'Atentamente,\nDeniz Bulut\nDeseTour');
  assert.equal(fillSenderNamePlaceholder('Atenciosamente,\n[Nome]\nDeseTour'), 'Atenciosamente,\nDeniz Bulut\nDeseTour');
  assert.equal(fillSenderNamePlaceholder('Cordiali saluti,\n[Il Tuo Nome]\nDeseTour'), 'Cordiali saluti,\nDeniz Bulut\nDeseTour');
});

test('fillSenderNamePlaceholder is case-insensitive on the placeholder word itself', () => {
  assert.equal(fillSenderNamePlaceholder('[NAME]'), 'Deniz Bulut');
  assert.equal(fillSenderNamePlaceholder('[name]'), 'Deniz Bulut');
  assert.equal(fillSenderNamePlaceholder('[NoMbRe]'), 'Deniz Bulut');
});

test('fillSenderNamePlaceholder replaces every occurrence if a placeholder somehow appears more than once', () => {
  assert.equal(fillSenderNamePlaceholder('[Name] ... later also [Name]'), 'Deniz Bulut ... later also Deniz Bulut');
});

test('fillSenderNamePlaceholder leaves text with no name placeholder completely unchanged', () => {
  const body = 'Best regards,\nDeniz Bulut\nDeseTour';
  assert.equal(fillSenderNamePlaceholder(body), body);
  assert.equal(fillSenderNamePlaceholder('No brackets at all here.'), 'No brackets at all here.');
});

test('fillSenderNamePlaceholder does not touch unrelated bracketed text that is not a name placeholder', () => {
  // e.g. a stray reference-style bracket the model might emit for some
  // other reason — must never be mistaken for a name placeholder.
  assert.equal(fillSenderNamePlaceholder('See [1] for details.'), 'See [1] for details.');
  assert.equal(fillSenderNamePlaceholder('[Company]'), '[Company]');
});

test('fillSenderNamePlaceholder is a no-op/safe pass-through on non-string or empty input', () => {
  assert.equal(fillSenderNamePlaceholder(''), '');
  assert.equal(fillSenderNamePlaceholder(undefined), undefined);
  assert.equal(fillSenderNamePlaceholder(null), null);
});

// ── buildSystemPrompt (via the real request the provider sends) ────────

function textBlock(text) { return { type: 'text', text }; }
function fakeResponse(contentBlocks) {
  return { ok: true, status: 200, json: async () => ({ content: contentBlocks }) };
}

test('the system prompt sent to the provider explicitly instructs the model to sign with OUTREACH_SENDER_NAME and never a placeholder', async () => {
  let capturedSystemPrompt = null;
  const fetchImpl = async (url, opts) => {
    capturedSystemPrompt = JSON.parse(opts.body).system;
    return fakeResponse([textBlock(JSON.stringify({
      subject: 'A quick note from DeseTour',
      body: 'word '.repeat(110).trim(),
    }))]);
  };
  await draftOutreach({ agency: { name: 'Acme Travel' }, language: 'English' }, { apiKey: 'test-key', fetchImpl });
  assert.ok(capturedSystemPrompt, 'expected the system prompt to be captured');
  assert.match(capturedSystemPrompt, /Deniz Bulut/);
  assert.match(capturedSystemPrompt, /never write a placeholder/i);
});

// ── End-to-end: draftOutreach() never ships an unresolved placeholder ──

test('draftOutreach() replaces a "[Name]" placeholder the model still produced, despite the prompt instruction — the mechanical safety net', async () => {
  const fetchImpl = async () => fakeResponse([textBlock(JSON.stringify({
    subject: 'A quick note from DeseTour',
    body: `Hello there,\n\n${'word '.repeat(100).trim()}\n\nBest regards,\n[Name]\nDeseTour`,
  }))]);
  const draft = await draftOutreach({ agency: { name: 'Acme Travel' }, language: 'English' }, { apiKey: 'test-key', fetchImpl });
  assert.doesNotMatch(draft.body, /\[Name\]/i);
  assert.match(draft.body, /Deniz Bulut/);
});

test('draftOutreach() leaves an already-correct draft (model followed the prompt) unchanged', async () => {
  const body = `Hello there,\n\n${'word '.repeat(100).trim()}\n\nBest regards,\nDeniz Bulut\nDeseTour`;
  const fetchImpl = async () => fakeResponse([textBlock(JSON.stringify({ subject: 'A quick note from DeseTour', body }))]);
  const draft = await draftOutreach({ agency: { name: 'Acme Travel' }, language: 'English' }, { apiKey: 'test-key', fetchImpl });
  assert.equal(draft.body, body);
});

test('draftOutreach() also fills a placeholder if it somehow ends up in the subject line', async () => {
  const fetchImpl = async () => fakeResponse([textBlock(JSON.stringify({
    subject: 'Following up — [Name] from DeseTour',
    body: 'word '.repeat(100).trim(),
  }))]);
  const draft = await draftOutreach({ agency: { name: 'Acme Travel' }, language: 'English' }, { apiKey: 'test-key', fetchImpl });
  assert.doesNotMatch(draft.subject, /\[Name\]/i);
  assert.match(draft.subject, /Deniz Bulut/);
});

test('draftOutreach() never introduces the sender-name fix where none is needed, for every ALLOWED_LANGUAGES value', async () => {
  for (const language of outreachDraftProvider.ALLOWED_LANGUAGES) {
    const fetchImpl = async () => fakeResponse([textBlock(JSON.stringify({
      subject: 'A quick note from DeseTour',
      body: 'word '.repeat(100).trim(),
    }))]);
    const draft = await draftOutreach({ agency: { name: 'Acme Travel' }, language }, { apiKey: 'test-key', fetchImpl });
    assert.doesNotMatch(draft.body, /\[.*\]/);
  }
});
