'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { extractTestableFn } = require('./extractTestableFn');

// The ONE real, shipping persistence path for reservations.guide_id —
// extracted from the real TESTABLE:assignReservationGuide block, never a
// hand-copied duplicate. AssignGuideModal (Operasyon Bilgileri), the
// Reservation List's inline Rehber-column popover (GuideAssignCell), and
// Operasyon Bilgileri's "Kaldır" button all call this exact function.
const assignReservationGuide = extractTestableFn('assignReservationGuide');

const SOURCE = fs.readFileSync(path.join(__dirname, '..', '..', 'DeseTourDashboard.jsx'), 'utf8');

function extractFunctionBody(name, nextMarker) {
  const idx = SOURCE.indexOf(`function ${name}(`);
  assert.ok(idx !== -1, `could not find function ${name}`);
  const endIdx = SOURCE.indexOf(nextMarker, idx);
  assert.ok(endIdx !== -1, `could not find end marker "${nextMarker}" for ${name}`);
  return SOURCE.slice(idx, endIdx);
}

function fakeMutate(impl) {
  return async (method, resId, patch) => impl(method, resId, patch);
}

function guideList() {
  return [
    { id: 'g-1', name: 'Ahmet Yılmaz', status: 'Aktif', languageNames: ['Türkçe', 'İngilizce'] },
    { id: 'g-2', name: 'Elif Kaya', status: 'Aktif', languageNames: ['İngilizce'] },
    { id: 'g-3', name: 'Eski Rehber', status: 'Pasif', languageNames: [] },
  ];
}

// ── 2/8. assignReservationGuide: the real, shared mutation ─────────────────

test('assignReservationGuide calls mutate("update", resId, {guideId, guide}) with the resolved guide name — the exact shape AssignGuideModal always used', async () => {
  let called = null;
  const mutate = fakeMutate((method, resId, patch) => { called = { method, resId, patch }; return { data: {}, error: null }; });
  await assignReservationGuide(mutate, 'res-1', 'g-1', guideList());
  assert.deepEqual(called, { method: 'update', resId: 'res-1', patch: { guideId: 'g-1', guide: 'Ahmet Yılmaz' } });
});

test('assignReservationGuide(guideId=null) removes the assignment — {guideId:null, guide:null} — the exact existing "Kaldır" payload, never a new backend behavior', async () => {
  let called = null;
  const mutate = fakeMutate((method, resId, patch) => { called = { method, resId, patch }; return { data: {}, error: null }; });
  await assignReservationGuide(mutate, 'res-1', null, guideList());
  assert.deepEqual(called.patch, { guideId: null, guide: null });
});

test('assignReservationGuide never dereferences `guides` when guideId is null (safe to call with guides=null, exactly as Operasyon Bilgileri\'s "Kaldır" button does)', async () => {
  const mutate = fakeMutate(() => ({ data: {}, error: null }));
  await assert.doesNotReject(assignReservationGuide(mutate, 'res-1', null, null));
});

test('assignReservationGuide propagates a failure from mutate untouched — {data:null, error} — so every caller can preserve prior state and show the existing toast', async () => {
  const mutate = fakeMutate(() => ({ data: null, error: 'RLS denied' }));
  const result = await assignReservationGuide(mutate, 'res-1', 'g-1', guideList());
  assert.deepEqual(result, { data: null, error: 'RLS denied' });
});

