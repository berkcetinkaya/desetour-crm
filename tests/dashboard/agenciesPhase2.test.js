'use strict';
/**
 * tests/dashboard/agenciesPhase2.test.js
 * ─────────────────────────────────────────────────────────────────────────
 * Acenteler (B2B agency acquisition) — Phase 2: market research, fit
 * evaluation, personalized outreach drafting.
 *
 * Phase 2 adds a small server-side boundary (api/_agencies/*, wired into
 * api/agency-research.js and api/agency-draft-outreach.js) plus a frontend
 * research modal and an outreach-draft section on AcenteDetailPage. This
 * suite proves: input validation, fit-level/evidence discipline, the
 * writing-standard enforcement, duplicate matching, role gating, and that
 * zero email-sending or auto-import behavior exists anywhere in this phase.
 *
 * Every live network call (fetchCandidatesFromProvider, fetchDraftFromProvider,
 * requireAgencyRole's Supabase calls) is injected via deps — this suite
 * never makes a real network call, matching every other test file in this
 * project.
 * ─────────────────────────────────────────────────────────────────────────
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.join(__dirname, '..', '..');
const SOURCE = fs.readFileSync(path.join(REPO_ROOT, 'DeseTourDashboard.jsx'), 'utf8');

const researchProvider = require('../../api/_agencies/researchProvider');
const outreachDraftProvider = require('../../api/_agencies/outreachDraftProvider');
const duplicateMatching = require('../../api/_agencies/duplicateMatching');
const authorize = require('../../api/_agencies/authorize');

const AGENCY_RESEARCH_API_SOURCE = fs.readFileSync(path.join(REPO_ROOT, 'api', 'agency-research.js'), 'utf8');
const AGENCY_DRAFT_API_SOURCE = fs.readFileSync(path.join(REPO_ROOT, 'api', 'agency-draft-outreach.js'), 'utf8');

function body(name, nextMarker) {
  const idx = SOURCE.indexOf(`function ${name}(`);
  assert.ok(idx !== -1, `could not find function ${name}`);
  return SOURCE.slice(idx, SOURCE.indexOf(nextMarker, idx));
}
function objectBody(startMarker, endMarker) {
  const start = SOURCE.indexOf(startMarker);
  assert.ok(start !== -1, `could not find "${startMarker}"`);
  return SOURCE.slice(start, SOURCE.indexOf(endMarker, start));
}

const AGENCY_RESEARCH_MODAL_BODY = body('AgencyResearchModal', '\nfunction AcenteDetailPage');
const ACENTE_DETAIL_BODY = body('AcenteDetailPage', '\nfunction GuidesPage');
const AGENCY_EMAIL_REPO_BODY = objectBody('const AgencyEmailRepository = {', '\nconst GuidePaymentRepository');
const SUPABASE_AGENCY_EMAIL_BODY = objectBody('const SupabaseAgencyEmailRepo = {', '\nconst SupabaseGuidePaymentRepo');

// ═════════════════════════════ RESEARCH (1-14) ═══════════════════════════

test('[1] country is required', () => {
  assert.throws(() => researchProvider.validateResearchInput({ language: 'English', limit: 5, minimumFit: 'Yüksek Uyum' }),
    researchProvider.ValidationError);
  try {
    researchProvider.validateResearchInput({ country: '  ', language: 'English', limit: 5, minimumFit: 'Yüksek Uyum' });
    assert.fail('expected ValidationError for blank country');
  } catch (err) {
    assert.ok(err instanceof researchProvider.ValidationError);
    assert.ok(err.errors.country);
  }
});

test('[2] language must be one of the 4 supported languages', () => {
  for (const lang of researchProvider.ALLOWED_LANGUAGES) {
    assert.doesNotThrow(() => researchProvider.validateResearchInput({ country: 'Spain', language: lang, limit: 5, minimumFit: 'Yüksek Uyum' }));
  }
  try {
    researchProvider.validateResearchInput({ country: 'Spain', language: 'French', limit: 5, minimumFit: 'Yüksek Uyum' });
    assert.fail('expected ValidationError for unsupported language');
  } catch (err) {
    assert.ok(err instanceof researchProvider.ValidationError);
    assert.ok(err.errors.language);
  }
  assert.deepEqual(researchProvider.ALLOWED_LANGUAGES, ['English', 'Spanish', 'Portuguese', 'Italian']);
});

test('[3] limit must be a positive integer', () => {
  for (const bad of [0, -1, 1.5, 'abc', null, undefined]) {
    try {
      researchProvider.validateResearchInput({ country: 'Spain', language: 'English', limit: bad, minimumFit: 'Yüksek Uyum' });
      assert.fail(`expected ValidationError for limit=${bad}`);
    } catch (err) {
      assert.ok(err instanceof researchProvider.ValidationError);
      assert.ok(err.errors.limit);
    }
  }
});

test('[4] limit is hard-capped at 20 (MAX_CANDIDATES) — rejected above that, never silently clamped', () => {
  assert.equal(researchProvider.MAX_CANDIDATES, 20);
  assert.doesNotThrow(() => researchProvider.validateResearchInput({ country: 'Spain', language: 'English', limit: 20, minimumFit: 'Yüksek Uyum' }));
  try {
    researchProvider.validateResearchInput({ country: 'Spain', language: 'English', limit: 21, minimumFit: 'Yüksek Uyum' });
    assert.fail('expected ValidationError for limit=21');
  } catch (err) {
    assert.ok(err instanceof researchProvider.ValidationError);
    assert.ok(err.errors.limit);
  }
});

test('[5] minimumFit must be exactly "Yüksek Uyum" or "Orta Uyum ve Üzeri" — no other filter dimension exists', () => {
  assert.deepEqual(researchProvider.ALLOWED_MINIMUM_FIT, ['Yüksek Uyum', 'Orta Uyum ve Üzeri']);
  try {
    researchProvider.validateResearchInput({ country: 'Spain', language: 'English', limit: 5, minimumFit: 'Düşük Uyum' });
    assert.fail('expected ValidationError for an out-of-range minimumFit');
  } catch (err) {
    assert.ok(err instanceof researchProvider.ValidationError);
    assert.ok(err.errors.minimumFit);
  }
});

test('[6] the research input form only has country/language/limit/minimumFit — no size, revenue, headcount, tags, or territory fields', () => {
  assert.doesNotMatch(AGENCY_RESEARCH_MODAL_BODY, /revenue|headcount|employee|territory|campaign|segment/i);
  const valid = researchProvider.validateResearchInput({ country: 'Spain', language: 'English', limit: 5, minimumFit: 'Yüksek Uyum' });
  assert.deepEqual(valid, { country: 'Spain', language: 'English', limit: 5, minimumFit: 'Yüksek Uyum' });
});

test('[7] sanitizeCandidate rejects a candidate with no usable name', () => {
  assert.equal(researchProvider.sanitizeCandidate({ name: '', fit_level: 'Yüksek Uyum' }), null);
  assert.equal(researchProvider.sanitizeCandidate({ fit_level: 'Yüksek Uyum' }), null);
  assert.equal(researchProvider.sanitizeCandidate(null), null);
});

test('[8] sanitizeCandidate rejects any fit_level outside the exact 3 allowed strings — never coerced to a guess', () => {
  assert.equal(researchProvider.sanitizeCandidate({ name: 'Acme Travel', fit_level: 'High' }), null);
  assert.equal(researchProvider.sanitizeCandidate({ name: 'Acme Travel', fit_level: 8 }), null);
  assert.equal(researchProvider.sanitizeCandidate({ name: 'Acme Travel', fit_level: '' }), null);
  assert.ok(researchProvider.sanitizeCandidate({ name: 'Acme Travel', fit_level: 'Orta Uyum' }));
});

test('[9] sanitizeCandidate defaults every optional field to "" — never null/undefined/a guess', () => {
  const c = researchProvider.sanitizeCandidate({ name: 'Acme Travel', fit_level: 'Yüksek Uyum' });
  for (const key of ['website', 'country', 'city', 'contact_person', 'email', 'phone', 'language', 'travel_focus', 'turkiye_signal', 'fit_reason', 'evidence_summary', 'source_url']) {
    assert.equal(c[key], '', `${key} must default to ''`);
  }
});

test('[10] no email address is ever invented — sanitizeCandidate only passes through what the provider actually returned', () => {
  const noEmail = researchProvider.sanitizeCandidate({ name: 'Acme Travel', fit_level: 'Yüksek Uyum', website: 'acme.com' });
  assert.equal(noEmail.email, '');
  const withEmail = researchProvider.sanitizeCandidate({ name: 'Acme Travel', fit_level: 'Yüksek Uyum', email: 'info@acme.com' });
  assert.equal(withEmail.email, 'info@acme.com');
});

test('[11] filterAndCapCandidates applies the minimumFit filter correctly for both allowed values', () => {
  const candidates = [
    { fit_level: 'Yüksek Uyum' }, { fit_level: 'Orta Uyum' }, { fit_level: 'Düşük Uyum' },
  ];
  assert.deepEqual(
    researchProvider.filterAndCapCandidates(candidates, { limit: 20, minimumFit: 'Yüksek Uyum' }),
    [{ fit_level: 'Yüksek Uyum' }]
  );
  assert.deepEqual(
    researchProvider.filterAndCapCandidates(candidates, { limit: 20, minimumFit: 'Orta Uyum ve Üzeri' }),
    [{ fit_level: 'Yüksek Uyum' }, { fit_level: 'Orta Uyum' }]
  );
});

test('[12] filterAndCapCandidates caps the result to the requested limit', () => {
  const candidates = Array.from({ length: 10 }, () => ({ fit_level: 'Yüksek Uyum' }));
  const result = researchProvider.filterAndCapCandidates(candidates, { limit: 3, minimumFit: 'Yüksek Uyum' });
  assert.equal(result.length, 3);
});

test('[13] filterAndCapCandidates never returns more than MAX_CANDIDATES even if limit were somehow larger', () => {
  const candidates = Array.from({ length: 30 }, () => ({ fit_level: 'Yüksek Uyum' }));
  const result = researchProvider.filterAndCapCandidates(candidates, { limit: 25, minimumFit: 'Yüksek Uyum' });
  assert.equal(result.length, researchProvider.MAX_CANDIDATES);
});

test('[14] extractCandidateArray throws ProviderError (never returns []) on malformed, non-array, or missing JSON', () => {
  assert.throws(() => researchProvider.extractCandidateArray('no json here at all'), researchProvider.ProviderError);
  assert.throws(() => researchProvider.extractCandidateArray('[{"name": "Acme" ,]'), researchProvider.ProviderError);
  assert.throws(() => researchProvider.extractCandidateArray('{"not":"an array"}'), researchProvider.ProviderError);
  assert.throws(() => researchProvider.extractCandidateArray(undefined), researchProvider.ProviderError);
  assert.deepEqual(researchProvider.extractCandidateArray('here is the list: [{"name":"Acme"}] thanks'), [{ name: 'Acme' }]);
});

// ═════════════════════════════════ FIT (15-17) ════════════════════════════

test('[15] exactly three fit levels exist — never a numeric score', () => {
  assert.deepEqual(researchProvider.ALLOWED_FIT_LEVELS, ['Yüksek Uyum', 'Orta Uyum', 'Düşük Uyum']);
  assert.ok(researchProvider.ALLOWED_FIT_LEVELS.every(l => typeof l === 'string' && !/^\d+$/.test(l)));
});

test('[16] allowedFitLevelsFor maps each minimumFit option to the correct fit-level set, strongest first', () => {
  assert.deepEqual(researchProvider.allowedFitLevelsFor('Yüksek Uyum'), ['Yüksek Uyum']);
  assert.deepEqual(researchProvider.allowedFitLevelsFor('Orta Uyum ve Üzeri'), ['Yüksek Uyum', 'Orta Uyum']);
});

test('[17] every retained candidate carries both fit_level and fit_reason fields (fit_reason may be empty, but the key is always present)', () => {
  const c = researchProvider.sanitizeCandidate({ name: 'Acme Travel', fit_level: 'Orta Uyum' });
  assert.ok('fit_level' in c);
  assert.ok('fit_reason' in c);
  assert.equal(c.fit_level, 'Orta Uyum');
});

// ═══════════════════════════════ DRAFTING (18-32) ═════════════════════════

test('[18] agency.name is required for drafting', () => {
  try {
    outreachDraftProvider.validateDraftInput({ agency: { name: '' }, language: 'English' });
    assert.fail('expected ValidationError');
  } catch (err) {
    assert.ok(err instanceof outreachDraftProvider.ValidationError);
    assert.ok(err.errors.agency);
  }
  try {
    outreachDraftProvider.validateDraftInput({ language: 'English' });
    assert.fail('expected ValidationError when agency is entirely missing');
  } catch (err) {
    assert.ok(err instanceof outreachDraftProvider.ValidationError);
  }
});

test('[19] draft language must be one of the 4 supported languages', () => {
  for (const lang of outreachDraftProvider.ALLOWED_LANGUAGES) {
    assert.doesNotThrow(() => outreachDraftProvider.validateDraftInput({ agency: { name: 'Acme' }, language: lang }));
  }
  try {
    outreachDraftProvider.validateDraftInput({ agency: { name: 'Acme' }, language: 'German' });
    assert.fail('expected ValidationError');
  } catch (err) {
    assert.ok(err instanceof outreachDraftProvider.ValidationError);
    assert.ok(err.errors.language);
  }
  assert.deepEqual(outreachDraftProvider.ALLOWED_LANGUAGES, ['English', 'Spanish', 'Portuguese', 'Italian']);
});

test('[20] draftOutreach fails closed with ConfigurationError when no API key is available — never a silent template fallback', async () => {
  await assert.rejects(
    () => outreachDraftProvider.draftOutreach({ agency: { name: 'Acme' }, language: 'English' }, { apiKey: '', fetchImpl: async () => { throw new Error('must not be called'); } }),
    outreachDraftProvider.ConfigurationError
  );
});

test('[21] enforceWritingStandard throws when the subject is missing', () => {
  assert.throws(() => outreachDraftProvider.enforceWritingStandard({ subject: '', body: 'Hello there, a perfectly normal email body.' }), outreachDraftProvider.ProviderError);
  assert.throws(() => outreachDraftProvider.enforceWritingStandard({ body: 'Hello there, a perfectly normal email body.' }), outreachDraftProvider.ProviderError);
});

test('[22] enforceWritingStandard throws when the body is missing', () => {
  assert.throws(() => outreachDraftProvider.enforceWritingStandard({ subject: 'Hello', body: '' }), outreachDraftProvider.ProviderError);
  assert.throws(() => outreachDraftProvider.enforceWritingStandard({ subject: 'Hello' }), outreachDraftProvider.ProviderError);
});

test('[23] enforceWritingStandard throws on any banned phrase, case-insensitively, in subject or body', () => {
  assert.throws(() => outreachDraftProvider.enforceWritingStandard({ subject: 'A Strategic Partnership', body: 'Normal body text that is long enough to pass other checks easily here.' }), outreachDraftProvider.ProviderError);
  assert.throws(() => outreachDraftProvider.enforceWritingStandard({ subject: 'Hello', body: 'We would love to discuss SYNERGY between our companies going forward together.' }), outreachDraftProvider.ProviderError);
  for (const phrase of outreachDraftProvider.BANNED_PHRASES) {
    assert.throws(() => outreachDraftProvider.enforceWritingStandard({ subject: 'Hello', body: `Some text containing ${phrase} right here in the middle of it.` }), outreachDraftProvider.ProviderError, `"${phrase}" should be banned`);
  }
});

test('[24] enforceWritingStandard throws on any emoji in subject or body', () => {
  assert.throws(() => outreachDraftProvider.enforceWritingStandard({ subject: 'Hello 🙂', body: 'Normal body text long enough to pass other checks easily here.' }), outreachDraftProvider.ProviderError);
  assert.throws(() => outreachDraftProvider.enforceWritingStandard({ subject: 'Hello', body: 'Great news 🎉 looking forward to connecting with your team soon.' }), outreachDraftProvider.ProviderError);
  assert.doesNotThrow(() => outreachDraftProvider.enforceWritingStandard({ subject: 'Hello', body: 'A perfectly normal email body with no emoji anywhere in it at all.' }));
});

test('[25] enforceWritingStandard throws on a fit_level outside the exact allowed set', () => {
  assert.throws(() => outreachDraftProvider.enforceWritingStandard({ subject: 'Hello', body: 'A perfectly normal email body with no emoji anywhere in it at all.', fit_level: 'High' }), outreachDraftProvider.ProviderError);
});

test('[26] enforceWritingStandard accepts an empty fit_level (no fit context was given)', () => {
  const result = outreachDraftProvider.enforceWritingStandard({ subject: 'Hello', body: 'A perfectly normal email body with no emoji anywhere in it at all.', fit_level: '' });
  assert.equal(result.fit_level, '');
  assert.equal(result.fit_reason, '');
});

test('[27] countWords/isWithinTargetLength correctly measure the 90-140 word target', () => {
  assert.equal(outreachDraftProvider.TARGET_MIN_WORDS, 90);
  assert.equal(outreachDraftProvider.TARGET_MAX_WORDS, 140);
  const short = 'word '.repeat(50).trim();
  const target = 'word '.repeat(110).trim();
  const long = 'word '.repeat(200).trim();
  assert.equal(outreachDraftProvider.countWords(target), 110);
  assert.equal(outreachDraftProvider.isWithinTargetLength(short), false);
  assert.equal(outreachDraftProvider.isWithinTargetLength(target), true);
  assert.equal(outreachDraftProvider.isWithinTargetLength(long), false);
});

test('[28] findBannedPhrase is case-insensitive and returns the first match or null', () => {
  assert.equal(outreachDraftProvider.findBannedPhrase('We propose a Strategic Partnership today.'), 'strategic partnership');
  assert.equal(outreachDraftProvider.findBannedPhrase('A perfectly ordinary sentence.'), null);
});

test('[29] containsEmoji detects emoji across common ranges and returns false for plain text', () => {
  assert.equal(outreachDraftProvider.containsEmoji('Hello 😀'), true);
  assert.equal(outreachDraftProvider.containsEmoji('Great news 🎉'), true);
  assert.equal(outreachDraftProvider.containsEmoji('Plain ASCII text only.'), false);
});

test('[30] a valid draft is normalized to exactly: subject, body, personalization_signal, angle_reason, fit_level, fit_reason', () => {
  const result = outreachDraftProvider.enforceWritingStandard({
    subject: '  Hello from DeseTour  ',
    body: '  A perfectly normal email body with no emoji anywhere in it at all.  ',
    personalization_signal: ' your Türkiye programs ',
    angle_reason: ' small groups fit well ',
    fit_level: 'Orta Uyum',
    fit_reason: ' operates outbound cultural travel ',
  });
  assert.deepEqual(Object.keys(result).sort(), ['angle_reason', 'body', 'fit_level', 'fit_reason', 'personalization_signal', 'subject'].sort());
  assert.equal(result.subject, 'Hello from DeseTour');
  assert.equal(result.body, 'A perfectly normal email body with no emoji anywhere in it at all.');
  assert.equal(result.personalization_signal, 'your Türkiye programs');
});

test('[31] buildUserPrompt only includes agency facts actually given — never invents a fact not present in the CRM record', () => {
  // buildUserPrompt is not exported directly (no network/public surface needed
  // beyond draftOutreach), so this is verified via the module's own source:
  // every optional line is gated behind `if (agency.<field>)`.
  const src = fs.readFileSync(path.join(REPO_ROOT, 'api', '_agencies', 'outreachDraftProvider.js'), 'utf8');
  assert.match(src, /if \(agency\.country\) lines\.push/);
  assert.match(src, /if \(agency\.city\) lines\.push/);
  assert.match(src, /if \(agency\.website\) lines\.push/);
  assert.match(src, /if \(agency\.fitNote\) lines\.push/);
  assert.match(src, /do not invent any fact about the agency/i);
  assert.match(src, /do not perform/i);
  assert.match(src, /a new web search/i);
});

test('[32] extractDraftObject throws ProviderError (never a silent fallback) on unparseable or missing text', () => {
  assert.throws(() => outreachDraftProvider.extractDraftObject('no json at all'), outreachDraftProvider.ProviderError);
  assert.throws(() => outreachDraftProvider.extractDraftObject('{"subject": "Hi" ,}'), outreachDraftProvider.ProviderError);
  assert.throws(() => outreachDraftProvider.extractDraftObject(undefined), outreachDraftProvider.ProviderError);
  assert.deepEqual(outreachDraftProvider.extractDraftObject('here you go: {"subject":"Hi","body":"text"} done'), { subject: 'Hi', body: 'text' });
});

// ═══════════════════════════ ROLE / REGRESSION (33-40) ════════════════════

test('[33] agency research/drafting is restricted to exactly admin and sales — no new role is introduced', () => {
  assert.deepEqual(authorize.ALLOWED_ROLES, ['admin', 'sales']);
});

test('[34] requireAgencyRole returns 401 when no bearer token is present', async () => {
  const result = await authorize.requireAgencyRole({ headers: {} });
  assert.equal(result.ok, false);
  assert.equal(result.status, 401);
});

test('[35] requireAgencyRole returns 403 for a role outside admin/sales (e.g. Operasyon/Rehber)', async () => {
  const fakeCreateClient = () => ({
    auth: { getUser: async () => ({ data: { user: { id: 'u1' } }, error: null }) },
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { role: 'operations' }, error: null }) }) }) }),
  });
  process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://example.supabase.co';
  process.env.SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || 'anon-test-key';
  process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'service-test-key';
  const result = await authorize.requireAgencyRole({ headers: { authorization: 'Bearer faketoken' } }, { createClient: fakeCreateClient });
  assert.equal(result.ok, false);
  assert.equal(result.status, 403);
});

test('[36] requireAgencyRole returns ok:true for admin and sales roles', async () => {
  for (const role of ['admin', 'sales']) {
    const fakeCreateClient = () => ({
      auth: {
        getUser: async () => ({ data: { user: { id: 'u1' } }, error: null }),
        mfa: { getAuthenticatorAssuranceLevel: async () => ({ data: { currentLevel: 'aal2', nextLevel: 'aal2', currentAuthenticationMethods: [] }, error: null }) },
      },
      from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { role }, error: null }) }) }) }),
    });
    const result = await authorize.requireAgencyRole({ headers: { authorization: 'Bearer faketoken' } }, { createClient: fakeCreateClient });
    assert.equal(result.ok, true);
    assert.equal(result.role, role);
  }
});

test('[37] findLikelyDuplicate checks website, then email, then normalized name, in that priority order', () => {
  const existing = [
    { id: 'A1', name: 'Other Name', website: 'acme.com', email: 'x@other.com' },
    { id: 'A2', name: 'Second Agency', website: 'different.com', email: 'contact@second.com' },
    { id: 'A3', name: 'Acme Travel Ltd', website: '', email: '' },
  ];
  assert.deepEqual(duplicateMatching.findLikelyDuplicate({ name: 'X', website: 'https://www.Acme.com/', email: 'nobody@nowhere.com' }, existing), { id: 'A1', name: 'Other Name', matchedOn: 'website' });
  assert.deepEqual(duplicateMatching.findLikelyDuplicate({ name: 'X', website: '', email: 'Contact@Second.com' }, existing), { id: 'A2', name: 'Second Agency', matchedOn: 'email' });
  assert.deepEqual(duplicateMatching.findLikelyDuplicate({ name: 'ACME TRAVEL', website: '', email: '' }, existing), { id: 'A3', name: 'Acme Travel Ltd', matchedOn: 'name' });
  assert.equal(duplicateMatching.findLikelyDuplicate({ name: 'Nobody Travel', website: '', email: '' }, existing), null);
});

const PHASE2_SOURCE_BUNDLE = [
  fs.readFileSync(path.join(REPO_ROOT, 'api', '_agencies', 'researchProvider.js'), 'utf8'),
  fs.readFileSync(path.join(REPO_ROOT, 'api', '_agencies', 'outreachDraftProvider.js'), 'utf8'),
  fs.readFileSync(path.join(REPO_ROOT, 'api', '_agencies', 'duplicateMatching.js'), 'utf8'),
  fs.readFileSync(path.join(REPO_ROOT, 'api', '_agencies', 'authorize.js'), 'utf8'),
  AGENCY_RESEARCH_API_SOURCE,
  AGENCY_DRAFT_API_SOURCE,
  AGENCY_RESEARCH_MODAL_BODY,
  ACENTE_DETAIL_BODY,
  AGENCY_EMAIL_REPO_BODY,
  SUPABASE_AGENCY_EMAIL_BODY,
].join('\n');

test('[38] no Phase 2 code path calls Resend, api/send-email.js, EmailService.send*, sendProposal, sendReminder, or sendReviewRequest', () => {
  // Mentions of these names INSIDE explanatory comments (e.g. "there is no
  // code path here that calls Resend/api/send-email.js") are expected and
  // fine — they document the absence. What must never appear is an actual
  // invocation/import of one of them.
  assert.doesNotMatch(PHASE2_SOURCE_BUNDLE, /require\(['"]resend['"]\)|new Resend\(|\.resend\.|fetch\(['"]\/api\/send-email/i);
  assert.doesNotMatch(PHASE2_SOURCE_BUNDLE, /EmailService\.send\w*\(/);
  assert.doesNotMatch(PHASE2_SOURCE_BUNDLE, /\bsendProposal\(|\bsendReminder\(|\bsendReviewRequest\(|\bsendAgencyOutreach\(/);
});

test('[39] both new endpoints enforce the role check server-side (not only a hidden frontend button) and research never auto-writes to agencies', () => {
  assert.match(AGENCY_RESEARCH_API_SOURCE, /requireAgencyRole\(req\)/);
  assert.match(AGENCY_DRAFT_API_SOURCE, /requireAgencyRole\(req\)/);
  // The research endpoint reads agencies only for duplicate annotation — it
  // must never insert/update/upsert into agencies itself.
  assert.doesNotMatch(AGENCY_RESEARCH_API_SOURCE, /\.from\(['"]agencies['"]\)\.(insert|update|upsert)/);
  // Importing a candidate is an explicit user action (handleImport, wired
  // only to the "CRM'e Ekle" button's onClick) — never auto-called from
  // handleResearch, and it never creates an agency_emails row during import.
  const handleResearchBody = AGENCY_RESEARCH_MODAL_BODY.slice(
    AGENCY_RESEARCH_MODAL_BODY.indexOf('async function handleResearch'),
    AGENCY_RESEARCH_MODAL_BODY.indexOf('async function handleImport')
  );
  assert.doesNotMatch(handleResearchBody, /handleImport\(/);
  assert.match(AGENCY_RESEARCH_MODAL_BODY, /onClick=\{\(\)=>handleImport\(c\)\}/);
  assert.doesNotMatch(AGENCY_RESEARCH_MODAL_BODY, /agencyEmail/i);
  // Imported agency gets no explicit status — relies on the existing
  // Phase 1 default ('Aday' in both mock AgencyRepository.create and the
  // agencies table's own DEFAULT), never a Phase-2-specific override.
  const handleImportBody = AGENCY_RESEARCH_MODAL_BODY.slice(AGENCY_RESEARCH_MODAL_BODY.indexOf('async function handleImport'), AGENCY_RESEARCH_MODAL_BODY.indexOf('async function handleImport') + 600);
  assert.doesNotMatch(handleImportBody, /status\s*:/);
});

test('[40] Phase 1 sections remain present and unmodified alongside the new Phase 2 sections; drafts never set sentAt or touch agencies.lastContactAt', () => {
  // Section names updated by the later Son Hareketler/Agencies redesign
  // phase, which reorganized the detail page into a header summary +
  // Genel Bakış/İletişim/Araştırma Bulguları/Notlar/Son Hareketler
  // modular layout — every Phase 1 field/capability this test cares
  // about (status control, contact info, notes, fit/research display,
  // last-contact display) is still present, just relabeled/relocated;
  // nothing was removed.
  for (const marker of ['İletişim', 'Araştırma Bulguları', 'Genel Bakış', 'Notlar', 'Sonraki Adım']) {
    assert.match(ACENTE_DETAIL_BODY, new RegExp(marker.replace(/[İ]/g, 'İ')), `redesigned section "${marker}" must be present`);
  }
  for (const marker of ['İlk Temas Taslağı', 'E-posta Geçmişi']) {
    assert.match(ACENTE_DETAIL_BODY, new RegExp(marker), `Phase 2 section "${marker}" must be present`);
  }
  assert.doesNotMatch(ACENTE_DETAIL_BODY, /lastContactAt\s*:/);
  assert.match(AGENCY_EMAIL_REPO_BODY, /sentAt\s*:\s*null/);
  assert.doesNotMatch(AGENCY_EMAIL_REPO_BODY, /lastContactAt/);
  assert.doesNotMatch(SUPABASE_AGENCY_EMAIL_BODY, /sent_at\s*:/);
  assert.doesNotMatch(SUPABASE_AGENCY_EMAIL_BODY, /last_contact_at/);
  // update() only ever touches subject/body — no status/sentAt changes, no version history.
  const updateFnMatch = AGENCY_EMAIL_REPO_BODY.match(/update\(id, patch\) \{[\s\S]*?\n  \},/);
  assert.ok(updateFnMatch, 'AgencyEmailRepository.update should exist');
  assert.doesNotMatch(updateFnMatch[0], /status/);
});

// ══════════ ADDITIONAL COVERAGE — closing gaps vs. the expanded 47-item audit ══════════
// The 40 tests above cover the original Phase 2 spec's own numbered test
// list. A follow-up audit requested several more specific items (guide-role
// rejection, no-guessed-contact-person, evidence-gated Yüksek Uyum,
// evidence-gated personalization, sparse-context safety, draft
// editability, no-follow-up/no-bulk-send, and untouched-domain smoke
// checks). Added here rather than renumbering the tests above.

test('[41] guide role (Rehber) is rejected, same as operations — only admin/sales pass', async () => {
  const fakeCreateClient = () => ({
    auth: { getUser: async () => ({ data: { user: { id: 'u1' } }, error: null }) },
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { role: 'guide' }, error: null }) }) }) }),
  });
  const result = await authorize.requireAgencyRole({ headers: { authorization: 'Bearer faketoken' } }, { createClient: fakeCreateClient });
  assert.equal(result.ok, false);
  assert.equal(result.status, 403);
});

test('[42] sanitizeCandidate never guesses a contact person when none was found', () => {
  const c = researchProvider.sanitizeCandidate({ name: 'Acme Travel', fit_level: 'Yüksek Uyum', website: 'acme.com' });
  assert.equal(c.contact_person, '');
});

test('[43] the research prompt requires clear evidence before granting "Yüksek Uyum" — never a guess', () => {
  const src = fs.readFileSync(path.join(REPO_ROOT, 'api', '_agencies', 'researchProvider.js'), 'utf8');
  assert.match(src, /"Yüksek Uyum":\s*clear evidence/);
});

test('[44] the drafting prompt only uses a personalization signal when it is actually evidence-backed, otherwise opens more generally', () => {
  const src = fs.readFileSync(path.join(REPO_ROOT, 'api', '_agencies', 'outreachDraftProvider.js'), 'utf8');
  assert.match(src, /verified personalization signal/i);
  assert.match(src, /only if the context actually supports one/i);
});

test('[45] the drafting prompt handles sparse agency context safely — shorter and honest, never invented detail', () => {
  const src = fs.readFileSync(path.join(REPO_ROOT, 'api', '_agencies', 'outreachDraftProvider.js'), 'utf8');
  assert.match(src, /sparse/i);
  assert.match(src, /rather than inventing detail to fill space/i);
});

test('[46] the generated draft subject/body remain editable in the UI before saving', () => {
  assert.match(ACENTE_DETAIL_BODY, /<FText value=\{draftSubject\} onChange=\{setDraftSubject\}\s*\/>/);
  assert.match(ACENTE_DETAIL_BODY, /<FTextArea value=\{draftBody\} onChange=\{setDraftBody\}/);
});

test('[47] no automated follow-up sequence or bulk-send capability exists anywhere in Phase 2', () => {
  assert.doesNotMatch(PHASE2_SOURCE_BUNDLE, /follow-?up sequence|bulk send|bulk email|mass email|batch send|campaign/i);
});

test('[48] Customers, Reservations, and Civitatis ingestion modules are present and untouched by this diff (git diff purity is the authoritative proof; this is a presence smoke-check)', () => {
  assert.match(SOURCE, /const CustomerRepository = \{/);
  assert.match(SOURCE, /function CustomersPage/);
  assert.match(SOURCE, /const ReservationRepository = \{/);
  assert.match(SOURCE, /function ReservationsPage/);
  assert.ok(fs.existsSync(path.join(REPO_ROOT, 'api', '_civitatis')), 'api/_civitatis must still exist, untouched');
});

test('[49] Reports module is present and untouched by this diff', () => {
  assert.match(SOURCE, /function ReportsPage/);
});

// ══════════ RESEARCH-EVIDENCE HARDENING (50-59) ══════════
// Follow-up hardening pass: persists research_evidence/research_source_url
// onto the imported agency row (new, additive columns — see
// supabase_migration_agencies_phase2_research_evidence.sql), hard-enforces
// (never just prompts) that "Yüksek Uyum" requires real evidence, and feeds
// that persisted evidence into drafting without a second hidden web search.

test('[50] research_evidence (candidate.evidence_summary) is persisted on CRM import', () => {
  const importCallMatch = AGENCY_RESEARCH_MODAL_BODY.match(/mutAgency\("create",\s*\{[\s\S]*?\}\);/);
  assert.ok(importCallMatch, 'handleImport\'s mutAgency("create", ...) call should exist');
  assert.match(importCallMatch[0], /researchEvidence:\s*candidate\.evidence_summary/);
});

test('[51] research_source_url (candidate.source_url) is persisted on CRM import', () => {
  const importCallMatch = AGENCY_RESEARCH_MODAL_BODY.match(/mutAgency\("create",\s*\{[\s\S]*?\}\);/);
  assert.ok(importCallMatch);
  assert.match(importCallMatch[0], /researchSourceUrl:\s*candidate\.source_url/);
  // fit_note stays the plain human-readable fit reason — never overloaded
  // with the raw evidence/source metadata that now has its own fields.
  assert.match(importCallMatch[0], /fitNote:\s*candidate\.fit_reason/);
  assert.doesNotMatch(importCallMatch[0], /fitNote:\s*\[candidate\.fit_reason,\s*candidate\.evidence_summary\]/);
});

test('[52] the persisted source URL is displayed on AcenteDetailPage as a clickable link, restrained and read-only', () => {
  // Relabeled by the later Agencies redesign phase (Araştırma Bulguları
  // card: "Kaynak Kanıt" for the evidence text, "Kaynak" for the source
  // URL link) — each now its own independent conditional block rather
  // than one combined researchEvidence||researchSourceUrl wrapper;
  // functionally unchanged (still read-only, still a plain <a> link).
  assert.match(ACENTE_DETAIL_BODY, /Kaynak Kanıt/);
  assert.match(ACENTE_DETAIL_BODY, /Kaynak<\/div>/);
  assert.match(ACENTE_DETAIL_BODY, /<a href=\{agency\.researchSourceUrl\}[\s\S]{0,80}target="_blank"/);
  // Read-only: no input/textarea/onChange anywhere near this section — it's
  // a plain info rendering, never an editable field. Checked for BOTH
  // now-independent conditional blocks (evidence text + source link).
  const researchSectionMatch = ACENTE_DETAIL_BODY.match(/agency\.researchSourceUrl && \([\s\S]*?<\/div>\s*\)\}/);
  assert.ok(researchSectionMatch, 'the conditional research source-url section should exist');
  assert.doesNotMatch(researchSectionMatch[0], /onChange=/);
  const evidenceSectionMatch = ACENTE_DETAIL_BODY.match(/agency\.researchEvidence && \([\s\S]*?<\/div>\s*\)\}/);
  assert.ok(evidenceSectionMatch, 'the conditional research evidence section should exist');
  assert.doesNotMatch(evidenceSectionMatch[0], /onChange=/);
});

test('[53] "Yüksek Uyum" cannot survive sanitizeCandidate without a non-empty evidence_summary — downgraded, not dropped', () => {
  const c = researchProvider.sanitizeCandidate({
    name: 'Acme Travel', fit_level: 'Yüksek Uyum', evidence_summary: '', source_url: 'https://acme.com/about',
  });
  assert.ok(c, 'candidate should be downgraded, never rejected outright');
  assert.equal(c.fit_level, 'Orta Uyum');
});

test('[54] "Yüksek Uyum" cannot survive sanitizeCandidate without a non-empty source_url — downgraded, not dropped', () => {
  const c = researchProvider.sanitizeCandidate({
    name: 'Acme Travel', fit_level: 'Yüksek Uyum', evidence_summary: 'Official site lists Türkiye tours.', source_url: '',
  });
  assert.ok(c);
  assert.equal(c.fit_level, 'Orta Uyum');
});

test('[55] "Yüksek Uyum" WITH both evidence_summary and source_url survives unchanged', () => {
  const c = researchProvider.sanitizeCandidate({
    name: 'Acme Travel', fit_level: 'Yüksek Uyum',
    evidence_summary: 'Official site lists Istanbul and Cappadocia cultural tours.',
    source_url: 'https://acme.com/tours/turkiye',
  });
  assert.ok(c);
  assert.equal(c.fit_level, 'Yüksek Uyum');
});

test('[56] Orta Uyum / Düşük Uyum behavior is unaffected by the evidence rule (it only ever downgrades from Yüksek Uyum)', () => {
  const orta = researchProvider.sanitizeCandidate({ name: 'Acme Travel', fit_level: 'Orta Uyum', evidence_summary: '', source_url: '' });
  assert.equal(orta.fit_level, 'Orta Uyum');
  const dusuk = researchProvider.sanitizeCandidate({ name: 'Acme Travel', fit_level: 'Düşük Uyum', evidence_summary: '', source_url: '' });
  assert.equal(dusuk.fit_level, 'Düşük Uyum');
  const ortaWithEvidence = researchProvider.sanitizeCandidate({ name: 'Acme Travel', fit_level: 'Orta Uyum', evidence_summary: 'Some evidence.', source_url: 'https://acme.com' });
  assert.equal(ortaWithEvidence.fit_level, 'Orta Uyum');
});

test('[57] drafting receives the persisted research evidence (researchEvidence/researchSourceUrl), gated on being non-empty, never a second research pass', () => {
  const outreachSrc = fs.readFileSync(path.join(REPO_ROOT, 'api', '_agencies', 'outreachDraftProvider.js'), 'utf8');
  assert.match(outreachSrc, /if \(agency\.researchEvidence\) lines\.push/);
  assert.match(outreachSrc, /if \(agency\.researchSourceUrl\) lines\.push/);
  assert.match(outreachSrc, /do not claim you personally visited/i);
  // The frontend must actually send these fields through.
  const handleGenerateDraftBody = ACENTE_DETAIL_BODY.slice(
    ACENTE_DETAIL_BODY.indexOf('async function handleGenerateDraft'),
    ACENTE_DETAIL_BODY.indexOf('async function handleSaveDraft')
  );
  assert.match(handleGenerateDraftBody, /researchEvidence:\s*agency\.researchEvidence/);
  assert.match(handleGenerateDraftBody, /researchSourceUrl:\s*agency\.researchSourceUrl/);
});

test('[58] drafting never attaches the web_search tool (no hidden second research pass), unlike the research provider which does', () => {
  const outreachSrc = fs.readFileSync(path.join(REPO_ROOT, 'api', '_agencies', 'outreachDraftProvider.js'), 'utf8');
  const researchSrc = fs.readFileSync(path.join(REPO_ROOT, 'api', '_agencies', 'researchProvider.js'), 'utf8');
  // Mentions of "web_search" INSIDE explanatory comments/prompt text (e.g.
  // "do not perform a new web search", "does NOT call the web_search tool")
  // document its absence and are expected. What must never appear is the
  // actual request-body tool declaration.
  assert.doesNotMatch(outreachSrc, /tools\s*:\s*\[/);
  assert.doesNotMatch(outreachSrc, /type:\s*'web_search_20250305'/);
  assert.match(researchSrc, /tools\s*:\s*\[\{\s*type:\s*'web_search_20250305'/);
});

test('[59] existing duplicate-matching logic is unchanged by this hardening pass, and no email-sending path was added', () => {
  const dupSrc = fs.readFileSync(path.join(REPO_ROOT, 'api', '_agencies', 'duplicateMatching.js'), 'utf8');
  // This file was not touched by the research-evidence hardening pass —
  // it has no reason to reference research_evidence/research_source_url.
  assert.doesNotMatch(dupSrc, /research_evidence|research_source_url|researchEvidence|researchSourceUrl/);
  // Same priority-order behavior re-confirmed (see test [37] for the full case).
  const existing = [{ id: 'A1', name: 'Other', website: 'acme.com', email: '' }];
  assert.deepEqual(duplicateMatching.findLikelyDuplicate({ name: 'X', website: 'acme.com', email: '' }, existing), { id: 'A1', name: 'Other', matchedOn: 'website' });

  const migrationSrc = fs.readFileSync(path.join(REPO_ROOT, 'supabase_migration_agencies_phase2_research_evidence.sql'), 'utf8');
  const rollbackSrc = fs.readFileSync(path.join(REPO_ROOT, 'supabase_migration_agencies_phase2_research_evidence_ROLLBACK.sql'), 'utf8');
  const allFiles = PHASE2_SOURCE_BUNDLE + '\n' + migrationSrc + '\n' + rollbackSrc;
  assert.doesNotMatch(allFiles, /require\(['"]resend['"]\)|new Resend\(|\.resend\.|fetch\(['"]\/api\/send-email/i);
  assert.doesNotMatch(allFiles, /EmailService\.send\w*\(/);
  assert.doesNotMatch(allFiles, /\bsendProposal\(|\bsendReminder\(|\bsendReviewRequest\(|\bsendAgencyOutreach\(/);
});
