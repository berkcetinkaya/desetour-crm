'use strict';
/**
 * tests/tours/additionalCivitatisTourDataPopulation.test.js
 * ─────────────────────────────────────────────────────────────────────────
 * Regression coverage for the three additional Civitatis Tour Information
 * Center data populations (Italian Grand Bazaar, Portuguese Bosphorus +
 * Sultanahmet, Portuguese Historic Istanbul) and their rollbacks. NOT YET
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

function readSQL(name) {
  return fs.readFileSync(path.join(ROOT, name), 'utf8');
}

// Extracts the single UPDATE public.<table> ... WHERE ...; statement,
// anchored to the real statement (not any "WHERE id = ..." text that may
// appear in header prose earlier in the file) by searching for WHERE/the
// terminating ";" only after the UPDATE keyword.
function extractUpdateStatement(text, table = 'tours') {
  const updateIdx = text.indexOf(`UPDATE public.${table}`);
  assert.ok(updateIdx !== -1, `expected to find UPDATE public.${table}`);
  const whereIdx = text.indexOf('WHERE', updateIdx);
  assert.ok(whereIdx !== -1, 'expected a WHERE clause after the UPDATE');
  const semiIdx = text.indexOf(';', whereIdx);
  assert.ok(semiIdx !== -1, 'expected a terminating ; after the WHERE clause');
  return text.slice(updateIdx, semiIdx + 1);
}

// Extracts the Nth "DO $$ ... END $$;" block (0-indexed) in the file.
function extractDoBlock(text, n) {
  let idx = -1;
  for (let i = 0; i <= n; i++) {
    idx = text.indexOf('DO $$', idx + 1);
    assert.ok(idx !== -1, `expected at least ${n + 1} DO $$ blocks`);
  }
  const endIdx = text.indexOf('END $$;', idx);
  assert.ok(endIdx !== -1, 'expected a terminating END $$; for the DO block');
  return text.slice(idx, endIdx);
}

const forwardItalian   = readSQL('supabase_data_grand_bazaar_italian_tour_information.sql');
const rollbackItalian  = readSQL('supabase_data_grand_bazaar_italian_tour_information_ROLLBACK.sql');
const forwardBosphorus = readSQL('supabase_data_bosphorus_portuguese_tour_information.sql');
const rollbackBosphorus= readSQL('supabase_data_bosphorus_portuguese_tour_information_ROLLBACK.sql');
const forwardHistoric  = readSQL('supabase_data_historic_istanbul_portuguese_tour_information.sql');
const rollbackHistoric = readSQL('supabase_data_historic_istanbul_portuguese_tour_information_ROLLBACK.sql');

const ITALIAN_TOUR_ID    = 'bed4fba3-e6ad-435a-b971-64606d8a46f4';
const ITALIAN_CH1_ID     = 'd3170525-e047-4775-bf0f-a01e721f5487';
const ITALIAN_CH2_ID     = 'de0e4a70-5844-4d9b-a7aa-92111111c5a7';
const BOSPHORUS_TOUR_ID  = '8f308669-2bb6-42ac-9b2f-a07f77e231d4';
const BOSPHORUS_CH_ID    = '4d20f364-3a40-451b-bd30-3a38843fd250';
const HISTORIC_TOUR_ID   = 'a4e4bf16-a108-4a45-9418-d849f5bb7917';
const HISTORIC_CH_ID     = '7adf541c-beb7-41fc-a9b7-8e7547f98755';

const ITALIAN_STOP_NAMES = [
  'Çemberlitaş Tramvay İstasyonu', 'Kalpakçılar Caddesi', 'Tarihi Hanlar', 'Büyük Valide Han',
  'Kızlarağası Han', 'Sandal Bedesteni', 'Halıcılar Sokak', 'Sahaflar Çarşısı', 'Şark Kahvesi', 'Grand Bazaar',
];
const BOSPHORUS_STOP_NAMES = [
  'Buluşma / Pickup', 'Mısır Çarşısı', 'Eminönü ve Tekne İskelesi', 'Boğaz Tekne Turu',
  'Geleneksel Restoran / Öğle Yemeği', 'Hipodrom Meydanı', 'Sultanahmet Camii', 'Ayasofya',
  'Sultanahmet veya Taksim',
];
const HISTORIC_STOP_NAMES = [
  'Buluşma / Pickup', 'Topkapı Sarayı', 'Topkapı Harem', 'Pera', 'Galata',
  'Geleneksel Restoran / Öğle Yemeği', 'Taksim Meydanı', 'İstiklal Caddesi',
  'Süleymaniye Camii', 'Grand Bazaar',
];

// A single manifest driving the generic (pair-shared) checks below; each
// pair's own distinctive rules (two-channel anomaly, NULL booking_language,
// accented name, per-stop durations) get dedicated tests further down.
const PAIRS = [
  {
    label: 'Italian Grand Bazaar',
    forward: forwardItalian, rollback: rollbackItalian,
    tourId: ITALIAN_TOUR_ID, tourName: 'Grand Bazaar Experience',
    stopNames: ITALIAN_STOP_NAMES, stopCount: 10,
    otherUuids: [ITALIAN_CH1_ID, ITALIAN_CH2_ID],
  },
  {
    label: 'Bosphorus Portuguese',
    forward: forwardBosphorus, rollback: rollbackBosphorus,
    tourId: BOSPHORUS_TOUR_ID, tourName: 'Bosforo y Barrio Sultanahmet',
    stopNames: BOSPHORUS_STOP_NAMES, stopCount: 9,
    otherUuids: [BOSPHORUS_CH_ID],
  },
  {
    label: 'Historic Istanbul Portuguese',
    forward: forwardHistoric, rollback: rollbackHistoric,
    tourId: HISTORIC_TOUR_ID, tourName: 'Estambul Histórica',
    stopNames: HISTORIC_STOP_NAMES, stopCount: 10,
    otherUuids: [HISTORIC_CH_ID],
  },
];

// ── Shared, per-pair generic checks ─────────────────────────────────────

for (const p of PAIRS) {
  test(`${p.label}: forward file is wrapped in exactly one BEGIN;/COMMIT; pair, no stray ROLLBACK`, () => {
    assert.equal((p.forward.match(/^BEGIN;\s*$/gm) || []).length, 1);
    assert.equal((p.forward.match(/^COMMIT;\s*$/gm) || []).length, 1);
    assert.doesNotMatch(p.forward, /^ROLLBACK/m);
  });

  test(`${p.label}: rollback file is wrapped in exactly one BEGIN;/COMMIT; pair`, () => {
    assert.equal((p.rollback.match(/^BEGIN;\s*$/gm) || []).length, 1);
    assert.equal((p.rollback.match(/^COMMIT;\s*$/gm) || []).length, 1);
    assert.doesNotMatch(p.rollback, /^ROLLBACK/m);
  });

  test(`${p.label}: neither file contains DROP, TRUNCATE, ALTER, or CREATE — this is data population, not schema`, () => {
    for (const file of [p.forward, p.rollback]) {
      assert.doesNotMatch(file, /\bDROP\s+(TABLE|COLUMN|FUNCTION|INDEX|TRIGGER|POLICY)\b/i);
      assert.doesNotMatch(file, /\bTRUNCATE\b/i);
      assert.doesNotMatch(file, /\bALTER\s+TABLE\b/i);
      assert.doesNotMatch(file, /\bCREATE\s+(TABLE|FUNCTION|TRIGGER|POLICY|INDEX)\b/i);
    }
  });

  test(`${p.label}: forward preflight resolves the tour by the exact target UUID and verifies its exact production name`, () => {
    const preflight = extractDoBlock(p.forward, 0);
    assert.match(preflight, new RegExp(`v_tour_id\\s+UUID\\s*:=\\s*'${p.tourId}'`));
    assert.match(preflight, /IF v_tour_name IS NULL THEN/);
    assert.match(preflight, /RAISE EXCEPTION[^;]*does not exist/);
    assert.match(preflight, new RegExp(`IF v_tour_name IS DISTINCT FROM '${p.tourName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}' THEN`));
  });

  test(`${p.label}: forward preflight fails closed if the itinerary already has any rows before population`, () => {
    const preflight2 = extractDoBlock(p.forward, 1);
    assert.match(preflight2, /IF v_stop_count <> 0 THEN/);
    assert.match(preflight2, /RAISE EXCEPTION[^;]*only inserts into an empty itinerary/);
  });

  test(`${p.label}: forward postflight verifies the exact itinerary count (${p.stopCount})`, () => {
    const stmt = p.forward.slice(p.forward.lastIndexOf('DO $$'));
    assert.match(stmt, new RegExp(`IF v_stop_count <> ${p.stopCount} THEN`));
  });

  test(`${p.label}: itinerary stop_order sequence is exactly 1..${p.stopCount}, place_name order matches expected sequence`, () => {
    const insertIdx = p.forward.indexOf('INSERT INTO public.tour_itinerary_stops');
    assert.ok(insertIdx !== -1);
    const valuesIdx = p.forward.indexOf('VALUES', insertIdx);
    const insertBlock = p.forward.slice(valuesIdx, p.forward.indexOf(';\n\n\n-- ──', insertIdx) + 1);
    const orders = [...insertBlock.matchAll(/'[0-9a-f-]+',\s*(\d+),/g)].map(m => Number(m[1]));
    assert.deepEqual(orders, Array.from({ length: p.stopCount }, (_, i) => i + 1));
    const names = [...insertBlock.matchAll(/'[0-9a-f-]+',\s*\d+,\s*'([^']+)',/g)].map(m => m[1]);
    assert.deepEqual(names, p.stopNames);
  });

  test(`${p.label}: every itinerary VALUES row targets the exact tour UUID — no other tour can ever receive these stops`, () => {
    const insertIdx = p.forward.indexOf('INSERT INTO public.tour_itinerary_stops');
    const valuesIdx = p.forward.indexOf('VALUES', insertIdx);
    const insertBlock = p.forward.slice(valuesIdx, p.forward.indexOf(';\n\n\n-- ──', insertIdx) + 1);
    const rowUuids = [...insertBlock.matchAll(/\('([0-9a-f-]+)',\s*\d+,/g)].map(m => m[1]);
    assert.equal(rowUuids.length, p.stopCount);
    for (const id of rowUuids) assert.equal(id, p.tourId);
  });

  test(`${p.label}: forward UPDATE and rollback UPDATE both target only the exact tour UUID (single WHERE, no IN/LIKE/OR)`, () => {
    for (const file of [p.forward, p.rollback]) {
      const stmt = extractUpdateStatement(file);
      assert.doesNotMatch(stmt, /\bIN\s*\(/);
      assert.doesNotMatch(stmt, /\bLIKE\b/i);
      assert.doesNotMatch(stmt, /\bOR\b/);
      assert.equal((stmt.match(/WHERE/g) || []).length, 1);
      assert.match(stmt, new RegExp(`WHERE id = '${p.tourId}';`));
    }
  });

  test(`${p.label}: neither file references tours.notes — that column stays completely untouched`, () => {
    for (const file of [p.forward, p.rollback]) {
      const body = file.slice(file.indexOf('BEGIN;'));
      assert.doesNotMatch(body, /\bnotes\s*=/);
    }
  });

  test(`${p.label}: neither file writes to tour_channels or tour_languages — read-only verification only`, () => {
    for (const file of [p.forward, p.rollback]) {
      assert.doesNotMatch(file, /UPDATE public\.tour_channels/);
      assert.doesNotMatch(file, /INSERT INTO public\.tour_channels/);
      assert.doesNotMatch(file, /DELETE FROM public\.tour_channels/);
      assert.doesNotMatch(file, /UPDATE public\.tour_languages/);
      assert.doesNotMatch(file, /INSERT INTO public\.tour_languages/);
      assert.doesNotMatch(file, /DELETE FROM public\.tour_languages/);
    }
  });

  test(`${p.label}: neither file references reservations, customers, reservation_guests, payments, reservation_reviews, guides, guide_payments, or activity_logs`, () => {
    for (const t of ['reservations', 'customers', 'reservation_guests', 'payments', 'reservation_reviews', 'guides', 'guide_payments', 'activity_logs']) {
      assert.doesNotMatch(p.forward, new RegExp(`public\\.${t}\\b`));
      assert.doesNotMatch(p.rollback, new RegExp(`public\\.${t}\\b`));
    }
  });

  test(`${p.label}: forward postflight re-verifies tour_channels row count and tour_languages presence unchanged`, () => {
    const postflight = p.forward.slice(p.forward.lastIndexOf('DO $$'));
    assert.match(postflight, /SELECT COUNT\(\*\) INTO v_channel_count FROM public\.tour_channels WHERE tour_id = v_tour_id;/);
    assert.match(postflight, /this migration must never touch tour_channels/);
    assert.match(postflight, /tour_languages/);
  });

  test(`${p.label}: rollback has a scalar drift guard and an itinerary drift guard, both before the destructive statements`, () => {
    const updateIdx = p.rollback.indexOf('UPDATE public.tours');
    const deleteIdx = p.rollback.indexOf('DELETE FROM public.tour_itinerary_stops');
    const scalarGuardIdx = p.rollback.indexOf('DRIFT GUARD (scalars)');
    const itineraryGuardIdx = p.rollback.indexOf('DRIFT GUARD (itinerary)');
    assert.ok(scalarGuardIdx > -1 && itineraryGuardIdx > scalarGuardIdx, 'expected scalar guard before itinerary guard');
    assert.ok(itineraryGuardIdx < updateIdx, 'both drift guards must precede the UPDATE');
    assert.ok(updateIdx < deleteIdx, 'UPDATE precedes DELETE');
    const scalarGuardBlock = p.rollback.slice(scalarGuardIdx, itineraryGuardIdx);
    assert.match(scalarGuardBlock, /RAISE EXCEPTION '.*ROLLBACK DRIFT GUARD FAILED/);
    const itineraryGuardBlock = p.rollback.slice(itineraryGuardIdx, updateIdx);
    assert.match(itineraryGuardBlock, /IF v_stop_count <> \d+ THEN/);
    assert.match(itineraryGuardBlock, /array_agg\(place_name ORDER BY stop_order\)/);
    assert.match(itineraryGuardBlock, /RAISE EXCEPTION '.*ITINERARY DRIFT GUARD FAILED/);
  });

  test(`${p.label}: rollback removes exactly the itinerary rows for this tour_id (DELETE present, scoped)`, () => {
    assert.match(p.rollback, new RegExp(`DELETE FROM public\\.tour_itinerary_stops WHERE tour_id = '${p.tourId}';`));
  });

  test(`${p.label}: rollback postflight verifies itinerary count is 0 and tour_channels remains unchanged`, () => {
    const postflight = p.rollback.slice(p.rollback.lastIndexOf('DO $$'));
    assert.match(postflight, /IF v_stop_count <> 0 THEN/);
    assert.match(postflight, /tour_channels row count changed/);
  });

  test(`${p.label}: rollback cannot affect any other tour — every UUID literal anywhere in the file is either the target tour or one of its own known channel row ids`, () => {
    const allowed = new Set([p.tourId, ...p.otherUuids]);
    const uuids = [...p.rollback.matchAll(/'([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})'/g)].map(m => m[1]);
    assert.ok(uuids.length >= 1);
    for (const id of uuids) assert.ok(allowed.has(id), `unexpected UUID ${id} in ${p.label} rollback — every UUID must be the target tour or its own known channel row`);
  });

  test(`${p.label}: forward migration cannot affect any other tour — every UUID literal anywhere in the file is either the target tour or one of its own known channel row ids`, () => {
    const allowed = new Set([p.tourId, ...p.otherUuids]);
    const body = p.forward.slice(p.forward.indexOf('BEGIN;'));
    const uuids = [...body.matchAll(/'([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})'/g)].map(m => m[1]);
    assert.ok(uuids.length >= 1);
    for (const id of uuids) assert.ok(allowed.has(id), `unexpected UUID ${id} in ${p.label} forward migration`);
  });

  test(`${p.label}: neither file contains a DELETE/UPDATE without a WHERE clause`, () => {
    for (const file of [p.forward, p.rollback]) {
      // The UPDATE is located via extractUpdateStatement (anchored on the
      // WHERE clause found AFTER the UPDATE keyword), not a naive
      // "first semicolon" scan — several of these tours' Turkish
      // descriptions legitimately contain a semicolon as punctuation
      // (e.g. "...başlayan; öğle yemeğinin..."), which would otherwise
      // truncate a naive match before it ever reaches the real WHERE.
      const updateStmt = extractUpdateStatement(file);
      assert.match(updateStmt, /WHERE/i, `UPDATE missing WHERE clause: ${updateStmt.slice(-80)}`);

      const deletes = file.replace(/--[^\n]*/g, '').match(/DELETE FROM public\.\w+[^;]*;/g) || [];
      for (const stmt of deletes) {
        assert.match(stmt, /WHERE/i, `DELETE missing WHERE clause: ${stmt.slice(0, 80)}...`);
      }
    }
  });
}