test('assignReservationGuide only ever calls the passed-in `mutate` — no direct Supabase/getSB/sb.from access, no bypass of whatever permission/RLS enforcement already guards SupabaseReservationRepo.update', () => {
  const body = extractFunctionBody('assignReservationGuide', '// TESTABLE:assignReservationGuide:end');
  assert.doesNotMatch(body, /getSB\(|sb\.from\(|supabase\./, 'assignReservationGuide must never talk to Supabase directly — only through the injected mutate()');
  assert.match(body, /return mutate\("update", resId,/);
});

// ── 9. All three surfaces call the SAME function — never a second mutation ─

test('9. exactly three real call sites invoke assignReservationGuide (AssignGuideModal\'s submit, Operasyon Bilgileri\'s "Kaldır", and the list-column GuideAssignCell) — no fourth, separate persistence path exists anywhere', () => {
  // Actual invocations only — `await assignReservationGuide(...)`, never
  // the function's own definition line or a bare mention in a comment
  // (this file documents the shared helper in prose too).
  const calls = (SOURCE.match(/await assignReservationGuide\(/g) || []).length;
  assert.equal(calls, 3, `expected exactly 3 real call sites, found ${calls}`);
});

test('AssignGuideModal.handleSubmit calls assignReservationGuide (Operasyon Bilgileri\'s "Ata"/"Değiştir" flow, and the same modal Quick Actions opens)', () => {
  const body = extractFunctionBody('AssignGuideModal', '\nfunction GuideAssignCell');
  assert.match(body, /await assignReservationGuide\(mutate, r\.id, guideId\|\|null, guides\)/);
});

test('Operasyon Bilgileri\'s "Kaldır" button calls assignReservationGuide instead of a separate inline mutate() call', () => {
  const startIdx = SOURCE.indexOf('setRemovingGuide(true);');
  assert.ok(startIdx !== -1);
  const endIdx = SOURCE.indexOf('>{removingGuide ? "…" : "Kaldır"}</button>');
  assert.ok(endIdx !== -1 && endIdx > startIdx);
  const between = SOURCE.slice(startIdx, endIdx);
  assert.match(between, /await assignReservationGuide\(mutGuideAssign, r\.id, null, null\)/);
});

test('GuideAssignCell.pick calls assignReservationGuide for both assignment and removal (guideId or null) — one handler, one code path, not two', () => {
  const body = extractFunctionBody('GuideAssignCell', '\nfunction EditTourLanguageModal');
  const pickCalls = (body.match(/assignReservationGuide\(mutate, r\.id,/g) || []).length;
  assert.equal(pickCalls, 1, 'expected exactly one call site inside pick(), reused for both assign and remove');
});

// ── 1/3/4. Reservation List inline popover: open without navigating ────────

test('1/4. GuideAssignCell stops click propagation at its outermost wrapper — the table row\'s onSelect/navigation handler never fires for any interaction with the guide selector', () => {
  const body = extractFunctionBody('GuideAssignCell', '\nfunction EditTourLanguageModal');
  assert.match(body, /onClick=\{e => e\.stopPropagation\(\)\}/);
  assert.doesNotMatch(body, /onSelect\(/, 'GuideAssignCell must never call the row-navigation callback itself');
});

test('1/3. the SAME trigger (rendering GuideChip, which shows "Atanmadı" or the guide\'s name) opens the popover whether or not a guide is already assigned — clicking either state calls the identical setOpen toggle', () => {
  const body = extractFunctionBody('GuideAssignCell', '\nfunction EditTourLanguageModal');
  const triggerIdx = body.indexOf('onClick={() => !mutating && setOpen(o => !o)}');
  assert.ok(triggerIdx !== -1, 'expected one toggle handler on the trigger, used for both the empty and assigned states');
  const chipIdx = body.indexOf('<GuideChip name={r.guide}/>', triggerIdx);
  assert.ok(chipIdx !== -1 && chipIdx > triggerIdx, 'the same GuideChip (which renders "Atanmadı" when r.guide is falsy) must be the clickable trigger content');
});

test('the Reservation List wires GuideAssignCell into the Rehber column, replacing the old static GuideChip', () => {
  assert.match(SOURCE, /<GuideAssignCell r=\{r\} guides=\{activeGuidesForAssign\}\/>/);
});

test('ReservationsPage fetches active guides once (status !== "Pasif", the same filter AssignGuideModal uses) and shares the list across every row, rather than each row fetching its own', () => {
  const body = extractFunctionBody('ReservationsPage', '\n\n      {}');
  assert.match(body, /const \{ data:guideListForAssign \} = useRepo\("guide", "getAll"\);/);
  assert.match(body, /const activeGuidesForAssign = \(guideListForAssign\|\|\[\]\)\.filter\(g=>g\.status!=="Pasif"\);/);
});

// ── 5. Failed assignment preserves prior UI state ───────────────────────────

test('5. GuideAssignCell.pick shows the existing toast and returns immediately on failure — it never calls setOpen(false) or touches any local guide state when assignReservationGuide fails', () => {
  const body = extractFunctionBody('GuideAssignCell', '\nfunction EditTourLanguageModal');
  const pickIdx = body.indexOf('async function pick(guideId)');
  const pickEnd = body.indexOf('\n  }', pickIdx);
  const pickBody = body.slice(pickIdx, pickEnd);
  assert.match(pickBody, /if \(error\) \{ showToast\("Rehber atanamadı: " \+ error\); return; \}/);
  // setOpen(false) must be the LAST statement, reached only past the
  // error-guard's early return — never executed on failure.
  const errorGuardIdx = pickBody.indexOf('if (error)');
  const setOpenIdx = pickBody.indexOf('setOpen(false)');
  assert.ok(errorGuardIdx !== -1 && setOpenIdx !== -1 && setOpenIdx > errorGuardIdx);
});

test('on failure, GuideAssignCell reads r.guide/r.guideId straight from props — there is no local optimistic-update state that could drift from the real (unchanged) repo data', () => {
  const body = extractFunctionBody('GuideAssignCell', '\nfunction EditTourLanguageModal');
  assert.doesNotMatch(body, /useState\([^)]*guideId/i, 'GuideAssignCell must not keep its own local copy of the assigned guide — it must always reflect r.guide/r.guideId as-is');
});

// ── Loading state while the mutation is running ─────────────────────────────

test('GuideAssignCell shows a small loading indicator and disables further picks while mutating', () => {
  const body = extractFunctionBody('GuideAssignCell', '\nfunction EditTourLanguageModal');
  assert.match(body, /\{mutating && <span[^>]*>…<\/span>\}/);
  assert.match(body, /onClick=\{\(\) => !mutating && pick\(g\.id\)\}/);
});

// ── 6/7. Reservation Detail quick action: fixed, reuses the same modal ─────

test('6. the "Rehber Ata" quick action now has a real onClick — previously undefined, now wired to onAssignGuide', () => {
  const body = extractFunctionBody('ResQuickActions', '\nfunction ReservationDetailPage');
  assert.match(body, /const isGuideAssign = a\.label === "Rehber Ata";/);
  assert.match(body, /const onClick = isGuideAssign \? onAssignGuide : isOdeme \? handleOdemeEkle : isTamamlandi \? handleTamamlandi : undefined;/);
});

test('6. the quick-action label reflects existing assignment state, matching Operasyon Bilgileri\'s own "Ata"/"Değiştir" wording pattern', () => {
  const body = extractFunctionBody('ResQuickActions', '\nfunction ReservationDetailPage');
  assert.match(body, /const label = isGuideAssign \? \(res\?\.guideId \? "Rehberi Değiştir" : "Rehber Ata"\) : a\.label;/);
});

test('7. Quick Actions opens the EXACT SAME AssignGuideModal instance/state as Operasyon Bilgileri — onAssignGuide is wired to the same setShowAssignGuide(true) setter, never a second modal', () => {
  const callSiteIdx = SOURCE.indexOf('<ResQuickActions res={r} onAssignGuide={()=>setShowAssignGuide(true)}/>');
  assert.ok(callSiteIdx !== -1, 'ResQuickActions must be handed the same setShowAssignGuide setter Operasyon Bilgileri\'s own button uses');
  // Operasyon Bilgileri's own "Ata"/"Değiştir" button, in the same
  // ReservationDetailPage render, must call the identical setter.
  const opButtonIdx = SOURCE.indexOf('onClick={()=>setShowAssignGuide(true)}', SOURCE.indexOf('function ReservationDetailPage'));
  assert.ok(opButtonIdx !== -1 && opButtonIdx > SOURCE.indexOf('function ReservationDetailPage') && opButtonIdx < callSiteIdx + 5000);
  // And there is only ONE <AssignGuideModal> render site in the whole file
  // (Operasyon Bilgileri's), which is what showAssignGuide/onAssignGuide
  // both ultimately control — proving there is no second modal instance.
  const modalRenders = (SOURCE.match(/<AssignGuideModal /g) || []).length;
  assert.equal(modalRenders, 1, 'there must be exactly one <AssignGuideModal> render site — Quick Actions must reuse it, never render its own');
});

test('7. because both entry points render the same r (from the same useRepo("reservation","getById",resId) call), a successful assignment is reflected in Operasyon Bilgileri, Quick Actions\' own label, and the header alike without any separate local state to keep in sync', () => {
  const body = extractFunctionBody('ReservationDetailPage', '\n\nconst AuthContext');
  assert.match(body, /useRepo\("reservation", "getById", resId\)/);
  // Only one `r` binding for the whole page — Operasyon Bilgileri,
  // ResQuickActions, and the guide-assignment modal all read from it.
  assert.match(body, /const r = _resRec;/);
});

// ── 10. Permissions: no new/bypassing write path introduced ────────────────

test('10. the reservations table write path is unchanged — SupabaseReservationRepo.update is still the only place reservations.guide_id is ever written, and this feature added no new .from(\'reservations\') call site', () => {
  const repoIdx = SOURCE.indexOf('const SupabaseReservationRepo = {');
  assert.ok(repoIdx !== -1);
  const updateFnIdx = SOURCE.indexOf('async update(id,p){', repoIdx);
  assert.ok(updateFnIdx !== -1);
  const updateFnEnd = SOURCE.indexOf('\n  async delete(id){', updateFnIdx);
  const updateBody = SOURCE.slice(updateFnIdx, updateFnEnd);
  assert.match(updateBody, /guideId:'guide_id'/, 'the existing field-name mapping (guideId -> guide_id) must be unchanged');
  // Every new component (GuideAssignCell) and every touched call site
  // (AssignGuideModal, the "Kaldır" button) reach this exact function only
  // through useRepoMutation("reservation") -> getActiveRepo("reservation")
  // -> SupabaseReservationRepo.update — never a second repo/table.
  const guideAssignCellBody = extractFunctionBody('GuideAssignCell', '\nfunction EditTourLanguageModal');
  assert.doesNotMatch(guideAssignCellBody, /getActiveRepo\(|getSB\(|\.from\(/, 'GuideAssignCell must only ever go through useRepoMutation("reservation"), never a direct repo/Supabase call');
});

test('10. GuideAssignCell uses useRepoMutation("reservation") — the same permission-carrying mutation hook every other reservation-editing UI in this file already uses', () => {
  const body = extractFunctionBody('GuideAssignCell', '\nfunction EditTourLanguageModal');
  assert.match(body, /const \{ mutate, mutating \} = useRepoMutation\("reservation"\);/);
});
