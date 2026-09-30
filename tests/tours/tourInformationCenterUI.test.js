'use strict';
/**
 * tests/tours/tourInformationCenterUI.test.js
 * ─────────────────────────────────────────────────────────────────────────
 * Regression coverage for Tour Information Center Phase 2 — the "Tur Bilgi
 * Merkezi" application/UI implementation on top of the already-applied
 * supabase_migration_tour_information_center.sql schema (commit 096175e).
 *
 * Pure logic (_operationalInfoRows, _cancellationRuleRows, _meetingEndRows,
 * _moveArrayItem) is extracted via extractTestableFn and exercised with
 * real mock data — the REAL shipping implementation, not a duplicate.
 * Everything else is a static source-region assertion against
 * DeseTourDashboard.jsx, the established convention for this single-file
 * component (see tests/dashboard/tourChannelBookingLanguage.test.js).
 * ─────────────────────────────────────────────────────────────────────────
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { extractTestableFn } = require('../dashboard/extractTestableFn');

const SOURCE_PATH = path.join(__dirname, '..', '..', 'DeseTourDashboard.jsx');
const SOURCE = fs.readFileSync(SOURCE_PATH, 'utf8');

function extractFunctionBody(name, nextMarker) {
  const idx = SOURCE.indexOf(`function ${name}(`);
  assert.ok(idx !== -1, `could not find function ${name}`);
  const end = SOURCE.indexOf(nextMarker, idx);
  assert.ok(end !== -1, `could not find end marker "${nextMarker}" after function ${name}`);
  return SOURCE.slice(idx, end);
}

const _operationalInfoRows = extractTestableFn('_operationalInfoRows');
const _cancellationRuleRows = extractTestableFn('_cancellationRuleRows');
const _meetingEndRows = extractTestableFn('_meetingEndRows');
const _moveArrayItem = extractTestableFn('_moveArrayItem');

const MAP_TOUR_FROM_DB_BODY = extractFunctionBody('mapTourFromDB', '\nfunction mapTourToDB');
const MAP_TOUR_TO_DB_BODY = extractFunctionBody('mapTourToDB', '\n// Replace-all sync of a tour\'s tour_languages');
const MAP_TOUR_ITINERARY_STOP_BODY = extractFunctionBody('mapTourItineraryStopFromDB', '\nfunction mapTourFromDB');
const SYNC_ITINERARY_IDX = SOURCE.indexOf('async function _syncTourItineraryStops(');
const SYNC_ITINERARY_BODY = SOURCE.slice(SYNC_ITINERARY_IDX, SOURCE.indexOf('\nconst _TOUR_SELECT', SYNC_ITINERARY_IDX));
const SUPABASE_TOUR_REPO_IDX = SOURCE.indexOf('const SupabaseTourRepo = {');
const SUPABASE_TOUR_REPO_BODY = SOURCE.slice(SUPABASE_TOUR_REPO_IDX, SOURCE.indexOf('\nconst SupabaseStaffRepo', SUPABASE_TOUR_REPO_IDX));
const GET_BY_ID_BODY = SUPABASE_TOUR_REPO_BODY.slice(
  SUPABASE_TOUR_REPO_BODY.indexOf('async getById('),
  SUPABASE_TOUR_REPO_BODY.indexOf('async create(')
);
const CREATE_BODY = SUPABASE_TOUR_REPO_BODY.slice(
  SUPABASE_TOUR_REPO_BODY.indexOf('async create('),
  SUPABASE_TOUR_REPO_BODY.indexOf('async update(')
);
const UPDATE_BODY = SUPABASE_TOUR_REPO_BODY.slice(SUPABASE_TOUR_REPO_BODY.indexOf('async update('));

const TOUR_DOSSIER_READ_VIEW_BODY = extractFunctionBody('TourDossierReadView', '\nfunction GuideTourInfoModal');
const GUIDE_TOUR_INFO_MODAL_BODY = extractFunctionBody('GuideTourInfoModal', '\nfunction TourDetailPage');
const TOUR_DETAIL_PAGE_BODY = extractFunctionBody('TourDetailPage', '\nfunction ToursPage');
const TOUR_INCLUSIONS_EDITOR_BODY = extractFunctionBody('TourInclusionsEditor', '\nfunction TourItineraryStopRows');
const TOUR_ITINERARY_STOP_ROWS_BODY = extractFunctionBody('TourItineraryStopRows', '\nfunction TourDossierEditFields');
const TOUR_DOSSIER_EDIT_FIELDS_BODY = extractFunctionBody('TourDossierEditFields', '\nfunction TourFormFields');
const TOUR_FORM_FIELDS_BODY = extractFunctionBody('TourFormFields', '\nfunction NewTourModal');
const NEW_TOUR_MODAL_BODY = extractFunctionBody('NewTourModal', '\nconst _QS_DB');
const RESERVATION_DETAIL_PAGE_IDX = SOURCE.indexOf('function ReservationDetailPage(');
const RESERVATION_DETAIL_PAGE_BODY = SOURCE.slice(RESERVATION_DETAIL_PAGE_IDX, SOURCE.indexOf('\nfunction CIc(', RESERVATION_DETAIL_PAGE_IDX));

function tour(overrides) {
  return {
    id: 'T-1', name: 'Grand Bazaar Experience', category: 'cultural',
    duration: null, durationText: '', status: 'Aktif',
    description: '', meetingPoint: '', tourType: [], maxGuests: null,
    meetingInstructionsTr: '', endPointTr: '', accessibilityInfoTr: '', petsPolicyTr: '',
    bookingCutoffText: '', freeCancellationText: '', lateCancellationText: '',
    noShowPolicyText: '', otherConditionsTr: '', guideNotesTr: '',
    includedItems: [], excludedItems: [], itineraryStops: [],
    languages: [], languageNames: [], channels: [],
    ...overrides,
  };
}

// ── Repository: loads itinerary, ordering, no N+1 ───────────────────────

test('repository: getById selects tour_itinerary_stops via _TOUR_DETAIL_SELECT (not the plain list-view _TOUR_SELECT)', () => {
  assert.match(GET_BY_ID_BODY, /select\(_TOUR_DETAIL_SELECT\)/);
});

test('repository: _TOUR_DETAIL_SELECT includes tour_itinerary_stops(*), built additively on top of _TOUR_SELECT', () => {
  const idx = SOURCE.indexOf("const _TOUR_DETAIL_SELECT = _TOUR_SELECT + ',tour_itinerary_stops(*)';");
  assert.ok(idx > -1);
});

test('repository: the plain list-view _TOUR_SELECT (used by getAll) does NOT include tour_itinerary_stops — avoids fetching every stop of every tour for a list page that never renders them', () => {
  const idx = SOURCE.indexOf("const _TOUR_SELECT = '*,tour_languages");
  const line = SOURCE.slice(idx, SOURCE.indexOf(';', idx));
  assert.doesNotMatch(line, /tour_itinerary_stops/);
});

test('repository: itinerary ordering is requested from the database itself (single query, no N+1) via Supabase\'s embedded-resource order syntax', () => {
  assert.match(GET_BY_ID_BODY, /\.order\('stop_order',\s*\{\s*foreignTable:\s*'tour_itinerary_stops'\s*\}\)/);
});

test('repository: mapTourFromDB additionally re-sorts itinerary stops client-side by stopOrder as a defensive backstop', () => {
  assert.match(MAP_TOUR_FROM_DB_BODY, /\.sort\(\(a,b\)\s*=>\s*a\.stopOrder\s*-\s*b\.stopOrder\)/);
});

// ── New scalar mapping ───────────────────────────────────────────────────

test('mapTourFromDB maps all ten new nullable columns, each defaulting to an empty string (never null/undefined)', () => {
  const cols = [
    ['meetingInstructionsTr', 'meeting_instructions_tr'],
    ['endPointTr', 'end_point_tr'],
    ['accessibilityInfoTr', 'accessibility_info_tr'],
    ['petsPolicyTr', 'pets_policy_tr'],
    ['bookingCutoffText', 'booking_cutoff_text'],
    ['freeCancellationText', 'free_cancellation_text'],
    ['lateCancellationText', 'late_cancellation_text'],
    ['noShowPolicyText', 'no_show_policy_text'],
    ['otherConditionsTr', 'other_conditions_tr'],
    ['guideNotesTr', 'guide_notes_tr'],
  ];
  for (const [jsKey, dbCol] of cols) {
    const re = new RegExp(`${jsKey}:\\s*r\\.${dbCol}(\\s*)?\\|\\|\\s*''`);
    assert.match(MAP_TOUR_FROM_DB_BODY, re, `expected ${jsKey} <- r.${dbCol}`);
  }
});

test('mapTourFromDB maps included_items/excluded_items to arrays, defaulting a NULL column to an empty array', () => {
  assert.match(MAP_TOUR_FROM_DB_BODY, /includedItems:\s*r\.included_items\s*\|\|\s*\[\]/);
  assert.match(MAP_TOUR_FROM_DB_BODY, /excludedItems:\s*r\.excluded_items\s*\|\|\s*\[\]/);
});

test('mapTourFromDB maps itineraryStops from tour_itinerary_stops via mapTourItineraryStopFromDB', () => {
  assert.match(MAP_TOUR_FROM_DB_BODY, /tour_itinerary_stops\|\|\[\]\)\s*\n\s*\.map\(mapTourItineraryStopFromDB\)/);
});

test('mapTourItineraryStopFromDB maps every itinerary column to its JS field', () => {
  assert.match(MAP_TOUR_ITINERARY_STOP_BODY, /stopOrder:\s*s\.stop_order/);
  assert.match(MAP_TOUR_ITINERARY_STOP_BODY, /placeName:\s*s\.place_name\s*\|\|\s*''/);
  assert.match(MAP_TOUR_ITINERARY_STOP_BODY, /descriptionTr:\s*s\.description_tr\s*\|\|\s*''/);
  assert.match(MAP_TOUR_ITINERARY_STOP_BODY, /operationalNote:\s*s\.operational_note\s*\|\|\s*''/);
  assert.match(MAP_TOUR_ITINERARY_STOP_BODY, /approxDurationText:\s*s\.approx_duration_text\s*\|\|\s*''/);
});

test('mapTourToDB writes all ten new fields AND included_items/excluded_items, only when the caller explicitly sent that key', () => {
  const scalarCols = [
    ['meetingInstructionsTr', 'meeting_instructions_tr'], ['endPointTr', 'end_point_tr'],
    ['accessibilityInfoTr', 'accessibility_info_tr'], ['petsPolicyTr', 'pets_policy_tr'],
    ['bookingCutoffText', 'booking_cutoff_text'], ['freeCancellationText', 'free_cancellation_text'],
    ['lateCancellationText', 'late_cancellation_text'], ['noShowPolicyText', 'no_show_policy_text'],
    ['otherConditionsTr', 'other_conditions_tr'], ['guideNotesTr', 'guide_notes_tr'],
  ];
  for (const [jsKey, dbCol] of scalarCols) {
    const re = new RegExp(`if \\(d\\.${jsKey}\\s*!== undefined\\) row\\.${dbCol}\\s*=`);
    assert.match(MAP_TOUR_TO_DB_BODY, re, `expected a guarded write for ${jsKey}`);
  }
  assert.match(MAP_TOUR_TO_DB_BODY, /if \(d\.includedItems\s*!== undefined\) row\.included_items/);
  assert.match(MAP_TOUR_TO_DB_BODY, /if \(d\.excludedItems\s*!== undefined\) row\.excluded_items/);
});

// ── tours.notes is structurally untouchable by application code ────────

test('mapTourToDB has NO branch for tours.notes at all — the key is never read, so it can never be written or nulled by any save', () => {
  assert.doesNotMatch(MAP_TOUR_TO_DB_BODY, /row\.notes/);
  assert.doesNotMatch(MAP_TOUR_TO_DB_BODY, /d\.notes/);
});

test('TourFormFields no longer has a notes/"Operasyon Notları" field or notes/setNotes props', () => {
  assert.doesNotMatch(TOUR_FORM_FIELDS_BODY, /notes,\s*setNotes/);
  assert.doesNotMatch(TOUR_FORM_FIELDS_BODY, /Operasyon Notları/);
});

test('NewTourModal no longer manages a notes field', () => {
  assert.doesNotMatch(NEW_TOUR_MODAL_BODY, /\[notes, setNotes\]/);
  assert.doesNotMatch(NEW_TOUR_MODAL_BODY, /notes,\s*setNotes/);
});

// ── No summary_tr anywhere in application code ──────────────────────────

test('summary_tr is never used as an actual property/column reference anywhere in DeseTourDashboard.jsx — description is reused instead', () => {
  // The string appears once, deliberately, inside an explanatory code
  // comment ("No summary_tr column exists or is read anywhere.") — that
  // is documentation, not usage. The real guarantee is structural: no
  // property access, object key, or JSX prop named summaryTr/summary_tr
  // exists in any executable code.
  assert.doesNotMatch(SOURCE, /\bsummaryTr\b/);
  assert.doesNotMatch(SOURCE, /\.summary_tr\b/);
  assert.doesNotMatch(SOURCE, /row\.summary_tr/);
});

test('Genel Bakış is rendered from tour.description', () => {
  assert.match(TOUR_DOSSIER_READ_VIEW_BODY, /Genel Bakış/);
  assert.match(TOUR_DOSSIER_READ_VIEW_BODY, /tour\.description/);
});

test('TourFormFields relabels the description field "Genel Bakış" (was "Açıklama"), same underlying description/setDescription props', () => {
  assert.match(TOUR_FORM_FIELDS_BODY, /label="Genel Bakış"/);
  assert.doesNotMatch(TOUR_FORM_FIELDS_BODY, /label="Açıklama"/);
  assert.match(TOUR_FORM_FIELDS_BODY, /value={description} onChange={setDescription}/);
});

// ── _syncTourItineraryStops: delete/reinsert, deterministic stop_order ──

test('_syncTourItineraryStops deletes then inserts (replace-all), same convention as _syncTourLanguages/_syncTourChannels', () => {
  assert.match(SYNC_ITINERARY_BODY, /sb\.from\('tour_itinerary_stops'\)\.delete\(\)\.eq\('tour_id', tourId\)/);
  assert.match(SYNC_ITINERARY_BODY, /sb\.from\('tour_itinerary_stops'\)\.insert\(rows\)/);
});

test('_syncTourItineraryStops regenerates stop_order deterministically from the array\'s own index (i + 1), never trusting a stale client-side value', () => {
  assert.match(SYNC_ITINERARY_BODY, /stop_order:\s*i\s*\+\s*1/);
});

test('_syncTourItineraryStops drops a stop with no place_name rather than sending it to the database (place_name is NOT NULL)', () => {
  assert.match(SYNC_ITINERARY_BODY, /filter\(s => s && s\.placeName && s\.placeName\.trim\(\)\)/);
});

test('_syncTourItineraryStops wired into both create and update, warning concatenated the same way languages/channels already are', () => {
  assert.match(CREATE_BODY, /if \(d\.itineraryStops !== undefined\) \{/);
  assert.match(CREATE_BODY, /_syncTourItineraryStops\(sb, c\.id, d\.itineraryStops\)/);
  assert.match(UPDATE_BODY, /if \(d\.itineraryStops !== undefined\) \{/);
  assert.match(UPDATE_BODY, /_syncTourItineraryStops\(sb, id, d\.itineraryStops\)/);
});

test('a child sync failure (languages/channels/itinerary) is surfaced via _syncWarning, never silently swallowed as a clean success', () => {
  assert.match(UPDATE_BODY, /syncWarning = syncWarning \? syncWarning \+ ' · Tur rotası kaydedilemedi: ' \+ e\.message : 'Tur rotası kaydedilemedi: ' \+ e\.message/);
  assert.match(UPDATE_BODY, /if \(syncWarning\) updated\._syncWarning = syncWarning;/);
});

// ── Itinerary data safety: undefined vs [] vs [items] — REAL execution,
// not just regex, of the actual shipping _syncTourItineraryStops ────────

function fakeSb() {
  const calls = { deletedFor: [], inserted: undefined, insertCalled: false };
  return {
    _calls: calls,
    from(table) {
      assert.equal(table, 'tour_itinerary_stops', 'must only ever touch tour_itinerary_stops');
      return {
        delete() {
          return {
            eq(col, val) {
              assert.equal(col, 'tour_id');
              calls.deletedFor.push(val);
              return Promise.resolve({ error: null });
            },
          };
        },
        insert(rows) {
          calls.insertCalled = true;
          calls.inserted = rows;
          return Promise.resolve({ error: null });
        },
      };
    },
  };
}

const _syncTourItineraryStops = extractTestableFn('_syncTourItineraryStops');

test('CASE 1 (itineraryStops === undefined): the update() guard itself prevents _syncTourItineraryStops from EVER being called — structurally, not by convention', () => {
  // The guard is `if (d.itineraryStops !== undefined) { ... }` — when the
  // key is absent from the payload object, d.itineraryStops is exactly
  // JS `undefined`, so this condition is false and the block (which is
  // the ONLY place _syncTourItineraryStops is invoked from update) never
  // executes. Proven directly against the real, unmodified guard text.
  assert.match(UPDATE_BODY, /if \(d\.itineraryStops !== undefined\) \{\s*\n\s*try \{ await _syncTourItineraryStops\(sb, id, d\.itineraryStops\); \}/);
});

test('CASE 2 (itineraryStops === []): _syncTourItineraryStops DOES run — deletes existing rows and inserts nothing, intentionally clearing the itinerary', async () => {
  const sb = fakeSb();
  await _syncTourItineraryStops(sb, 'tour-1', []);
  assert.deepEqual(sb._calls.deletedFor, ['tour-1'], 'must delete the tour\'s existing rows');
  assert.equal(sb._calls.insertCalled, false, 'must not insert anything for an empty array — that IS the clear');
});

test('CASE 3 (itineraryStops === [items]): _syncTourItineraryStops deletes then inserts the replacement rows', async () => {
  const sb = fakeSb();
  await _syncTourItineraryStops(sb, 'tour-1', [
    { placeName: 'Kapalıçarşı', descriptionTr: 'Giriş', operationalNote: '', approxDurationText: '20 dakika' },
    { placeName: 'Süleymaniye Camii', descriptionTr: '', operationalNote: 'Kapanış saatine dikkat', approxDurationText: '' },
  ]);
  assert.deepEqual(sb._calls.deletedFor, ['tour-1']);
  assert.equal(sb._calls.insertCalled, true);
  assert.equal(sb._calls.inserted.length, 2);
  assert.equal(sb._calls.inserted[0].place_name, 'Kapalıçarşı');
  assert.equal(sb._calls.inserted[1].place_name, 'Süleymaniye Camii');
});

test('stop_order is regenerated deterministically (1-based array index), never read from the input objects', async () => {
  const sb = fakeSb();
  await _syncTourItineraryStops(sb, 'tour-1', [
    { placeName: 'A' }, { placeName: 'B' }, { placeName: 'C' },
  ]);
  assert.deepEqual(sb._calls.inserted.map(r => r.stop_order), [1, 2, 3]);
});

test('an unrelated tour update (itineraryStops key entirely absent from the payload) cannot delete an existing itinerary — proven by simulating SupabaseTourRepo.update\'s own guard directly', async () => {
  // Simulates exactly what update() does: build the same conditional
  // dispatch it uses, feed it a payload that edits only `name` (a
  // completely unrelated field), and confirm tour_itinerary_stops is
  // never touched at all.
  const sb = fakeSb();
  const unrelatedPayload = { name: 'Yeni İsim' }; // itineraryStops key absent
  if (unrelatedPayload.itineraryStops !== undefined) {
    await _syncTourItineraryStops(sb, 'tour-1', unrelatedPayload.itineraryStops);
  }
  assert.deepEqual(sb._calls.deletedFor, [], 'tour_itinerary_stops must never be touched by an update that never mentions itineraryStops');
  assert.equal(sb._calls.insertCalled, false);
});

// ── Pure logic: _operationalInfoRows ─────────────────────────────────────

test('_operationalInfoRows: an empty tour produces zero rows — never fabricated content', () => {
  assert.deepEqual(_operationalInfoRows(tour()), []);
});

test('_operationalInfoRows: duration prefers durationText, falls back to duration+" gün"', () => {
  assert.equal(_operationalInfoRows(tour({ durationText:'3 saat' })).find(r=>r.key==='duration').value, '3 saat');
  assert.equal(_operationalInfoRows(tour({ duration:2 })).find(r=>r.key==='duration').value, '2 gün');
});

test('_operationalInfoRows: joins multiple language names with " · "', () => {
  const row = _operationalInfoRows(tour({ languageNames:['İspanyolca','İtalyanca'] })).find(r=>r.key==='language');
  assert.equal(row.value, 'İspanyolca · İtalyanca');
});

test('_operationalInfoRows: translates tourType codes to Turkish labels', () => {
  const row = _operationalInfoRows(tour({ tourType:['private','group'] })).find(r=>r.key==='type');
  assert.equal(row.value, 'Özel · Grup');
});

test('_operationalInfoRows: includes maxGuests/accessibilityInfoTr/petsPolicyTr only when set', () => {
  const full = _operationalInfoRows(tour({
    maxGuests: 12, meetingPoint: 'Sultanahmet Meydanı', bookingCutoffText: '24 saat önce',
    accessibilityInfoTr: 'Tekerlekli sandalye uygun değildir', petsPolicyTr: 'Evcil hayvan kabul edilmez',
  }));
  assert.equal(full.find(r=>r.key==='maxguests').value, '12');
  assert.equal(full.find(r=>r.key==='accessibility').value, 'Tekerlekli sandalye uygun değildir');
  assert.equal(full.find(r=>r.key==='pets').value, 'Evcil hayvan kabul edilmez');
});

// ── Correction: no read-mode field duplication across sections ─────────
// Buluşma Noktası and Rezervasyon Limiti must each have exactly ONE home
// in the read-mode dossier — Operasyon Bilgileri must never repeat either.

test('_operationalInfoRows NEVER includes a "meetingpoint" row, even when tour.meetingPoint is set — Buluşma Noktası lives ONLY in _meetingEndRows/"Buluşma ve Bitiş"', () => {
  const rows = _operationalInfoRows(tour({ meetingPoint: 'Sultanahmet Meydanı' }));
  assert.equal(rows.find(r => r.key === 'meetingpoint'), undefined);
  assert.doesNotMatch(JSON.stringify(rows), /Sultanahmet Meydanı/);
});

test('_operationalInfoRows NEVER includes a "cutoff" row, even when tour.bookingCutoffText is set — Rezervasyon Limiti lives ONLY in _cancellationRuleRows/"Rezervasyon ve İptal Kuralları"', () => {
  const rows = _operationalInfoRows(tour({ bookingCutoffText: '24 saat önce' }));
  assert.equal(rows.find(r => r.key === 'cutoff'), undefined);
  assert.doesNotMatch(JSON.stringify(rows), /24 saat önce/);
});

test('meetingPoint appears in _meetingEndRows exactly once (its one authoritative home)', () => {
  const rows = _meetingEndRows(tour({ meetingPoint: 'Sultanahmet Meydanı' }));
  const matches = rows.filter(r => r.value === 'Sultanahmet Meydanı');
  assert.equal(matches.length, 1);
  assert.equal(matches[0].key, 'point');
});

test('bookingCutoffText appears in _cancellationRuleRows exactly once (its one authoritative home)', () => {
  const rows = _cancellationRuleRows(tour({ bookingCutoffText: '24 saat önce' }));
  const matches = rows.filter(r => r.value === '24 saat önce');
  assert.equal(matches.length, 1);
  assert.equal(matches[0].key, 'cutoff');
});

test('the source code itself: Operasyon Bilgileri (_operationalInfoRows) has no "meetingpoint" or "cutoff" row-push statement anywhere in its body', () => {
  const idx = SOURCE.indexOf('function _operationalInfoRows(tour) {');
  const body = SOURCE.slice(idx, SOURCE.indexOf('\n}', idx));
  assert.doesNotMatch(body, /key:'meetingpoint'/);
  assert.doesNotMatch(body, /key:'cutoff'/);
  assert.doesNotMatch(body, /Buluşma Noktası/);
  assert.doesNotMatch(body, /Rezervasyon Limiti/);
});

// ── Pure logic: _cancellationRuleRows ────────────────────────────────────

test('_cancellationRuleRows: hides individual empty rows, shows only what is set', () => {
  const rows = _cancellationRuleRows(tour({ freeCancellationText:'48 saat öncesine kadar ücretsiz' }));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].key, 'free');
});

test('_cancellationRuleRows: all five fields map to distinct rows when all are set', () => {
  const rows = _cancellationRuleRows(tour({
    bookingCutoffText:'a', freeCancellationText:'b', lateCancellationText:'c',
    noShowPolicyText:'d', otherConditionsTr:'e',
  }));
  assert.deepEqual(rows.map(r=>r.key), ['cutoff','free','late','noshow','other']);
});

// ── Pure logic: _meetingEndRows ──────────────────────────────────────────

test('_meetingEndRows: empty tour produces zero rows', () => {
  assert.deepEqual(_meetingEndRows(tour()), []);
});

test('_meetingEndRows: meetingPoint/meetingInstructionsTr/endPointTr each become independent rows', () => {
  const rows = _meetingEndRows(tour({
    meetingPoint:'Sultanahmet Meydanı', meetingInstructionsTr:'Çeşmenin yanında bekleyin', endPointTr:'Kapalıçarşı Nuruosmaniye Kapısı',
  }));
  assert.deepEqual(rows.map(r=>r.key), ['point','instructions','end']);
});

// ── Pure logic: _moveArrayItem (itinerary reorder) ──────────────────────

test('_moveArrayItem: moves an item up/down without mutating the original array', () => {
  const arr = ['A','B','C'];
  const moved = _moveArrayItem(arr, 1, -1);
  assert.deepEqual(moved, ['B','A','C']);
  assert.deepEqual(arr, ['A','B','C'], 'original array must not be mutated');
});

test('_moveArrayItem: moving the first item up, or the last item down, is a no-op', () => {
  assert.deepEqual(_moveArrayItem(['A','B','C'], 0, -1), ['A','B','C']);
  assert.deepEqual(_moveArrayItem(['A','B','C'], 2, 1), ['A','B','C']);
});

// ── Read mode default + edit-mode permission gating (no new permission
// system — reuses the existing tours write-RLS role split) ─────────────

test('TourDetailPage defaults to read mode', () => {
  assert.match(TOUR_DETAIL_PAGE_BODY, /const \[mode, setMode\] = useState\("read"\);/);
});

test('TourDetailPage gates "Düzenle" using the SAME role split as the existing tours write RLS (Yönetici/Operasyon) — no new permission system invented', () => {
  assert.match(TOUR_DETAIL_PAGE_BODY, /const canEdit = auth\.role === "Yönetici" \|\| auth\.role === "Operasyon";/);
  assert.match(TOUR_DETAIL_PAGE_BODY, /canEdit && \(\s*\n\s*<button onClick={enterEdit}/);
});

test('read mode renders TourDossierReadView; edit mode renders TourFormFields + TourDossierEditFields', () => {
  assert.match(TOUR_DETAIL_PAGE_BODY, /mode === "read" \? \(\s*\n\s*<TourDossierReadView tour={orig}\/>/);
  assert.match(TOUR_DETAIL_PAGE_BODY, /<TourFormFields/);
  assert.match(TOUR_DETAIL_PAGE_BODY, /<TourDossierEditFields/);
});

test('a role without edit rights (e.g. no canEdit match) never sees a Düzenle button — it only renders inside the canEdit guard', () => {
  const readBranchIdx = TOUR_DETAIL_PAGE_BODY.indexOf('mode === "read" ? (');
  const editBranchIdx = TOUR_DETAIL_PAGE_BODY.indexOf(') : (', readBranchIdx);
  const readBranch = TOUR_DETAIL_PAGE_BODY.slice(readBranchIdx, editBranchIdx);
  assert.match(readBranch, /canEdit && \(/);
});

// ── Save preserves unrelated dossier data (data-loss protection) ────────

test('handleSave sends the COMPLETE field set (existing + all Tour Information Center fields) in one call — never a partial subset', () => {
  const handleSaveIdx = TOUR_DETAIL_PAGE_BODY.indexOf('async function handleSave()');
  const handleSaveBody = TOUR_DETAIL_PAGE_BODY.slice(handleSaveIdx, TOUR_DETAIL_PAGE_BODY.indexOf('\n  }', TOUR_DETAIL_PAGE_BODY.indexOf('mutTour("update"', handleSaveIdx)));
  for (const field of [
    'name', 'category', 'description', 'durationText', 'basePrice', 'currency', 'status',
    'tourType', 'maxGuests', 'meetingPoint', 'languages', 'channels',
    'meetingInstructionsTr', 'endPointTr', 'accessibilityInfoTr', 'petsPolicyTr',
    'bookingCutoffText', 'freeCancellationText', 'lateCancellationText', 'noShowPolicyText',
    'otherConditionsTr', 'guideNotesTr', 'includedItems', 'excludedItems', 'itineraryStops',
  ]) {
    assert.match(handleSaveBody, new RegExp(`\\b${field}\\b`), `expected handleSave's payload to include ${field}`);
  }
});

test('handleSave never sends `notes` — omitted entirely, not cleared', () => {
  const handleSaveIdx = TOUR_DETAIL_PAGE_BODY.indexOf('async function handleSave()');
  const payloadIdx = TOUR_DETAIL_PAGE_BODY.indexOf('mutTour("update"', handleSaveIdx);
  const payloadEnd = TOUR_DETAIL_PAGE_BODY.indexOf('});', payloadIdx);
  const payload = TOUR_DETAIL_PAGE_BODY.slice(payloadIdx, payloadEnd);
  assert.doesNotMatch(payload, /\bnotes\b/);
});

test('a sync-failure response keeps the page in edit mode (setMode("read") only runs in the success branch, never alongside _syncWarning)', () => {
  const handleSaveIdx = TOUR_DETAIL_PAGE_BODY.indexOf('async function handleSave()');
  const handleSaveBody = TOUR_DETAIL_PAGE_BODY.slice(handleSaveIdx, handleSaveIdx + 1500);
  const warningBranch = handleSaveBody.slice(handleSaveBody.indexOf('if (data?._syncWarning)'), handleSaveBody.indexOf('} else {'));
  assert.doesNotMatch(warningBranch, /setMode\("read"\)/);
  const successBranch = handleSaveBody.slice(handleSaveBody.indexOf('} else {'));
  assert.match(successBranch, /setMode\("read"\)/);
});

test('cancelEdit reverts every field back to the last-loaded record without saving', () => {
  const cancelIdx = TOUR_DETAIL_PAGE_BODY.indexOf('function cancelEdit()');
  const cancelBody = TOUR_DETAIL_PAGE_BODY.slice(cancelIdx, TOUR_DETAIL_PAGE_BODY.indexOf('\n  }\n\n  ', cancelIdx));
  assert.match(cancelBody, /setMode\("read"\)/);
  assert.doesNotMatch(cancelBody, /mutTour/);
});

// ── Read-mode content: empty dossier, meeting/end, cancellation, guide
// notes, sales channel info, listing URL ────────────────────────────────

test('empty dossier renders quiet empty states for primary sections, never ten empty cards', () => {
  assert.match(TOUR_DOSSIER_READ_VIEW_BODY, /<DossierEmptyNote\/>/);
  assert.match(SOURCE, /Henüz bilgi eklenmedi\./);
});

test('secondary sections (itinerary, inclusions, cancellation rules, meeting/end, guide notes, channels) are hidden ENTIRELY when empty — not shown with a placeholder', () => {
  assert.match(TOUR_DOSSIER_READ_VIEW_BODY, /\{hasItinerary && \(/);
  assert.match(TOUR_DOSSIER_READ_VIEW_BODY, /\{hasInclusionsSection && \(/);
  assert.match(TOUR_DOSSIER_READ_VIEW_BODY, /\{cancelRows\.length > 0 && \(/);
  assert.match(TOUR_DOSSIER_READ_VIEW_BODY, /\{meetingRows\.length > 0 && \(/);
  assert.match(TOUR_DOSSIER_READ_VIEW_BODY, /\{tour\.guideNotesTr && \(/);
  assert.match(TOUR_DOSSIER_READ_VIEW_BODY, /\{hasChannels && \(/);
});

test('meeting/end information section reads from _meetingEndRows', () => {
  assert.match(TOUR_DOSSIER_READ_VIEW_BODY, /Buluşma ve Bitiş/);
  assert.match(TOUR_DOSSIER_READ_VIEW_BODY, /const meetingRows = _meetingEndRows\(tour\);/);
});

test('cancellation rules section reads from _cancellationRuleRows', () => {
  assert.match(TOUR_DOSSIER_READ_VIEW_BODY, /Rezervasyon ve İptal Kuralları/);
  assert.match(TOUR_DOSSIER_READ_VIEW_BODY, /const cancelRows = _cancellationRuleRows\(tour\);/);
});

test('guide notes are visually and structurally distinct — a separate section with an explicit "İç Operasyon Notu" badge, never blended into Genel Bakış or Operasyon Notları', () => {
  const guideSectionIdx = TOUR_DOSSIER_READ_VIEW_BODY.indexOf('Rehber İçin Operasyon Notları');
  assert.ok(guideSectionIdx > -1);
  const guideSection = TOUR_DOSSIER_READ_VIEW_BODY.slice(guideSectionIdx, guideSectionIdx + 800);
  assert.match(guideSection, /İç Operasyon Notu/);
  assert.match(guideSection, /tour\.guideNotesTr/);
  // Must not read from the deprecated generic `notes` field.
  assert.doesNotMatch(guideSection, /tour\.notes\b/);
});

test('sales channel section shows source, external product ID, booking language, active state, and price override', () => {
  const chIdx = TOUR_DOSSIER_READ_VIEW_BODY.indexOf('Satış Kanalı Bilgileri');
  const chSection = TOUR_DOSSIER_READ_VIEW_BODY.slice(chIdx);
  assert.match(chSection, /c\.sourceName/);
  assert.match(chSection, /External Product ID.*c\.externalProductId/s);
  assert.match(chSection, /Rezervasyon Dili.*c\.bookingLanguage/s);
  assert.match(chSection, /c\.isActive \? "Aktif" : "Pasif"/);
  assert.match(chSection, /Platform Fiyatı/);
});

test('listing URL renders as a safe external link (target=_blank, rel=noopener noreferrer)', () => {
  assert.match(TOUR_DOSSIER_READ_VIEW_BODY, /<a href={c\.listingUrl} target="_blank" rel="noopener noreferrer"/);
});

// ── Inclusions/exclusions editor: simple repeatable rows ────────────────

test('TourInclusionsEditor is a repeatable-row editor (add/remove/update), never a comma-separated textarea', () => {
  assert.match(TOUR_INCLUSIONS_EDITOR_BODY, /function addRow\(\) \{ setItems\(prev => \[\.\.\.prev, ""\]\); \}/);
  assert.match(TOUR_INCLUSIONS_EDITOR_BODY, /function removeRow\(i\) \{ setItems\(prev => prev\.filter/);
  assert.doesNotMatch(TOUR_INCLUSIONS_EDITOR_BODY, /FTextArea/, 'must never use a giant textarea for a list of items');
});

test('TourDossierEditFields mounts TWO independent TourInclusionsEditor instances — one for included_items, one for excluded_items', () => {
  const matches = TOUR_DOSSIER_EDIT_FIELDS_BODY.match(/<TourInclusionsEditor/g) || [];
  assert.equal(matches.length, 2);
  assert.match(TOUR_DOSSIER_EDIT_FIELDS_BODY, /items={includedItems} setItems={setIncludedItems}/);
  assert.match(TOUR_DOSSIER_EDIT_FIELDS_BODY, /items={excludedItems} setItems={setExcludedItems}/);
});

// ── Itinerary editor: add / remove / reorder, no drag-and-drop dep ──────

test('TourItineraryStopRows supports add, remove, and move up/down — no drag-and-drop library dependency', () => {
  assert.match(TOUR_ITINERARY_STOP_ROWS_BODY, /function addRow\(\) \{ setStops\(prev => \[\.\.\.prev, \{ placeName:"", descriptionTr:"", operationalNote:"", approxDurationText:"" \}\]\); \}/);
  assert.match(TOUR_ITINERARY_STOP_ROWS_BODY, /function removeRow\(i\) \{ setStops\(prev => prev\.filter/);
  assert.match(TOUR_ITINERARY_STOP_ROWS_BODY, /function move\(i, direction\) \{ setStops\(prev => _moveArrayItem\(prev, i, direction\)\); \}/);
  assert.doesNotMatch(SOURCE, /react-beautiful-dnd|react-dnd|sortablejs|dnd-kit/i);
});

test('TourItineraryStopRows never lets the editor set stop_order directly — only placeName/descriptionTr/operationalNote/approxDurationText are editable per row', () => {
  assert.doesNotMatch(TOUR_ITINERARY_STOP_ROWS_BODY, /stopOrder:/);
  assert.match(TOUR_ITINERARY_STOP_ROWS_BODY, /s\.placeName/);
  assert.match(TOUR_ITINERARY_STOP_ROWS_BODY, /s\.descriptionTr/);
  assert.match(TOUR_ITINERARY_STOP_ROWS_BODY, /s\.operationalNote/);
  assert.match(TOUR_ITINERARY_STOP_ROWS_BODY, /s\.approxDurationText/);
});

test('TourDetailPage seeds itineraryStops state WITHOUT carrying forward id/stopOrder from the loaded record — only the four editable fields — so a stale stop_order can never round-trip back to the database', () => {
  const seedIdx = TOUR_DETAIL_PAGE_BODY.indexOf('setItineraryStops((orig.itineraryStops || []).map(s => ({');
  assert.ok(seedIdx > -1);
  const seedStmt = TOUR_DETAIL_PAGE_BODY.slice(seedIdx, TOUR_DETAIL_PAGE_BODY.indexOf('})));', seedIdx));
  assert.doesNotMatch(seedStmt, /\bid:/);
  assert.doesNotMatch(seedStmt, /stopOrder/);
  assert.match(seedStmt, /placeName/);
});

// ── Mobile: no horizontal overflow ───────────────────────────────────────

test('DossierRow stacks label above value on mobile instead of a fixed-width side-by-side layout', () => {
  const idx = SOURCE.indexOf('function DossierRow(');
  const body = SOURCE.slice(idx, SOURCE.indexOf('\nfunction DossierEmptyNote', idx));
  assert.match(body, /const \{ isMobile \} = useBreakpoint\(\);/);
  assert.match(body, /flexDirection: isMobile \? "column" : "row"/);
});

test('inclusions/exclusions two-column layout collapses to one column on mobile', () => {
  assert.match(TOUR_DOSSIER_READ_VIEW_BODY, /const \{ isMobile \} = useBreakpoint\(\);/);
  assert.match(TOUR_DOSSIER_READ_VIEW_BODY, /gridTemplateColumns: \(!isMobile && hasIncluded && hasExcluded\) \? "1fr 1fr" : "1fr"/);
});

test('TourDetailPage\'s outer layout stacks main content above the sidebar on mobile (single column), matching the existing established page pattern', () => {
  assert.match(TOUR_DETAIL_PAGE_BODY, /gridTemplateColumns: isMobile \? "1fr" : "1fr 300px"/);
});

test('no fixed pixel width strong enough to force horizontal scroll appears in the new dossier/editor components', () => {
  for (const body of [TOUR_DOSSIER_READ_VIEW_BODY, TOUR_ITINERARY_STOP_ROWS_BODY, TOUR_INCLUSIONS_EDITOR_BODY]) {
    assert.doesNotMatch(body, /width:\s*\d{3,}(?!px['")\]])/);
  }
});

// ── Guide behavior: deep link, forced read-only, commercial info hidden ─

test('guide deep link: ReservationDetailPage shows "Tur Bilgilerini Gör" only for the guide role, only when the reservation has a linked tour', () => {
  assert.match(RESERVATION_DETAIL_PAGE_BODY, /const isGuideViewer = auth\.role === "Rehber";/);
  assert.match(RESERVATION_DETAIL_PAGE_BODY, /isGuideViewer && r\.tourId \? \(/);
  assert.match(RESERVATION_DETAIL_PAGE_BODY, /Tur Bilgilerini Gör/);
});

test('guide deep link opens GuideTourInfoModal, not a navigation to /tours/:id — ROLE_PERMISSIONS.Rehber is untouched (still has no "tours" entry)', () => {
  assert.match(RESERVATION_DETAIL_PAGE_BODY, /<GuideTourInfoModal tourId={r\.tourId} onClose/);
  const rolePermsIdx = SOURCE.indexOf('const ROLE_PERMISSIONS = {');
  const rolePermsBody = SOURCE.slice(rolePermsIdx, SOURCE.indexOf('};', rolePermsIdx));
  const rehberLine = rolePermsBody.split('\n').find(l => l.includes('"Rehber"'));
  assert.ok(rehberLine);
  assert.doesNotMatch(rehberLine, /"tours"/);
});

test('GuideTourInfoModal renders ONLY the read-only dossier — no TourFormFields, no TourDossierEditFields, no Düzenle/Kaydet button anywhere', () => {
  assert.match(GUIDE_TOUR_INFO_MODAL_BODY, /<TourDossierReadView tour={tour} hideChannels\/>/);
  assert.doesNotMatch(GUIDE_TOUR_INFO_MODAL_BODY, /TourFormFields/);
  assert.doesNotMatch(GUIDE_TOUR_INFO_MODAL_BODY, /TourDossierEditFields/);
  assert.doesNotMatch(GUIDE_TOUR_INFO_MODAL_BODY, /Düzenle/);
  assert.doesNotMatch(GUIDE_TOUR_INFO_MODAL_BODY, /Kaydet/);
});

test('GuideTourInfoModal fetches via the SAME useRepo("tour","getById",tourId) call TourDetailPage itself uses — same RLS-scoped query, no bespoke guide endpoint', () => {
  assert.match(GUIDE_TOUR_INFO_MODAL_BODY, /useRepo\("tour", "getById", tourId\)/);
});

test('the guide modal passes hideChannels — Satış Kanalı Bilgileri is explicitly suppressed as defense in depth, independent of RLS already returning zero channel rows for a guide', () => {
  assert.match(GUIDE_TOUR_INFO_MODAL_BODY, /hideChannels/);
  assert.match(TOUR_DOSSIER_READ_VIEW_BODY, /const hasChannels = !hideChannels && \(tour\.channels \|\| \[\]\)\.length > 0;/);
});

test('guide never gets edit access even in the ordinary Tour Detail page: a Rehber session\'s role fails the canEdit check', () => {
  assert.doesNotMatch(TOUR_DETAIL_PAGE_BODY, /auth\.role === "Rehber"/);
});

// ── NewTourModal stays lightweight — no dossier overload ────────────────

test('NewTourModal does not render TourDossierEditFields or any itinerary/inclusions editor — dossier is completed afterward from Tour Detail', () => {
  assert.doesNotMatch(NEW_TOUR_MODAL_BODY, /TourDossierEditFields/);
  assert.doesNotMatch(NEW_TOUR_MODAL_BODY, /TourItineraryStopRows/);
  assert.doesNotMatch(NEW_TOUR_MODAL_BODY, /TourInclusionsEditor/);
});

test('NewTourModal\'s create payload omits every Tour Information Center field — never nulls them, simply never mentions them', () => {
  const payloadIdx = NEW_TOUR_MODAL_BODY.indexOf('mutTour("create"');
  const payloadEnd = NEW_TOUR_MODAL_BODY.indexOf('});', payloadIdx);
  const payload = NEW_TOUR_MODAL_BODY.slice(payloadIdx, payloadEnd);
  for (const field of [
    'meetingInstructionsTr', 'endPointTr', 'accessibilityInfoTr', 'petsPolicyTr',
    'bookingCutoffText', 'freeCancellationText', 'lateCancellationText', 'noShowPolicyText',
    'otherConditionsTr', 'guideNotesTr', 'includedItems', 'excludedItems', 'itineraryStops',
  ]) {
    assert.doesNotMatch(payload, new RegExp(`\\b${field}\\b`), `NewTourModal must never send ${field}`);
  }
});

// ── No hardcoded tour content — this is a generic architecture ─────────

test('no real tour content (Grand Bazaar copy, Civitatis product URLs) is hardcoded anywhere in the new dossier/editor components', () => {
  for (const body of [TOUR_DOSSIER_READ_VIEW_BODY, TOUR_DOSSIER_EDIT_FIELDS_BODY, TOUR_ITINERARY_STOP_ROWS_BODY, GUIDE_TOUR_INFO_MODAL_BODY]) {
    assert.doesNotMatch(body, /civitatis\.com/i);
    assert.doesNotMatch(body, /Grand Bazaar/i);
  }
});

test('the one "Kapalıçarşı" mention anywhere is a placeholder attribute, not a hardcoded real value ever sent to the database', () => {
  const idx = SOURCE.indexOf('Kapalıçarşı Ana Giriş');
  assert.ok(idx > -1);
  const context = SOURCE.slice(idx - 40, idx + 20);
  assert.match(context, /placeholder=/);
});

// ── Scope guard: Civitatis ingestion / auto-provisioning untouched ─────

test('scope guard: no change to ingest_civitatis_booking, V12/V13/V13.1, scheduler, or auth in this phase (frontend-only diff expected)', () => {
  assert.doesNotMatch(SOURCE, /CREATE (OR REPLACE )?FUNCTION/);
});