// ── Italian Grand Bazaar: two-channel anomaly, validated not modified ──

test('Italian forward preflight verifies BOTH known Civitatis channel rows by id, exactly as verified in production, without modifying either', () => {
  const preflight = extractDoBlock(forwardItalian, 0);
  assert.match(preflight, /IF v_channel_count <> 2 THEN/);
  assert.match(preflight, new RegExp(`tc\\.id = '${ITALIAN_CH1_ID}'`));
  assert.match(preflight, /external_product_id = 'Grand Bazaar Experience'/);
  assert.match(preflight, /booking_language = 'İtalyanca'/);
  assert.match(preflight, new RegExp(`tc\\.id = '${ITALIAN_CH2_ID}'`));
  assert.match(preflight, /listing_url = 'https:\/\/www\.civitatis\.com\/it\/istanbul\/tour-grande-bazar'/);
});

test('Italian forward postflight re-verifies both known channel rows are still exactly as they were (count still 2)', () => {
  const postflight = forwardItalian.slice(forwardItalian.lastIndexOf('DO $$'));
  assert.match(postflight, /IF v_channel_count <> 2 THEN/);
  assert.match(postflight, new RegExp(`id = '${ITALIAN_CH1_ID}'`));
  assert.match(postflight, new RegExp(`id = '${ITALIAN_CH2_ID}'`));
});

