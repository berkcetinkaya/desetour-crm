'use strict';
/**
 * tests/dashboard/agencyDraftParserRobustness.test.js
 * ─────────────────────────────────────────────────────────────────────────
 * Agency Outreach Draft — provider response parsing reliability.
 *
 * Production symptom this follows up on: "Draft provider response did not
 * contain a parseable draft object." — i.e. the Anthropic request
 * COMPLETED (no HTTP error), but outreachDraftProvider.js could not
 * extract the draft JSON from the real response text.
 *
 * Root cause, proven from the code (not guessed):
 *   - extractDraftObject used ONE greedy regex (/\{[\s\S]*\}/) across the
 *     whole joined text. Greedy means "from the FIRST '{' anywhere to the
 *     LAST '}' anywhere" — it returns no match at all (producing exactly
 *     the reported error) whenever the response has an opening '{' with
 *     no closing '}' anywhere after it, which is exactly what happens if
 *     the response is cut off (by max_tokens, or any other truncation)
 *     before the model finishes the object, or if the model wraps its
 *     answer in a markdown fence or brief prose the old regex never
 *     accounted for.
 *   - max_tokens was 1024 for a six-field JSON object (subject, a 90-140
 *     word body, personalization_signal, angle_reason, fit_level,
 *     fit_reason) in the TARGET language, which the model is not fully
 *     reliable about emitting with zero surrounding text despite being
 *     told to — the same class of incident already proven and fixed in
 *     researchProvider.js (see agencyResearchParserRobustness.test.js).
 *
 * Fix: the same deterministic, string-scanning (never eval, never a
 * hand-rolled JSON grammar, never a naive greedy regex) extraction
 * strategy as researchProvider.js's extractCandidateArray, adapted for a
 * single object instead of an array — direct JSON.parse, markdown-fence-
 * stripped JSON.parse, then a balanced-brace scan that stops at the first
 * depth-zero close and skips the contents of quoted strings — plus
 * max_tokens raised to 2048. Every assertion here is a pure-function test
 * (no live Anthropic call) or a static source assertion, like every other
 * test file in this project.
 * ─────────────────────────────────────────────────────────────────────────
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.join(__dirname, '..', '..');
const outreachDraftProvider = require(path.join(REPO_ROOT, 'api', '_agencies', 'outreachDraftProvider'));
const AGENCY_DRAFT_API_SOURCE = fs.readFileSync(path.join(REPO_ROOT, 'api', 'agency-draft-outreach.js'), 'utf8');

const {
  extractDraftObject, stripMarkdownFence, findBalancedJsonSpan,
  enforceWritingStandard, draftOutreach, ProviderError,
} = outreachDraftProvider;

const VALID_DRAFT = {
  subject: 'A quick note from DeseTour',
  body: 'word '.repeat(110).trim(),
  personalization_signal: 'your Türkiye-focused programs',
  angle_reason: 'small-group operations fit well',
  fit_level: 'Orta Uyum',
  fit_reason: 'Operates outbound cultural travel to the eastern Mediterranean.',
};

function textBlock(text) { return { type: 'text', text }; }
function toolUseBlock() { return { type: 'tool_use', id: 'tool_1', name: 'some_tool', input: {} }; }

function fakeResponse(contentBlocks) {
  return { ok: true, status: 200, json: async () => ({ content: contentBlocks }) };
}

async function draftWith(contentBlocks, input) {
  const fetchImpl = async () => fakeResponse(contentBlocks);
  return draftOutreach(input || { agency: { name: 'Acme Travel' }, language: 'English' }, { apiKey: 'test-key', fetchImpl });
}

// ═══════════════ [1] direct JSON object in a single text block ══════════

test('[1] a direct JSON object in a single text block parses successfully end to end', async () => {
  const draft = await draftWith([textBlock(JSON.stringify(VALID_DRAFT))]);
  assert.equal(draft.subject, VALID_DRAFT.subject);
  assert.equal(draft.fit_level, 'Orta Uyum');
});

// ═══════════════ [2] JSON inside a ```json markdown fence ════════════════

test('[2] JSON wrapped in a ```json ... ``` markdown fence is extracted and parsed', async () => {
  const fenced = '```json\n' + JSON.stringify(VALID_DRAFT) + '\n```';
  const draft = await draftWith([textBlock(fenced)]);
  assert.equal(draft.subject, VALID_DRAFT.subject);
});

test('[3] a plain ``` ... ``` fence with no "json" language tag also works', () => {
  const fenced = '```\n' + JSON.stringify({ subject: 'Hi', body: 'word '.repeat(100).trim() }) + '\n```';
  const result = extractDraftObject(fenced);
  assert.equal(result.subject, 'Hi');
});

test('stripMarkdownFence returns the original text unchanged when there is no fence', () => {
  assert.equal(stripMarkdownFence('{"subject":"Hi"}'), '{"subject":"Hi"}');
});

// ═══════════════ [4] explanatory prose before/after/both ═════════════════

test('[4] prose before the JSON object is ignored — only the object is extracted', () => {
  const text = 'Here is the draft:\n\n' + JSON.stringify(VALID_DRAFT);
  const result = extractDraftObject(text);
  assert.equal(result.subject, VALID_DRAFT.subject);
});

test('[5] prose after the JSON object is ignored — only the object is extracted', () => {
  const text = JSON.stringify(VALID_DRAFT) + '\n\nLet me know if you would like any adjustments.';
  const result = extractDraftObject(text);
  assert.equal(result.subject, VALID_DRAFT.subject);
});

test('[6] prose both before AND after the JSON object is ignored', () => {
  const text = 'Here is the draft you asked for:\n\n' + JSON.stringify(VALID_DRAFT) + '\n\nHope this helps!';
  const result = extractDraftObject(text);
  assert.deepEqual(Object.keys(result).sort(), Object.keys(VALID_DRAFT).sort());
});

// ═══════════════ [7] JSON spanning multiple text blocks ══════════════════

test('[7] a JSON object split across two text blocks is joined and parsed correctly', async () => {
  // Blocks are joined with '\n' (see fetchDraftFromProvider) — split at a
  // clean structural boundary (right after the comma separating two top-
  // level fields), never mid-string, since a real content-block boundary
  // is never literally mid-character either.
  const full = JSON.stringify(VALID_DRAFT);
  const splitAt = full.indexOf('","body"') + 2; // right after the comma
  const draft = await draftWith([textBlock(full.slice(0, splitAt)), textBlock(full.slice(splitAt))]);
  assert.equal(draft.subject, VALID_DRAFT.subject);
});

// ═══════════════ [8] non-text blocks interleaved are ignored ═════════════

test('[8] a non-text block (e.g. tool_use) interleaved before the real text block is never scanned for JSON', async () => {
  const blocks = [toolUseBlock(), textBlock(JSON.stringify(VALID_DRAFT))];
  const draft = await draftWith(blocks);
  assert.equal(draft.subject, VALID_DRAFT.subject);
});

test('a tool_use block with no "text" property never crashes block collection (no assumption every block has .text)', async () => {
  const draft = await draftWith([toolUseBlock(), textBlock(JSON.stringify(VALID_DRAFT)), toolUseBlock()]);
  assert.equal(draft.subject, VALID_DRAFT.subject);
});

// ═══════════════ [9] block 0 is never assumed complete ═══════════════════

test('[9] block 0 alone being incomplete JSON does not short-circuit extraction — the joined text (all blocks) is what is scanned', async () => {
  const full = JSON.stringify(VALID_DRAFT);
  // Block 0 is just the opening brace — unmistakably incomplete on its
  // own — split cleanly rather than mid-string.
  const draft = await draftWith([textBlock(full.slice(0, 1)), textBlock(full.slice(1))]);
  assert.equal(draft.subject, VALID_DRAFT.subject);
});

// ═══════════════ [10] escaped quotes and braces inside strings ═══════════

test('[10] escaped quotes inside a string value do not break balanced-brace scanning', () => {
  // Built as raw JSON text (not via JSON.stringify, which would double-
  // escape) so the span itself contains a literal \" escape sequence — the
  // exact thing an in-string-aware scanner must not treat as the string's
  // closing quote.
  const body = 'word '.repeat(100).trim();
  const rawJson = `{"subject":"Hi","body":"${body}","personalization_signal":"their \\"Türkiye Explorer\\" program","angle_reason":"x","fit_level":"","fit_reason":""}`;
  const result = extractDraftObject('intro text ' + rawJson + ' outro text');
  assert.equal(result.personalization_signal, 'their "Türkiye Explorer" program');
});

test('[11] literal brace characters inside a string value do not confuse the balanced scanner', () => {
  const draftWithBraces = { ...VALID_DRAFT, angle_reason: 'their itinerary notes {Istanbul, Cappadocia} fit well' };
  const result = extractDraftObject(JSON.stringify(draftWithBraces));
  assert.equal(result.angle_reason, 'their itinerary notes {Istanbul, Cappadocia} fit well');
});

test('[12] nested objects inside the draft (if ever present) do not break balanced-brace scanning', () => {
  const nested = 'prefix ' + JSON.stringify({ subject: 'Hi', body: 'word '.repeat(100).trim(), meta: { a: { b: 1 } } }) + ' suffix';
  const result = extractDraftObject(nested);
  assert.equal(result.subject, 'Hi');
  assert.deepEqual(result.meta, { a: { b: 1 } });
});

// ═══════════════ [13] whitespace handling ════════════════════════════════

test('[13] leading/trailing whitespace around the whole response does not prevent direct parsing', () => {
  const result = extractDraftObject('\n\n   ' + JSON.stringify(VALID_DRAFT) + '   \n');
  assert.equal(result.subject, VALID_DRAFT.subject);
});

// ═══════════════ [14] empty/whitespace-only subject or body rejected ═════

test('[14] an empty-string subject is rejected by enforceWritingStandard', () => {
  assert.throws(() => enforceWritingStandard({ ...VALID_DRAFT, subject: '' }), ProviderError);
});

test('[15] a whitespace-only subject is rejected (not just a literally empty string)', () => {
  assert.throws(() => enforceWritingStandard({ ...VALID_DRAFT, subject: '   \n\t  ' }), ProviderError);
});

test('[16] an empty-string body is rejected by enforceWritingStandard', () => {
  assert.throws(() => enforceWritingStandard({ ...VALID_DRAFT, body: '' }), ProviderError);
});

test('[17] a whitespace-only body is rejected (not just a literally empty string)', () => {
  assert.throws(() => enforceWritingStandard({ ...VALID_DRAFT, body: '   \n\t  ' }), ProviderError);
});

// ═══════════════ [18] malformed/wrong-shape JSON fails closed ════════════

test('[18] malformed JSON (trailing comma) fails closed with ProviderError', () => {
  assert.throws(() => extractDraftObject('{"subject": "Hi" ,}'), ProviderError);
});

test('[19] JSON truncated mid-object (no closing brace at all — the max_tokens truncation scenario) fails closed', () => {
  const truncated = '{"subject":"A quick note from DeseTour","body":"word word word word word word word';
  assert.throws(() => extractDraftObject(truncated), ProviderError);
});

test('[20] a bare JSON array (no object at all in the text) fails closed with ProviderError', () => {
  assert.throws(() => extractDraftObject('[1,2,3]'), ProviderError);
});

test('[21] a bare JSON null (no object at all in the text) fails closed with ProviderError', () => {
  assert.throws(() => extractDraftObject('null'), ProviderError);
});

test('[22] a plain unrelated JSON object (valid JSON, but not the draft schema) is extracted as JSON yet still rejected end to end by enforceWritingStandard', async () => {
  await assert.rejects(draftWith([textBlock('{"foo":"bar","baz":42}')]), ProviderError);
});

test('[23] a JSON object with keys but empty subject/body as actual values is rejected end to end', async () => {
  await assert.rejects(draftWith([textBlock(JSON.stringify({ subject: '', body: '' }))]), ProviderError);
});

test('[24] a completely empty JSON object {} is extracted as JSON yet still rejected end to end (missing subject/body)', async () => {
  await assert.rejects(draftWith([textBlock('{}')]), ProviderError);
});

test('an empty response.content array fails closed with ProviderError, never an empty-but-ok success', async () => {
  await assert.rejects(draftWith([]), ProviderError);
});

test('content with only non-text blocks (no text at all) fails closed the same way', async () => {
  await assert.rejects(draftWith([toolUseBlock(), toolUseBlock()]), ProviderError);
});

test('a missing response.content entirely (undefined) fails closed, never a crash', async () => {
  const fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({}) });
  await assert.rejects(
    draftOutreach({ agency: { name: 'Acme Travel' }, language: 'English' }, { apiKey: 'test-key', fetchImpl }),
    ProviderError
  );
});

// ═══════════════ [25] deterministic first-valid-object selection ═════════

test('[25] when multiple candidate braces exist, the first balanced span that actually has subject/body keys wins, deterministically', () => {
  const text = 'A note: {"unrelated":"thing"} then the real draft: ' + JSON.stringify(VALID_DRAFT);
  const result = extractDraftObject(text);
  assert.equal(result.subject, VALID_DRAFT.subject);
});

test('repeating the same extraction on the same input always returns the same result (no randomness/order-dependence)', () => {
  const text = '{"not":"it"} ' + JSON.stringify(VALID_DRAFT);
  const first = extractDraftObject(text);
  const second = extractDraftObject(text);
  assert.deepEqual(first, second);
});

// ═══════════════ findBalancedJsonSpan — direct proof ══════════════════════

test('findBalancedJsonSpan ignores braces inside quoted strings', () => {
  const text = '{"subject":"A note","body":"see {ref} in the itinerary"}';
  const span = findBalancedJsonSpan(text, '{', '}');
  assert.equal(span, text);
  assert.deepEqual(JSON.parse(span), { subject: 'A note', body: 'see {ref} in the itinerary' });
});

test('findBalancedJsonSpan returns null when braces never balance (truncated input)', () => {
  assert.equal(findBalancedJsonSpan('{"subject":"A note"', '{', '}'), null);
});

test('no eval/Function-based parsing was introduced — JSON.parse is the only parser used', () => {
  const SRC = fs.readFileSync(path.join(REPO_ROOT, 'api', '_agencies', 'outreachDraftProvider.js'), 'utf8');
  assert.doesNotMatch(SRC, /\beval\(/);
  assert.doesNotMatch(SRC, /new Function\(/);
});

test('extraction never uses the old naive greedy regex (text.match against /\\{[\\s\\S]*\\}/) as executable code — mentions in explanatory comments documenting its removal are expected and fine', () => {
  const SRC = fs.readFileSync(path.join(REPO_ROOT, 'api', '_agencies', 'outreachDraftProvider.js'), 'utf8');
  assert.doesNotMatch(SRC, /\.match\(\/\\\{\[\\s\\S\]\*\\\}\/\)/);
});

// ═══════════════ safe diagnostics on failure ══════════════════════════════

test('a parse failure logs ONLY safe structural diagnostics (block count/types, text lengths) — never the raw response text', async () => {
  const originalError = console.error;
  const logs = [];
  console.error = (...args) => { logs.push(args); };
  try {
    await assert.rejects(draftWith([textBlock('I could not produce a usable draft this time.')]), ProviderError);
  } finally {
    console.error = originalError;
  }
  const diagLog = logs.find(args => String(args[0]).includes('draft provider response could not be used'));
  assert.ok(diagLog, 'expected a diagnostic console.error call on failure');
  const payload = diagLog[1];
  assert.equal(typeof payload.blockCount, 'number');
  assert.ok(Array.isArray(payload.blockTypes));
  assert.ok(Array.isArray(payload.textBlockLengths));
  const serialized = JSON.stringify(payload);
  assert.doesNotMatch(serialized, /I could not produce a usable draft this time/, 'the raw response text itself must never be logged');
});

test('a validation failure (banned phrase) also logs safe diagnostics, not the full body', async () => {
  const bannedDraft = { ...VALID_DRAFT, body: 'We propose a Strategic Partnership between our two companies for the coming season together.' };
  const originalError = console.error;
  const logs = [];
  console.error = (...args) => { logs.push(args); };
  try {
    await assert.rejects(draftWith([textBlock(JSON.stringify(bannedDraft))]), ProviderError);
  } finally {
    console.error = originalError;
  }
  const diagLog = logs.find(args => String(args[0]).includes('draft provider response could not be used'));
  assert.ok(diagLog);
  const serialized = JSON.stringify(diagLog[1]);
  assert.doesNotMatch(serialized, /We propose a Strategic Partnership between our two companies/);
});

test('the diagnostic payload never includes an apiKey, Authorization header, or token field', async () => {
  const originalError = console.error;
  const logs = [];
  console.error = (...args) => { logs.push(args); };
  try {
    await assert.rejects(draftWith([textBlock('no json at all')]), ProviderError);
  } finally {
    console.error = originalError;
  }
  const diagLog = logs.find(args => String(args[0]).includes('draft provider response could not be used'));
  const serialized = JSON.stringify(diagLog[1]);
  assert.doesNotMatch(serialized, /apiKey|api_key|Authorization|Bearer|sk-ant/i);
});

// ═══════════════ safe Turkish UI error for a parser failure ══════════════

test('api/agency-draft-outreach.js returns the safe Turkish message for ProviderError, never the raw internal diagnostic text', () => {
  assert.match(AGENCY_DRAFT_API_SOURCE, /error: 'E posta taslağı işlenemedi\. Lütfen tekrar deneyin\.'/);
  const idx = AGENCY_DRAFT_API_SOURCE.indexOf("if (err instanceof outreachDraftProvider.ProviderError) {");
  assert.ok(idx !== -1);
  const block = AGENCY_DRAFT_API_SOURCE.slice(idx, idx + 900);
  assert.doesNotMatch(block, /error: err\.message/);
});

test('the banned raw diagnostic sentence from the production incident never reaches the browser-facing error field', () => {
  const idx = AGENCY_DRAFT_API_SOURCE.indexOf("if (err instanceof outreachDraftProvider.ProviderError) {");
  const block = AGENCY_DRAFT_API_SOURCE.slice(idx, idx + 900);
  const jsonCallIdx = block.indexOf('res.status(502).json(');
  assert.ok(jsonCallIdx !== -1);
  const jsonCallArg = block.slice(jsonCallIdx, block.indexOf(');', jsonCallIdx));
  assert.doesNotMatch(jsonCallArg, /did not contain a parseable draft object/);
});

// ═══════════════ endpoint-level contract preserved ════════════════════════

test('the endpoint never writes to any repository merely because a draft was parsed/validated successfully — persistence stays a separate frontend action', () => {
  assert.doesNotMatch(AGENCY_DRAFT_API_SOURCE, /\.from\(['"]agency_emails['"]\)\.(insert|update|upsert)/);
  assert.doesNotMatch(AGENCY_DRAFT_API_SOURCE, /AgencyEmailRepository/);
});

test('the endpoint still enforces requireAgencyRole and the 503/400/502/500 status conventions are unchanged', () => {
  assert.match(AGENCY_DRAFT_API_SOURCE, /requireAgencyRole\(req\)/);
  assert.match(AGENCY_DRAFT_API_SOURCE, /res\.status\(503\)/);
  assert.match(AGENCY_DRAFT_API_SOURCE, /res\.status\(400\)/);
  assert.match(AGENCY_DRAFT_API_SOURCE, /res\.status\(502\)/);
  assert.match(AGENCY_DRAFT_API_SOURCE, /res\.status\(500\)/);
});

test('max_tokens for the draft request was deliberately raised from 1024 — never left arbitrary/undocumented', () => {
  const SRC = fs.readFileSync(path.join(REPO_ROOT, 'api', '_agencies', 'outreachDraftProvider.js'), 'utf8');
  assert.match(SRC, /max_tokens:\s*2048/);
  assert.doesNotMatch(SRC, /max_tokens:\s*1024/);
});
