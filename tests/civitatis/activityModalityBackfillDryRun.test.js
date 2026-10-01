'use strict';
/**
 * tests/civitatis/activityModalityBackfillDryRun.test.js
 * ─────────────────────────────────────────────────────────────────────────
 * Tour Preparation Intelligence — Phase B2 backfill dry-run tests.
 *
 * Pure-function tests (selectAuthoritativeIngestion, extractActivity-
 * AndLanguage, buildDryRunRow, getIstanbulTodayISO) need no fake Supabase
 * client at all. The full runCivitatisActivityModalityBackfillDryRun
 * integration test uses a minimal, self-contained fake Supabase client —
 * not shared with anything under tests/whatsapp/ — that throws on any
 * call to .insert/.update/.delete/.rpc, so an accidental write anywhere
 * in this tool would fail the test immediately.
 *
 * Real fixture bodies are reused from tests/civitatis/fixtures.js where
 * they carry an evidenced Activity string; the "Tour com"/"Tour sem"
 * production-evidenced strings (no fixture in fixtures.js happens to
 * carry that exact suffix) are built as clearly-labeled synthetic email
 * bodies using exactly the real strings confirmed by the user in Phase
 * B1 — no language/phrase is fabricated beyond what has been evidenced.
 * ─────────────────────────────────────────────────────────────────────────
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  selectAuthoritativeIngestion,
  extractActivityAndLanguage,
  buildDryRunRow,
  getIstanbulTodayISO,
  runCivitatisActivityModalityBackfillDryRun,
  VALID_SCOPES,
} = require('../../api/_civitatis/activityModalityBackfillDryRun');

const { portugueseA40466869HourPlaceholderBooking } = require('./fixtures');

// ── selectAuthoritativeIngestion ─────────────────────────────────────────

test('selectAuthoritativeIngestion picks the newest processed, non-cancellation row', () => {
  const rows = [
    { id: 'a', event_type: 'new_booking', processing_status: 'processed', received_at: '2026-07-01T00:00:00Z', created_at: '2026-07-01T00:00:01Z' },
    { id: 'b', event_type: 'modified', processing_status: 'processed', received_at: '2026-08-01T00:00:00Z', created_at: '2026-08-01T00:00:01Z' },
  ];
  const selected = selectAuthoritativeIngestion(rows);
  assert.equal(selected.id, 'b');
});

test('selectAuthoritativeIngestion excludes cancellation events as an Activity source', () => {
  const rows = [
    { id: 'a', event_type: 'new_booking', processing_status: 'processed', received_at: '2026-07-01T00:00:00Z', created_at: '2026-07-01T00:00:01Z' },
    { id: 'c', event_type: 'cancelled', processing_status: 'processed', received_at: '2026-09-01T00:00:00Z', created_at: '2026-09-01T00:00:01Z' },
  ];
  const selected = selectAuthoritativeIngestion(rows);
  assert.equal(selected.id, 'a'); // the later but cancelled row is never selected
});

test('selectAuthoritativeIngestion ignores failed/needs_review/received rows (non-authoritative)', () => {
  const rows = [
    { id: 'a', event_type: 'new_booking', processing_status: 'processed', received_at: '2026-07-01T00:00:00Z', created_at: '2026-07-01T00:00:01Z' },
    { id: 'b', event_type: 'modified', processing_status: 'failed', received_at: '2026-08-01T00:00:00Z', created_at: '2026-08-01T00:00:01Z' },
    { id: 'c', event_type: 'modified', processing_status: 'needs_review', received_at: '2026-08-15T00:00:00Z', created_at: '2026-08-15T00:00:01Z' },
    { id: 'd', event_type: 'modified', processing_status: 'received', received_at: '2026-08-20T00:00:00Z', created_at: '2026-08-20T00:00:01Z' },
  ];
  const selected = selectAuthoritativeIngestion(rows);
  assert.equal(selected.id, 'a');
});

test('selectAuthoritativeIngestion deterministically tie-breaks on created_at then id when received_at ties', () => {
  const sameReceivedAt = '2026-08-01T00:00:00Z';
  const rows = [
    { id: 'x', event_type: 'modified', processing_status: 'processed', received_at: sameReceivedAt, created_at: '2026-08-01T00:00:01Z' },
    { id: 'y', event_type: 'modified', processing_status: 'processed', received_at: sameReceivedAt, created_at: '2026-08-01T00:00:02Z' },
  ];
  const selected = selectAuthoritativeIngestion(rows);
  assert.equal(selected.id, 'y'); // later created_at wins the tie
});

test('selectAuthoritativeIngestion returns null when there are zero eligible rows', () => {
  assert.equal(selectAuthoritativeIngestion([]), null);
  assert.equal(selectAuthoritativeIngestion([{ id: 'z', event_type: 'cancelled', processing_status: 'processed', received_at: '2026-01-01T00:00:00Z', created_at: '2026-01-01T00:00:00Z' }]), null);
  assert.equal(selectAuthoritativeIngestion(null), null);
});

// ── extractActivityAndLanguage ───────────────────────────────────────────

test('extractActivityAndLanguage pulls Activity and languageCode from a real fixture body', () => {
  const { activityRaw, languageCode } = extractActivityAndLanguage(portugueseA40466869HourPlaceholderBooking.body);
  assert.equal(activityRaw, 'Visita guiada pela Istambul imprescindível');
  assert.equal(languageCode, 'pt');
});

test('extractActivityAndLanguage extracts the real production "Tour com" Activity string verbatim', () => {
  const syntheticBody = [
    'Activity: Visita guiada pela Istambul imprescindível - Tour com',
    'Reservation number: 20130',
    'Language: Português',
    'Internal code: Estambul Historica',
  ].join('\n');
  const { activityRaw, languageCode } = extractActivityAndLanguage(syntheticBody);
  assert.equal(activityRaw, 'Visita guiada pela Istambul imprescindível - Tour com');
  assert.equal(languageCode, 'pt');
});

test('extractActivityAndLanguage returns nulls for a missing/empty body — never throws', () => {
  assert.deepEqual(extractActivityAndLanguage(null), { activityRaw: null, languageCode: null });
  assert.deepEqual(extractActivityAndLanguage(''), { activityRaw: null, languageCode: null });
  assert.deepEqual(extractActivityAndLanguage(undefined), { activityRaw: null, languageCode: null });
});

test('extractActivityAndLanguage never throws on a body with no Language: field', () => {
  const { activityRaw, languageCode } = extractActivityAndLanguage('Activity: Something\nNo language field here');
  assert.equal(activityRaw, 'Something');
  assert.equal(languageCode, null);
});

// ── buildDryRunRow ───────────────────────────────────────────────────────

const PT_RULES = [
  { id: 'rule-contains-com-almoco', language_code: 'pt', match_type: 'contains', match_text: 'com almoço', meal_status: 'included', is_active: true },
  { id: 'rule-contains-sem-almoco', language_code: 'pt', match_type: 'contains', match_text: 'sem almoço', meal_status: 'not_included', is_active: true },
  { id: 'rule-suffix-tour-com', language_code: 'pt', match_type: 'suffix_exact', match_text: 'Visita guiada pela Istambul imprescindível - Tour com', meal_status: 'included', is_active: true },
  { id: 'rule-suffix-tour-sem', language_code: 'pt', match_type: 'suffix_exact', match_text: 'Visita guiada pela Istambul imprescindível - Tour sem', meal_status: 'not_included', is_active: true },
];

function makeReservation(overrides) {
  return Object.assign({
    id: 'res-1',
    reservation_number: 'R-2026-0013',
    external_booking_id: '40466869',
    check_in: '2026-10-05',
    status: 'confirmed',
    tour_language: 'Portekizce',
    purchased_activity_raw: null,
    meal_status: 'unknown',
  }, overrides);
}

test('buildDryRunRow: Portuguese "Tour com" resolves to included, raw preserved exactly, would_change true from initial unknown state', () => {
  const candidateIngestions = [
    { id: 'ing-1', event_type: 'new_booking', processing_status: 'processed', received_at: '2026-09-01T00:00:00Z', created_at: '2026-09-01T00:00:01Z', raw_body_snapshot: 'Activity: Visita guiada pela Istambul imprescindível - Tour com\nLanguage: Português' },
  ];
  const row = buildDryRunRow({ reservation: makeReservation(), candidateIngestions, activeRules: PT_RULES });

  assert.equal(row.activity_raw, 'Visita guiada pela Istambul imprescindível - Tour com');
  assert.equal(row.proposed_meal_status, 'included');
  assert.equal(row.normalization_reason, 'matched');
  assert.equal(row.matched_rule_id, 'rule-suffix-tour-com');
  assert.equal(row.would_change, true);
  assert.equal(row.selected_ingestion_id, 'ing-1');
});

test('buildDryRunRow: Portuguese "Tour sem" resolves to not_included', () => {
  const candidateIngestions = [
    { id: 'ing-2', event_type: 'new_booking', processing_status: 'processed', received_at: '2026-09-01T00:00:00Z', created_at: '2026-09-01T00:00:01Z', raw_body_snapshot: 'Activity: Visita guiada pela Istambul imprescindível - Tour sem\nLanguage: Português' },
  ];
  const row = buildDryRunRow({ reservation: makeReservation({ id: 'res-2' }), candidateIngestions, activeRules: PT_RULES });

  assert.equal(row.proposed_meal_status, 'not_included');
  assert.equal(row.normalization_reason, 'matched');
});

test('buildDryRunRow: Spanish Grand Bazaar resolves to unknown but RAW ACTIVITY IS STILL PRESERVED', () => {
  const candidateIngestions = [
    { id: 'ing-3', event_type: 'new_booking', processing_status: 'processed', received_at: '2026-09-01T00:00:00Z', created_at: '2026-09-01T00:00:01Z', raw_body_snapshot: 'Activity: Tour por el Gran Bazar - Tour en español\nLanguage: Español' },
  ];
  const row = buildDryRunRow({ reservation: makeReservation({ id: 'res-3' }), candidateIngestions, activeRules: PT_RULES });

  assert.equal(row.activity_raw, 'Tour por el Gran Bazar - Tour en español');
  assert.equal(row.proposed_meal_status, 'unknown');
  assert.equal(row.normalization_reason, 'no_match');
  // Absence of meal wording is never interpreted as not_included.
  assert.notEqual(row.proposed_meal_status, 'not_included');
});

test('buildDryRunRow: Italian Grand Bazaar resolves to unknown, raw preserved', () => {
  const candidateIngestions = [
    { id: 'ing-4', event_type: 'new_booking', processing_status: 'processed', received_at: '2026-09-01T00:00:00Z', created_at: '2026-09-01T00:00:01Z', raw_body_snapshot: 'Activity: Tour del Grande Bazar - Tour in italiano\nLanguage: Italiano' },
  ];
  const row = buildDryRunRow({ reservation: makeReservation({ id: 'res-4' }), candidateIngestions, activeRules: PT_RULES });

  assert.equal(row.activity_raw, 'Tour del Grande Bazar - Tour in italiano');
  assert.equal(row.proposed_meal_status, 'unknown');
});

test('buildDryRunRow: Portuguese Bosphorus (no evidenced meal wording) resolves to unknown, raw preserved', () => {
  const candidateIngestions = [
    { id: 'ing-5', event_type: 'new_booking', processing_status: 'processed', received_at: '2026-09-01T00:00:00Z', created_at: '2026-09-01T00:00:01Z', raw_body_snapshot: 'Activity: Cruzeiro pelo Bósforo + Mesquita Azul + Santa Sofia -\nLanguage: Português' },
  ];
  const row = buildDryRunRow({ reservation: makeReservation({ id: 'res-5' }), candidateIngestions, activeRules: PT_RULES });

  assert.equal(row.activity_raw, 'Cruzeiro pelo Bósforo + Mesquita Azul + Santa Sofia -');
  assert.equal(row.proposed_meal_status, 'unknown');
  assert.equal(row.normalization_reason, 'no_match');
});

test('buildDryRunRow: would_change is false when current persisted state already matches the proposal', () => {
  const candidateIngestions = [
    { id: 'ing-6', event_type: 'new_booking', processing_status: 'processed', received_at: '2026-09-01T00:00:00Z', created_at: '2026-09-01T00:00:01Z', raw_body_snapshot: 'Activity: Visita guiada pela Istambul imprescindível - Tour com\nLanguage: Português' },
  ];
  const reservation = makeReservation({
    purchased_activity_raw: 'Visita guiada pela Istambul imprescindível - Tour com',
    meal_status: 'included',
  });
  const row = buildDryRunRow({ reservation, candidateIngestions, activeRules: PT_RULES });
  assert.equal(row.would_change, false);
});

test('buildDryRunRow: no eligible ingestion row at all -> unknown, null raw, selected_ingestion_id null', () => {
  const row = buildDryRunRow({ reservation: makeReservation({ id: 'res-7' }), candidateIngestions: [], activeRules: PT_RULES });
  assert.equal(row.activity_raw, null);
  assert.equal(row.proposed_meal_status, 'unknown');
  assert.equal(row.normalization_reason, 'missing_activity');
  assert.equal(row.selected_ingestion_id, null);
});

test('buildDryRunRow report row includes every required field', () => {
  const row = buildDryRunRow({ reservation: makeReservation(), candidateIngestions: [], activeRules: PT_RULES });
  const expectedFields = [
    'reservation_id', 'reservation_number', 'external_booking_id', 'check_in',
    'reservation_status', 'tour_language', 'selected_ingestion_id', 'selected_received_at',
    'activity_raw', 'current_purchased_activity_raw', 'current_meal_status',
    'proposed_meal_status', 'normalization_reason', 'matched_rule_id', 'would_change',
  ];
  for (const field of expectedFields) {
    assert.ok(Object.prototype.hasOwnProperty.call(row, field), `missing report field: ${field}`);
  }
});

// ── getIstanbulTodayISO ──────────────────────────────────────────────────

test('getIstanbulTodayISO returns a plain YYYY-MM-DD string', () => {
  const iso = getIstanbulTodayISO(new Date('2026-10-01T10:00:00Z'));
  assert.match(iso, /^\d{4}-\d{2}-\d{2}$/);
});

test('getIstanbulTodayISO rolls over at the correct Istanbul-local boundary, not UTC', () => {
  // 2026-10-01 22:30 UTC is already 2026-10-02 01:30 in Istanbul (UTC+3).
  const iso = getIstanbulTodayISO(new Date('2026-10-01T22:30:00Z'));
  assert.equal(iso, '2026-10-02');
});

// ── runCivitatisActivityModalityBackfillDryRun (integration, fake client) ─

function makeWriteGuardedFakeSupabase({ sourceRow, reservations, ingestionsByBooking, rulesRows }) {
  function guardedWrite(name) {
    return () => { throw new Error(`UNEXPECTED WRITE CALL in dry run: ${name}() must never be called`); };
  }
  const reservationsQueryCalls = { eq: [], gte: [], neq: [] };
  return {
    reservationsQueryCalls,
    from(table) {
      if (table === 'sources') {
        return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: sourceRow, error: null }) }) }), insert: guardedWrite('insert'), update: guardedWrite('update'), delete: guardedWrite('delete') };
      }
      if (table === 'reservations') {
        const builder = {
          select() { return builder; },
          eq(col, val) { reservationsQueryCalls.eq.push([col, val]); return builder; },
          gte(col, val) { reservationsQueryCalls.gte.push([col, val]); return builder; },
          neq(col, val) { reservationsQueryCalls.neq.push([col, val]); return builder; },
          then(resolve) { return resolve({ data: reservations, error: null }); },
          insert: guardedWrite('insert'), update: guardedWrite('update'), delete: guardedWrite('delete'),
        };
        return builder;
      }
      if (table === 'email_ingestions') {
        let bookingId = null;
        const builder = {
          select() { return builder; },
          eq(col, val) { if (col === 'external_booking_id') bookingId = val; return builder; },
          then(resolve) { return resolve({ data: ingestionsByBooking[bookingId] || [], error: null }); },
          insert: guardedWrite('insert'), update: guardedWrite('update'), delete: guardedWrite('delete'),
        };
        return builder;
      }
      if (table === 'civitatis_activity_modality_map') {
        const builder = {
          select() { return builder; },
          eq() { return builder; },
          then(resolve) { return resolve({ data: rulesRows, error: null }); },
          insert: guardedWrite('insert'), update: guardedWrite('update'), delete: guardedWrite('delete'),
        };
        return builder;
      }
      throw new Error(`unexpected table in dry-run test fake: ${table}`);
    },
    rpc: guardedWrite('rpc'),
  };
}

/**
 * Loads a fresh copy of activityModalityBackfillDryRun.js with the
 * service-role client stubbed EVERYWHERE './supabaseAdmin' is required —
 * not just by this module directly, but also by activityModalityRules.js,
 * which it depends on and which independently requires the same file.
 * Pre-seeds require.cache for the resolved supabaseAdmin.js path with the
 * stubbed exports BEFORE any dependent module's own top-level
 * `require('./supabaseAdmin')` runs, so every one of them resolves to the
 * same fake — a plain Module._load intercept keyed to a single parent
 * file is not enough once more than one file in the same directory
 * requires the same dependency.
 */