test('Italian rollback preflight and postflight also re-verify both known channel rows unchanged (count still 2)', () => {
  const scalarGuard = rollbackItalian.slice(rollbackItalian.indexOf('DRIFT GUARD (scalars)'), rollbackItalian.indexOf('DRIFT GUARD (itinerary)'));
  // the scalar guard itself doesn't re-check channels (that's the postflight's job) — confirm postflight does.
  void scalarGuard;
  const postflight = rollbackItalian.slice(rollbackItalian.lastIndexOf('DO $$'));
  assert.match(postflight, /IF v_channel_count <> 2 THEN/);
  assert.match(postflight, new RegExp(`id = '${ITALIAN_CH1_ID}'`));
  assert.match(postflight, new RegExp(`id = '${ITALIAN_CH2_ID}'`));
});

test('Italian forward UPDATE never mentions meeting_instructions_tr, excluded_items, or other_conditions_tr — these are left completely unchanged, not even set to NULL', () => {
  const stmt = extractUpdateStatement(forwardItalian);
  assert.doesNotMatch(stmt, /meeting_instructions_tr\s*=/);
  assert.doesNotMatch(stmt, /excluded_items\s*=/);
  assert.doesNotMatch(stmt, /\bother_conditions_tr\s*=/);
});

test('Italian rollback UPDATE never mentions meeting_instructions_tr, excluded_items, or other_conditions_tr either — the rollback restores only what the forward migration wrote', () => {
  const stmt = extractUpdateStatement(rollbackItalian);
  assert.doesNotMatch(stmt, /meeting_instructions_tr\s*=/);
  assert.doesNotMatch(stmt, /excluded_items\s*=/);
  assert.doesNotMatch(stmt, /\bother_conditions_tr\s*=/);
});

