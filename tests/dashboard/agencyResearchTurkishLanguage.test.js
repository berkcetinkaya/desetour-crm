'use strict';
/**
 * tests/dashboard/agencyResearchTurkishLanguage.test.js
 * ─────────────────────────────────────────────────────────────────────────
 * Agencies Market Research — language-separation UX follow-up.
 *
 * Research still happens in the requested market's own language/sources
 * (unchanged). The five analytical fields a DeseTour CRM user actually
 * reads — travel_focus, turkiye_signal, fit_reason, evidence_summary,
 * cooperation_angle — must now be written in Turkish by the prompt,
 * regardless of the research language. Factual fields (name, website,
 * city, contact_person, email, phone, source_url) are never translated.
 * Outreach drafting's OWN output language (the selected market language)
 * is explicitly unchanged — only its grounding context changed language.
 *
 * Every assertion here is either a pure-function test (sanitizeCandidate,
 * no network) or a static source/prompt-text assertion — no live provider
 * call, matching every other test file in this project.
 * ─────────────────────────────────────────────────────────────────────────
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const researchProvider = require('../../api/_agencies/researchProvider');
const outreachDraftProvider = require('../../api/_agencies/outreachDraftProvider');
const duplicateMatching = require('../../api/_agencies/duplicateMatching');

const REPO_ROOT = path.join(__dirname, '..', '..');
const SOURCE = fs.readFileSync(path.join(REPO_ROOT, 'DeseTourDashboard.jsx'), 'utf8');
const RESEARCH_PROVIDER_SRC = fs.readFileSync(path.join(REPO_ROOT, 'api', '_agencies', 'researchProvider.js'), 'utf8');
const OUTREACH_PROVIDER_SRC = fs.readFileSync(path.join(REPO_ROOT, 'api', '_agencies', 'outreachDraftProvider.js'), 'utf8');

function body(name, nextMarker) {
  const idx = SOURCE.indexOf(`function ${name}(`);
  assert.ok(idx !== -1, `could not find function ${name}`);
  return SOURCE.slice(idx, SOURCE.indexOf(nextMarker, idx));
}
const AGENCY_RESEARCH_MODAL_BODY = body('AgencyResearchModal', '\nfunction AcenteDetailPage');

// ═══════════════ [1] Research output internal analysis is Turkish ═══════

test('[1] the research system prompt instructs Turkish output for exactly the five analytical fields', () => {
  assert.match(RESEARCH_PROVIDER_SRC, /OUTPUT LANGUAGE RULE/);
  assert.match(RESEARCH_PROVIDER_SRC, /travel_focus, turkiye_signal, fit_reason, evidence_summary, cooperation_angle/);
  assert.match(RESEARCH_PROVIDER_SRC, /natural, fluent TURKISH/);
});

test('the prompt anchors Turkish output with a concrete good/bad example, matching the quality rules (no generic machine-translation tone)', () => {
  assert.match(RESEARCH_PROVIDER_SRC, /Bu şirket yüksek uyumludur çünkü Türkiye turları sunmaktadır/);
  assert.match(RESEARCH_PROVIDER_SRC, /İstanbul konaklaması, rehberlik ve transfer hizmetleri/);
});

test('cooperation_angle is a new field in both the prompt contract and sanitizeCandidate\'s output shape', () => {
  assert.match(RESEARCH_PROVIDER_SRC, /cooperation_angle/);
  const c = researchProvider.sanitizeCandidate({ name: 'Acme Travel', fit_level: 'Orta Uyum', cooperation_angle: 'İstanbul operasyonları için yerel destek sağlanabilir.' });
  assert.equal(c.cooperation_angle, 'İstanbul operasyonları için yerel destek sağlanabilir.');
});

test('cooperation_angle defaults to "" (never invented) when the provider omits it', () => {
  const c = researchProvider.sanitizeCandidate({ name: 'Acme Travel', fit_level: 'Orta Uyum' });
  assert.equal(c.cooperation_angle, '');
});

test('the JSON response contract explicitly lists cooperation_angle alongside every other key', () => {
  const idx = RESEARCH_PROVIDER_SRC.indexOf('Respond with ONLY a JSON array');
  const stmt = RESEARCH_PROVIDER_SRC.slice(idx, idx + 400);
  assert.match(stmt, /fit_reason, evidence_summary, cooperation_angle, source_url/);
});

// ═══════════════ [2] Company names / URLs are not translated ════════════

test('[2] the prompt explicitly lists name/website/city/contact_person/email/phone/source_url as never-translate fields', () => {
  assert.match(RESEARCH_PROVIDER_SRC, /Do NOT translate or alter these fields/);
  assert.match(RESEARCH_PROVIDER_SRC, /name, website, city, contact_person, email, phone,[^a-zA-Z]*source_url/);
});

test('sanitizeCandidate passes factual fields through byte-for-byte (trimmed only), never rewriting them', () => {
  const c = researchProvider.sanitizeCandidate({
    name: '  Turismo São Paulo Ltda  ', website: 'www.turismosp.com.br', city: 'São Paulo',
    contact_person: 'João Silva', email: 'contato@turismosp.com.br', phone: '+55 11 1234 5678',
    fit_level: 'Orta Uyum',
  });
  assert.equal(c.name, 'Turismo São Paulo Ltda');
  assert.equal(c.website, 'www.turismosp.com.br');
  assert.equal(c.city, 'São Paulo');
  assert.equal(c.contact_person, 'João Silva');
  assert.equal(c.email, 'contato@turismosp.com.br');
  assert.equal(c.phone, '+55 11 1234 5678');
});

test('the research-language rule (search in the market language/sources) is still present and distinct from the output-language rule', () => {
  assert.match(RESEARCH_PROVIDER_SRC, /Research using the requested country's own local sources and the requested market language/);
  assert.match(RESEARCH_PROVIDER_SRC, /separate from the OUTPUT LANGUAGE RULE/);
});

// ═══════════════ [3] Contact data is not invented ════════════════════════

test('[3] sanitizeCandidate never invents email/contact_person/phone — empty stays empty', () => {
  const c = researchProvider.sanitizeCandidate({ name: 'Acme Travel', fit_level: 'Orta Uyum', website: 'acme.com' });
  assert.equal(c.email, '');
  assert.equal(c.contact_person, '');
  assert.equal(c.phone, '');
});

test('the prompt still explicitly forbids guessing an email address pattern', () => {
  // Strengthened (Agency CRM research workflow follow-up, PART 1): now
  // also tells the model a usable email is mandatory for a candidate to
  // be worth including at all, not just "never guess one".
  assert.match(RESEARCH_PROVIDER_SRC, /Never guess, infer, or fabricate an email address pattern/);
  assert.match(RESEARCH_PROVIDER_SRC, /MANDATORY for a company to be worth including/);
});

// ═══════════════ [4] Yüksek Uyum still requires evidence + source URL ════

test('[4] Yüksek Uyum without evidence_summary is downgraded, unaffected by the cooperation_angle addition', () => {
  const c = researchProvider.sanitizeCandidate({
    name: 'Acme Travel', fit_level: 'Yüksek Uyum', evidence_summary: '', source_url: 'https://acme.com',
    cooperation_angle: 'Bir şey söylenebilir.',
  });
  assert.equal(c.fit_level, 'Orta Uyum');
});

test('Yüksek Uyum without source_url is downgraded, unaffected by the cooperation_angle addition', () => {
  const c = researchProvider.sanitizeCandidate({
    name: 'Acme Travel', fit_level: 'Yüksek Uyum', evidence_summary: 'Kanıt bulundu.', source_url: '',
    cooperation_angle: 'Bir şey söylenebilir.',
  });
  assert.equal(c.fit_level, 'Orta Uyum');
});

test('Yüksek Uyum WITH both evidence_summary and source_url survives, cooperation_angle never gates it', () => {
  const c = researchProvider.sanitizeCandidate({
    name: 'Acme Travel', fit_level: 'Yüksek Uyum', evidence_summary: 'Kanıt bulundu.', source_url: 'https://acme.com',
    // cooperation_angle intentionally omitted — must not matter for the gate.
  });
  assert.equal(c.fit_level, 'Yüksek Uyum');
  assert.equal(c.cooperation_angle, '');
});

// ═══════════════ [5][6][7] Import persistence (fit_note/evidence/source) ═

test('[5] handleImport maps candidate.fit_reason -> fitNote with no transformation (already Turkish from the provider)', () => {
  const importCallMatch = AGENCY_RESEARCH_MODAL_BODY.match(/mutAgency\("create",\s*\{[\s\S]*?\}\);/);
  assert.ok(importCallMatch);
  assert.match(importCallMatch[0], /fitNote:\s*candidate\.fit_reason\s*\|\|\s*""/);
});

test('[6] handleImport maps candidate.evidence_summary -> researchEvidence with no transformation', () => {
  const importCallMatch = AGENCY_RESEARCH_MODAL_BODY.match(/mutAgency\("create",\s*\{[\s\S]*?\}\);/);
  assert.match(importCallMatch[0], /researchEvidence:\s*candidate\.evidence_summary\s*\|\|\s*""/);
});

test('[7] handleImport maps candidate.source_url -> researchSourceUrl verbatim, never rewritten', () => {
  const importCallMatch = AGENCY_RESEARCH_MODAL_BODY.match(/mutAgency\("create",\s*\{[\s\S]*?\}\);/);
  assert.match(importCallMatch[0], /researchSourceUrl:\s*candidate\.source_url\s*\|\|\s*""/);
  // cooperation_angle is deliberately NOT persisted — candidate-review-only field.
  assert.doesNotMatch(importCallMatch[0], /cooperation_angle/);
});

// ═══════════════ [8]-[11] Outreach draft language per selected market ═══

test('[8][9][10][11] outreachDraftProvider still supports exactly Portuguese, Italian, Spanish, and English as the OUTPUT language, unchanged by this phase', () => {
  assert.deepEqual(outreachDraftProvider.ALLOWED_LANGUAGES, ['English', 'Spanish', 'Portuguese', 'Italian']);
  for (const language of outreachDraftProvider.ALLOWED_LANGUAGES) {
    assert.doesNotThrow(() => outreachDraftProvider.validateDraftInput({ agency: { name: 'Acme' }, language }));
  }
});

test('the drafting system prompt still instructs writing in the target language given in the request, never Turkish, never the research language', () => {
  assert.match(OUTREACH_PROVIDER_SRC, /Write the email in the target language given in the user message below/);
  assert.doesNotMatch(OUTREACH_PROVIDER_SRC, /Write the email in Turkish/i);
});

test('the drafting prompt now explicitly warns that the Turkish grounding context must not leak into the (differently-languaged) outgoing email', () => {
  assert.match(OUTREACH_PROVIDER_SRC, /may be written in Turkish/);
  assert.match(OUTREACH_PROVIDER_SRC, /never copy Turkish words or phrases into the email/);
});

test('drafting still never attaches the web_search tool and never re-runs research — grounding is read-only, language-independent of that rule', () => {
  assert.doesNotMatch(OUTREACH_PROVIDER_SRC, /tools\s*:\s*\[/);
  assert.doesNotMatch(OUTREACH_PROVIDER_SRC, /type:\s*'web_search_20250305'/);
});

test('buildUserPrompt still forwards fitNote/researchEvidence/researchSourceUrl as plain grounding context, never translating or language-tagging them itself', () => {
  assert.match(OUTREACH_PROVIDER_SRC, /if \(agency\.fitNote\) lines\.push/);
  assert.match(OUTREACH_PROVIDER_SRC, /if \(agency\.researchEvidence\) lines\.push/);
  assert.match(OUTREACH_PROVIDER_SRC, /if \(agency\.researchSourceUrl\) lines\.push/);
});

// ═══════════════ [12] Duplicate detection behavior is unchanged ══════════

test('[12] duplicateMatching.js is untouched by this phase — same website/email/name priority order', () => {
  const existing = [{ id: 'A1', name: 'Other', website: 'acme.com', email: '' }];
  assert.deepEqual(
    duplicateMatching.findLikelyDuplicate({ name: 'X', website: 'https://www.Acme.com/', email: '' }, existing),
    { id: 'A1', name: 'Other', matchedOn: 'website' }
  );
});

test('AgencyResearchModal still only imports via the explicit "CRM\'e Ekle" action, never auto-imports research results', () => {
  const handleResearchBody = AGENCY_RESEARCH_MODAL_BODY.slice(
    AGENCY_RESEARCH_MODAL_BODY.indexOf('async function handleResearch'),
    AGENCY_RESEARCH_MODAL_BODY.indexOf('async function handleImport')
  );
  assert.doesNotMatch(handleResearchBody, /handleImport\(/);
  assert.match(AGENCY_RESEARCH_MODAL_BODY, /onClick=\{\(\)=>handleImport\(c\)\}/);
});

// ═══════════════ UI: new Turkish section labels, hide-if-empty ══════════

test('the candidate card renders the exact four Turkish section labels, each conditionally only when the field is present', () => {
  for (const label of ['Ne yapıyor?', "Neden DeseTour'a uygun?", 'Kanıt', 'İş Birliği Fırsatı']) {
    assert.match(AGENCY_RESEARCH_MODAL_BODY, new RegExp(label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
  assert.match(AGENCY_RESEARCH_MODAL_BODY, /c\.travel_focus && \(/);
  assert.match(AGENCY_RESEARCH_MODAL_BODY, /c\.fit_reason && \(/);
  assert.match(AGENCY_RESEARCH_MODAL_BODY, /c\.evidence_summary && \(/);
  assert.match(AGENCY_RESEARCH_MODAL_BODY, /c\.cooperation_angle && \(/);
});

test('contact rows (E-posta/İletişim kişisi/Telefon) are shown only when present — never a placeholder dash, matching "never guess"', () => {
  assert.match(AGENCY_RESEARCH_MODAL_BODY, /E-posta:/);
  assert.match(AGENCY_RESEARCH_MODAL_BODY, /İletişim kişisi:/);
  assert.match(AGENCY_RESEARCH_MODAL_BODY, /Telefon:/);
  assert.match(AGENCY_RESEARCH_MODAL_BODY, /const hasContact = !!\(c\.email \|\| c\.contact_person \|\| c\.phone\);/);
  assert.match(AGENCY_RESEARCH_MODAL_BODY, /\{hasContact && \(/);
});

test('the source URL is rendered as a clickable link (Kaynak), only when present', () => {
  assert.match(AGENCY_RESEARCH_MODAL_BODY, /c\.source_url && \(/);
  assert.match(AGENCY_RESEARCH_MODAL_BODY, /<a href=\{c\.source_url\} target="_blank" rel="noopener noreferrer"/);
  assert.match(AGENCY_RESEARCH_MODAL_BODY, /Kaynak:/);
});

test('the existing CRM\'e Ekle / Zaten CRM\'de / Eklendi button logic is untouched', () => {
  assert.match(AGENCY_RESEARCH_MODAL_BODY, /Zaten CRM'de — Aç/);
  assert.match(AGENCY_RESEARCH_MODAL_BODY, /Eklendi ✓/);
  assert.match(AGENCY_RESEARCH_MODAL_BODY, /CRM'e Ekle/);
});

// ═══════════════ [13] handled by running the Phase 1/2 suites directly ══
// (see the implementation report — 89/89 pass, confirmed separately; not
// re-asserted here to avoid duplicating that suite's own test IDs.)