function loadDryRunModuleWithFakeClient(fakeClient) {
  const modPath = require.resolve('../../api/_civitatis/activityModalityBackfillDryRun.js');
  const rulesPath = require.resolve('../../api/_civitatis/activityModalityRules.js');
  const adminPath = require.resolve('../../api/_civitatis/supabaseAdmin.js');

  const realAdminExports = require(adminPath);
  const stubbedAdmin = Object.assign({}, realAdminExports, {
    getServiceRoleClient: () => fakeClient,
  });

  delete require.cache[modPath];
  delete require.cache[rulesPath];
  const previousAdminModule = require.cache[adminPath];
  require.cache[adminPath] = { id: adminPath, filename: adminPath, loaded: true, exports: stubbedAdmin };

  try {
    return require(modPath);
  } finally {
    delete require.cache[modPath];
    delete require.cache[rulesPath];
    if (previousAdminModule) require.cache[adminPath] = previousAdminModule;
    else delete require.cache[adminPath];
  }
}

test('runCivitatisActivityModalityBackfillDryRun: future_active excludes a cancelled reservation', async () => {
  const sourceRow = { id: 'src-civitatis' };
  const reservations = [
    makeReservation({ id: 'res-active', status: 'confirmed', external_booking_id: '111' }),
  ]; // the fake's reservations query already simulates .neq('status','cancelled') server-side by only returning non-cancelled rows
  const ingestionsByBooking = { '111': [{ id: 'ing-a', event_type: 'new_booking', processing_status: 'processed', received_at: '2026-09-01T00:00:00Z', created_at: '2026-09-01T00:00:01Z', raw_body_snapshot: 'Activity: Visita guiada pela Istambul imprescindível - Tour com\nLanguage: Português' }] };
  const fake = makeWriteGuardedFakeSupabase({ sourceRow, reservations, ingestionsByBooking, rulesRows: PT_RULES });
  const { runCivitatisActivityModalityBackfillDryRun: run } = loadDryRunModuleWithFakeClient(fake);

  const report = await run({ scope: 'future_active' });

  assert.equal(report.scope, 'future_active');
  assert.equal(report.rows.length, 1);
  assert.equal(report.rows[0].reservation_status, 'confirmed');
  // The actual server-side exclusion query was issued, not just assumed:
  assert.deepEqual(fake.reservationsQueryCalls.neq[0], ['status', 'cancelled']);
  assert.equal(fake.reservationsQueryCalls.gte[0][0], 'check_in');
  assert.match(fake.reservationsQueryCalls.gte[0][1], /^\d{4}-\d{2}-\d{2}$/);
});

