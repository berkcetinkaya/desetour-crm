'use strict';
/**
 * tests/dashboard/agencyResearchDuplicateExclusion.test.js
 * ─────────────────────────────────────────────────────────────────────────
 * Agency CRM research workflow — three connected fixes:
 *
 *   PART 2/5 — a research candidate with no usable contact email is never
 *   returned to the browser at all: not shown as a successful prospect,
 *   never counted toward the requested limit, never importable.
 *
 *   PART 3 — EARLY EXCLUSION: a candidate matching an agency already in
 *   the CRM is silently dropped BEFORE the result is ever shown — no
 *   "Zaten CRM'de" row, no extra import step. Canonical website domain is
 *   the primary duplicate key (protocol/www/trailing-slash/path/query-
 *   string/case all ignored); normalized email and then normalized
 *   company name are the fallback when no reliable website exists.
 *
 *   PART 4 — defense in depth. These tests cover the researchProvider.js/
 *   duplicateMatching.js/agency-research.js side; the final persistence-
 *   time check lives in DeseTourDashboard.jsx's SupabaseAgencyRepo.create
 *   (see tests/dashboard/agencyContactEditing.test.js for that half).
 *
 * All pure-function tests here exercise the REAL, currently-shipping
 * implementations directly (no network, no Supabase) — same convention as
 * every other api/_agencies/*.js test file in this project.
 * ─────────────────────────────────────────────────────────────────────────
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.join(__dirname, '..', '..');
const duplicateMatching = require(path.join(REPO_ROOT, 'api', '_agencies', 'duplicateMatching'));
const researchProvider = require(path.join(REPO_ROOT, 'api', '_agencies', 'researchProvider'));

const AGENCY_RESEARCH_API_SOURCE = fs.readFileSync(path.join(REPO_ROOT, 'api', 'agency-research.js'), 'utf8');

const { normalizeWebsite, isValidEmailAddress, findLikelyDuplicate } = duplicateMatching;
const { filterUsableCandidates, researchAgencies, sanitizeCandidate } = researchProvider;

function candidate(overrides) {
  return sanitizeCandidate({
    name: 'Acme Travel',
    website: 'https://www.acme.com/',
    email: 'hello@acme.com',
    fit_level: 'Orta Uyum',
    ...overrides,
  });
}

// ── PART 3 — canonical domain normalization ─────────────────────────────

test('normalizeWebsite reduces protocol/www/trailing-slash/path/query-string/case variants to the same canonical domain', () => {
  const variants = [
    'https://www.example.com/',
    'http://example.com',
    'www.example.com',
    'example.com/',
    'example.com?utm=abc&ref=1',
    'EXAMPLE.COM',
    'https://www.Example.com/tours/istanbul?src=campaign#section',
  ];
  for (const v of variants) assert.equal(normalizeWebsite(v), 'example.com', `expected "${v}" to normalize to "example.com"`);
});

test('normalizeWebsite does not conflate a different subdomain with the bare domain (only the literal "www." prefix is stripped)', () => {
  assert.equal(normalizeWebsite('shop.example.com'), 'shop.example.com');
  assert.notEqual(normalizeWebsite('shop.example.com'), normalizeWebsite('example.com'));
});

test('normalizeWebsite returns "" for empty/non-string input, never throws', () => {
  assert.equal(normalizeWebsite(''), '');
  assert.equal(normalizeWebsite(null), '');
  assert.equal(normalizeWebsite(undefined), '');
});

// ── isValidEmailAddress ──────────────────────────────────────────────────

test('isValidEmailAddress accepts a well-formed address and rejects empty/malformed ones', () => {
  assert.equal(isValidEmailAddress('hello@acme.com'), true);
  assert.equal(isValidEmailAddress(''), false);
  assert.equal(isValidEmailAddress('not-an-email'), false);
  assert.equal(isValidEmailAddress('missing-domain@'), false);
  assert.equal(isValidEmailAddress(undefined), false);
});

// ── PART 2/5 — usable email required ─────────────────────────────────────

test('filterUsableCandidates drops a candidate with an empty email', () => {
  const candidates = [candidate({ name: 'No Email Co', email: '' })];
  assert.deepEqual(filterUsableCandidates(candidates, []), []);
});

test('filterUsableCandidates keeps a candidate with a usable email', () => {
  const candidates = [candidate()];
  const result = filterUsableCandidates(candidates, []);
  assert.equal(result.length, 1);
  assert.equal(result[0].name, 'Acme Travel');
});

// ── PART 3 — early exclusion by canonical domain/email/name ─────────────

test('a candidate whose website matches an existing agency\'s canonical domain is silently excluded', () => {
  const existing = [{ id: 'AGN-1', name: 'Acme Co', website: 'https://www.acme.com', email: '' }];
  const candidates = [candidate({ website: 'http://acme.com/contact?utm=1' })];
  assert.deepEqual(filterUsableCandidates(candidates, existing), []);
});

test('www and non-www variants of the same existing domain are treated as the same agency', () => {
  const existing = [{ id: 'AGN-1', name: 'Acme Co', website: 'acme.com', email: '' }];
  const candidates = [candidate({ website: 'https://www.acme.com/' })];
  assert.deepEqual(filterUsableCandidates(candidates, existing), []);
});

test('http and https variants of the same existing domain are treated as the same agency', () => {
  const existing = [{ id: 'AGN-1', name: 'Acme Co', website: 'https://acme.com', email: '' }];
  const candidates = [candidate({ website: 'http://acme.com' })];
  assert.deepEqual(filterUsableCandidates(candidates, existing), []);
});

test('a URL path and query/tracking parameters do not bypass duplicate detection', () => {
  const existing = [{ id: 'AGN-1', name: 'Acme Co', website: 'acme.com', email: '' }];
  const candidates = [candidate({ website: 'https://acme.com/en/contact-us?utm_source=research&utm_campaign=x' })];
  assert.deepEqual(filterUsableCandidates(candidates, existing), []);
});

test('falls back to email match when the candidate has no reliable website', () => {
  const existing = [{ id: 'AGN-1', name: 'Acme Co', website: '', email: 'hello@acme.com' }];
  const candidates = [candidate({ website: '', email: 'hello@acme.com' })];
  assert.deepEqual(filterUsableCandidates(candidates, existing), []);
});

test('falls back to normalized name match only when neither website nor email is available on the existing row', () => {
  const existing = [{ id: 'AGN-1', name: 'Acme Travel', website: '', email: '' }];
  const candidates = [candidate({ name: 'ACME TRAVEL', website: '', email: 'new@someotherdomain.com' })];
  // Name match only fires when the existing row has no website/email to
  // compare against first — exactly findLikelyDuplicate's own pre-existing,
  // already-tested priority order (see agenciesPhase2.test.js's own [37]),
  // not a new/aggressive fuzzy name matcher introduced by this change.
  assert.deepEqual(filterUsableCandidates(candidates, existing), []);
});

test('a genuinely new, non-duplicate candidate is never excluded', () => {
  const existing = [{ id: 'AGN-1', name: 'Existing Co', website: 'existing.com', email: 'x@existing.com' }];
  const candidates = [candidate({ name: 'Brand New Travel', website: 'brandnewtravel.com', email: 'y@brandnewtravel.com' })];
  const result = filterUsableCandidates(candidates, existing);
  assert.equal(result.length, 1);
  assert.equal(result[0].name, 'Brand New Travel');
});

test('two genuinely different companies with completely different names are never suppressed, even when the existing row has no website (no aggressive fuzzy matching)', () => {
  const existing = [{ id: 'AGN-1', name: 'Silver Compass Travel', website: '', email: '' }];
  const candidates = [candidate({ name: 'Golden Pathway Expeditions', website: 'goldenpathway.com', email: 'a@goldenpathway.com' })];
  const result = filterUsableCandidates(candidates, existing);
  assert.equal(result.length, 1);
});

test('the SAME company listed twice within one research batch is excluded the second time (intra-batch self-dedup, same mechanism)', () => {
  const candidates = [
    candidate({ name: 'Acme Travel', website: 'https://www.acme.com/', email: 'a@acme.com' }),
    candidate({ name: 'Acme Travel', website: 'http://acme.com/contact', email: 'contact@acme.com' }),
  ];
  const result = filterUsableCandidates(candidates, []);
  assert.equal(result.length, 1);
});

// ── PART 4 — defense in depth: duplicate candidate is silently skipped,
// never shown, never counted (verified through the full public API) ─────

test('duplicate candidate is silently skipped from filterUsableCandidates — absent, not annotated', () => {
  const existing = [{ id: 'AGN-1', name: 'Acme Co', website: 'acme.com', email: '' }];
  const candidates = [candidate({ website: 'https://www.acme.com/' })];
  const result = filterUsableCandidates(candidates, existing);
  assert.deepEqual(result, []);
  // Confirms there is no annotation shape anywhere (no existingAgencyId on
  // the dropped item, because there IS no dropped item in the output).
});

test('running the SAME research twice does not re-surface an agency imported after the first run', () => {
  const firstRunCandidates = [candidate({ name: 'Acme Travel', website: 'acme.com', email: 'a@acme.com' })];
  const firstRunResult = filterUsableCandidates(firstRunCandidates, []);
  assert.equal(firstRunResult.length, 1, 'first run finds the new candidate');

  // Simulate the user importing it — it now exists in the CRM.
  const existingAfterImport = [{ id: 'AGN-NEW', name: 'Acme Travel', website: 'acme.com', email: 'a@acme.com' }];

  // Second research run returns the same company again (same or slightly
  // different URL formatting) — must now be excluded.
  const secondRunCandidates = [candidate({ name: 'Acme Travel', website: 'https://www.acme.com/', email: 'a@acme.com' })];
  const secondRunResult = filterUsableCandidates(secondRunCandidates, existingAfterImport);
  assert.deepEqual(secondRunResult, []);
});

// ── filterAndCapCandidates / researchAgencies ordering ──────────────────

test('a candidate excluded for missing email or being a duplicate never consumes one of the requested `limit` slots', () => {
  const candidates = [
    candidate({ name: 'No Email Co', email: '', fit_level: 'Orta Uyum' }),
    candidate({ name: 'Already In CRM', website: 'existing.com', email: 'x@existing.com', fit_level: 'Orta Uyum' }),
    candidate({ name: 'Genuinely New', website: 'newco.com', email: 'y@newco.com', fit_level: 'Orta Uyum' }),
  ];
  const existing = [{ id: 'AGN-1', name: 'Existing Co', website: 'existing.com', email: '' }];
  const actionable = filterUsableCandidates(candidates, existing);
  const final = researchProvider.filterAndCapCandidates(actionable, { limit: 20, minimumFit: 'Orta Uyum ve Üzeri' });
  assert.deepEqual(final.map(c => c.name), ['Genuinely New']);
});

// ── researchAgencies end to end (fake provider response) ─────────────────

function textBlock(text) { return { type: 'text', text }; }
function fakeResponse(contentBlocks) { return { ok: true, status: 200, json: async () => ({ content: contentBlocks }) }; }

test('researchAgencies end to end: a no-email candidate and a duplicate candidate are both absent from the final result, a genuine new one is present', async () => {
  const raw = [
    { name: 'No Email Co', website: 'noemail.com', email: '', fit_level: 'Orta Uyum' },
    { name: 'Dup Co', website: 'https://www.existing.com/path?x=1', email: 'x@existing.com', fit_level: 'Orta Uyum' },
    { name: 'New Co', website: 'newco.com', email: 'y@newco.com', fit_level: 'Orta Uyum' },
  ];
  const fetchImpl = async () => fakeResponse([textBlock(JSON.stringify(raw))]);
  const existingAgencies = [{ id: 'AGN-1', name: 'Existing Co', website: 'existing.com', email: '' }];
  const result = await researchAgencies(
    { country: 'Spain', language: 'Spanish', limit: 10, minimumFit: 'Orta Uyum ve Üzeri' },
    { apiKey: 'test-key', fetchImpl, existingAgencies }
  );
  assert.deepEqual(result.candidates.map(c => c.name), ['New Co']);
});

test('researchAgencies defaults existingAgencies to [] when the dep is omitted — never throws, never blocks results', async () => {
  const raw = [{ name: 'New Co', website: 'newco.com', email: 'y@newco.com', fit_level: 'Orta Uyum' }];
  const fetchImpl = async () => fakeResponse([textBlock(JSON.stringify(raw))]);
  const result = await researchAgencies(
    { country: 'Spain', language: 'Spanish', limit: 10, minimumFit: 'Orta Uyum ve Üzeri' },
    { apiKey: 'test-key', fetchImpl }
  );
  assert.equal(result.candidates.length, 1);
});

// ── PART 5 — research result quality / shape ─────────────────────────────

test('every candidate researchAgencies can return still carries name/website/email and the existing analytical fields — nothing new invented, nothing required stripped', async () => {
  const raw = [{
    name: 'New Co', website: 'newco.com', country: 'Spain', city: 'Madrid',
    contact_person: 'Marco Rossi', email: 'y@newco.com', phone: '', language: 'Spanish',
    travel_focus: 'Cultural tours', turkiye_signal: '', fit_level: 'Orta Uyum',
    fit_reason: 'Outbound cultural travel operator.', evidence_summary: '', cooperation_angle: '',
    source_url: 'https://newco.com/about',
  }];
  const fetchImpl = async () => fakeResponse([textBlock(JSON.stringify(raw))]);
  const result = await researchAgencies(
    { country: 'Spain', language: 'Spanish', limit: 10, minimumFit: 'Orta Uyum ve Üzeri' },
    { apiKey: 'test-key', fetchImpl }
  );
  const c = result.candidates[0];
  assert.equal(c.name, 'New Co');
  assert.equal(c.email, 'y@newco.com');
  assert.equal(c.contact_person, 'Marco Rossi');
  assert.equal(c.country, 'Spain');
  assert.equal(c.city, 'Madrid');
  assert.equal(c.fit_reason, 'Outbound cultural travel operator.');
});

// ── api/agency-research.js wiring (static source) ────────────────────────

test('api/agency-research.js fetches existing agencies BEFORE calling researchAgencies and passes them as existingAgencies', () => {
  const fetchIdx = AGENCY_RESEARCH_API_SOURCE.indexOf('const existingAgencies = await fetchExistingAgenciesForDuplicateCheck();');
  const callIdx = AGENCY_RESEARCH_API_SOURCE.indexOf('researchProvider.researchAgencies(input, { existingAgencies })');
  assert.ok(fetchIdx > -1, 'expected the existing-agencies fetch');
  assert.ok(callIdx > -1, 'expected existingAgencies to be passed into researchAgencies');
  assert.ok(fetchIdx < callIdx, 'existing agencies must be fetched BEFORE calling researchAgencies (early exclusion, not post-hoc annotation)');
});

test('api/agency-research.js no longer does post-hoc duplicate annotation (no existingAgencyId/existingAgencyName field construction, no direct findLikelyDuplicate import)', () => {
  // Scoped to the actual CODE pattern, not a bare substring — this file's
  // own header comment legitimately explains the REMOVED annotation
  // behavior using these words for context, which a bare substring check
  // would false-positive on.
  assert.doesNotMatch(AGENCY_RESEARCH_API_SOURCE, /existingAgencyId:\s*dup/);
  assert.doesNotMatch(AGENCY_RESEARCH_API_SOURCE, /existingAgencyName:\s*dup/);
  assert.doesNotMatch(AGENCY_RESEARCH_API_SOURCE, /require\(['"]\.\/_agencies\/duplicateMatching['"]\)/);
  assert.doesNotMatch(AGENCY_RESEARCH_API_SOURCE, /result\.candidates\.map\(candidate =>/);
});

test('api/agency-research.js still never writes to public.agencies itself', () => {
  assert.doesNotMatch(AGENCY_RESEARCH_API_SOURCE, /\.from\(['"]agencies['"]\)\.(insert|update|upsert)/);
});