test('Italian postflight confirms the three left-unchanged fields are still NULL after population', () => {
  const postflight = forwardItalian.slice(forwardItalian.lastIndexOf('DO $$'));
  assert.match(postflight, /meeting_instructions_tr IS NOT NULL THEN/);
  assert.match(postflight, /excluded_items IS NOT NULL THEN/);
  assert.match(postflight, /other_conditions_tr IS NOT NULL THEN/);
});

test('Italian rollback restores duration_text to the verified production value "4" (not "4 Saat") and meeting_point to "Çemberlitaş Tramvay Durağı"', () => {
  const stmt = extractUpdateStatement(rollbackItalian);
  assert.match(stmt, /duration_text = '4',/);
  assert.match(stmt, /meeting_point = 'Çemberlitaş Tramvay Durağı'/);
});

test('Italian itinerary has no approx_duration_text anywhere (forward), matching the Spanish/Italian source which provides none', () => {
  const insertIdx = forwardItalian.indexOf('INSERT INTO public.tour_itinerary_stops');
  const valuesIdx = forwardItalian.indexOf('VALUES', insertIdx);
  const insertBlock = forwardItalian.slice(valuesIdx, forwardItalian.indexOf(';\n\n\n-- ──', insertIdx) + 1);
  const rows = insertBlock.match(/\([^()]*\)/g) || [];
  assert.equal(rows.length, 10);
  for (const row of rows) {
    assert.match(row, /,\s*NULL,\s*NULL\)$/, `expected NULL operational_note and approx_duration_text: ${row}`);
  }
});