test('runCivitatisActivityModalityBackfillDryRun: scope=all issues no check_in/status filter at all', async () => {
  const sourceRow = { id: 'src-civitatis' };
  const reservations = [makeReservation({ id: 'r1', status: 'cancelled', external_booking_id: '999' })];
  const fake = makeWriteGuardedFakeSupabase({ sourceRow, reservations, ingestionsByBooking: { '999': [] }, rulesRows: PT_RULES });
  const { runCivitatisActivityModalityBackfillDryRun: run } = loadDryRunModuleWithFakeClient(fake);

  const report = await run({ scope: 'all' });

  assert.equal(report.rows.length, 1); // cancelled reservation IS included under 'all'
  assert.deepEqual(fake.reservationsQueryCalls.neq, []);
  assert.deepEqual(fake.reservationsQueryCalls.gte, []);
});

test('runCivitatisActivityModalityBackfillDryRun: zero writes occur even across a full multi-reservation run', async () => {
  const sourceRow = { id: 'src-civitatis' };
  const reservations = [
    makeReservation({ id: 'r1', external_booking_id: '111' }),
    makeReservation({ id: 'r2', external_booking_id: '222' }),
  ];
  const ingestionsByBooking = {
    '111': [{ id: 'i1', event_type: 'new_booking', processing_status: 'processed', received_at: '2026-09-01T00:00:00Z', created_at: '2026-09-01T00:00:01Z', raw_body_snapshot: 'Activity: Visita guiada pela Istambul imprescindível - Tour com\nLanguage: Português' }],
    '222': [{ id: 'i2', event_type: 'new_booking', processing_status: 'processed', received_at: '2026-09-01T00:00:00Z', created_at: '2026-09-01T00:00:01Z', raw_body_snapshot: 'Activity: Tour por el Gran Bazar - Tour en español\nLanguage: Español' }],
  };
  const fake = makeWriteGuardedFakeSupabase({ sourceRow, reservations, ingestionsByBooking, rulesRows: PT_RULES });
  const { runCivitatisActivityModalityBackfillDryRun: run } = loadDryRunModuleWithFakeClient(fake);

  // Would throw if the tool ever called insert/update/delete/rpc.
  const report = await run({ scope: 'all' });
  assert.equal(report.rows.length, 2);
});

