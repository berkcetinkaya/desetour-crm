'use strict';
/**
 * tests/dashboard/agencyDbUniquenessRaceHandling.test.js
 * ─────────────────────────────────────────────────────────────────────────
 * Agency CRM research workflow — Round 6, PARTS 3/4/7.
 *
 * Now that idx_agencies_canonical_domain_unique (see
 * supabase_migration_agencies_canonical_domain_uniqueness.sql) is the
 * final, race-safe authority on canonical website-domain uniqueness,
 * SupabaseAgencyRepo.create()/update() must handle a PostgreSQL 23505
 * (unique_violation) response from that index gracefully:
 *   - create(): a race lost to the index becomes the SAME
 *     _duplicateOfExisting:true shape the pre-check already returns — no
 *     raw DB error, no activity log, no new-Agency metric.
 *   - update(): a manual website edit that collides with another
 *     Agency's canonical domain throws a clear Turkish Error (naming the
 *     other Agency when it can be resolved), never partially saves the
 *     rest of the patch (a single atomic .update() call either fully
 *     succeeds or fully fails).
 *
 * DeseTourDashboard.jsx is a module-less browser script — getSB() depends
 * on runtime Supabase config this Node test environment does not have, so
 * (matching every other SupabaseAgencyRepo test in this repo, e.g.
 * agenciesPhase1.test.js's SUPABASE_AGENCY_BODY assertions) this suite
 * verifies the REAL source text/control flow statically rather than
 * executing the method against a live or mocked client.
 * ─────────────────────────────────────────────────────────────────────────
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.join(__dirname, '..', '..');
const SOURCE = fs.readFileSync(path.join(REPO_ROOT, 'DeseTourDashboard.jsx'), 'utf8');

function objectBody(startMarker, endMarker) {
  const start = SOURCE.indexOf(startMarker);
  assert.ok(start !== -1, `could not find "${startMarker}"`);
  return SOURCE.slice(start, SOURCE.indexOf(endMarker, start));
}

const SUPABASE_AGENCY_BODY = objectBody('const SupabaseAgencyRepo = {', '\nconst SupabaseGuidePaymentRepo');

function methodBody(name) {
  const idx = SUPABASE_AGENCY_BODY.indexOf(`async ${name}(`);
  assert.ok(idx !== -1, `could not find SupabaseAgencyRepo.${name}`);
  // Each method body ends at the next top-level "async " method or the
  // object's own closing brace, whichever comes first.
  const nextAsync = SUPABASE_AGENCY_BODY.indexOf('\n  async ', idx + 1);
  const end = nextAsync === -1 ? SUPABASE_AGENCY_BODY.length : nextAsync;
  return SUPABASE_AGENCY_BODY.slice(idx, end);
}

const CREATE_BODY = methodBody('create');
const UPDATE_BODY = methodBody('update');

// ── PART 3 — create(): 23505 race handling ───────────────────────────────

test('create() checks error.code===\'23505\' on the insert itself (distinct from the pre-check)', () => {
  assert.match(CREATE_BODY, /if\(error\.code==='23505'\)/);
});

test('create() on 23505 re-resolves the existing Agency via _findExistingAgencyMatch, the SAME matcher the pre-check uses', () => {
  const raceIdx = CREATE_BODY.indexOf("if(error.code==='23505')");
  const raceBlockEnd = CREATE_BODY.indexOf('throw new Error', raceIdx);
  const raceBlock = CREATE_BODY.slice(raceIdx, raceBlockEnd);
  assert.match(raceBlock, /_findExistingAgencyMatch\(d,\s*raceRows\|\|\[\]\)/);
  assert.match(raceBlock, /_duplicateOfExisting:true/);
});

test('create() on 23505 never throws the raw Postgres error message to the UI — only a clean Turkish fallback Error', () => {
  const raceIdx = CREATE_BODY.indexOf("if(error.code==='23505')");
  const raceBlockEnd = CREATE_BODY.indexOf('\n      throw new Error(error.message);', raceIdx);
  const raceBlock = CREATE_BODY.slice(raceIdx, raceBlockEnd === -1 ? CREATE_BODY.length : raceBlockEnd);
  assert.match(raceBlock, /throw new Error\("Bu website zaten CRM'de başka bir acentaya ait\."\)/);
  assert.doesNotMatch(raceBlock, /error\.message/);
});

test('create() on 23505 never calls _sbLog — no activity log for a race-lost duplicate', () => {
  const raceIdx = CREATE_BODY.indexOf("if(error.code==='23505')");
  const raceBlockEnd = CREATE_BODY.indexOf('\n      throw new Error(error.message);', raceIdx);
  const raceBlock = CREATE_BODY.slice(raceIdx, raceBlockEnd === -1 ? CREATE_BODY.length : raceBlockEnd);
  assert.doesNotMatch(raceBlock, /_sbLog/);
});

test('create() on 23505 returns BEFORE reaching the real insert\'s _sbLog(\'agency\',...,\'created\',...) call — a race loss can never increment "new Agency" activity/metrics', () => {
  const sbLogIdx = CREATE_BODY.indexOf("_sbLog('agency'");
  const raceReturnIdx = CREATE_BODY.indexOf('_duplicateOfExisting:true', CREATE_BODY.indexOf("if(error.code==='23505')"));
  assert.ok(sbLogIdx > -1 && raceReturnIdx > -1);
  assert.ok(raceReturnIdx < sbLogIdx, 'the race-duplicate return must happen before the only _sbLog(\'agency\',...,\'created\',...) call in create()');
});

test('create() 23505 handling sits strictly between the application-level pre-check and the activity log — the pre-check is NOT replaced, only backed up', () => {
  const precheckIdx = CREATE_BODY.indexOf('_findExistingAgencyMatch(d, existingRows');
  const raceIdx = CREATE_BODY.indexOf("if(error.code==='23505')");
  const sbLogIdx = CREATE_BODY.indexOf("_sbLog('agency'");
  assert.ok(precheckIdx > -1 && raceIdx > -1 && sbLogIdx > -1);
  assert.ok(precheckIdx < raceIdx && raceIdx < sbLogIdx);
});

// ── PART 4 — update(): website-edit collision handling ──────────────────

test('update() checks error.code===\'23505\' on the update itself', () => {
  assert.match(UPDATE_BODY, /if\(error\.code==='23505'\)/);
});

test('update() on 23505 throws a clear Turkish Error, never the raw Postgres message', () => {
  const raceIdx = UPDATE_BODY.indexOf("if(error.code==='23505')");
  const raceBlockEnd = UPDATE_BODY.indexOf('\n      throw new Error(error.message);', raceIdx);
  const raceBlock = UPDATE_BODY.slice(raceIdx, raceBlockEnd === -1 ? UPDATE_BODY.length : raceBlockEnd);
  assert.match(raceBlock, /Bu website zaten CRM'de başka bir acentaya ait\./);
  assert.doesNotMatch(raceBlock, /throw new Error\(error\.message\)/);
});

test('update() on 23505 tries to resolve and name the OTHER Agency for a precise message: "Bu website zaten CRM\'de kayıtlı: {isim}"', () => {
  const raceIdx = UPDATE_BODY.indexOf("if(error.code==='23505')");
  const raceBlockEnd = UPDATE_BODY.indexOf('\n      throw new Error(error.message);', raceIdx);
  const raceBlock = UPDATE_BODY.slice(raceIdx, raceBlockEnd === -1 ? UPDATE_BODY.length : raceBlockEnd);
  assert.match(raceBlock, /Bu website zaten CRM'de kayıtlı: \$\{existingName\}/);
  assert.match(raceBlock, /_findExistingAgencyMatch\(\{website:p\.website\}, others\|\|\[\]\)/);
});

test('update() on 23505 queries OTHER agencies (.neq(\'id\',id)) — never re-matches against the row being edited itself', () => {
  const raceIdx = UPDATE_BODY.indexOf("if(error.code==='23505')");
  const raceBlockEnd = UPDATE_BODY.indexOf('\n      throw new Error(error.message);', raceIdx);
  const raceBlock = UPDATE_BODY.slice(raceIdx, raceBlockEnd === -1 ? UPDATE_BODY.length : raceBlockEnd);
  assert.match(raceBlock, /\.neq\('id',id\)/);
});

test('update() on 23505 never calls _sbLog and never reaches the normal update()\'s own log call for that failed attempt', () => {
  const raceIdx = UPDATE_BODY.indexOf("if(error.code==='23505')");
  const raceBlockEnd = UPDATE_BODY.indexOf('\n      throw new Error(error.message);', raceIdx);
  const raceBlock = UPDATE_BODY.slice(raceIdx, raceBlockEnd === -1 ? UPDATE_BODY.length : raceBlockEnd);
  assert.doesNotMatch(raceBlock, /_sbLog/);
  const sbLogIdx = UPDATE_BODY.indexOf('_sbLog(action');
  const throwIdx = UPDATE_BODY.indexOf('throw new Error', raceIdx);
  assert.ok(sbLogIdx === -1 || throwIdx < sbLogIdx, 'the 23505 throw must happen before update()\'s own activity log call');
});

test('update() is a SINGLE atomic .update(row).eq(\'id\',id) call — a 23505 rejection can never leave a partial write (Postgres rejects the whole statement)', () => {
  assert.match(UPDATE_BODY, /await sb\.from\('agencies'\)\.update\(row\)\.eq\('id',id\)\.select\(\)\.single\(\)/);
  // Exactly one .update( call in this method — no secondary/fallback write path.
  const updateCalls = (UPDATE_BODY.match(/\.from\('agencies'\)\.update\(/g) || []).length;
  assert.equal(updateCalls, 1);
});

// ── PART 4 — AcenteDetailPage.handleSaveContact: preserves form state, no partial save ──

test('handleSaveContact never resets contactEditMode or any draft field when update() throws — the user\'s entered values and edit mode survive a failed save so they can correct the website', () => {
  function body(name, nextMarker) {
    const idx = SOURCE.indexOf(`function ${name}(`);
    assert.ok(idx !== -1, `could not find function ${name}`);
    return SOURCE.slice(idx, SOURCE.indexOf(nextMarker, idx));
  }
  const ACENTE_DETAIL_BODY = body('AcenteDetailPage', '\nfunction GuidesPage');
  const idx = ACENTE_DETAIL_BODY.indexOf('async function handleSaveContact');
  const end = ACENTE_DETAIL_BODY.indexOf('\n  }', idx);
  const handleSaveContactBody = ACENTE_DETAIL_BODY.slice(idx, end);

  const mutateIdx = handleSaveContactBody.indexOf('await mutAgency("update"');
  const errCheckIdx = handleSaveContactBody.indexOf('if (err)', mutateIdx);
  const earlyReturnBlockEnd = handleSaveContactBody.indexOf('\n', errCheckIdx);
  const earlyReturnBlock = handleSaveContactBody.slice(errCheckIdx, earlyReturnBlockEnd);

  assert.ok(mutateIdx > -1 && errCheckIdx > -1);
  assert.match(earlyReturnBlock, /return;/, 'an error must return immediately, before setContactEditMode(false) runs');
  assert.match(earlyReturnBlock, /showToast\(/);

  // setContactEditMode(false) must appear strictly AFTER the error-path
  // return, i.e. only on the success path — never cleared/reset on error.
  const successCloseIdx = handleSaveContactBody.indexOf('setContactEditMode(false)', mutateIdx);
  assert.ok(successCloseIdx > earlyReturnBlockEnd, 'setContactEditMode(false) must only run on the success path, after the error-path return');

  // No draft-state setter is ever called on the error path (between the
  // mutate call and the error-path return) — the typed-in values are
  // never cleared.
  const errorPathSlice = handleSaveContactBody.slice(mutateIdx, errCheckIdx + earlyReturnBlock.length);
  assert.doesNotMatch(errorPathSlice.slice(errorPathSlice.indexOf('return;') + 'return;'.length), /setContactWebsiteDraft|setContactPersonDraft|setContactEmailDraft|setContactPhoneDraft/);
});

test('handleSaveContact surfaces the thrown error text to the user via showToast, prefixed clearly in Turkish', () => {
  function body(name, nextMarker) {
    const idx = SOURCE.indexOf(`function ${name}(`);
    return SOURCE.slice(idx, SOURCE.indexOf(nextMarker, idx));
  }
  const ACENTE_DETAIL_BODY = body('AcenteDetailPage', '\nfunction GuidesPage');
  const idx = ACENTE_DETAIL_BODY.indexOf('async function handleSaveContact');
  const end = ACENTE_DETAIL_BODY.indexOf('\n  }', idx);
  const handleSaveContactBody = ACENTE_DETAIL_BODY.slice(idx, end);
  assert.match(handleSaveContactBody, /showToast\("İletişim bilgileri güncellenemedi: " \+ err\)/);
});

// ── PART 5/6 — confirm nothing about the research pipeline/summary UX was weakened ──

test('REGRESSION: _findExistingAgencyMatch is still the single shared matcher used by the pre-check (create), the 23505 race fallback (create), AND the 23505 collision resolution (update) — one deterministic rule everywhere', () => {
  const usages = (SUPABASE_AGENCY_BODY.match(/_findExistingAgencyMatch\(/g) || []).length;
  assert.equal(usages, 3, `expected exactly 3 uses of _findExistingAgencyMatch in SupabaseAgencyRepo (create pre-check, create race fallback, update collision resolution), found ${usages}`);
});

test('REGRESSION: the DB unique index is additive race-safety only — create() still runs its application-level pre-check BEFORE ever attempting the insert', () => {
  const precheckIdx = CREATE_BODY.indexOf("select('id,name,website,email')");
  const insertIdx = CREATE_BODY.indexOf(".insert(row)");
  assert.ok(precheckIdx > -1 && insertIdx > -1 && precheckIdx < insertIdx);
});
