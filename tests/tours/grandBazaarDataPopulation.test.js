'use strict';
/**
 * tests/tours/grandBazaarDataPopulation.test.js
 * ─────────────────────────────────────────────────────────────────────────
 * Regression coverage for the one-time Grand Bazaar Experience · İspanyolca
 * Tour Information Center data population and its rollback. NOT YET
 * APPLIED to any database — explicitly withheld pending manual approval,
 * exactly like every prior migration's own test file in this repository.
 * Every test here is a pure, static, never-executed text assertion
 * against the prepared .sql files. Nothing in this file connects to a
 * database or runs any SQL.
 * ─────────────────────────────────────────────────────────────────────────
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const FORWARD_PATH  = path.join(ROOT, 'supabase_data_grand_bazaar_spanish_tour_information.sql');
const ROLLBACK_PATH = path.join(ROOT, 'supabase_data_grand_bazaar_spanish_tour_information_ROLLBACK.sql');

const forward  = fs.readFileSync(FORWARD_PATH, 'utf8');
const rollback = fs.readFileSync(ROLLBACK_PATH, 'utf8');

const TARGET_TOUR_ID = 'c5e42d88-0a6c-4703-9c22-90eec5a278bd';
const CIVITATIS_URL = 'https://www.civitatis.com/es/estambul/tour-gran-bazar';

const EXPECTED_STOP_NAMES = [
  'Çemberlitaş Tramvay İstasyonu', 'Kalpakçılar Caddesi', 'Tarihi Hanlar', 'Büyük Valide Han',
  'Kızlarağası Han', 'Sandal Bedesteni', 'Halıcılar Sokak', 'Sahaflar Çarşısı', 'Şark Kahvesi', 'Grand Bazaar',
];

// The 9 of the 10 Phase-2 Tour Information Center TEXT columns this population
// actually writes. meeting_instructions_tr is deliberately excluded: the task
// supplied content only for the pre-existing meeting_point column (corrected
// from "Çemberlitaş Metro Durağı" to "Çemberlitaş Tramvay İstasyonu"), not for
// meeting_instructions_tr, so it is left untouched (structurally NULL, same as
// before this population) rather than populated with unsupplied content.
const TIC_TEXT_COLUMNS = [
  'end_point_tr', 'accessibility_info_tr', 'pets_policy_tr',
  'booking_cutoff_text', 'free_cancellation_text', 'late_cancellation_text',
  'no_show_policy_text', 'other_conditions_tr', 'guide_notes_tr',
];

// Extracts the single UPDATE public.<table> ... WHERE ...; statement, anchored to the
// real statement (not any "WHERE id = ..." text that may appear in header prose earlier
// in the file) by searching for WHERE/the terminating ";" only after the UPDATE keyword.
function extractUpdateStatement(text, table = 'tours') {
  const updateIdx = text.indexOf(`UPDATE public.${table}`);
  assert.ok(updateIdx !== -1, `expected to find UPDATE public.${table}`);
  const whereIdx = text.indexOf('WHERE', updateIdx);
  assert.ok(whereIdx !== -1, 'expected a WHERE clause after the UPDATE');
  const semiIdx = text.indexOf(';', whereIdx);
  assert.ok(semiIdx !== -1, 'expected a terminating ; after the WHERE clause');
  return text.slice(updateIdx, semiIdx + 1);
}

// ── A. File structure: transactional, balanced ──────────────────────────

test('forward file is wrapped in exactly one BEGIN;/COMMIT; pair, no stray ROLLBACK', () => {
  assert.equal((forward.match(/^BEGIN;\s*$/gm) || []).length, 1);
  assert.equal((forward.match(/^COMMIT;\s*$/gm) || []).length, 1);
  assert.doesNotMatch(forward, /^ROLLBACK/m);
});

test('forward file dollar-quoting is balanced (preflight + postflight DO blocks)', () => {
  const dollarLines = forward.split('\n').filter(l => l.includes('$$'));
  assert.equal(dollarLines.length, 4, `expected exactly 4 lines containing $$, found ${dollarLines.length}`);
});

test('rollback file is wrapped in exactly one BEGIN;/COMMIT; pair, dollar-quoting balanced (4 DO blocks: preflight, scalar drift guard, itinerary drift guard, postflight)', () => {
  assert.equal((rollback.match(/^BEGIN;\s*$/gm) || []).length, 1);
  assert.equal((rollback.match(/^COMMIT;\s*$/gm) || []).length, 1);
  const dollarLines = rollback.split('\n').filter(l => l.includes('$$'));
  assert.equal(dollarLines.length, 8, 'expected exactly 8 lines containing $$ (4 DO blocks)');
});

test('neither file contains DROP, TRUNCATE, ALTER, or CREATE — this is data population, not schema', () => {
  for (const file of [forward, rollback]) {
    assert.doesNotMatch(file, /\bDROP\s+(TABLE|COLUMN|FUNCTION|INDEX|TRIGGER|POLICY)\b/i);
    assert.doesNotMatch(file, /\bTRUNCATE\b/i);
    assert.doesNotMatch(file, /\bALTER\s+TABLE\b/i);
    assert.doesNotMatch(file, /\bCREATE\s+(TABLE|FUNCTION|TRIGGER|POLICY|INDEX)\b/i);
  }
});

// ── B. Targeting: exact UUID, fails closed on any mismatch ─────────────

test('forward preflight resolves the tour by the exact target UUID and verifies its name', () => {
  const preflightIdx = forward.indexOf('DO $$');
  const preflight = forward.slice(preflightIdx, forward.indexOf('END $$;', preflightIdx));
  assert.match(preflight, new RegExp(`v_tour_id\\s+UUID\\s*:=\\s*'${TARGET_TOUR_ID}'`));
  assert.match(preflight, /IF v_tour_name IS NULL THEN/);
  assert.match(preflight, /RAISE EXCEPTION[^;]*tour % does not exist/);
  assert.match(preflight, /IF v_tour_name IS DISTINCT FROM 'Grand Bazaar Experience' THEN/);
  assert.match(preflight, /RAISE EXCEPTION[^;]*wrong tour/);
});

test('forward preflight verifies exactly one Civitatis tour_channels row with booking_language=İspanyolca and the exact known listing_url, aborting on any mismatch', () => {
  const preflightIdx = forward.indexOf('DO $$');
  const preflight = forward.slice(preflightIdx, forward.indexOf('END $$;', preflightIdx));
  assert.match(preflight, /SELECT COUNT\(\*\) INTO v_channel_count FROM public\.tour_channels WHERE tour_id = v_tour_id;/);
  assert.match(preflight, /IF v_channel_count <> 1 THEN/);
  assert.match(preflight, /JOIN public\.sources s ON s\.id = tc\.source_id/);
  assert.match(preflight, /IF v_source_name IS DISTINCT FROM 'Civitatis' THEN/);
  assert.match(preflight, /IF v_booking_language IS DISTINCT FROM 'İspanyolca' THEN/);
  assert.match(preflight, new RegExp(`IF v_listing_url IS DISTINCT FROM '${CIVITATIS_URL.replace(/\//g, '\\/')}' THEN`));
});

test('every write statement in the forward file is scoped to the exact target UUID literal — no other tour can ever be touched', () => {
  const updateMatch = forward.match(/UPDATE public\.tours\s*\n\s*SET[\s\S]*?WHERE id = '([0-9a-f-]+)';/);
  assert.ok(updateMatch, 'expected exactly one UPDATE public.tours statement');
  assert.equal(updateMatch[1], TARGET_TOUR_ID);

  const deleteMatch = forward.match(/DELETE FROM public\.tour_itinerary_stops WHERE tour_id = '([0-9a-f-]+)';/);
  assert.ok(deleteMatch);
  assert.equal(deleteMatch[1], TARGET_TOUR_ID);

  // Every VALUES row in the INSERT must start with the exact same UUID.
  const insertBlock = forward.slice(forward.indexOf('INSERT INTO public.tour_itinerary_stops'), forward.indexOf(';\n\n\n-- ──', forward.indexOf('INSERT INTO public.tour_itinerary_stops')) + 1);
  const rowUuids = [...insertBlock.matchAll(/\('([0-9a-f-]+)',\s*\d+,/g)].map(m => m[1]);
  assert.equal(rowUuids.length, 10, 'expected 10 itinerary VALUES rows');
  for (const id of rowUuids) assert.equal(id, TARGET_TOUR_ID);
});

test('the forward UPDATE has exactly ONE WHERE clause and it is not a multi-row-capable condition (no IN, no LIKE, no OR)', () => {
  const stmt = extractUpdateStatement(forward);
  assert.doesNotMatch(stmt, /\bIN\s*\(/);
  assert.doesNotMatch(stmt, /\bLIKE\b/i);
  assert.doesNotMatch(stmt, /\bOR\b/);
  assert.equal((stmt.match(/WHERE/g) || []).length, 1);
});

// ── C. tour_channels / tour_languages are read-only in both files ──────

test('forward file never writes to tour_channels or tour_languages — read-only preflight/postflight verification only', () => {
  assert.doesNotMatch(forward, /UPDATE public\.tour_channels/);
  assert.doesNotMatch(forward, /INSERT INTO public\.tour_channels/);
  assert.doesNotMatch(forward, /DELETE FROM public\.tour_channels/);
  assert.doesNotMatch(forward, /UPDATE public\.tour_languages/);
  assert.doesNotMatch(forward, /INSERT INTO public\.tour_languages/);
  assert.doesNotMatch(forward, /DELETE FROM public\.tour_languages/);
});

test('rollback file never writes to tour_channels or tour_languages either', () => {
  assert.doesNotMatch(rollback, /UPDATE public\.tour_channels/);
  assert.doesNotMatch(rollback, /INSERT INTO public\.tour_channels/);
  assert.doesNotMatch(rollback, /DELETE FROM public\.tour_channels/);
  assert.doesNotMatch(rollback, /UPDATE public\.tour_languages/);
  assert.doesNotMatch(rollback, /INSERT INTO public\.tour_languages/);
  assert.doesNotMatch(rollback, /DELETE FROM public\.tour_languages/);
});

test('neither file references reservations, customers, reservation_guests, payments, reservation_reviews, guides, or guide_payments', () => {
  for (const t of ['reservations', 'customers', 'reservation_guests', 'payments', 'reservation_reviews', 'guides', 'guide_payments']) {
    assert.doesNotMatch(forward, new RegExp(`public\\.${t}\\b`));
    assert.doesNotMatch(rollback, new RegExp(`public\\.${t}\\b`));
  }
});

test('neither file references tours.notes — that column stays completely untouched, per the standing Tour Information Center decision', () => {
  // Scoped to the executable SQL body (from BEGIN; onward) — the header
  // comments discuss tours.notes and its verified snapshot value in prose,
  // which would otherwise false-positive against this same check.
  assert.doesNotMatch(forward.slice(forward.indexOf('BEGIN;')), /\bnotes\s*=/);
  assert.doesNotMatch(rollback.slice(rollback.indexOf('BEGIN;')), /\bnotes\s*=/);
});

test('the forward UPDATE never sets name, category, status, base_price, currency, pricing_type, tour_type, maximum_guest_capacity, or is_active', () => {
  const stmt = extractUpdateStatement(forward);
  for (const col of ['name', 'category', 'status', 'base_price', 'currency', 'pricing_type', 'tour_type', 'maximum_guest_capacity', 'is_active']) {
    assert.doesNotMatch(stmt, new RegExp(`\\b${col}\\s*=`), `must not set ${col}`);
  }
});

// ── D. Exact field values ────────────────────────────────────────────────

test('duration_text is set to exactly "4 Saat"', () => {
  assert.match(forward, /duration_text = '4 Saat'/);
});

test('meeting_point is corrected to "Çemberlitaş Tramvay İstasyonu" (not the prior "Metro" value)', () => {
  assert.match(forward, /meeting_point = 'Çemberlitaş Tramvay İstasyonu'/);
  const updateStmt = extractUpdateStatement(forward);
  assert.doesNotMatch(updateStmt, /Metro/);
});

test('end_point_tr is set to "Grand Bazaar"', () => {
  assert.match(forward, /end_point_tr = 'Grand Bazaar'/);
});

test('included_items is set to exactly the two source-supported items, no more, no fewer', () => {
  assert.match(forward, /included_items = ARRAY\['İspanyolca konuşan rehber', 'Bir adet geleneksel Türk çayı'\]::TEXT\[\]/);
});

test('excluded_items is NULL — no exclusions are invented, since the Civitatis source lists none', () => {
  assert.match(forward, /excluded_items = NULL,/);
});

test('all ten Tour Information Center TEXT columns receive a value in the forward UPDATE (none silently skipped)', () => {
  const stmt = extractUpdateStatement(forward);
  for (const col of TIC_TEXT_COLUMNS) {
    assert.match(stmt, new RegExp(`${col}\\s*=`), `expected ${col} to be set`);
  }
});

test('other_conditions_tr states ONLY the source-supported minimum-participant rule — no invented conditions', () => {
  assert.match(forward, /other_conditions_tr = 'Turun gerçekleşmesi için minimum 2 katılımcı gereklidir\./);
});

// ── E. guide_notes_tr: Dese Tour internal, never marketplace-derived ───

test('guide_notes_tr carries the approved Dese Tour internal operational standard, never Civitatis marketing language', () => {
  const stmt = extractUpdateStatement(forward);
  assert.match(stmt, /guide_notes_tr = 'Turun alışveriş odaklı bir deneyime dönüşmemesine dikkat edilmelidir\./);
  assert.match(stmt, /komisyon odaklı mağaza yönlendirmelerinden kaçınılmalıdır/);
});

test('guide_notes_tr and description are two distinct literal strings — internal guidance is never blended into the marketplace-derived overview', () => {
  const descMatch = forward.match(/description = '([^']*(?:''[^']*)*)',/);
  const guideMatch = forward.match(/guide_notes_tr = '([^']*(?:''[^']*)*)'\s*\n WHERE/);
  assert.ok(descMatch && guideMatch);
  assert.notEqual(descMatch[1], guideMatch[1]);
});

// ── F. Itinerary: 10 stops, exact order, no fabricated durations ───────

test('the itinerary replace-all follows the same delete-then-insert convention as the application\'s own _syncTourItineraryStops', () => {
  const deleteIdx = forward.indexOf('DELETE FROM public.tour_itinerary_stops');
  const insertIdx = forward.indexOf('INSERT INTO public.tour_itinerary_stops');
  assert.ok(deleteIdx > -1 && insertIdx > deleteIdx, 'DELETE must come before INSERT');
});

test('exactly 10 itinerary stops are inserted, in stop_order 1 through 10', () => {
  const insertBlock = forward.slice(forward.indexOf('INSERT INTO public.tour_itinerary_stops'), forward.indexOf(';\n\n\n-- ──', forward.indexOf('INSERT INTO public.tour_itinerary_stops')) + 1);
  const orders = [...insertBlock.matchAll(/'[0-9a-f-]+',\s*(\d+),/g)].map(m => Number(m[1]));
  assert.deepEqual(orders, [1,2,3,4,5,6,7,8,9,10]);
});

test('itinerary stop place_names match the expected sequence exactly, in order', () => {
  const insertBlock = forward.slice(forward.indexOf('INSERT INTO public.tour_itinerary_stops'), forward.indexOf(';\n\n\n-- ──', forward.indexOf('INSERT INTO public.tour_itinerary_stops')) + 1);
  const names = [...insertBlock.matchAll(/'[0-9a-f-]+',\s*\d+,\s*'([^']+)',/g)].map(m => m[1]);
  assert.deepEqual(names, EXPECTED_STOP_NAMES);
});

test('no itinerary stop has an approx_duration_text value — Civitatis provides none, so none is fabricated', () => {
  const insertIdx = forward.indexOf('INSERT INTO public.tour_itinerary_stops');
  const valuesIdx = forward.indexOf('VALUES', insertIdx);
  const insertBlock = forward.slice(valuesIdx, forward.indexOf(';\n\n\n-- ──', insertIdx) + 1);
  // Every row must end in ", NULL, NULL)" — operational_note, approx_duration_text.
  // (Sliced from VALUES onward so the column-name list "(tour_id, stop_order, ...,
  // approx_duration_text)" is never mistaken for a data row.)
  const rows = insertBlock.match(/\([^()]*\)/g) || [];
  assert.equal(rows.length, 10, 'expected exactly 10 VALUES rows');
  for (const row of rows) {
    assert.match(row, /,\s*NULL,\s*NULL\)$/, `expected row to end with NULL operational_note and NULL approx_duration_text: ${row}`);
  }
});

test('postflight explicitly re-verifies the itinerary count (10), the exact ordered name sequence, and that no stop has a non-NULL approx_duration_text', () => {
  const postflightIdx = forward.lastIndexOf('DO $$');
  const postflight = forward.slice(postflightIdx);
  assert.match(postflight, /IF v_stop_count <> 10 THEN/);
  assert.match(postflight, /array_agg\(place_name ORDER BY stop_order\)/);
  assert.match(postflight, /approx_duration_text IS NOT NULL/);
});

// ── G. Postflight verifies tour_channels/tour_languages unchanged ──────

test('forward postflight re-verifies tour_channels row count, booking_language, and listing_url are unchanged', () => {
  const postflightIdx = forward.lastIndexOf('DO $$');
  const postflight = forward.slice(postflightIdx);
  assert.match(postflight, /SELECT COUNT\(\*\) INTO v_channel_count FROM public\.tour_channels WHERE tour_id = v_tour_id;/);
  assert.match(postflight, /IF v_channel_count <> 1 THEN/);
  assert.match(postflight, /booking_language = 'İspanyolca'/);
  assert.match(postflight, new RegExp(`listing_url = '${CIVITATIS_URL.replace(/\//g, '\\/')}'`));
});

test('forward postflight re-verifies tour_languages was not emptied', () => {
  const postflightIdx = forward.lastIndexOf('DO $$');
  const postflight = forward.slice(postflightIdx);
  assert.match(postflight, /SELECT COUNT\(\*\) INTO v_language_count FROM public\.tour_languages WHERE tour_id = v_tour_id;/);
  assert.match(postflight, /IF v_language_count < 1 THEN/);
});

// ── H. Rollback: verified production snapshot, drift guards, exact scope ─

test('rollback restores description to the verified production value "Deneme deneme"', () => {
  const stmt = extractUpdateStatement(rollback);
  assert.match(stmt, /description = 'Deneme deneme'/);
});

test('rollback restores duration_text to the verified production value "4 Saat" (a no-op relative to the forward migration, which writes the same string)', () => {
  const stmt = extractUpdateStatement(rollback);
  assert.match(stmt, /duration_text = '4 Saat'/);
});

test('rollback restores meeting_point to the verified production value "Çemberlitaş Metro Durağı"', () => {
  const stmt = extractUpdateStatement(rollback);
  assert.match(stmt, /meeting_point = 'Çemberlitaş Metro Durağı'/);
});

test('rollback restores every Tour Information Center TEXT column (including meeting_instructions_tr, which the forward migration never wrote) to NULL', () => {
  const stmt = extractUpdateStatement(rollback);
  for (const col of [...TIC_TEXT_COLUMNS, 'meeting_instructions_tr']) {
    assert.match(stmt, new RegExp(`${col} = NULL`), `expected ${col} restored to NULL`);
  }
});

test('rollback restores included_items to NULL', () => {
  const stmt = extractUpdateStatement(rollback);
  assert.match(stmt, /included_items = NULL/);
});

test('rollback restores excluded_items to NULL', () => {
  const stmt = extractUpdateStatement(rollback);
  assert.match(stmt, /excluded_items = NULL/);
});

test('rollback restores guide_notes_tr to NULL', () => {
  const stmt = extractUpdateStatement(rollback);
  assert.match(stmt, /guide_notes_tr = NULL/);
});

test('rollback removes all itinerary rows for the target tour, restoring the verified zero-row pre-population state', () => {
  assert.match(rollback, new RegExp(`DELETE FROM public\\.tour_itinerary_stops WHERE tour_id = '${TARGET_TOUR_ID}';`));
});

test('rollback never references tours.notes — the verified snapshot value "Deneme" is explicitly out of scope and is never written by this rollback', () => {
  // Scoped to the executable SQL body (from BEGIN; onward) — the header
  // comments discuss the verified 'Deneme' notes snapshot value in prose,
  // which would otherwise false-positive against this same check.
  const body = rollback.slice(rollback.indexOf('BEGIN;'));
  assert.doesNotMatch(body, /\bnotes\s*=/);
  assert.doesNotMatch(body, /'Deneme'/);
});

test('the old duration_text sentinel and its forced-exception guard no longer exist anywhere in the rollback — duration_text is now a verified, unblocked restoration', () => {
  assert.doesNotMatch(rollback, /REPLACE_ME/);
  assert.doesNotMatch(rollback, /GRAND BAZAAR ROLLBACK BLOCKED/);
});

test('rollback has a scalar drift guard that runs before the destructive UPDATE, re-verifying every Tour Information Center field still matches what the forward migration wrote', () => {
  const guardIdx = rollback.indexOf('DRIFT GUARD (scalars)');
  const updateIdx = rollback.indexOf('UPDATE public.tours');
  assert.ok(guardIdx > -1 && guardIdx < updateIdx, 'expected a scalar drift guard section before the UPDATE');
  const guardBlock = rollback.slice(rollback.indexOf('DO $$', guardIdx), updateIdx);
  for (const col of [...TIC_TEXT_COLUMNS, 'included_items', 'excluded_items']) {
    assert.match(guardBlock, new RegExp(`v_row\\.${col}`), `expected the scalar drift guard to re-check ${col}`);
  }
  assert.match(guardBlock, /RAISE EXCEPTION 'GRAND BAZAAR ROLLBACK DRIFT GUARD FAILED/);
});

test('rollback has an itinerary drift guard that runs before the destructive DELETE, refusing to blindly erase itinerary content added or changed after the forward migration', () => {
  const guardIdx = rollback.indexOf('DRIFT GUARD (itinerary)');
  const deleteIdx = rollback.indexOf('DELETE FROM public.tour_itinerary_stops');
  assert.ok(guardIdx > -1 && guardIdx < deleteIdx, 'expected an itinerary drift guard section before the DELETE');
  const guardBlock = rollback.slice(rollback.indexOf('DO $$', guardIdx), deleteIdx);
  assert.match(guardBlock, /IF v_stop_count <> 10 THEN/);
  assert.match(guardBlock, /array_agg\(place_name ORDER BY stop_order\)/);
  assert.match(guardBlock, /approx_duration_text IS NOT NULL/);
  assert.match(guardBlock, /RAISE EXCEPTION 'GRAND BAZAAR ROLLBACK ITINERARY DRIFT GUARD FAILED/);
});

test('both drift guards run strictly before both destructive statements (UPDATE and DELETE), never after', () => {
  const scalarGuardIdx = rollback.indexOf('DRIFT GUARD (scalars)');
  const itineraryGuardIdx = rollback.indexOf('DRIFT GUARD (itinerary)');
  const updateIdx = rollback.indexOf('UPDATE public.tours');
  const deleteIdx = rollback.indexOf('DELETE FROM public.tour_itinerary_stops');
  assert.ok(scalarGuardIdx > -1 && itineraryGuardIdx > scalarGuardIdx);
  assert.ok(itineraryGuardIdx < updateIdx, 'both drift guards must precede the UPDATE');
  assert.ok(updateIdx < deleteIdx, 'UPDATE precedes DELETE, matching the forward migration\'s own ordering');
});

test('rollback targets the exact same tour UUID as the forward migration, with the same name-match defense in depth', () => {
  const preflightIdx = rollback.indexOf('DO $$');
  const preflight = rollback.slice(preflightIdx, rollback.indexOf('END $$;', preflightIdx));
  assert.match(preflight, new RegExp(`v_tour_id\\s+UUID\\s*:=\\s*'${TARGET_TOUR_ID}'`));
  assert.match(preflight, /IF v_tour_name IS DISTINCT FROM 'Grand Bazaar Experience' THEN/);
});

test('rollback cannot affect any other tour — every UUID literal anywhere in the file is the exact target UUID', () => {
  const uuids = [...rollback.matchAll(/'([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})'/g)].map(m => m[1]);
  assert.ok(uuids.length >= 4, 'expected the target UUID to appear in preflight, UPDATE, DELETE, and postflight');
  for (const id of uuids) assert.equal(id, TARGET_TOUR_ID);
});

test('rollback postflight verifies every restored field against the verified snapshot and that the itinerary is empty again', () => {
  const postflightIdx = rollback.lastIndexOf('DO $$');
  const postflight = rollback.slice(postflightIdx);
  assert.match(postflight, /description IS DISTINCT FROM 'Deneme deneme'/);
  assert.match(postflight, /duration_text IS DISTINCT FROM '4 Saat'/);
  assert.match(postflight, /meeting_point IS DISTINCT FROM 'Çemberlitaş Metro Durağı'/);
  assert.match(postflight, /IF v_stop_count <> 0 THEN/);
});

// ── I. No SQL executed, no destructive scope creep ──────────────────────

test('neither file contains a DELETE/UPDATE without a WHERE clause (no accidental full-table statement)', () => {
  for (const file of [forward, rollback]) {
    // Strip "-- ..." line comments first — a comment's own prose (e.g. "never
    // invented; NULL matches...") can contain a semicolon that would otherwise
    // truncate a naive statement match before it ever reaches the real WHERE.
    const withoutComments = file.replace(/--[^\n]*/g, '');
    const deletes = withoutComments.match(/DELETE FROM public\.\w+[^;]*;/g) || [];
    const updates = withoutComments.match(/UPDATE public\.\w+[\s\S]*?;/g) || [];
    assert.ok(deletes.length >= 1 && updates.length >= 1, 'expected at least one DELETE and one UPDATE');
    for (const stmt of [...deletes, ...updates]) {
      assert.match(stmt, /WHERE/i, `statement missing WHERE clause: ${stmt.slice(0, 80)}...`);
    }
  }
});

test('this test file itself never connects to a database or imports a Supabase client', () => {
  const selfSrc = fs.readFileSync(__filename, 'utf8');
  // Matched as call/import forms (not bare substrings) so this assertion does not
  // trip over its own regex literal, which necessarily contains these words as text.
  assert.doesNotMatch(selfSrc, /createClient\(/);
  assert.doesNotMatch(selfSrc, /require\(\s*['"]@supabase\/supabase-js['"]\s*\)/);
  assert.doesNotMatch(selfSrc, /getSB\(\)/);
});