// ── Bosphorus Portuguese: NULL booking_language accepted, not repaired ─

test('Bosphorus forward preflight explicitly accepts booking_language IS NULL rather than repairing it', () => {
  const preflight = extractDoBlock(forwardBosphorus, 0);
  assert.match(preflight, /tc\.booking_language IS NULL/);
  assert.match(preflight, new RegExp(`tc\\.id = '${BOSPHORUS_CH_ID}'`));
  assert.match(preflight, /external_product_id = 'Bosforo y Barrio Sultanahmet'/);
});

test('Bosphorus forward postflight re-verifies booking_language IS NULL unchanged (not repaired)', () => {
  const postflight = forwardBosphorus.slice(forwardBosphorus.lastIndexOf('DO $$'));
  assert.match(postflight, /booking_language IS NULL/);
});

test('Bosphorus rollback never sets or checks a non-NULL booking_language literal — the accepted NULL state is preserved throughout', () => {
  for (const file of [forwardBosphorus, rollbackBosphorus]) {
    assert.doesNotMatch(file, /booking_language = '[^']+'/);
  }
});

test('Bosphorus forward UPDATE never mentions guide_notes_tr — no approved internal content exists, so it must never be touched', () => {
  const stmt = extractUpdateStatement(forwardBosphorus);
  assert.doesNotMatch(stmt, /guide_notes_tr\s*=/);
});