test('an unknown scope is rejected before any Supabase call is made', async () => {
  const fake = makeWriteGuardedFakeSupabase({ sourceRow: { id: 'x' }, reservations: [], ingestionsByBooking: {}, rulesRows: [] });
  const { runCivitatisActivityModalityBackfillDryRun: run } = loadDryRunModuleWithFakeClient(fake);

  await assert.rejects(() => run({ scope: 'bogus_scope' }), /Unknown backfill dry-run scope/);
});

test('VALID_SCOPES is exactly future_active and all', () => {
  assert.deepEqual(VALID_SCOPES.slice().sort(), ['all', 'future_active']);
});

function codeOnlyLines(source) {
  return source.split('\n').filter((l) => {
    const t = l.trim();
    return !t.startsWith('*') && !t.startsWith('//') && !t.startsWith('/**');
  }).join('\n');
}

test('this module never REQUIRES activityModalityPersistence.js (dry run never persists)', () => {
  const fs = require('fs');
  const implSource = fs.readFileSync(require.resolve('../../api/_civitatis/activityModalityBackfillDryRun.js'), 'utf8');
  // The header docblock legitimately NAMES activityModalityPersistence.js
  // in prose (explaining that it is NOT imported) — the real guarantee is
  // that no require() statement actually pulls it in.
  assert.doesNotMatch(codeOnlyLines(implSource), /require\([^)]*activityModalityPersistence/);
});

test('this module contains no executable .insert(/.update(/.delete(/.rpc( call anywhere in its own source', () => {
  const fs = require('fs');
  const implSource = fs.readFileSync(require.resolve('../../api/_civitatis/activityModalityBackfillDryRun.js'), 'utf8');
  const code = codeOnlyLines(implSource);
  assert.doesNotMatch(code, /\.insert\(/);
  assert.doesNotMatch(code, /\.update\(/);
  assert.doesNotMatch(code, /\.delete\(/);
  assert.doesNotMatch(code, /\.rpc\(/);
});
