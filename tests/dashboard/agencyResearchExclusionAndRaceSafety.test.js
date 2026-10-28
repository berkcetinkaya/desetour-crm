'use strict';
/**
 * tests/dashboard/agencyResearchExclusionAndRaceSafety.test.js
 * ─────────────────────────────────────────────────────────────────────────
 * Agency CRM research workflow — second follow-up pass:
 *
 *   PART 1 — PROMPT-SIDE EXCLUSION: existing agencies' canonical website
 *   domains (ONLY domains — never name/email/status/notes/staff info) are
 *   sent to the research provider as a bounded exclusion list, with an
 *   explicit instruction not to return a company on that list, and a
 *   separate explicit instruction that a usable email is mandatory for a
 *   candidate to be worth including at all. The deterministic post-
 *   provider filter (filterCandidatesWithCounts) remains the ONLY thing
 *   actually relied upon for correctness — this prompt instruction is a
 *   pure efficiency hint, never trusted on its own.
 *
 *   PART 2 — RACE SAFETY AUDIT: documents, with a direct schema-file
 *   assertion, that NO database-level uniqueness constraint currently
 *   exists on agencies.website/email — the persistence-time duplicate
 *   check (SupabaseAgencyRepo.create/AgencyRepository.create) is
 *   therefore a best-effort read-then-insert, NOT race-safe against two
 *   truly concurrent imports. See the implementation report for the
 *   proposed (not yet created) database-level fix.
 *
 *   PART 3 — fail-closed research import: a candidate with no usable
 *   email can never be imported via AgencyResearchModal's handleImport,
 *   even if the object reaching it was tampered with client-side.
 *
 *   PART 5 — safe research summary counts, reliably computed, never
 *   fabricated.
 * ─────────────────────────────────────────────────────────────────────────
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.join(__dirname, '..', '..');
const researchProvider = require(path.join(REPO_ROOT, 'api', '_agencies', 'researchProvider'));
const { researchAgencies, buildExclusionDomains, filterCandidatesWithCounts, sanitizeCandidate, MAX_EXCLUSION_DOMAINS } = researchProvider;

const { extractFunctionSource } = require('./extractTestableFn');
const AGENCY_RESEARCH_MODAL_BODY = extractFunctionSource('AgencyResearchModal');

function textBlock(text) { return { type: 'text', text }; }
function fakeResponse(contentBlocks) { return { ok: true, status: 200, json: async () => ({ content: contentBlocks }) }; }

// ── PART 1 — buildExclusionDomains: canonical domains ONLY ──────────────

test('buildExclusionDomains extracts canonical website domains from existing agencies, deduped and sorted', () => {
  const existing = [
    { id: '1', website: 'https://www.acme.com/' },
    { id: '2', website: 'acme.com' }, // same canonical domain — deduped
    { id: '3', website: 'http://beta.com/contact?utm=1' },
    { id: '4', website: '' }, // no website — contributes nothing
  ];
  assert.deepEqual(buildExclusionDomains(existing), ['acme.com', 'beta.com']);
});

test('buildExclusionDomains sends NOTHING but the domain — no name, email, status, notes, or staff info leaks into the returned list', () => {
  const existing = [{
    id: 'AGN-SECRET', name: 'Super Secret Partner Co', website: 'acme.com',
    email: 'confidential@acme.com', internalNotes: 'Sensitive negotiation details',
    status: 'Görüşülüyor', createdBy: 'staff-uuid-123',
  }];
  const result = buildExclusionDomains(existing);
  assert.deepEqual(result, ['acme.com']);
  const serialized = JSON.stringify(result);
  assert.doesNotMatch(serialized, /Secret|confidential|Sensitive|Görüşülüyor|staff-uuid/);
});

test('buildExclusionDomains is bounded to MAX_EXCLUSION_DOMAINS, never unbounded as the CRM grows', () => {
  const many = Array.from({ length: MAX_EXCLUSION_DOMAINS + 50 }, (_, i) => ({ id: String(i), website: `company${i}.com` }));
  const result = buildExclusionDomains(many);
  assert.equal(result.length, MAX_EXCLUSION_DOMAINS);
});

test('buildExclusionDomains returns [] for no existing agencies, or agencies with no usable website — never throws', () => {
  assert.deepEqual(buildExclusionDomains([]), []);
  assert.deepEqual(buildExclusionDomains([{ id: '1', website: '' }, { id: '2' }]), []);
  assert.deepEqual(buildExclusionDomains(undefined), []);
  assert.deepEqual(buildExclusionDomains(null), []);
});

// ── PART 1 — the actual request sent to the provider ─────────────────────

test('researchAgencies sends the exclusion list to the provider as an explicit instruction, containing ONLY canonical domains', async () => {
  let capturedBody = null;
  const fetchImpl = async (url, opts) => {
    capturedBody = JSON.parse(opts.body);
    return fakeResponse([textBlock(JSON.stringify([]))]);
  };
  const existingAgencies = [
    { id: '1', name: 'Confidential Partner Name', website: 'https://www.acme.com/', email: 'secret@acme.com', status: 'Partner' },
  ];
  await researchAgencies(
    { country: 'Spain', language: 'Spanish', limit: 10, minimumFit: 'Orta Uyum ve Üzeri' },
    { apiKey: 'test-key', fetchImpl, existingAgencies }
  );
  assert.ok(capturedBody, 'expected a captured request body');
  const userMessage = capturedBody.messages[0].content;
  assert.match(userMessage, /EXCLUSION LIST/);
  assert.match(userMessage, /acme\.com/);
  assert.match(userMessage, /do NOT return any/i);
  // Nothing beyond the canonical domain ever reaches the provider request.
  assert.doesNotMatch(userMessage, /Confidential Partner Name/);
  assert.doesNotMatch(userMessage, /secret@acme\.com/);
  assert.doesNotMatch(capturedBody.system, /Confidential Partner Name|secret@acme\.com/);
});

test('researchAgencies sends no EXCLUSION LIST instruction at all when there are no existing agencies with a website (no empty/noise instruction)', async () => {
  let capturedBody = null;
  const fetchImpl = async (url, opts) => {
    capturedBody = JSON.parse(opts.body);
    return fakeResponse([textBlock(JSON.stringify([]))]);
  };
  await researchAgencies(
    { country: 'Spain', language: 'Spanish', limit: 10, minimumFit: 'Orta Uyum ve Üzeri' },
    { apiKey: 'test-key', fetchImpl, existingAgencies: [] }
  );
  assert.doesNotMatch(capturedBody.messages[0].content, /EXCLUSION LIST/);
});

test('the system prompt explicitly tells the provider a usable email is mandatory, and never to fabricate one', async () => {
  let capturedBody = null;
  const fetchImpl = async (url, opts) => {
    capturedBody = JSON.parse(opts.body);
    return fakeResponse([textBlock(JSON.stringify([]))]);
  };
  await researchAgencies(
    { country: 'Spain', language: 'Spanish', limit: 10, minimumFit: 'Orta Uyum ve Üzeri' },
    { apiKey: 'test-key', fetchImpl }
  );
  assert.match(capturedBody.system, /MANDATORY for a company to be worth including/);
  assert.match(capturedBody.system, /Never guess, infer, or fabricate an email address pattern/);
  assert.match(capturedBody.system, /skip that company/);
});

// ── PART 1 — deterministic post-provider filtering still the real guard ─

test('a provider that ignores the exclusion instruction and returns an existing agency anyway is still caught by the deterministic post-provider filter', async () => {
  const existingAgencies = [{ id: 'AGN-1', name: 'Existing Co', website: 'existing.com', email: '' }];
  const raw = [
    // Provider "ignored" the EXCLUSION LIST and returned this anyway.
    { name: 'Existing Co', website: 'https://www.existing.com/', email: 'x@existing.com', fit_level: 'Orta Uyum' },
    { name: 'New Co', website: 'newco.com', email: 'y@newco.com', fit_level: 'Orta Uyum' },
  ];
  const fetchImpl = async () => fakeResponse([textBlock(JSON.stringify(raw))]);
  const result = await researchAgencies(
    { country: 'Spain', language: 'Spanish', limit: 10, minimumFit: 'Orta Uyum ve Üzeri' },
    { apiKey: 'test-key', fetchImpl, existingAgencies }
  );
  assert.deepEqual(result.candidates.map(c => c.name), ['New Co']);
  assert.equal(result.summary.excludedExistingInCrm, 1);
});

// ── PART 5 — safe summary counts ─────────────────────────────────────────

test('researchAgencies returns reliable summary counts: examined, excludedExistingInCrm, excludedNoEmail, actionable', async () => {
  const existingAgencies = [{ id: 'AGN-1', name: 'Existing Co', website: 'existing.com', email: '' }];
  const raw = [
    { name: 'Existing Co', website: 'existing.com', email: 'x@existing.com', fit_level: 'Orta Uyum' }, // duplicate
    { name: 'No Email Co', website: 'noemail.com', email: '', fit_level: 'Orta Uyum' }, // no email
    { name: 'New Co A', website: 'newcoa.com', email: 'a@newcoa.com', fit_level: 'Orta Uyum' },
    { name: 'New Co B', website: 'newcob.com', email: 'b@newcob.com', fit_level: 'Orta Uyum' },
  ];
  const fetchImpl = async () => fakeResponse([textBlock(JSON.stringify(raw))]);
  const result = await researchAgencies(
    { country: 'Spain', language: 'Spanish', limit: 10, minimumFit: 'Orta Uyum ve Üzeri' },
    { apiKey: 'test-key', fetchImpl, existingAgencies }
  );
  assert.deepEqual(result.summary, {
    examined: 4,
    excludedExistingInCrm: 1,
    excludedNoEmail: 1,
    actionable: 2,
  });
  assert.equal(result.candidates.length, 2);
});

test('the result list shown to the user contains ONLY the actionable candidates — never the excluded ones alongside a count', async () => {
  const raw = [
    { name: 'No Email Co', website: 'noemail.com', email: '', fit_level: 'Orta Uyum' },
    { name: 'Good Co', website: 'goodco.com', email: 'x@goodco.com', fit_level: 'Orta Uyum' },
  ];
  const fetchImpl = async () => fakeResponse([textBlock(JSON.stringify(raw))]);
  const result = await researchAgencies(
    { country: 'Spain', language: 'Spanish', limit: 10, minimumFit: 'Orta Uyum ve Üzeri' },
    { apiKey: 'test-key', fetchImpl }
  );
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].name, 'Good Co');
});

test('AgencyResearchModal renders the summary line using the real summary field names, only the actionable candidates in the list below it', () => {
  assert.match(AGENCY_RESEARCH_MODAL_BODY, /setSummary\(payload\.summary \|\| null\)/);
  assert.match(AGENCY_RESEARCH_MODAL_BODY, /\{summary\.examined\}/);
  assert.match(AGENCY_RESEARCH_MODAL_BODY, /\{summary\.excludedExistingInCrm\}/);
  assert.match(AGENCY_RESEARCH_MODAL_BODY, /\{summary\.excludedNoEmail\}/);
  assert.match(AGENCY_RESEARCH_MODAL_BODY, /\{summary\.actionable\}/);
});

// ── PART 3 — research import fails closed on a no-email candidate ───────

test('handleImport fails closed (never calls create) when the candidate object has no usable email, even if it somehow reached this far', () => {
  const idx = AGENCY_RESEARCH_MODAL_BODY.indexOf('async function handleImport');
  const end = AGENCY_RESEARCH_MODAL_BODY.indexOf('\n  return (', idx);
  const body = AGENCY_RESEARCH_MODAL_BODY.slice(idx, end);
  assert.match(body, /const emailCheck = validate\(\{ email: \{ required: true, email: true \} \}, \{ email: candidate\.email \}\);/);
  const guardIdx = body.indexOf('emailCheck');
  const createIdx = body.indexOf('mutAgency("create"');
  assert.ok(guardIdx > -1 && createIdx > -1 && guardIdx < createIdx, 'the email check must run BEFORE create() is ever called');
  assert.match(body, /if \(Object\.keys\(emailCheck\)\.length\) \{/);
});

test('the fail-closed email check does not affect manual "Yeni Acente Ekle" — NewAgencyModal keeps email optional (established product behavior, untouched)', () => {
  const NEW_AGENCY_MODAL_BODY = extractFunctionSource('NewAgencyModal');
  assert.doesNotMatch(NEW_AGENCY_MODAL_BODY, /email: \{ required: true/);
  assert.match(NEW_AGENCY_MODAL_BODY, /validate\(\{name:\{required:"Acente adı zorunludur"\},email:\{email:true\}\}/);
});

// ── PART 2 — race-safety audit (documented, not fixed) ───────────────────

test('AUDIT (RESOLVED): a database-level canonical-domain uniqueness constraint now exists on agencies.website — supabase_migration_agencies_canonical_domain_uniqueness.sql closes the TOCTOU race the application-level pre-check alone could not. Still no uniqueness on agencies.email or agencies.name.', () => {
  const migrationFiles = fs.readdirSync(REPO_ROOT).filter(f => f.startsWith('supabase_migration_') && f.endsWith('.sql') && !f.includes('ROLLBACK'));
  const schemaFile = fs.readFileSync(path.join(REPO_ROOT, 'supabase_schema.sql'), 'utf8');
  const allSql = migrationFiles.map(f => fs.readFileSync(path.join(REPO_ROOT, f), 'utf8')).join('\n') + '\n' + schemaFile;

  // Per this test's own earlier forward-looking note ("if someone adds one
  // later ... update this assertion to confirm it, document it, and add a
  // regression test proving the behavior") — the Agency canonical-domain
  // uniqueness migration now provides exactly this, as a partial UNIQUE
  // expression index on canonical_agency_domain(website), never a plain
  // column-level constraint and never on email or name.
  assert.match(allSql, /CREATE\s+UNIQUE\s+INDEX\s+idx_agencies_canonical_domain_unique\s+ON\s+public\.agencies\s*\(public\.canonical_agency_domain\(website\)\)/is);
  assert.doesNotMatch(allSql, /CREATE\s+UNIQUE\s+INDEX[^;]*\bagencies\b[^;]*\bemail\b/is);
  assert.doesNotMatch(allSql, /ALTER TABLE public\.agencies[^;]*ADD CONSTRAINT[^;]*UNIQUE/is);
});

test('AUDIT: SupabaseAgencyRepo.create performs its duplicate check as a separate read, not an atomic/conditional write (ON CONFLICT, upsert, or similar) — confirms the TOCTOU race window exists in the current code, exactly as the race-safety concern describes', () => {
  const SOURCE = fs.readFileSync(path.join(REPO_ROOT, 'DeseTourDashboard.jsx'), 'utf8');
  const repoIdx = SOURCE.indexOf('const SupabaseAgencyRepo = {');
  const createIdx = SOURCE.indexOf('async create(d){', repoIdx);
  const end = SOURCE.indexOf('\n  async update', createIdx);
  const body = SOURCE.slice(createIdx, end);
  assert.match(body, /\.select\('id,name,website,email'\)/, 'a plain read, not a conditional write');
  assert.doesNotMatch(body, /on_conflict|onConflict|upsert\(/i);
});

// ── PART 4 — manual contact editing: the one explicit confirmation not
// already covered by tests/dashboard/agencyContactEditing.test.js ───────

test('adding/editing an email in AcenteDetailPage never sends outreach automatically — handleSaveContact only ever calls the agency update() mutation, no draft/send call anywhere in its body', () => {
  const ACENTE_DETAIL_BODY = extractFunctionSource('AcenteDetailPage');
  const idx = ACENTE_DETAIL_BODY.indexOf('async function handleSaveContact');
  const end = ACENTE_DETAIL_BODY.indexOf('\n  }', idx);
  const body = ACENTE_DETAIL_BODY.slice(idx, end);
  assert.doesNotMatch(body, /agency-draft-outreach|agency-send-email|mutAgencyEmail|handleSendEmail|handleGenerateDraft/);
  assert.match(body, /await mutAgency\("update", agency\.id, patch\)/);
});