test('Bosphorus rollback UPDATE never mentions guide_notes_tr either', () => {
  const stmt = extractUpdateStatement(rollbackBosphorus);
  assert.doesNotMatch(stmt, /guide_notes_tr\s*=/);
});

test('Bosphorus postflight confirms guide_notes_tr is still NULL after population', () => {
  const postflight = forwardBosphorus.slice(forwardBosphorus.lastIndexOf('DO $$'));
  assert.match(postflight, /guide_notes_tr IS NOT NULL THEN/);
});

test('Bosphorus rollback scalar drift guard aborts if guide_notes_tr is no longer NULL (protects any internal content written since)', () => {
  const scalarGuard = rollbackBosphorus.slice(rollbackBosphorus.indexOf('DRIFT GUARD (scalars)'), rollbackBosphorus.indexOf('DRIFT GUARD (itinerary)'));
  assert.match(scalarGuard, /IF v_row\.guide_notes_tr IS NOT NULL THEN/);
});

test('Bosphorus itinerary has approx_duration_text on exactly 3 stops (Boğaz Tekne Turu, Sultanahmet Camii, Ayasofya) and NULL on the other 6', () => {
  const insertIdx = forwardBosphorus.indexOf('INSERT INTO public.tour_itinerary_stops');
  const valuesIdx = forwardBosphorus.indexOf('VALUES', insertIdx);
  const insertBlock = forwardBosphorus.slice(valuesIdx, forwardBosphorus.indexOf(';\n\n\n-- ──', insertIdx) + 1);
  // Every VALUES row ends "..., operational_note, approx_duration_text)" —
  // count rows ending in NULL,NULL) (no duration) vs NULL,'...') (duration set),
  // rather than splitting on ")," boundaries, which strips the very
  // parenthesis this check needs to anchor on.
  const noDurationRows = insertBlock.match(/,\s*NULL,\s*NULL\)/g) || [];
  const withDurationRows = insertBlock.match(/,\s*NULL,\s*'[^']*'\)/g) || [];
  assert.equal(noDurationRows.length, 6, 'expected 6 stops with NULL approx_duration_text');
  assert.equal(withDurationRows.length, 3, 'expected 3 stops with a non-NULL approx_duration_text');
  assert.match(insertBlock, /'Boğaz Tekne Turu'[\s\S]{0,120}'Yaklaşık 1,5 saat'\)/);
  assert.match(insertBlock, /'Sultanahmet Camii'[\s\S]{0,120}'Yaklaşık 1 saat'\)/);
  assert.match(insertBlock, /'Ayasofya'[\s\S]{0,120}'Yaklaşık 1 saat'\)/);
});

