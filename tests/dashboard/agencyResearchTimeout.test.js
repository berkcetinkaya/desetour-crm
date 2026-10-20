'use strict';
/**
 * tests/dashboard/agencyResearchTimeout.test.js
 * ─────────────────────────────────────────────────────────────────────────
 * Agencies Market Research — production 504 fix.
 *
 * Root cause (confirmed by reading the code, not guessed): api/agency-
 * research.js never constructs or returns an HTTP 504 itself — its only
 * status codes are 405/503/400/502/500/200 (see the handler below). The
 * research call to Anthropic (Opus + native web_search) has no
 * AbortController, Promise.race, or any other client-side timeout — the
 * only ceiling on how long it can run was Vercel's own platform-level
 * maxDuration (60s), which this phase raises to 300s for this one
 * function. The "(504)" the user actually saw came from the frontend's
 * generic status-code fallback, reached because Vercel's gateway-timeout
 * response body isn't valid JSON (resp.json() throws, caught into {}).
 *
 * This file proves: (a) the duration fix landed exactly where it should
 * and nowhere else, (b) nothing about research quality, evidence
 * discipline, Turkish output, or duplicate detection changed, and (c) the
 * fail-closed contract (no fabricated candidates, ever) still holds.
 * ─────────────────────────────────────────────────────────────────────────
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.join(__dirname, '..', '..');
const VERCEL_JSON = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'vercel.json'), 'utf8'));
const AGENCY_RESEARCH_SRC = fs.readFileSync(path.join(REPO_ROOT, 'api', 'agency-research.js'), 'utf8');
const RESEARCH_PROVIDER_SRC = fs.readFileSync(path.join(REPO_ROOT, 'api', '_agencies', 'researchProvider.js'), 'utf8');
const DASHBOARD_SRC = fs.readFileSync(path.join(REPO_ROOT, 'DeseTourDashboard.jsx'), 'utf8');

const researchProvider = require(path.join(REPO_ROOT, 'api', '_agencies', 'researchProvider'));

function handleResearchBody() {
  const idx = DASHBOARD_SRC.indexOf('async function handleResearch()');
  assert.ok(idx !== -1, 'handleResearch not found');
  return DASHBOARD_SRC.slice(idx, DASHBOARD_SRC.indexOf('\n  async function handleImport', idx));
}

// ═══════════════ [1] agency-research duration > old 60s limit ═══════════

test('[1] api/agency-research.js maxDuration is raised above the old 60s limit, to the 300s target', () => {
  const fn = VERCEL_JSON.functions['api/agency-research.js'];
  assert.ok(fn, 'api/agency-research.js must still have a functions entry');
  assert.ok(fn.maxDuration > 60, `maxDuration (${fn.maxDuration}) must be greater than the old 60s limit`);
  assert.equal(fn.maxDuration, 300);
});

test('memory for api/agency-research.js is unchanged — only the duration was touched', () => {
  assert.equal(VERCEL_JSON.functions['api/agency-research.js'].memory, 512);
});

test('api/agency-draft-outreach.js duration is untouched by this phase — no evidence it needs it (no web_search tool, plain text generation)', () => {
  const fn = VERCEL_JSON.functions['api/agency-draft-outreach.js'];
  assert.equal(fn.maxDuration, 30);
  assert.equal(fn.memory, 512);
});

test('no unrelated function duration was changed (ingest-civitatis, cron, send-email all unchanged)', () => {
  assert.equal(VERCEL_JSON.functions['api/send-email.js'].maxDuration, 30);
  assert.equal(VERCEL_JSON.functions['api/ingest-civitatis.js'].maxDuration, 60);
  assert.equal(VERCEL_JSON.functions['api/ingest-civitatis-write.js'].maxDuration, 60);
  assert.equal(VERCEL_JSON.functions['api/cron-ingest-civitatis-write.js'].maxDuration, 60);
});

// ═══════════════ app never emits 504 itself (confirms diagnosis) ════════

test('api/agency-research.js never constructs a 504 response — every res.status(...) call is one of 405/503/400/502/500/200', () => {
  const statusCodes = [...AGENCY_RESEARCH_SRC.matchAll(/res\.status\((\d+)\)/g)].map(m => Number(m[1]));
  assert.ok(statusCodes.length > 0, 'expected at least one res.status(...) call');
  for (const code of statusCodes) {
    assert.ok([405, 503, 400, 502, 500, 200].includes(code), `unexpected status code ${code} — a 504 (or anything else) here would mean the app itself, not the platform, is the source`);
  }
  assert.doesNotMatch(AGENCY_RESEARCH_SRC, /res\.status\(504\)/);
});

test('no client-side timeout (AbortController/Promise.race/setTimeout/signal) cuts the research request off before Vercel\'s own maxDuration would', () => {
  assert.doesNotMatch(RESEARCH_PROVIDER_SRC, /AbortController/);
  assert.doesNotMatch(RESEARCH_PROVIDER_SRC, /Promise\.race/);
  assert.doesNotMatch(RESEARCH_PROVIDER_SRC, /\bsignal\s*:/);
  assert.doesNotMatch(AGENCY_RESEARCH_SRC, /AbortController/);
});

// ═══════════════ [2] Research provider behavior unchanged ═══════════════

test('[2] the model and web_search tool are byte-for-byte unchanged; max_tokens was deliberately raised (8192) in the parser-reliability follow-up to remove a proven truncation risk, not lowered or left at the value that risk was found at', () => {
  assert.match(RESEARCH_PROVIDER_SRC, /const ANTHROPIC_MODEL = 'claude-opus-5-5';/);
  assert.match(RESEARCH_PROVIDER_SRC, /max_tokens: 8192,/);
  assert.doesNotMatch(RESEARCH_PROVIDER_SRC, /max_tokens: 4096,/);
  assert.match(RESEARCH_PROVIDER_SRC, /tools: \[\{ type: 'web_search_20250305', name: 'web_search' \}\],/);
});

test('fetchCandidatesFromProvider still takes an injectable fetchImpl — no hardcoded global fetch, still directly testable', () => {
  assert.match(RESEARCH_PROVIDER_SRC, /async function fetchCandidatesFromProvider\(\{ country, language, limit, minimumFit \}, \{ apiKey, fetchImpl \}\)/);
});

// ═══════════════ [3] Yüksek Uyum evidence gating unchanged ══════════════

test('[3] Yüksek Uyum without evidence_summary or source_url is still downgraded — the evidence gate was not touched', () => {
  const noEvidence = researchProvider.sanitizeCandidate({ name: 'A', fit_level: 'Yüksek Uyum', source_url: 'https://a.com' });
  assert.notEqual(noEvidence.fit_level, 'Yüksek Uyum');
  const noSourceUrl = researchProvider.sanitizeCandidate({ name: 'B', fit_level: 'Yüksek Uyum', evidence_summary: 'Kanıt var.' });
  assert.notEqual(noSourceUrl.fit_level, 'Yüksek Uyum');
  const bothPresent = researchProvider.sanitizeCandidate({ name: 'C', fit_level: 'Yüksek Uyum', evidence_summary: 'Kanıt var.', source_url: 'https://c.com' });
  assert.equal(bothPresent.fit_level, 'Yüksek Uyum');
});

// ═══════════════ [4] Turkish internal analysis unchanged ════════════════

test('[4] the OUTPUT LANGUAGE RULE (Turkish analytical fields) is still present, unmodified', () => {
  assert.match(RESEARCH_PROVIDER_SRC, /OUTPUT LANGUAGE RULE/);
  assert.match(RESEARCH_PROVIDER_SRC, /travel_focus, turkiye_signal, fit_reason, evidence_summary, cooperation_angle/);
  assert.match(RESEARCH_PROVIDER_SRC, /natural, fluent TURKISH/);
});

// ═══════════════ [5] Duplicate detection unchanged ═══════════════════════

test('[5] agency-research.js still annotates duplicates via the real, unmodified findLikelyDuplicate', () => {
  assert.match(AGENCY_RESEARCH_SRC, /const \{ findLikelyDuplicate \} = require\('\.\/_agencies\/duplicateMatching'\);/);
  assert.match(AGENCY_RESEARCH_SRC, /const dup = findLikelyDuplicate\(candidate, existingAgencies\);/);
  assert.match(AGENCY_RESEARCH_SRC, /existingAgencyId: dup \? dup\.id : null,/);
});

// ═══════════════ [6][7] Provider failures fail closed, never fabricated ═

test('[6][7] a provider/network failure during research propagates as a real error — never a fabricated candidate list', async () => {
  const fetchImpl = async () => { throw new Error('network down'); };
  await assert.rejects(
    researchProvider.researchAgencies({ country: 'Brazil', language: 'Portuguese', limit: 5, minimumFit: 'Orta Uyum ve Üzeri' }, { apiKey: 'test-key', fetchImpl }),
    /network down/
  );
});

test('[6][7] an HTTP error from the provider raises ProviderError, not a silent empty/fake success', async () => {
  const fetchImpl = async () => ({ ok: false, status: 500, text: async () => 'upstream error body' });
  await assert.rejects(
    researchProvider.researchAgencies({ country: 'Brazil', language: 'Portuguese', limit: 5, minimumFit: 'Orta Uyum ve Üzeri' }, { apiKey: 'test-key', fetchImpl }),
    (err) => err instanceof researchProvider.ProviderError
  );
});

test('the handler maps ProviderError to 502 and ConfigurationError to 503 — never swallowed into a fabricated 200 with candidates', () => {
  assert.match(AGENCY_RESEARCH_SRC, /if \(err instanceof researchProvider\.ConfigurationError\) \{\s*\n\s*return res\.status\(503\)/);
  // ProviderError's branch now logs server-side (see the parser-reliability
  // follow-up: the browser must never see the raw internal parser message)
  // before returning, so the `{` and `return res.status(502)` are no longer
  // on adjacent lines — matched anywhere within the if-block instead of
  // requiring immediate adjacency.
  const idx = AGENCY_RESEARCH_SRC.indexOf('if (err instanceof researchProvider.ProviderError) {');
  assert.ok(idx !== -1);
  assert.match(AGENCY_RESEARCH_SRC.slice(idx, idx + 900), /return res\.status\(502\)/);
});

test('the ProviderError branch returns a clean Turkish message, never the raw internal parser/provider diagnostic', () => {
  const idx = AGENCY_RESEARCH_SRC.indexOf('if (err instanceof researchProvider.ProviderError) {');
  const block = AGENCY_RESEARCH_SRC.slice(idx, idx + 900);
  assert.match(block, /error: 'Araştırma sonucu işlenemedi\. Lütfen tekrar deneyin\.'/);
  assert.doesNotMatch(block, /error: err\.message/);
});

// ═══════════════ [8] Timeout UX exposes nothing internal ════════════════

test('[8] the new 504 branch shows a plain Turkish timeout message, never the raw response payload/status internals', () => {
  const HANDLE_RESEARCH_BODY = handleResearchBody();
  assert.match(HANDLE_RESEARCH_BODY, /if \(resp\.status === 504\) \{ setError\("Araştırma beklenenden uzun sürdü\. Lütfen tekrar deneyin\."\); return; \}/);
});

test('the 504 branch never echoes payload.error or any provider/body text — only the fixed Turkish sentence', () => {
  const HANDLE_RESEARCH_BODY = handleResearchBody();
  const idx = HANDLE_RESEARCH_BODY.indexOf('resp.status === 504');
  assert.ok(idx !== -1);
  const line = HANDLE_RESEARCH_BODY.slice(idx, HANDLE_RESEARCH_BODY.indexOf('\n', idx));
  assert.doesNotMatch(line, /payload\.error/);
});

test('no secret-like value (API key, bearer token literal, stack trace marker) appears in the new timeout copy', () => {
  assert.doesNotMatch(DASHBOARD_SRC, /Araştırma beklenenden uzun sürdü\. Lütfen tekrar deneyin\.[^"]*(sk-|api[_-]?key|Bearer )/i);
});
