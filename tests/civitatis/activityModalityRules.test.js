'use strict';
/**
 * tests/civitatis/activityModalityRules.test.js
 * ─────────────────────────────────────────────────────────────────────────
 * Tour Preparation Intelligence — Phase B1 rule repository tests.
 *
 * Uses a minimal, self-contained fake Supabase query-builder (not shared
 * with, or imported from, anything under tests/whatsapp/ — the WhatsApp
 * Phase 1.2 working tree is explicitly untouched by this phase) to
 * verify the exact filters getActiveCivitatisModalityRules applies,
 * without any real network/database call.
 * ─────────────────────────────────────────────────────────────────────────
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('module');

// A tiny chainable fake mirroring just the surface
// api/_civitatis/supabaseAdmin.js's own existing functions already use
// (.from().select().eq()...), recording every call for assertions.
function makeFakeSupabase(rows) {
  const calls = { table: null, select: null, eq: [] };
  const builder = {
    select(cols) { calls.select = cols; return builder; },
    eq(col, val) { calls.eq.push([col, val]); return builder; },
    then(resolve) { return resolve({ data: rows, error: null }); },
  };
  return {
    calls,
    from(table) { calls.table = table; return builder; },
  };
}

function makeFailingFakeSupabase(message) {
  const builder = {
    select() { return builder; },
    eq() { return builder; },
    then(resolve) { return resolve({ data: null, error: { message } }); },
  };
  return { from() { return builder; } };
}

/**
 * Loads a fresh copy of activityModalityRules.js with
 * ./supabaseAdmin's getServiceRoleClient stubbed to return the given
 * fake client — isolated per test via the Node module cache, never
 * touching the real module or any real credential.
 */
function loadRulesModuleWithFakeClient(fakeClient) {
  const rulesPath = require.resolve('../../api/_civitatis/activityModalityRules.js');
  const adminPath = require.resolve('../../api/_civitatis/supabaseAdmin.js');
  delete require.cache[rulesPath];
  const realAdminExports = require(adminPath);
  const stubbedAdmin = Object.assign({}, realAdminExports, {
    getServiceRoleClient: () => fakeClient,
  });
  const originalLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === './supabaseAdmin' && parent && parent.filename === rulesPath) {
      return stubbedAdmin;
    }
    return originalLoad.apply(this, arguments);
  };
  try {
    return require(rulesPath);
  } finally {
    Module._load = originalLoad;
  }
}

test('getActiveCivitatisModalityRules queries civitatis_activity_modality_map filtered to is_active=true', async () => {
  const fakeRows = [
    { id: 'r1', language_code: 'pt', match_type: 'contains', match_text: 'com almoço', meal_status: 'included', is_active: true },
  ];
  const fake = makeFakeSupabase(fakeRows);
  const { getActiveCivitatisModalityRules } = loadRulesModuleWithFakeClient(fake);

  const result = await getActiveCivitatisModalityRules();

  assert.equal(fake.calls.table, 'civitatis_activity_modality_map');
  assert.deepEqual(fake.calls.eq[0], ['is_active', true]);
  assert.deepEqual(result, fakeRows);
});

test('getActiveCivitatisModalityRules additionally filters by language_code when provided', async () => {
  const fake = makeFakeSupabase([]);
  const { getActiveCivitatisModalityRules } = loadRulesModuleWithFakeClient(fake);

  await getActiveCivitatisModalityRules({ languageCode: 'pt' });

  assert.deepEqual(fake.calls.eq[0], ['is_active', true]);
  assert.deepEqual(fake.calls.eq[1], ['language_code', 'pt']);
});

test('getActiveCivitatisModalityRules does not apply a language_code filter when none is given', async () => {
  const fake = makeFakeSupabase([]);
  const { getActiveCivitatisModalityRules } = loadRulesModuleWithFakeClient(fake);

  await getActiveCivitatisModalityRules();

  assert.equal(fake.calls.eq.length, 1); // only is_active, no language_code
});

test('getActiveCivitatisModalityRules returns [] (never null/undefined) when no rows exist', async () => {
  const fake = makeFakeSupabase(null);
  const { getActiveCivitatisModalityRules } = loadRulesModuleWithFakeClient(fake);

  const result = await getActiveCivitatisModalityRules();
  assert.deepEqual(result, []);
});

test('getActiveCivitatisModalityRules throws a clear Error (never swallows) on a Supabase query error', async () => {
  const fake = makeFailingFakeSupabase('relation does not exist');
  const { getActiveCivitatisModalityRules } = loadRulesModuleWithFakeClient(fake);

  await assert.rejects(
    () => getActiveCivitatisModalityRules(),
    (err) => {
      assert.match(err.message, /civitatis_activity_modality_map/);
      assert.match(err.message, /relation does not exist/);
      return true;
    }
  );
});

test('the selected columns include id/language_code/match_type/match_text/meal_status/is_active', async () => {
  const fake = makeFakeSupabase([]);
  const { getActiveCivitatisModalityRules } = loadRulesModuleWithFakeClient(fake);

  await getActiveCivitatisModalityRules();

  for (const col of ['id', 'language_code', 'match_type', 'match_text', 'meal_status', 'is_active']) {
    assert.match(fake.calls.select, new RegExp(col));
  }
});

test('activityModalityRules.js itself never requires or mentions anything WhatsApp-related', () => {
  const fs = require('fs');
  const implSource = fs.readFileSync(require.resolve('../../api/_civitatis/activityModalityRules.js'), 'utf8');
  assert.doesNotMatch(implSource, /whatsapp/i);
  assert.doesNotMatch(implSource, /require\([^)]*_whatsapp/);
});