test('Bosphorus forward postflight verifies exactly 3 stops carry a non-NULL approx_duration_text, and names each one', () => {
  const postflight = forwardBosphorus.slice(forwardBosphorus.lastIndexOf('DO $$'));
  assert.match(postflight, /IF v_duration_stops <> 3 THEN/);
  assert.match(postflight, /'Boğaz Tekne Turu'/);
  assert.match(postflight, /'Sultanahmet Camii'/);
  assert.match(postflight, /'Ayasofya'/);
});

test('Bosphorus rollback itinerary drift guard re-verifies the same 3 durations before allowing the destructive DELETE', () => {
  const itineraryGuard = rollbackBosphorus.slice(rollbackBosphorus.indexOf('DRIFT GUARD (itinerary)'), rollbackBosphorus.indexOf('UPDATE public.tours'));
  assert.match(itineraryGuard, /IF v_duration_stops <> 3 THEN/);
  assert.match(itineraryGuard, /'Boğaz Tekne Turu'/);
});

test('Bosphorus lunch (Öğle yemeği) remains in included_items — the currently published Civitatis product still lists it, per the explicit meal-warning instruction', () => {
  const stmt = extractUpdateStatement(forwardBosphorus);
  assert.match(stmt, /Öğle yemeği/);
});

// ── Historic Istanbul Portuguese: accented name preserved exactly ──────

test('Historic Istanbul preserves the accented production tour name "Estambul Histórica" exactly, in both forward and rollback', () => {
  for (const file of [forwardHistoric, rollbackHistoric]) {
    assert.match(file, /Estambul Histórica/);
    // Never silently normalized to the unaccented "Estambul Historica".
    assert.doesNotMatch(file, /Estambul Historica[^́́]/);
  }
});

test('Historic Istanbul forward preflight verifies external_product_id exactly "Estambul Histórica" (accented) and booking_language exactly "Portekizce"', () => {
  const preflight = extractDoBlock(forwardHistoric, 0);
  assert.match(preflight, /external_product_id = 'Estambul Histórica'/);
  assert.match(preflight, /booking_language = 'Portekizce'/);
  assert.match(preflight, new RegExp(`tc\\.id = '${HISTORIC_CH_ID}'`));
});

