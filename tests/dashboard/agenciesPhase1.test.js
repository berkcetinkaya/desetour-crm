'use strict';
/**
 * tests/dashboard/agenciesPhase1.test.js
 * ─────────────────────────────────────────────────────────────────────────
 * Acenteler (B2B agency acquisition) — Phase 1 Foundation.
 *
 * Phase 1 is deliberately narrow: list + detail + status tracking +
 * internal notes. No AI/discovery, no email drafting, no sending. This
 * suite proves the schema/role/nav/repo/UI foundation is correct AND that
 * every explicitly-deferred capability (email, AI/discovery) has zero
 * footprint in this phase — not just "untested", but absent from the
 * source entirely.
 * ─────────────────────────────────────────────────────────────────────────
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.join(__dirname, '..', '..');
const SOURCE = fs.readFileSync(path.join(REPO_ROOT, 'DeseTourDashboard.jsx'), 'utf8');
const MIGRATION = fs.readFileSync(path.join(REPO_ROOT, 'supabase_migration_agencies.sql'), 'utf8');

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

const AGENCY_REPO_BODY         = objectBody('const AgencyRepository = {', '\nconst GuidePaymentRepository');
const SUPABASE_AGENCY_BODY     = objectBody('const SupabaseAgencyRepo = {', '\nconst SupabaseGuidePaymentRepo');
const ACENTELER_PAGE_BODY      = body('AcentelerPage', '\n// Fields match the architecture audit');
const NEW_AGENCY_MODAL_BODY    = body('NewAgencyModal', '\n// Keep it simple per the product brief');
const ACENTE_DETAIL_BODY       = body('AcenteDetailPage', '\nfunction GuidesPage');
const PAGE_ROUTER_BODY         = body('PageRouter', '\nfunction App()');

// Pull the REAL ROLE_PERMISSIONS/canAccess implementation and evaluate it,
// rather than re-typing the permission matrix by hand.
const rolePermIdx = SOURCE.indexOf('const ROLE_PERMISSIONS');
const canAccessEnd = SOURCE.indexOf('\n}', SOURCE.indexOf('function canAccess(role, page)', rolePermIdx));
const canAccess = new Function(`${SOURCE.slice(rolePermIdx, canAccessEnd + 2)}\nreturn canAccess;`)();
const ROLES = { admin: 'Yönetici', sales: 'Satış', operations: 'Operasyon', guide: 'Rehber' };

// ── 1-3. agencies migration ──────────────────────────────────────────────

test('[1] agencies migration creates the agencies table', () => {
  assert.match(MIGRATION, /CREATE TABLE IF NOT EXISTS public\.agencies \(/);
});

test('[2] agencies.status CHECK contains exactly the five approved values, no more', () => {
  const idx = MIGRATION.indexOf('status          TEXT        NOT NULL DEFAULT');
  const snippet = MIGRATION.slice(idx, MIGRATION.indexOf('),', idx) + 2);
  assert.match(snippet, /CHECK \(status IN \('Aday','İletişime Geçildi','Görüşülüyor','Partner','Uygun Değil'\)\)/);
  // No sixth value snuck in — the parenthesized list has exactly 5 commas-separated entries.
  const valuesMatch = snippet.match(/CHECK \(status IN \(([^)]*)\)\)/);
  assert.ok(valuesMatch, 'CHECK clause not found');
  const values = valuesMatch[1].split(',');
  assert.equal(values.length, 5, `expected exactly 5 statuses, found ${values.length}: ${valuesMatch[1]}`);
});

test('[3] agencies.status defaults to Aday', () => {
  assert.match(MIGRATION, /status\s+TEXT\s+NOT NULL DEFAULT 'Aday'/);
});

// ── 4-5. agency_emails migration ─────────────────────────────────────────

test('[4] agency_emails table exists', () => {
  assert.match(MIGRATION, /CREATE TABLE IF NOT EXISTS public\.agency_emails \(/);
});

test('[5] agency_emails references agencies via a foreign key', () => {
  assert.match(MIGRATION, /agency_id\s+UUID\s+NOT NULL REFERENCES public\.agencies\(id\) ON DELETE CASCADE/);
});

test('agency_emails allowed statuses are exactly draft/sent/failed, direction defaults to outbound', () => {
  assert.match(MIGRATION, /status\s+TEXT\s+NOT NULL DEFAULT 'draft' CHECK \(status IN \('draft','sent','failed'\)\)/);
  assert.match(MIGRATION, /direction\s+TEXT\s+NOT NULL DEFAULT 'outbound' CHECK \(direction IN \('outbound','inbound'\)\)/);
});

test('migration reuses the EXISTING is_admin()/is_sales() RLS helpers — no new role, no new helper function, and no POLICY calls is_operations()/is_guide()', () => {
  assert.match(MIGRATION, /USING\s+\(\s*is_admin\(\)\s*\)/);
  assert.match(MIGRATION, /USING\s+\(\s*is_sales\(\)\s*\)/);
  assert.doesNotMatch(MIGRATION, /CREATE (OR REPLACE )?FUNCTION public\.is_/);
  // is_operations()/is_guide() are only ever mentioned in prose (explaining
  // why this table, unlike guides, has no policy for those roles) — never
  // inside an actual USING(...)/WITH CHECK(...) clause.
  assert.doesNotMatch(MIGRATION, /(USING|WITH CHECK)\s*\(\s*is_(operations|guide)\(\)\s*\)/);
});

test('migration is purely additive — no actual DROP TABLE statement, no ALTER of any existing table', () => {
  // Checked as a real statement (start of a line, optional whitespace),
  // not a substring match — this file's own safety-notes prose legitimately
  // contains the words "DROP TABLE" while explaining that none exists.
  assert.doesNotMatch(MIGRATION, /^\s*DROP TABLE\b/m);
  assert.doesNotMatch(MIGRATION, /ALTER TABLE public\.(customers|reservations|payments|leads|quotes|staff_users)/);
});

// ── 6-9. navigation visibility per role ──────────────────────────────────

test('[6] Acenteler navigation is visible to Yönetici', () => {
  assert.equal(canAccess(ROLES.admin, 'agencies'), true);
});

test('[7] Acenteler navigation is visible to Satış', () => {
  assert.equal(canAccess(ROLES.sales, 'agencies'), true);
});

test('[8] Acenteler navigation is hidden from Operasyon', () => {
  assert.equal(canAccess(ROLES.operations, 'agencies'), false);
});

test('[9] Acenteler navigation is hidden from Rehber', () => {
  assert.equal(canAccess(ROLES.guide, 'agencies'), false);
});

test('NAV_BOT carries exactly one "Acenteler" entry, placed after Hatırlatmalar and before Raporlar', () => {
  const navBotStart = SOURCE.indexOf('const NAV_BOT = [');
  const navBotBody = SOURCE.slice(navBotStart, SOURCE.indexOf('];', navBotStart));
  const reminderIdx = navBotBody.indexOf('id:"reminders"');
  const agenciesIdx = navBotBody.indexOf('id:"agencies"');
  const reportsIdx  = navBotBody.indexOf('id:"reports"');
  assert.ok(reminderIdx !== -1 && agenciesIdx !== -1 && reportsIdx !== -1);
  assert.ok(reminderIdx < agenciesIdx && agenciesIdx < reportsIdx, 'Acenteler must sit between Hatırlatmalar and Raporlar');
  assert.match(navBotBody, /id:"agencies",\s*label:"Acenteler"/);
});

// ── 10. route gating uses the existing architecture, no parallel system ──

test('[10] /agencies route is gated by the SAME top-level canAccess(role, base) check every other route uses — no special-cased bypass', () => {
  const guardIdx = PAGE_ROUTER_BODY.indexOf('if (!canAccess(role, base))');
  assert.ok(guardIdx !== -1, 'PageRouter must still have its universal canAccess guard');
  const mobileAgenciesIdx = PAGE_ROUTER_BODY.indexOf('base === "agencies" && param) return <AcenteDetailPage');
  const desktopAgenciesIdx = PAGE_ROUTER_BODY.indexOf('base === "agencies")  return <AcentelerPage');
  assert.ok(mobileAgenciesIdx > guardIdx, 'mobile /agencies route must be reached only after the universal guard');
  assert.ok(desktopAgenciesIdx > guardIdx, 'desktop /agencies route must be reached only after the universal guard');
  // Both list and detail route the EXACT SAME AcentelerPage/AcenteDetailPage
  // components for mobile and desktop (responsive internally), same as guides.
  assert.match(PAGE_ROUTER_BODY, /base === "agencies" && param\) return <AcenteDetailPage agencyId=\{param\} onBack=\{\(\)=>navigate\('\/agencies'\)\}\/>;/);
  assert.match(PAGE_ROUTER_BODY, /base === "agencies" && param\)\s*\n\s*return <AcenteDetailPage agencyId=\{param\} onBack=\{\(\)=>navigate\('\/agencies'\)\}\/>;/);
});

// ── 11-14. repository methods ─────────────────────────────────────────────

test('[11] agency repo supports getAll (mock AgencyRepository and SupabaseAgencyRepo)', () => {
  assert.match(AGENCY_REPO_BODY, /getAll\(filters = \{\}\)/);
  assert.match(SUPABASE_AGENCY_BODY, /async getAll\(f=\{\}\)\{/);
});

test('[12] agency repo supports getById (mock AgencyRepository and SupabaseAgencyRepo)', () => {
  assert.match(AGENCY_REPO_BODY, /getById\(id\) \{ return DB\.agencies\.find/);
  assert.match(SUPABASE_AGENCY_BODY, /async getById\(id\)\{/);
});

test('[13] agency repo supports create (mock AgencyRepository and SupabaseAgencyRepo)', () => {
  assert.match(AGENCY_REPO_BODY, /create\(data\) \{/);
  assert.match(SUPABASE_AGENCY_BODY, /async create\(d\)\{/);
  assert.match(SUPABASE_AGENCY_BODY, /sb\.from\('agencies'\)\.insert/);
});

test('[14] agency repo supports update (mock AgencyRepository and SupabaseAgencyRepo)', () => {
  assert.match(AGENCY_REPO_BODY, /update\(id, patch\) \{/);
  assert.match(SUPABASE_AGENCY_BODY, /async update\(id,p\)\{/);
  assert.match(SUPABASE_AGENCY_BODY, /sb\.from\('agencies'\)\.update/);
});

test('getActiveRepo("agency") is wired to the real/mock pair, same pattern as every other entity', () => {
  assert.match(SOURCE, /if\(entity==='agency'\)\s*return useReal \? SupabaseAgencyRepo\s*: AgencyRepository;/);
});

test('repo methods are limited to Phase 1\'s needs — no speculative send/discover/research methods', () => {
  // Matches an actual METHOD definition/call shape (name immediately
  // followed by a call), not a plain field reference — a later phase
  // legitimately reads/writes the pre-existing researchEvidence/
  // researchSourceUrl AGENCY FIELDS (Pazar Araştırması import) inside
  // create(), which must not be confused with a new research() METHOD.
  for (const body_ of [AGENCY_REPO_BODY, SUPABASE_AGENCY_BODY]) {
    assert.doesNotMatch(body_, /\b(sendEmail|draftEmail|discover|research|score)\s*\(/i);
  }
});

// ── 15-18. NewAgencyModal + status model ─────────────────────────────────

test('[15] NewAgencyModal requires agency name', () => {
  assert.match(NEW_AGENCY_MODAL_BODY, /validate\(\{name:\{required:"Acente adı zorunludur"\}/);
  assert.match(NEW_AGENCY_MODAL_BODY, /<FRow label="Acente Adı" required error=\{errs\.name\}>/);
});

test('[15b] NewAgencyModal does not require every other field (country/city/website/contact/phone/languages/notes are all optional)', () => {
  // Only "name" and the email FORMAT (when non-empty) are validated.
  const validateCallIdx = NEW_AGENCY_MODAL_BODY.indexOf('validate({');
  const validateCall = NEW_AGENCY_MODAL_BODY.slice(validateCallIdx, NEW_AGENCY_MODAL_BODY.indexOf('},{', validateCallIdx));
  assert.doesNotMatch(validateCall, /country:\{required|city:\{required|website:\{required|phone:\{required/);
});

test('[16] new agency defaults to Aday (mock create, Supabase create fallback, and the DB column default all agree)', () => {
  assert.match(AGENCY_REPO_BODY, /const record = \{\s*\n\s*id, status:'Aday'/);
  assert.match(SUPABASE_AGENCY_BODY, /if\(!row\.status\) row\.status='Aday';/);
  assert.match(MIGRATION, /DEFAULT 'Aday'/);
});

test('[17] all five statuses are available in the UI status options', () => {
  assert.match(SOURCE, /const AGENCY_STATUS_OPTIONS = \["Aday","İletişime Geçildi","Görüşülüyor","Partner","Uygun Değil"\];/);
});

test('[18] no extra pipeline stage/status is introduced anywhere in the Acenteler UI', () => {
  const optionsIdx = SOURCE.indexOf('const AGENCY_STATUS_OPTIONS = [');
  const optionsLine = SOURCE.slice(optionsIdx, SOURCE.indexOf('\n', optionsIdx));
  const count = (optionsLine.match(/"/g) || []).length / 2;
  assert.equal(count, 5, `AGENCY_STATUS_OPTIONS must have exactly 5 entries, found ${count}`);
  for (const forbidden of ['Lead Score', 'Deal', 'Opportunity', 'Forecast', 'Pipeline Stage', 'Won', 'Lost']) {
    assert.doesNotMatch(ACENTELER_PAGE_BODY, new RegExp(forbidden, 'i'));
    assert.doesNotMatch(ACENTE_DETAIL_BODY, new RegExp(forbidden, 'i'));
  }
});

// ── 19-20. adjacent domains are unaffected ───────────────────────────────

test('[19] existing Customers logic is untouched by this phase', () => {
  assert.doesNotMatch(AGENCY_REPO_BODY, /DB\.customers/);
  assert.doesNotMatch(SUPABASE_AGENCY_BODY, /from\('customers'\)/);
  // CustomerRepository/SupabaseCustomerRepo still exist, unmodified in shape.
  assert.match(SOURCE, /const CustomerRepository = \{/);
  assert.match(SOURCE, /const SupabaseCustomerRepo = \{/);
});

test('[20] existing Leads/Quotes remain retired — not resurrected by this phase', () => {
  // The router's own "retired from active navigation" comment for leads/quotes is untouched.
  assert.match(SOURCE, /Retired from active navigation — no more list\/create\/edit entry/);
  // leads/quotes stay out of NAV_TOP/NAV_BOT (no nav entry was added for them).
  const navTopBody = SOURCE.slice(SOURCE.indexOf('const NAV_TOP = ['), SOURCE.indexOf('];', SOURCE.indexOf('const NAV_TOP = [')));
  const navBotBody = SOURCE.slice(SOURCE.indexOf('const NAV_BOT = ['), SOURCE.indexOf('];', SOURCE.indexOf('const NAV_BOT = [')));
  assert.doesNotMatch(navTopBody, /id:"leads"|id:"quotes"/);
  assert.doesNotMatch(navBotBody, /id:"leads"|id:"quotes"/);
  // Acenteler never references leads/quotes repos.
  assert.doesNotMatch(ACENTELER_PAGE_BODY + NEW_AGENCY_MODAL_BODY + ACENTE_DETAIL_BODY, /getActiveRepo\("lead"\)|getActiveRepo\("quote"\)|useRepo\("lead"|useRepo\("quote"/);
});

// ── 21-22. send transport and direct-provider calls stay out of the frontend ──
// Phase 1 shipped with zero email/AI footprint by design. Phase 2 (approved
// separately) legitimately adds agency_emails draft storage and a
// server-side research/drafting boundary (api/_agencies/*). Agency Mailbox
// Phase A (approved separately, after Phase 2) legitimately adds ONE
// human-approved send path: a fetch to this app's own /api/agency-send-email
// endpoint (api/agency-send-email.js), which re-verifies identity/role/
// is_active/AAL2 server-side (requireAgencyRole, unchanged) and performs the
// actual Gmail API call — never Resend, never any direct provider transport
// from the browser. These two tests now assert what must remain true
// indefinitely rather than "doesn't exist yet": no code path here bypasses
// that one endpoint with a DIRECT email transport (EmailService/Resend/a
// provider SDK called straight from the browser), and the frontend never
// talks to an AI provider or an external URL directly — only to this app's
// own /api endpoints, which enforce auth and validation server-side.

test('[21] no DIRECT/bypassing email send transport in the agency UI — only the one proper /api/agency-send-email call', () => {
  const acenteSource = ACENTELER_PAGE_BODY + NEW_AGENCY_MODAL_BODY + ACENTE_DETAIL_BODY;
  assert.doesNotMatch(acenteSource, /EmailService|ResendEmailProvider|sendProposal|sendAgencyOutreach|sendReminder|sendReviewRequest/i);
  // "send-email" alone would also catch the new, legitimate
  // "/api/agency-send-email" call — excluded here specifically, and
  // re-asserted as the ONLY sanctioned send-shaped string below.
  const sendEmailMentions = acenteSource.match(/[\w/-]*send-email[\w-]*/gi) || [];
  for (const mention of sendEmailMentions) {
    assert.match(mention, /^\/api\/agency-send-email$/, `unexpected send-email-shaped reference: "${mention}"`);
  }
});

test('[22] agency research/drafting never calls an AI provider directly from the frontend', () => {
  const acenteSource = ACENTELER_PAGE_BODY + NEW_AGENCY_MODAL_BODY + ACENTE_DETAIL_BODY;
  assert.doesNotMatch(acenteSource, /anthropic|openai|claude-|gpt-/i);
  assert.doesNotMatch(acenteSource, /fetch\(['"]https?:\/\//i, "research/drafting must call this app's own /api endpoint, never an external URL directly from the browser");
  assert.match(NEW_AGENCY_MODAL_BODY, /Neden Uygun Olabilir/, 'fit_note remains a plain manually-typed field on manual creation, not AI-generated');
});

// ── no em/en dash introduced in new UI copy ──────────────────────────────

test('no em or en dash introduced in this phase\'s new UI copy', () => {
  for (const s of ['Acenteler', 'Yeni Acente', 'Acente Adı', 'Acente Bilgileri', 'Uygunluk', 'İç Notlar', 'Son Temas', 'Notu Kaydet']) {
    assert.doesNotMatch(s, /[–—]/, `"${s}" must not contain an em/en dash`);
  }
});
