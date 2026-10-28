'use strict';
/**
 * tests/dashboard/agencyResearchParserRobustness.test.js
 * ─────────────────────────────────────────────────────────────────────────
 * Agency Market Research — provider response parsing reliability.
 *
 * Production symptom this follows up on: "Research provider response did
 * not contain a parseable candidate list." — i.e. the Anthropic request
 * COMPLETED (no 504, no HTTP error), but researchProvider.js could not
 * extract the candidate JSON from the real response text.
 *
 * Root cause, proven from the code (not guessed):
 *   - extractCandidateArray used ONE greedy regex (/\[[\s\S]*\]/) across
 *     the whole joined text. Greedy means "from the FIRST '[' anywhere to
 *     the LAST ']' anywhere" — fragile the moment any stray bracket
 *     appears elsewhere, and silently returns nothing useful (or throws)
 *     if the array itself was cut off mid-stream with no closing ']' at
 *     all.
 *   - max_tokens was 4096 for a request whose single turn has to cover
 *     BOTH the model's own web_search tool-use reasoning AND a JSON array
 *     of up to 20 candidates, each now carrying five Turkish analytical
 *     sentences (travel_focus, turkiye_signal, fit_reason,
 *     evidence_summary, cooperation_angle) plus every factual field. For
 *     a large result set this plausibly exceeds 4096 tokens before the
 *     array's closing ']' is ever written — an unclosed '[' with nothing
 *     else bracket-shaped in the text produces EXACTLY the reported
 *     error, because there is nothing for the old regex (or any correct
 *     parser) to match.
 *
 * Fix: a three-strategy, string-scanning (never eval, never a hand-rolled
 * JSON grammar) extractCandidateArray — direct JSON.parse, markdown-fence-
 * stripped JSON.parse, then a balanced-bracket scan that stops at the
 * first depth-zero close and skips the contents of quoted strings — plus
 * max_tokens raised to 8192. Every assertion here is a pure-function test
 * (no live Anthropic/Supabase call) or a static source assertion, like
 * every other test file in this project.
 * ─────────────────────────────────────────────────────────────────────────
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.join(__dirname, '..', '..');
const researchProvider = require(path.join(REPO_ROOT, 'api', '_agencies', 'researchProvider'));
const AGENCY_RESEARCH_SRC = fs.readFileSync(path.join(REPO_ROOT, 'api', 'agency-research.js'), 'utf8');

const { extractCandidateArray, stripMarkdownFence, parseCandidateJson, findBalancedJsonSpan, researchAgencies, sanitizeCandidate, ProviderError } = researchProvider;

function textBlock(text) { return { type: 'text', text }; }
function serverToolUseBlock() { return { type: 'server_tool_use', id: 'srvtool_1', name: 'web_search', input: { query: 'tour operators Brazil' } }; }
function webSearchResultBlock() { return { type: 'web_search_tool_result', tool_use_id: 'srvtool_1', content: [{ type: 'web_search_result', url: 'https://example.com', title: 'Example' }] }; }

function fakeResponse(contentBlocks) {
  return { ok: true, status: 200, json: async () => ({ content: contentBlocks }) };
}

const VALID_CANDIDATE = {
  name: 'Turismo São Paulo Ltda', website: 'www.turismosp.com.br', country: 'Brazil', city: 'São Paulo',
  // Agency CRM research workflow follow-up: a usable email is now
  // required for a candidate to survive researchAgencies' own
  // filterUsableCandidates — '' here (as it legitimately can be, per the
  // provider's own "never guess an email" rule) would make every
  // end-to-end test in this file fail for a reason that has nothing to do
  // with what they actually test (JSON-parsing robustness), so this fixed
  // fixture carries a real one.
  contact_person: '', email: 'contato@turismosp.com.br', phone: '', language: 'Portuguese',
  travel_focus: 'İstanbul ve Kapadokya turları düzenliyor.', turkiye_signal: 'Var',
  fit_level: 'Yüksek Uyum', fit_reason: 'Türkiye paketleri mevcut.',
  evidence_summary: 'Resmi web sitesinde İstanbul turları listeleniyor.',
  cooperation_angle: 'Yerel ground handling sağlanabilir.',
  source_url: 'https://turismosp.com.br/tours',
};

async function researchWith(contentBlocks) {
  const fetchImpl = async () => fakeResponse(contentBlocks);
  return researchAgencies({ country: 'Brazil', language: 'Portuguese', limit: 5, minimumFit: 'Orta Uyum ve Üzeri' }, { apiKey: 'test-key', fetchImpl });
}

// ═══════════════ [1] direct JSON array in a single text block ═══════════

test('[1] a direct JSON array in a single text block parses successfully end to end', async () => {
  const { candidates } = await researchWith([textBlock(JSON.stringify([VALID_CANDIDATE]))]);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].name, 'Turismo São Paulo Ltda');
});

// ═══════════════ [2] object with a candidates array ══════════════════════

test('[2] an object wrapping the array as {"candidates": [...]} is accepted, not just a bare array', async () => {
  const { candidates } = await researchWith([textBlock(JSON.stringify({ candidates: [VALID_CANDIDATE] }))]);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].source_url, 'https://turismosp.com.br/tours');
});

test('extractCandidateArray directly: bare array vs. {candidates:[...]} both return the same array', () => {
  assert.deepEqual(extractCandidateArray('[{"name":"A"}]'), [{ name: 'A' }]);
  assert.deepEqual(extractCandidateArray('{"candidates":[{"name":"A"}]}'), [{ name: 'A' }]);
});

test('an object with no candidates array still fails closed, exactly as before this phase', () => {
  assert.throws(() => extractCandidateArray('{"not":"an array"}'), ProviderError);
});

// ═══════════════ [3] JSON inside a ```json markdown fence ═══════════════

test('[3] JSON wrapped in a ```json ... ``` markdown fence is extracted and parsed', async () => {
  const fenced = '```json\n' + JSON.stringify([VALID_CANDIDATE]) + '\n```';
  const { candidates } = await researchWith([textBlock(fenced)]);
  assert.equal(candidates.length, 1);
});

test('a plain ``` ... ``` fence with no "json" language tag also works', () => {
  const fenced = '```\n[{"name":"A"}]\n```';
  assert.deepEqual(extractCandidateArray(fenced), [{ name: 'A' }]);
});

test('stripMarkdownFence returns the original text unchanged when there is no fence', () => {
  assert.equal(stripMarkdownFence('[{"name":"A"}]'), '[{"name":"A"}]');
});

// ═══════════════ [4] explanatory prose before/after the JSON ════════════

test('[4] explanatory prose before AND after the JSON array is ignored — only the array is extracted', async () => {
  const prose = 'Based on my research, here are the candidates:\n\n' + JSON.stringify([VALID_CANDIDATE]) + '\n\nLet me know if you need more detail.';
  const { candidates } = await researchWith([textBlock(prose)]);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].name, 'Turismo São Paulo Ltda');
});

test('a stray bracket-like citation marker in prose before the JSON does not corrupt extraction', () => {
  const text = 'Several sources [1] confirm this. ' + JSON.stringify([{ name: 'A' }]);
  assert.deepEqual(extractCandidateArray(text), [{ name: 'A' }]);
});

// ═══════════════ [5] multiple text blocks around web-search tool blocks ═

test('[5] multiple text blocks, with tool-use/search-result blocks interleaved, are joined and parsed correctly', async () => {
  const blocks = [
    textBlock("I'll search for Brazilian tour operators with Türkiye interest."),
    serverToolUseBlock(),
    webSearchResultBlock(),
    textBlock('Based on my research, here are the candidates:\n' + JSON.stringify([VALID_CANDIDATE])),
  ];
  const { candidates } = await researchWith(blocks);
  assert.equal(candidates.length, 1);
});

// ═══════════════ [6] tool result blocks before the final text response ═

test('[6] tool_use/web_search_tool_result blocks are never scanned for JSON — only type==="text" blocks are', async () => {
  // A web_search_tool_result's own `content` can itself contain bracket-
  // shaped text (search snippets, titles) — if that were ever scanned for
  // JSON it could produce a WRONG candidate list. Prove it is ignored by
  // giving it content a naive scanner could misparse, and confirming the
  // real (and only) answer comes from the actual text block.
  const trickyResult = {
    type: 'web_search_tool_result',
    tool_use_id: 'srvtool_1',
    content: [{ type: 'web_search_result', url: 'https://example.com', title: '[{"name":"FAKE-FROM-SEARCH-RESULT"}]' }],
  };
  const blocks = [serverToolUseBlock(), trickyResult, textBlock(JSON.stringify([VALID_CANDIDATE]))];
  const { candidates } = await researchWith(blocks);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].name, 'Turismo São Paulo Ltda');
  assert.ok(!candidates.some(c => c.name === 'FAKE-FROM-SEARCH-RESULT'));
});

// ═══════════════ [7] malformed JSON fails closed ═════════════════════════

test('[7] malformed JSON (trailing comma) fails closed with ProviderError', async () => {
  await assert.rejects(researchWith([textBlock('[{"name": "Acme" ,]')]), ProviderError);
});

test('[7] JSON truncated mid-array (no closing bracket at all — the max_tokens truncation scenario) fails closed', async () => {
  const truncated = '[{"name":"Acme Turismo","fit_level":"Orta Uyum","website":"acme.com.br"'; // cut off, no closing ] or }
  await assert.rejects(researchWith([textBlock(truncated)]), ProviderError);
});

// ═══════════════ [8] empty content fails closed ═════════════════════════

test('[8] an empty content array fails closed with ProviderError, never an empty-but-ok success', async () => {
  await assert.rejects(researchWith([]), ProviderError);
});

test('[8] content with only non-text blocks (no text at all) fails closed the same way', async () => {
  await assert.rejects(researchWith([serverToolUseBlock(), webSearchResultBlock()]), ProviderError);
});

// ═══════════════ [9] valid candidates still pass sanitizeCandidate ══════

test('[9] a successfully parsed candidate still goes through the real, unmodified sanitizeCandidate', async () => {
  const { candidates } = await researchWith([textBlock(JSON.stringify([VALID_CANDIDATE]))]);
  const direct = sanitizeCandidate(VALID_CANDIDATE);
  assert.deepEqual(candidates[0], direct);
});

// ═══════════════ [10] Yüksek Uyum evidence gate unchanged ═══════════════

test('[10] a parsed Yüksek Uyum candidate missing evidence_summary/source_url is still downgraded to Orta Uyum', async () => {
  const noEvidence = { ...VALID_CANDIDATE, evidence_summary: '', source_url: '' };
  const { candidates } = await researchWith([textBlock(JSON.stringify([noEvidence]))]);
  // minimumFit here is 'Orta Uyum ve Üzeri', which allows Orta Uyum — so the
  // downgraded candidate is still included, just never AS Yüksek Uyum.
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].fit_level, 'Orta Uyum');
});

// ═══════════════ [11] Turkish analysis fields unchanged ═════════════════

test('[11] Turkish analytical field values pass through unchanged — no re-translation, no mangling by the new parser', async () => {
  const { candidates } = await researchWith([textBlock(JSON.stringify([VALID_CANDIDATE]))]);
  assert.equal(candidates[0].fit_reason, 'Türkiye paketleri mevcut.');
  assert.equal(candidates[0].evidence_summary, 'Resmi web sitesinde İstanbul turları listeleniyor.');
  assert.equal(candidates[0].cooperation_angle, 'Yerel ground handling sağlanabilir.');
});

// ═══════════════ [12] no fallback candidate is ever fabricated ══════════

test('[12] a parse failure never produces a fabricated candidate — researchAgencies rejects, it never resolves with a fake result', async () => {
  await assert.rejects(researchWith([textBlock('I could not find any suitable matches.')]), ProviderError);
});

test('extractCandidateArray never returns a non-array on failure — it always throws, never [] or undefined', () => {
  assert.throws(() => extractCandidateArray('nothing here'), ProviderError);
  assert.throws(() => extractCandidateArray(''), ProviderError);
});

// ═══════════════ [13] safe Turkish UI error for a parser failure ════════

test('[13] api/agency-research.js returns the safe Turkish message for ProviderError, never the raw internal diagnostic text', () => {
  assert.match(AGENCY_RESEARCH_SRC, /error: 'Araştırma sonucu işlenemedi\. Lütfen tekrar deneyin\.'/);
  const idx = AGENCY_RESEARCH_SRC.indexOf('if (err instanceof researchProvider.ProviderError) {');
  const block = AGENCY_RESEARCH_SRC.slice(idx, idx + 900);
  assert.doesNotMatch(block, /error: err\.message/);
});

test('the banned raw diagnostic sentence from the production incident never reaches the browser-facing error field', () => {
  const idx = AGENCY_RESEARCH_SRC.indexOf('if (err instanceof researchProvider.ProviderError) {');
  const block = AGENCY_RESEARCH_SRC.slice(idx, idx + 900);
  // The sentence may appear in a comment EXPLAINING why it's hidden — that's
  // documentation, not something sent to the browser. Only the actual
  // `res.status(502).json({ error: ... })` call's own argument matters.
  const jsonCallIdx = block.indexOf('res.status(502).json(');
  assert.ok(jsonCallIdx !== -1);
  const jsonCallArg = block.slice(jsonCallIdx, block.indexOf(');', jsonCallIdx));
  assert.doesNotMatch(jsonCallArg, /did not contain a parseable candidate list/);
});

// ═══════════════ Safe diagnostics — structural only, never raw content ═══

test('a parse failure logs ONLY safe structural diagnostics (block count/types, text lengths) — never the raw response text', async () => {
  const originalError = console.error;
  const logs = [];
  console.error = (...args) => { logs.push(args); };
  try {
    await assert.rejects(researchWith([textBlock('I could not find any suitable matches.')]), ProviderError);
  } finally {
    console.error = originalError;
  }
  const diagLog = logs.find(args => String(args[0]).includes('candidate extraction failed'));
  assert.ok(diagLog, 'expected a diagnostic console.error call on parse failure');
  const payload = diagLog[1];
  assert.equal(typeof payload.blockCount, 'number');
  assert.ok(Array.isArray(payload.blockTypes));
  assert.ok(Array.isArray(payload.textBlockLengths));
  const serialized = JSON.stringify(payload);
  assert.doesNotMatch(serialized, /I could not find any suitable matches/, 'the raw response text itself must never be logged');
});

test('the diagnostic payload never includes an apiKey, Authorization header, or token field', async () => {
  const originalError = console.error;
  const logs = [];
  console.error = (...args) => { logs.push(args); };
  try {
    await assert.rejects(researchWith([textBlock('no json at all')]), ProviderError);
  } finally {
    console.error = originalError;
  }
  const diagLog = logs.find(args => String(args[0]).includes('candidate extraction failed'));
  const serialized = JSON.stringify(diagLog[1]);
  assert.doesNotMatch(serialized, /apiKey|api_key|Authorization|Bearer|sk-ant/i);
});

// ═══════════════ findBalancedJsonSpan / parseCandidateJson — direct proof ═

test('findBalancedJsonSpan ignores brackets inside quoted strings (a URL or sentence containing "[" or "]" cannot confuse it)', () => {
  const text = '[{"name":"A","note":"see [ref] at url.com/[x]"}]';
  const span = findBalancedJsonSpan(text, '[', ']');
  assert.equal(span, text);
  assert.deepEqual(JSON.parse(span), [{ name: 'A', note: 'see [ref] at url.com/[x]' }]);
});

test('findBalancedJsonSpan returns null when brackets never balance (truncated input)', () => {
  assert.equal(findBalancedJsonSpan('[{"name":"A"', '[', ']'), null);
});

test('parseCandidateJson distinguishes "not JSON at all" (undefined) from "valid JSON, wrong shape" (null)', () => {
  assert.equal(parseCandidateJson('not json'), undefined);
  assert.equal(parseCandidateJson('{"foo":"bar"}'), null);
  assert.deepEqual(parseCandidateJson('[1,2,3]'), [1, 2, 3]);
  assert.deepEqual(parseCandidateJson('{"candidates":[1]}'), [1]);
});

test('no eval/Function-based parsing was introduced — JSON.parse is the only parser used', () => {
  const RESEARCH_PROVIDER_SRC = fs.readFileSync(path.join(REPO_ROOT, 'api', '_agencies', 'researchProvider.js'), 'utf8');
  assert.doesNotMatch(RESEARCH_PROVIDER_SRC, /\beval\(/);
  assert.doesNotMatch(RESEARCH_PROVIDER_SRC, /new Function\(/);
});
