'use strict';
/**
 * tests/dashboard/agencyContactEditing.test.js
 * ─────────────────────────────────────────────────────────────────────────
 * Agency CRM research workflow fixes — frontend half (DeseTourDashboard.jsx):
 *
 *   PART 1 — manual İletişim (contact) editing on AcenteDetailPage: website/
 *   İletişim Kişisi/E-posta/Telefon become editable via a compact Düzenle
 *   toggle, reusing the existing shared validate() email-format check and
 *   the existing agency update() mutation (and therefore its existing
 *   'updated'/'status_changed'/'note_added' activity-log action — no new
 *   action value, no new logging architecture).
 *
 *   PART 4 — defense in depth, frontend half: AgencyRepository.create
 *   (mock) and SupabaseAgencyRepo.create (real) both run a deterministic,
 *   pre-insert duplicate check (_findExistingAgencyMatch, a frontend copy
 *   of api/_agencies/duplicateMatching.js's findLikelyDuplicate — kept
 *   behaviorally identical, see its own header comment for why it can't
 *   be imported instead) and refuse/skip idempotently by returning the
 *   existing row instead of inserting a second one.
 *
 *   PART 6 — an existing agency with no email is never deleted and stays
 *   fully editable; adding an email through Part 1's form is all that's
 *   needed for it to become outreach-ready via the existing draft/send flow.
 *
 *   PART 7 — metrics: "Bugün Yeni Acente" (computeAgencyCrmPlusSummary)
 *   counts agencies.created_at only — an update() call never touches that
 *   field, so a contact edit can never increment it.
 *
 * Every assertion is either a pure-function test against the REAL
 * extracted implementation (via extractTestableFn's nested-marker support)
 * or a static source-text assertion against the real shipping
 * DeseTourDashboard.jsx — same convention as every other test file for
 * this single-file, module-less browser script.
 * ─────────────────────────────────────────────────────────────────────────
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const { extractTestableFn, extractFunctionSource } = require('./extractTestableFn');

const normalizeWebsite = extractTestableFn('_normalizeAgencyWebsiteDomain');
const normalizeEmail = extractTestableFn('_normalizeAgencyEmailForMatch');
const normalizeName = extractTestableFn('_normalizeAgencyNameForMatch');
const findExistingAgencyMatch = extractTestableFn('_findExistingAgencyMatch');

const ACENTE_DETAIL_BODY = extractFunctionSource('AcenteDetailPage');
const NEW_AGENCY_MODAL_BODY = extractFunctionSource('NewAgencyModal');
const AGENCY_RESEARCH_MODAL_BODY = extractFunctionSource('AgencyResearchModal');

const SOURCE_PATH = path.join(__dirname, '..', '..', 'DeseTourDashboard.jsx');
const fs = require('fs');
const SOURCE = fs.readFileSync(SOURCE_PATH, 'utf8');

// AgencyRepository is `const AgencyRepository = {...}`, not a `function`
// declaration — extractFunctionSource's `function <name>(` marker doesn't
// apply, so this slices by the next top-level const/comment instead.
const AGENCY_REPOSITORY_BODY = SOURCE.slice(
  SOURCE.indexOf('const AgencyRepository = {'),
  SOURCE.indexOf('const AgencyEmailRepository = {')
);

function sliceFunction(name, nextMarker) {
  const idx = SOURCE.indexOf(`function ${name}(`);
  assert.ok(idx !== -1, `could not find function ${name}`);
  return SOURCE.slice(idx, SOURCE.indexOf(nextMarker, idx));
}

// ── PART 4 (frontend) — _findExistingAgencyMatch pure-function parity ──
// Same cases as api/_agencies/duplicateMatching.js's own test file,
// proving the frontend copy is behaviorally identical.

test('_normalizeAgencyWebsiteDomain reduces protocol/www/path/query/case variants to the same canonical domain', () => {
  const variants = [
    'https://www.example.com/', 'http://example.com', 'www.example.com',
    'example.com/', 'example.com?utm=abc', 'EXAMPLE.COM',
    'https://www.Example.com/tours?src=x#frag',
  ];
  for (const v of variants) assert.equal(normalizeWebsite(v), 'example.com');
});

test('_findExistingAgencyMatch: www vs non-www, http vs https, and a path+query variant all match the same existing agency', () => {
  const existing = [{ id: 'AGN-1', name: 'Acme Co', website: 'acme.com', email: '' }];
  assert.ok(findExistingAgencyMatch({ name: 'X', website: 'https://www.acme.com/' }, existing));
  assert.ok(findExistingAgencyMatch({ name: 'X', website: 'http://acme.com' }, existing));
  assert.ok(findExistingAgencyMatch({ name: 'X', website: 'https://acme.com/contact?utm_source=research' }, existing));
});

test('_findExistingAgencyMatch falls back to normalized email, then normalized name, in that priority order', () => {
  const byEmail = [{ id: 'AGN-1', name: 'Other', website: '', email: 'hello@acme.com' }];
  assert.equal(findExistingAgencyMatch({ name: 'X', website: '', email: 'Hello@Acme.com' }, byEmail).id, 'AGN-1');

  const byName = [{ id: 'AGN-2', name: 'Acme Travel', website: '', email: '' }];
  assert.equal(findExistingAgencyMatch({ name: 'ACME TRAVEL', website: '', email: '' }, byName).id, 'AGN-2');
});

test('_findExistingAgencyMatch returns null for a genuinely new, non-duplicate agency', () => {
  const existing = [{ id: 'AGN-1', name: 'Existing Co', website: 'existing.com', email: 'x@existing.com' }];
  assert.equal(findExistingAgencyMatch({ name: 'Brand New Co', website: 'brandnew.com', email: 'y@brandnew.com' }, existing), null);
});

test('_findExistingAgencyMatch never confuses two genuinely different companies with different names/domains', () => {
  const existing = [{ id: 'AGN-1', name: 'Silver Compass Travel', website: '', email: '' }];
  const candidate = { name: 'Golden Pathway Expeditions', website: 'goldenpathway.com', email: 'a@goldenpathway.com' };
  assert.equal(findExistingAgencyMatch(candidate, existing), null);
});

// ── PART 4 — persistence-layer wiring (static source) ───────────────────

test('AgencyRepository.create (mock) refuses/skips a duplicate idempotently — returns the existing row, never inserts a second one', () => {
  const createIdx = AGENCY_REPOSITORY_BODY.indexOf('create(data) {');
  const createEnd = AGENCY_REPOSITORY_BODY.indexOf('\n  },', createIdx);
  const body = AGENCY_REPOSITORY_BODY.slice(createIdx, createEnd);
  assert.match(body, /const dup = _findExistingAgencyMatch\(data, DB\.agencies\);/);
  assert.match(body, /if \(dup\) return \{ \.\.\.dup, _duplicateOfExisting: true \};/);
});

test('SupabaseAgencyRepo.create (real) runs the same deterministic duplicate check immediately before the INSERT', () => {
  const repoIdx = SOURCE.indexOf('const SupabaseAgencyRepo = {');
  assert.ok(repoIdx > -1);
  const idx = SOURCE.indexOf('async create(d){', repoIdx);
  const end = SOURCE.indexOf('\n  async update', idx);
  assert.ok(idx > -1 && end > -1 && idx > repoIdx);
  const body = SOURCE.slice(idx, end);
  assert.match(body, /_findExistingAgencyMatch\(d, existingRows\|\|\[\]\)/);
  assert.match(body, /_duplicateOfExisting:true/);
  // The duplicate check must run BEFORE the insert, not after.
  const dupCheckIdx = body.indexOf('_findExistingAgencyMatch');
  const insertIdx = body.indexOf(".from('agencies').insert(row)");
  assert.ok(dupCheckIdx > -1 && insertIdx > -1 && dupCheckIdx < insertIdx, 'duplicate check must run before the insert');
});

test('NewAgencyModal (manual "Yeni Acente Ekle") recognizes _duplicateOfExisting and does not claim a new agency was created', () => {
  assert.match(NEW_AGENCY_MODAL_BODY, /data && data\._duplicateOfExisting/);
  assert.match(NEW_AGENCY_MODAL_BODY, /zaten CRM'de kayıtlı/);
});

test('AgencyResearchModal\'s handleImport recognizes _duplicateOfExisting as the final defense-in-depth reaction, never a pre-computed/normal result', () => {
  const importIdx = AGENCY_RESEARCH_MODAL_BODY.indexOf('async function handleImport');
  const importEnd = AGENCY_RESEARCH_MODAL_BODY.indexOf('\n  return (', importIdx);
  const body = AGENCY_RESEARCH_MODAL_BODY.slice(importIdx, importEnd);
  assert.match(body, /data && data\._duplicateOfExisting/);
  assert.match(body, /setDuplicateOf/);
  // This state is populated ONLY as a reaction inside handleImport — the
  // candidate list itself is never pre-annotated with existingAgencyId
  // any more (see agencyResearchDuplicateExclusion.test.js).
  assert.doesNotMatch(AGENCY_RESEARCH_MODAL_BODY, /c\.existingAgencyId/);
});

// ── PART 1 — manual contact editing ──────────────────────────────────────

test('İletişim card has a Düzenle edit action, only shown when not already editing', () => {
  const iletisimIdx = ACENTE_DETAIL_BODY.indexOf('RCardHead title="İletişim"');
  assert.ok(iletisimIdx > -1);
  const section = ACENTE_DETAIL_BODY.slice(iletisimIdx, iletisimIdx + 600);
  assert.match(section, /!contactEditMode && \(/);
  assert.match(section, />Düzenle</);
  assert.match(section, /onClick=\{handleStartEditContact\}/);
});

test('edit mode renders editable fields for website, İletişim Kişisi, E-posta, and Telefon — and country/city stay read-only (not in the editable field list)', () => {
  const iletisimIdx = ACENTE_DETAIL_BODY.indexOf('RCardHead title="İletişim"');
  const cardEnd = ACENTE_DETAIL_BODY.indexOf('\n      </RCard>', iletisimIdx);
  const section = ACENTE_DETAIL_BODY.slice(iletisimIdx, cardEnd);
  assert.match(section, /FText value=\{contactWebsiteDraft\} onChange=\{setContactWebsiteDraft\}/);
  assert.match(section, /FText value=\{contactPersonDraft\} onChange=\{setContactPersonDraft\}/);
  assert.match(section, /FText value=\{contactEmailDraft\} onChange=\{setContactEmailDraft\}.*type="email"/);
  assert.match(section, /FText value=\{contactPhoneDraft\} onChange=\{setContactPhoneDraft\}/);
  // Ülke/Şehir are always rendered as plain RInfoRow, never inside the
  // contactEditMode-only block — no editable Country/City field exists.
  assert.doesNotMatch(section, /contactCountryDraft|contactCityDraft/);
});

test('handleStartEditContact initializes every draft from the CURRENT agency, including when a field is empty (an agency with no email can still be edited)', () => {
  const idx = ACENTE_DETAIL_BODY.indexOf('function handleStartEditContact');
  const end = ACENTE_DETAIL_BODY.indexOf('\n  }', idx);
  const body = ACENTE_DETAIL_BODY.slice(idx, end);
  assert.match(body, /setContactWebsiteDraft\(agency\.website \|\| ""\);/);
  assert.match(body, /setContactPersonDraft\(agency\.contactPerson \|\| ""\);/);
  assert.match(body, /setContactEmailDraft\(agency\.email \|\| ""\);/);
  assert.match(body, /setContactPhoneDraft\(agency\.phone \|\| ""\);/);
  assert.match(body, /setContactEditMode\(true\);/);
});

test('handleSaveContact validates email format via the SAME shared validate() helper (and its SAME email regex) every other form in this app uses', () => {
  const idx = ACENTE_DETAIL_BODY.indexOf('async function handleSaveContact');
  const end = ACENTE_DETAIL_BODY.indexOf('\n  }', idx);
  const body = ACENTE_DETAIL_BODY.slice(idx, end);
  assert.match(body, /validate\(\{ email: \{ email: true \} \}, \{ email: normalizedEmail \}\)/);
});

test('handleSaveContact normalizes leading/trailing whitespace before validating and storing — trim(), not a new normalization scheme', () => {
  const idx = ACENTE_DETAIL_BODY.indexOf('async function handleSaveContact');
  const end = ACENTE_DETAIL_BODY.indexOf('\n  }', idx);
  const body = ACENTE_DETAIL_BODY.slice(idx, end);
  assert.match(body, /const normalizedEmail = \(contactEmailDraft \|\| ""\)\.trim\(\);/);
  assert.match(body, /const normalizedWebsite = \(contactWebsiteDraft \|\| ""\)\.trim\(\);/);
});

test('handleSaveContact never silently replaces a field unless it actually changed — only the diff is sent to update()', () => {
  const idx = ACENTE_DETAIL_BODY.indexOf('async function handleSaveContact');
  const end = ACENTE_DETAIL_BODY.indexOf('\n  }', idx);
  const body = ACENTE_DETAIL_BODY.slice(idx, end);
  assert.match(body, /if \(normalizedEmail {3}!== \(agency\.email \|\| ""\)\) patch\.email = normalizedEmail;/);
  assert.match(body, /if \(Object\.keys\(patch\)\.length === 0\) \{ setContactEditMode\(false\); return; \}/);
});

test('handleSaveContact saves ONLY via an explicit call inside itself — reuses the existing agency update() mutation (and therefore its existing activity-log action), never a new mutation/endpoint', () => {
  const idx = ACENTE_DETAIL_BODY.indexOf('async function handleSaveContact');
  const end = ACENTE_DETAIL_BODY.indexOf('\n  }', idx);
  const body = ACENTE_DETAIL_BODY.slice(idx, end);
  assert.match(body, /await mutAgency\("update", agency\.id, patch\)/);
});

test('handleSaveContact shows a normal success toast after saving, and the save button is only reachable via an explicit click (no auto-save on blur/change anywhere in the edit form)', () => {
  const idx = ACENTE_DETAIL_BODY.indexOf('async function handleSaveContact');
  const end = ACENTE_DETAIL_BODY.indexOf('\n  }', idx);
  const body = ACENTE_DETAIL_BODY.slice(idx, end);
  assert.match(body, /showToast\("İletişim bilgileri güncellendi ✓"\);/);
  // The only call site of handleSaveContact anywhere in this page is the Kaydet button's onClick.
  const callSites = (ACENTE_DETAIL_BODY.match(/handleSaveContact/g) || []).length;
  assert.equal(callSites, 2, 'expected exactly 2 occurrences: the function definition and its one onClick wiring');
});

test('a validation error blocks the save (never writes a malformed email) and is shown inline on the E-posta field', () => {
  const idx = ACENTE_DETAIL_BODY.indexOf('async function handleSaveContact');
  const end = ACENTE_DETAIL_BODY.indexOf('\n  }', idx);
  const body = ACENTE_DETAIL_BODY.slice(idx, end);
  assert.match(body, /setContactErrors\(e\);\s*\n\s*if \(Object\.keys\(e\)\.length\) return;/);
  const iletisimIdx = ACENTE_DETAIL_BODY.indexOf('RCardHead title="İletişim"');
  const cardEnd = ACENTE_DETAIL_BODY.indexOf('\n      </RCard>', iletisimIdx);
  const section = ACENTE_DETAIL_BODY.slice(iletisimIdx, cardEnd);
  assert.match(section, /FRow label="E-posta" error=\{contactErrors\.email\}/);
});

// ── PART 2/6 — subtle "Email Eksik" state, existing no-email agencies ──

test('AcenteDetailPage shows a subtle "Email eksik" indicator in place of E-posta when the agency has no email, never a blocking state', () => {
  const iletisimIdx = ACENTE_DETAIL_BODY.indexOf('RCardHead title="İletişim"');
  const cardEnd = ACENTE_DETAIL_BODY.indexOf('\n      </RCard>', iletisimIdx);
  const section = ACENTE_DETAIL_BODY.slice(iletisimIdx, cardEnd);
  assert.match(section, /Email eksik/);
});

test('the Acenteler list row shows "Email eksik" in the İletişim column when email is missing, and the plain email value otherwise', () => {
  const listBody = sliceFunction('AcentelerPage', '\nfunction ');
  assert.match(listBody, /a\.email \? \(/);
  assert.match(listBody, />Email eksik</);
});

test('an existing agency with no email is never deleted by this change — no delete/remove call was introduced anywhere for a missing-email agency', () => {
  assert.doesNotMatch(ACENTE_DETAIL_BODY, /mutAgency\("delete"/);
  assert.doesNotMatch(SOURCE, /AgencyRepository\.delete\b/);
  assert.doesNotMatch(SOURCE, /SupabaseAgencyRepo\.delete\b/);
});

// ── PART 7 — metrics: a contact edit is never counted as a new agency ──

test('mapAgencyToDB never maps created_at — an update() call can never bump an agency\'s createdAt, however many fields it patches', () => {
  const idx = SOURCE.indexOf('function mapAgencyToDB(d) {');
  const end = SOURCE.indexOf('\n}', idx);
  const body = SOURCE.slice(idx, end);
  assert.doesNotMatch(body, /row\.created_at/);
});

test('computeAgencyCrmPlusSummary\'s "Bugün Yeni Acente" count is driven ONLY by created_at, confirmed with a same-day EDIT scenario (createdAt yesterday, i.e. not today, still excluded)', () => {
  const computeAgencyCrmPlusSummary = extractTestableFn('computeAgencyCrmPlusSummary');
  const NOW_ISO = '2026-01-15T12:00:00.000Z';
  const editedButNotNewToday = {
    id: 'AGN-1', createdAt: '2026-01-10T09:00:00.000Z', // created days ago
    status: 'Aday',
  };
  const result = computeAgencyCrmPlusSummary([editedButNotNewToday], [], NOW_ISO);
  assert.equal(result.newAgenciesTodayCount, 0, 'an agency only EDITED today, not created today, must not count toward Bugün Yeni Acente');
});

test('computeAgencyCrmPlusSummary still correctly counts a genuinely new agency created today', () => {
  const computeAgencyCrmPlusSummary = extractTestableFn('computeAgencyCrmPlusSummary');
  const NOW_ISO = '2026-01-15T12:00:00.000Z';
  const genuinelyNewToday = { id: 'AGN-2', createdAt: '2026-01-15T08:00:00.000Z', status: 'Aday' };
  const result = computeAgencyCrmPlusSummary([genuinelyNewToday], [], NOW_ISO);
  assert.equal(result.newAgenciesTodayCount, 1);
});

// ── Existing Gmail outreach/reply behavior is unrelated and unmodified ──

test('this change introduces no dependency on any Gmail/mailbox/reply-threading module (no require() of one, anywhere in the files this change touched)', () => {
  const touchedFiles = [
    'api/_agencies/duplicateMatching.js',
    'api/_agencies/researchProvider.js',
    'api/agency-research.js',
  ];
  // Scoped to an actual require() call, not a bare substring — one of
  // these files' own comments legitimately cites gmailSendClient.js by
  // name as prior art for a duplicated regex, which a bare substring
  // check would false-positive on.
  const requiresGmailModule = /require\(['"][^'"]*(gmailInboundSync|gmailSendClient|agency-send-email|agency-mailbox-sync)['"]\)/;
  for (const f of touchedFiles) {
    const content = fs.readFileSync(path.join(__dirname, '..', '..', f), 'utf8');
    assert.doesNotMatch(content, requiresGmailModule, `${f} must not depend on any Gmail/mailbox module`);
  }
});