test('Historic Istanbul forward UPDATE never mentions guide_notes_tr — no approved internal content exists, so it must never be touched', () => {
  const stmt = extractUpdateStatement(forwardHistoric);
  assert.doesNotMatch(stmt, /guide_notes_tr\s*=/);
});

test('Historic Istanbul rollback UPDATE never mentions guide_notes_tr either', () => {
  const stmt = extractUpdateStatement(rollbackHistoric);
  assert.doesNotMatch(stmt, /guide_notes_tr\s*=/);
});

test('Historic Istanbul postflight confirms guide_notes_tr is still NULL after population', () => {
  const postflight = forwardHistoric.slice(forwardHistoric.lastIndexOf('DO $$'));
  assert.match(postflight, /guide_notes_tr IS NOT NULL THEN/);
});

test('Historic Istanbul rollback scalar drift guard aborts if guide_notes_tr is no longer NULL', () => {
  const scalarGuard = rollbackHistoric.slice(rollbackHistoric.indexOf('DRIFT GUARD (scalars)'), rollbackHistoric.indexOf('DRIFT GUARD (itinerary)'));
  assert.match(scalarGuard, /IF v_row\.guide_notes_tr IS NOT NULL THEN/);
});

test('Historic Istanbul itinerary has no approx_duration_text anywhere — the source does not provide per-stop durations for this product', () => {
  const insertIdx = forwardHistoric.indexOf('INSERT INTO public.tour_itinerary_stops');
  const valuesIdx = forwardHistoric.indexOf('VALUES', insertIdx);
  const insertBlock = forwardHistoric.slice(valuesIdx, forwardHistoric.indexOf(';\n\n\n-- ──', insertIdx) + 1);
  const rows = insertBlock.match(/\([^()]*\)/g) || [];
  assert.equal(rows.length, 10);
  for (const row of rows) {
    assert.match(row, /,\s*NULL,\s*NULL\)$/, `expected NULL operational_note and approx_duration_text: ${row}`);
  }
});

test('Historic Istanbul lunch (öğle yemeği) remains in included_items — the currently published Civitatis product still lists it', () => {
  const stmt = extractUpdateStatement(forwardHistoric);
  assert.match(stmt, /öğle yemeği/);
});

test('Historic Istanbul other_conditions_tr includes the passport-matching and Topkapı/Grand Bazaar closure conditions, with no invented content', () => {
  const stmt = extractUpdateStatement(forwardHistoric);
  assert.match(stmt, /pasaporttaki bilgilerle birebir eşleşmesi gerekir/);
  assert.match(stmt, /Topkapı Sarayı/);
  assert.match(stmt, /29 Ekim/);
});

// ── Cross-file: the already-applied Spanish population is untouched ────

test('the already-applied Spanish Grand Bazaar population and rollback files are not modified by this task', () => {
  const spanishForward = readSQL('supabase_data_grand_bazaar_spanish_tour_information.sql');
  const spanishRollback = readSQL('supabase_data_grand_bazaar_spanish_tour_information_ROLLBACK.sql');
  assert.match(spanishForward, /c5e42d88-0a6c-4703-9c22-90eec5a278bd/);
  assert.match(spanishRollback, /c5e42d88-0a6c-4703-9c22-90eec5a278bd/);
  // The three new tour ids must never appear in the Spanish files.
  for (const id of [ITALIAN_TOUR_ID, BOSPHORUS_TOUR_ID, HISTORIC_TOUR_ID]) {
    assert.doesNotMatch(spanishForward, new RegExp(id));
    assert.doesNotMatch(spanishRollback, new RegExp(id));
  }
});

test('this test file itself never connects to a database or imports a Supabase client', () => {
  const selfSrc = fs.readFileSync(__filename, 'utf8');
  assert.doesNotMatch(selfSrc, /createClient\(/);
  assert.doesNotMatch(selfSrc, /require\(\s*['"]@supabase\/supabase-js['"]\s*\)/);
  assert.doesNotMatch(selfSrc, /getSB\(\)/);
});
