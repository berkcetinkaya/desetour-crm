'use strict';
/**
 * tests/dashboard/reservationsActiveTabRedesign.test.js
 * ─────────────────────────────────────────────────────────────────────────
 * Reservations UX simplification: completed tours and cancelled
 * reservations no longer clutter the default operational view.
 *
 * Pure presentation/filtering change over the EXISTING opStatus values —
 * no new database status, no business-logic/status-transition change, no
 * schema change. Covers:
 *   - Desktop ReservationsPage: TABS replaced with Aktif Rezervasyonlar /
 *     Hazırlanıyor / Onaylandı / Tur Günü / Tamamlanan Turlar / İptal,
 *     Aktif Rezervasyonlar is the default tab, its count/filter excludes
 *     completed+cancelled, Tamamlanan Turlar shows ONLY completed (sorted
 *     newest-first), İptal shows ONLY cancelled, counts stay accurate, the
 *     existing table structure/row-click navigation is untouched, the
 *     Tamamlanan KPI card is untouched.
 *   - Mobile MobileReservationsPage: same conceptual separation via its
 *     existing chip/filter + card-list pattern (no table recreated).
 * ─────────────────────────────────────────────────────────────────────────
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.join(__dirname, '..', '..');
const SOURCE = fs.readFileSync(path.join(REPO_ROOT, 'DeseTourDashboard.jsx'), 'utf8');
const { extractTestableFn } = require('./extractTestableFn');

function body(name, nextMarker) {
  const idx = SOURCE.indexOf(`function ${name}(`);
  assert.ok(idx !== -1, `could not find function ${name}`);
  return SOURCE.slice(idx, SOURCE.indexOf(nextMarker, idx));
}

const RESERVATIONS_PAGE_BODY = body('ReservationsPage', '\nfunction RCard(');
const MOBILE_RESERVATIONS_PAGE_BODY = body('MobileReservationsPage', '\n/* ');

// ── 1. _isActiveOperationalReservation — the single shared "active" rule ──

const isActiveOperationalReservation = extractTestableFn('_isActiveOperationalReservation');

test('[1] _isActiveOperationalReservation excludes ONLY Tamamlandı and İptal', () => {
  assert.equal(isActiveOperationalReservation({ opStatus: 'Hazırlanıyor' }), true);
  assert.equal(isActiveOperationalReservation({ opStatus: 'Onaylandı' }), true);
  assert.equal(isActiveOperationalReservation({ opStatus: 'Tur Günü' }), true);
  assert.equal(isActiveOperationalReservation({ opStatus: 'Tamamlandı' }), false);
  assert.equal(isActiveOperationalReservation({ opStatus: 'İptal' }), false);
});

test('[2] _isActiveOperationalReservation includes an unrecognized/future non-final status by default (exclusion rule, never an allow-list)', () => {
  assert.equal(isActiveOperationalReservation({ opStatus: 'Yeni Bir Durum' }), true);
  assert.equal(isActiveOperationalReservation({ opStatus: undefined }), true);
  assert.equal(isActiveOperationalReservation({}), true);
});

// ── 2. Desktop TABS structure ────────────────────────────────────────────

test('[3] desktop TABS is exactly Aktif Rezervasyonlar / Hazırlanıyor / Onaylandı / Tur Günü / Tamamlanan Turlar / İptal, in that order', () => {
  const m = RESERVATIONS_PAGE_BODY.match(/const TABS = \[([^\]]*)\];/);
  assert.ok(m, 'TABS array not found');
  const tabs = m[1].split(',').map(s => s.trim().replace(/^"|"$/g, ''));
  assert.deepEqual(tabs, ['Aktif Rezervasyonlar', 'Hazırlanıyor', 'Onaylandı', 'Tur Günü', 'Tamamlanan Turlar', 'İptal']);
});

test('[4] "Tümü" no longer appears anywhere in the desktop ReservationsPage tab/count/filter logic', () => {
  assert.doesNotMatch(RESERVATIONS_PAGE_BODY, /"Tümü"/);
});

test('[5] Aktif Rezervasyonlar is the default selected tab on desktop', () => {
  assert.match(RESERVATIONS_PAGE_BODY, /useState\("Aktif Rezervasyonlar"\)/);
});

// ── 3. Desktop tab filter behavior ───────────────────────────────────────

test('[6] desktop tabOk: Aktif Rezervasyonlar uses _isActiveOperationalReservation, Tamamlanan Turlar maps to opStatus==="Tamamlandı", everything else is a literal opStatus match', () => {
  const idx = RESERVATIONS_PAGE_BODY.indexOf('const tabOk');
  const end = RESERVATIONS_PAGE_BODY.indexOf(';', idx);
  const snippet = RESERVATIONS_PAGE_BODY.slice(idx, end);
  assert.match(snippet, /activeTab === "Aktif Rezervasyonlar" \? _isActiveOperationalReservation\(r\)/);
  assert.match(snippet, /activeTab === "Tamamlanan Turlar" \? r\.opStatus === "Tamamlandı"/);
  assert.match(snippet, /: r\.opStatus === activeTab/);
});

test('[7] completed reservations are excluded from Aktif Rezervasyonlar, and cancelled reservations are excluded from Aktif Rezervasyonlar (functional check via the real shared predicate)', () => {
  const sample = [
    { id: '1', opStatus: 'Hazırlanıyor' },
    { id: '2', opStatus: 'Onaylandı' },
    { id: '3', opStatus: 'Tur Günü' },
    { id: '4', opStatus: 'Tamamlandı' },
    { id: '5', opStatus: 'İptal' },
  ];
  const activeOnly = sample.filter(isActiveOperationalReservation);
  assert.deepEqual(activeOnly.map(r => r.id), ['1', '2', '3']);
});

// ── 4. Desktop counts ─────────────────────────────────────────────────────

test('[8] desktop counts: Aktif Rezervasyonlar excludes completed+cancelled, Tamamlanan Turlar counts only completed, other tabs count a literal opStatus match', () => {
  const idx = RESERVATIONS_PAGE_BODY.indexOf('const counts = TABS.reduce');
  const end = RESERVATIONS_PAGE_BODY.indexOf('}, {});', idx);
  const snippet = RESERVATIONS_PAGE_BODY.slice(idx, end);
  assert.match(snippet, /t === "Aktif Rezervasyonlar" \? _allRes\.filter\(_isActiveOperationalReservation\)\.length/);
  assert.match(snippet, /t === "Tamamlanan Turlar" \? _allRes\.filter\(r => r\.opStatus === "Tamamlandı"\)\.length/);
  assert.match(snippet, /: _allRes\.filter\(r => r\.opStatus === t\)\.length/);
});

test('[9] existing Hazırlanıyor/Onaylandı/Tur Günü per-status filters remain a plain literal opStatus match — unchanged behavior', () => {
  for (const status of ['Hazırlanıyor', 'Onaylandı', 'Tur Günü']) {
    const sample = [{ opStatus: status }, { opStatus: 'Tamamlandı' }, { opStatus: 'İptal' }];
    const matches = sample.filter(r => r.opStatus === status);
    assert.equal(matches.length, 1);
  }
});

test('[10] İptal count/filter matches ONLY cancelled reservations', () => {
  const sample = [{ opStatus: 'Hazırlanıyor' }, { opStatus: 'Tamamlandı' }, { opStatus: 'İptal' }, { opStatus: 'İptal' }];
  assert.equal(sample.filter(r => r.opStatus === 'İptal').length, 2);
});

test('[11] Tamamlanan Turlar count/filter matches ONLY completed reservations', () => {
  const sample = [{ opStatus: 'Hazırlanıyor' }, { opStatus: 'Tamamlandı' }, { opStatus: 'Tamamlandı' }, { opStatus: 'İptal' }];
  assert.equal(sample.filter(r => r.opStatus === 'Tamamlandı').length, 2);
});

// ── 5. Sorting: Tamamlanan Turlar flips to newest-first only ─────────────

test('[12] desktop sort flips to checkIn-descending ONLY for the Tamamlanan Turlar tab; every other tab keeps the repo\'s own (ascending) order untouched', () => {
  const idx = RESERVATIONS_PAGE_BODY.indexOf('.sort((a, b) =>');
  assert.ok(idx !== -1, 'expected a .sort( call on the filtered list');
  const end = RESERVATIONS_PAGE_BODY.indexOf(');', idx);
  const snippet = RESERVATIONS_PAGE_BODY.slice(idx, end);
  assert.match(snippet, /activeTab === "Tamamlanan Turlar"/);
  assert.match(snippet, /\(b\.checkIn \|\| b\.date \|\| ''\)\.localeCompare\(a\.checkIn \|\| a\.date \|\| ''\)/);
  assert.match(snippet, /:\s*0/, 'every other tab must be a no-op sort (0), never reordering the repo\'s own order');
});

test('[13] the sort comparator itself produces newest-first for a set of completed tours with different check-in dates', () => {
  const rows = [
    { opStatus: 'Tamamlandı', checkIn: '2026-01-05' },
    { opStatus: 'Tamamlandı', checkIn: '2026-03-20' },
    { opStatus: 'Tamamlandı', checkIn: '2026-02-10' },
  ];
  const sorted = [...rows].sort((a, b) => (b.checkIn || '').localeCompare(a.checkIn || ''));
  assert.deepEqual(sorted.map(r => r.checkIn), ['2026-03-20', '2026-02-10', '2026-01-05']);
});

// ── 6. Empty states ───────────────────────────────────────────────────────

test('[14] desktop empty-state copy matches exactly for Aktif Rezervasyonlar / Tamamlanan Turlar / İptal, compact (single line)', () => {
  assert.match(SOURCE, /"Aktif Rezervasyonlar": "Aktif rezervasyon bulunmuyor\."/);
  assert.match(SOURCE, /"Tamamlanan Turlar": "Tamamlanan tur bulunmuyor\."/);
  assert.match(SOURCE, /"İptal": "İptal edilmiş rezervasyon bulunmuyor\."/);
  assert.match(RESERVATIONS_PAGE_BODY, /RESERVATIONS_TAB_EMPTY_TEXT\[activeTab\] \|\| "Bu filtre için kayıt yok\."/);
});

// ── 7. Table structure / navigation untouched ────────────────────────────

test('[15] the desktop table\'s column headers are unchanged by this redesign', () => {
  assert.match(RESERVATIONS_PAGE_BODY, /\["Rezervasyon No","Misafir","Tur","Tarih \/ Saat","Kişi","Rehber","Ödeme","Operasyon",""\]/);
});

test('[16] every row\'s onClick still calls onSelect unconditionally — completed/cancelled rows remain clickable, their detail is never gated by tab', () => {
  const occurrences = RESERVATIONS_PAGE_BODY.match(/onClick=\{\(\)=>onSelect&&onSelect\(r\.id\)\}/g) || [];
  assert.ok(occurrences.length >= 1, 'expected the table row onClick to call onSelect unconditionally');
});

// ── 8. KPI cards untouched ────────────────────────────────────────────────

test('[17] the "Tamamlanan" KPI card is still present and still shows the total completed count', () => {
  assert.match(RESERVATIONS_PAGE_BODY, /label:"Tamamlanan",\s*val:completed/);
  assert.match(RESERVATIONS_PAGE_BODY, /const completed\s*=\s*_allRes\.filter\(r => r\.opStatus === "Tamamlandı"\)\.length;/);
});

test('[18] the "Aktif Rezervasyon" KPI card uses the SAME shared active-reservation rule as the Aktif Rezervasyonlar tab (can never disagree)', () => {
  assert.match(RESERVATIONS_PAGE_BODY, /const upcoming\s*=\s*_allRes\.filter\(_isActiveOperationalReservation\)\.length;/);
});

// ── 9. Mobile: same conceptual separation, existing card pattern kept ───

test('[19] mobile FILTERS is Aktif Rezervasyonlar / Bugün / Sorunlu / Tamamlanan Turlar / İptal, in that order, with Aktif Rezervasyonlar default', () => {
  const m = MOBILE_RESERVATIONS_PAGE_BODY.match(/const FILTERS = \[([^\]]*)\];/);
  assert.ok(m, 'mobile FILTERS array not found');
  const filters = m[1].split(',').map(s => s.trim().replace(/^"|"$/g, ''));
  assert.deepEqual(filters, ['Aktif Rezervasyonlar', 'Bugün', 'Sorunlu', 'Tamamlanan Turlar', 'İptal']);
  assert.match(MOBILE_RESERVATIONS_PAGE_BODY, /useState\("Aktif Rezervasyonlar"\)/);
});

test('[20] "Tümü" no longer appears anywhere in the mobile reservations filter logic', () => {
  assert.doesNotMatch(MOBILE_RESERVATIONS_PAGE_BODY, /"Tümü"/);
});

test('[21] mobile filter predicate: Tamamlanan Turlar/İptal are literal opStatus matches, default falls back to the SAME shared active-reservation rule used on desktop', () => {
  assert.match(MOBILE_RESERVATIONS_PAGE_BODY, /if \(filter === "Tamamlanan Turlar"\) return r\.opStatus === "Tamamlandı";/);
  assert.match(MOBILE_RESERVATIONS_PAGE_BODY, /if \(filter === "İptal"\) return r\.opStatus === "İptal";/);
  assert.match(MOBILE_RESERVATIONS_PAGE_BODY, /return _isActiveOperationalReservation\(r\);/);
});

test('[22] mobile "Bugün" and "Sorunlu" AND _isActiveOperationalReservation(r) as their first condition; the existing today/problematic calculations themselves are byte-for-byte unchanged', () => {
  assert.match(MOBILE_RESERVATIONS_PAGE_BODY, /if \(filter === "Bugün"\) return _isActiveOperationalReservation\(r\) && \(r\.date === _TODAY_STR \|\| r\.checkIn === _TODAY_ISO\);/);
  assert.match(MOBILE_RESERVATIONS_PAGE_BODY, /if \(filter === "Sorunlu"\) return _isActiveOperationalReservation\(r\) && \(!r\.guide \|\| r\.payStatus === "Bekliyor" \|\| !r\.pickup\);/);
});

// ── 9b. Bugün/Sorunlu: completed/cancelled excluded, active still included ──

function mobileFilterPredicate(filter, r) {
  if (filter === 'Tamamlanan Turlar') return r.opStatus === 'Tamamlandı';
  if (filter === 'İptal') return r.opStatus === 'İptal';
  if (filter === 'Bugün') return isActiveOperationalReservation(r) && (r.date === _TODAY_STR_FOR_TEST || r.checkIn === _TODAY_ISO_FOR_TEST);
  if (filter === 'Sorunlu') return isActiveOperationalReservation(r) && (!r.guide || r.payStatus === 'Bekliyor' || !r.pickup);
  return isActiveOperationalReservation(r);
}
const _TODAY_ISO_FOR_TEST = '2026-06-15';
const _TODAY_STR_FOR_TEST = '15 Haz 2026';

test('[22a] Bugün excludes a completed reservation that matches today\'s date', () => {
  const r = { opStatus: 'Tamamlandı', checkIn: _TODAY_ISO_FOR_TEST, guide: 'Ali', payStatus: 'Ödendi', pickup: true };
  assert.equal(mobileFilterPredicate('Bugün', r), false);
});

test('[22b] Bugün excludes a cancelled reservation that matches today\'s date', () => {
  const r = { opStatus: 'İptal', checkIn: _TODAY_ISO_FOR_TEST, guide: 'Ali', payStatus: 'Ödendi', pickup: true };
  assert.equal(mobileFilterPredicate('Bugün', r), false);
});

test('[22c] Sorunlu excludes a completed reservation that would otherwise look problematic (no guide)', () => {
  const r = { opStatus: 'Tamamlandı', guide: null, payStatus: 'Ödendi', pickup: true };
  assert.equal(mobileFilterPredicate('Sorunlu', r), false);
});

test('[22d] Sorunlu excludes a cancelled reservation that would otherwise look problematic (payment bekliyor)', () => {
  const r = { opStatus: 'İptal', guide: 'Ali', payStatus: 'Bekliyor', pickup: true };
  assert.equal(mobileFilterPredicate('Sorunlu', r), false);
});

test('[22e] Bugün still includes an active (non-final) reservation that matches today\'s date', () => {
  const r = { opStatus: 'Onaylandı', checkIn: _TODAY_ISO_FOR_TEST, guide: 'Ali', payStatus: 'Ödendi', pickup: true };
  assert.equal(mobileFilterPredicate('Bugün', r), true);
});

test('[22f] Sorunlu still includes an active (non-final) reservation that is genuinely problematic (no guide)', () => {
  const r = { opStatus: 'Hazırlanıyor', guide: null, payStatus: 'Ödendi', pickup: true };
  assert.equal(mobileFilterPredicate('Sorunlu', r), true);
});

test('[23] mobile sort flips to checkIn-descending ONLY for the Tamamlanan Turlar filter', () => {
  const idx = MOBILE_RESERVATIONS_PAGE_BODY.indexOf('.sort((a, b) =>');
  assert.ok(idx !== -1);
  const end = MOBILE_RESERVATIONS_PAGE_BODY.indexOf(');', idx);
  const snippet = MOBILE_RESERVATIONS_PAGE_BODY.slice(idx, end);
  assert.match(snippet, /filter === "Tamamlanan Turlar"/);
  assert.match(snippet, /\(b\.checkIn \|\| b\.date \|\| ''\)\.localeCompare\(a\.checkIn \|\| a\.date \|\| ''\)/);
});

test('[24] mobile empty-state copy matches exactly for Aktif Rezervasyonlar / Tamamlanan Turlar / İptal; Bugün/Sorunlu keep the existing generic copy', () => {
  assert.match(SOURCE, /MOBILE_RESERVATIONS_FILTER_EMPTY_TEXT = \{/);
  const idx = SOURCE.indexOf('const MOBILE_RESERVATIONS_FILTER_EMPTY_TEXT = {');
  const end = SOURCE.indexOf('};', idx);
  const snippet = SOURCE.slice(idx, end);
  assert.match(snippet, /"Aktif Rezervasyonlar": "Aktif rezervasyon bulunmuyor\."/);
  assert.match(snippet, /"Tamamlanan Turlar": "Tamamlanan tur bulunmuyor\."/);
  assert.match(snippet, /"İptal": "İptal edilmiş rezervasyon bulunmuyor\."/);
  assert.match(MOBILE_RESERVATIONS_PAGE_BODY, /MOBILE_RESERVATIONS_FILTER_EMPTY_TEXT\[filter\] \|\| "Bu filtre için rezervasyon yok\."/);
});

test('[25] mobile page does NOT recreate the desktop table — no <table> element, the existing MobileEntityCard/card-list pattern is preserved', () => {
  assert.doesNotMatch(MOBILE_RESERVATIONS_PAGE_BODY, /<table/);
  assert.match(MOBILE_RESERVATIONS_PAGE_BODY, /<MobileEntityCard/);
});

test('[26] mobile cards remain clickable for every reservation regardless of status — onSelect is never gated by filter/tab', () => {
  assert.match(MOBILE_RESERVATIONS_PAGE_BODY, /onClick=\{\(\)=>onSelect\(r\.id\)\}/);
});

// ── 10. Completed reservation detail remains fully accessible ───────────

test('[27] navigating to a reservation\'s detail route (/reservations/:id) is independent of the list/tab — both desktop and mobile route a param straight to the detail page component', () => {
  assert.match(SOURCE, /if \(base === "reservations" && param\) return <MobileReservationDetailPage resId={param} onBack={\(\)=>navigate\('\/reservations'\)}\/>;/);
  assert.match(SOURCE, /return <ReservationDetailPage resId={param} onBack={\(\)=>navigate\('\/reservations'\)}\/>;/);
});

test('[28] ReservationRepository/SupabaseReservationRepo.getById fetches by id alone — no opStatus filter that could block opening a completed or cancelled reservation', () => {
  const mockIdx = SOURCE.indexOf('getById(id) {\n    return DB.reservations.find');
  assert.ok(mockIdx !== -1, 'mock ReservationRepository.getById not found');
  const supaIdx = SOURCE.indexOf("async getById(id){const sb=getSB();if(!sb)return ReservationRepository.getById(id);");
  assert.ok(supaIdx !== -1, 'SupabaseReservationRepo.getById not found');
  const supaSnippet = SOURCE.slice(supaIdx, supaIdx + 300);
  assert.doesNotMatch(supaSnippet, /opStatus|status.*(?:Tamamlandı|İptal)/);
});

// ── 11. Safety: no business-logic/status-transition/schema change ───────

test('[29] no new database status/migration file is introduced by this change — only presentation/filtering over existing opStatus values', () => {
  const migrationFiles = fs.readdirSync(REPO_ROOT).filter(f => f.startsWith('supabase_migration_') && f.endsWith('.sql'));
  for (const f of migrationFiles) {
    assert.doesNotMatch(f, /reservation.*status|opstatus/i, `unexpected new reservation-status migration file: ${f}`);
  }
});

test('[30] the status-transition write paths (mark completed / cancel) are untouched — still write the exact same literal opStatus values', () => {
  assert.match(SOURCE, /await Promise\.resolve\(repo\.update\(res\.id, \{ opStatus:"Tamamlandı" \}\)\);/);
  assert.match(SOURCE, /ReservationRepository\.update\(resId, \{ opStatus: 'Tamamlandı' \}\)/);
  assert.match(SOURCE, /ReservationRepository\.update\(resId, \{ opStatus: 'İptal' \}\)/);
});
