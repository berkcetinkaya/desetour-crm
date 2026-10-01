'use strict';
/**
 * tests/civitatis/activityModalityPersistence.test.js
 * ─────────────────────────────────────────────────────────────────────────
 * Tour Preparation Intelligence — Phase B2 persistence helper tests.
 * Uses a minimal, self-contained fake Supabase RPC client — no real
 * network/database call, not shared with anything under tests/whatsapp/.
 * ─────────────────────────────────────────────────────────────────────────
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('module');

function makeFakeSupabase(rpcResult, rpcError) {
  const calls = { rpcName: null, rpcArgs: null };
  return {
    calls,
    rpc(name, args) {
      calls.rpcName = name;
      calls.rpcArgs = args;
      return Promise.resolve({ data: rpcError ? null : rpcResult, error: rpcError || null });
    },
  };
}

function loadPersistenceModuleWithFakeClient(fakeClient) {
  const modPath = require.resolve('../../api/_civitatis/activityModalityPersistence.js');
  const adminPath = require.resolve('../../api/_civitatis/supabaseAdmin.js');
  delete require.cache[modPath];
  const realAdminExports = require(adminPath);
  const stubbedAdmin = Object.assign({}, realAdminExports, {
    getServiceRoleClient: () => fakeClient,
  });
  const originalLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === './supabaseAdmin' && parent && parent.filename === modPath) {
      return stubbedAdmin;
    }
    return originalLoad.apply(this, arguments);
  };
  try {
    return require(modPath);
  } finally {
    Module._load = originalLoad;
  }
}

const VALID_IDENTITY = {
  reservationId: '11111111-1111-1111-1111-111111111111',
  sourceId: '22222222-2222-2222-2222-222222222222',
  externalBookingId: '40466869',
};

test('calls set_reservation_activity_modality with the exact expected RPC arguments', async () => {
  const fake = makeFakeSupabase({ result: 'updated', reservation_id: VALID_IDENTITY.reservationId, meal_status: 'included' });
  const { persistReservationActivityModality } = loadPersistenceModuleWithFakeClient(fake);

  await persistReservationActivityModality({
    ...VALID_IDENTITY,
    purchasedActivityRaw: 'Visita guiada pela Istambul imprescindível - Tour com',
    mealStatus: 'included',
  });

  assert.equal(fake.calls.rpcName, 'set_reservation_activity_modality');
  assert.deepEqual(fake.calls.rpcArgs, {
    p_reservation_id: VALID_IDENTITY.reservationId,
    p_source_id: VALID_IDENTITY.sourceId,
    p_external_booking_id: VALID_IDENTITY.externalBookingId,
    p_purchased_activity_raw: 'Visita guiada pela Istambul imprescindível - Tour com',
    p_meal_status: 'included',
  });
});

test('passes through the RPC result verbatim on success', async () => {
  const fake = makeFakeSupabase({ result: 'updated', reservation_id: VALID_IDENTITY.reservationId, meal_status: 'not_included' });
  const { persistReservationActivityModality } = loadPersistenceModuleWithFakeClient(fake);

  const result = await persistReservationActivityModality({
    ...VALID_IDENTITY,
    purchasedActivityRaw: 'Visita guiada pela Istambul imprescindível - Tour sem',
    mealStatus: 'not_included',
  });

  assert.deepEqual(result, { result: 'updated', reservation_id: VALID_IDENTITY.reservationId, meal_status: 'not_included' });
});

test('mealStatus=unknown is accepted and persisted (unknown is a valid state)', async () => {
  const fake = makeFakeSupabase({ result: 'updated', reservation_id: VALID_IDENTITY.reservationId, meal_status: 'unknown' });
  const { persistReservationActivityModality } = loadPersistenceModuleWithFakeClient(fake);

  const result = await persistReservationActivityModality({
    ...VALID_IDENTITY,
    purchasedActivityRaw: 'Tour por el Gran Bazar - Tour en español',
    mealStatus: 'unknown',
  });

  assert.equal(result.result, 'updated');
  assert.equal(fake.calls.rpcArgs.p_meal_status, 'unknown');
});

test('purchasedActivityRaw of null is passed through as null, never coerced to a string', async () => {
  const fake = makeFakeSupabase({ result: 'updated' });
  const { persistReservationActivityModality } = loadPersistenceModuleWithFakeClient(fake);

  await persistReservationActivityModality({ ...VALID_IDENTITY, purchasedActivityRaw: null, mealStatus: 'unknown' });

  assert.equal(fake.calls.rpcArgs.p_purchased_activity_raw, null);
});

test('an invalid mealStatus is rejected fail-closed, without calling the RPC at all', async () => {
  const fake = makeFakeSupabase({ result: 'updated' });
  const { persistReservationActivityModality } = loadPersistenceModuleWithFakeClient(fake);

  const result = await persistReservationActivityModality({ ...VALID_IDENTITY, purchasedActivityRaw: 'x', mealStatus: 'maybe' });

  assert.equal(result.result, 'invalid_meal_status');
  assert.equal(fake.calls.rpcName, null);
});

test('missing reservationId/sourceId/externalBookingId is rejected fail-closed, without calling the RPC', async () => {
  const fake = makeFakeSupabase({ result: 'updated' });
  const { persistReservationActivityModality } = loadPersistenceModuleWithFakeClient(fake);

  for (const bad of [
    { sourceId: VALID_IDENTITY.sourceId, externalBookingId: VALID_IDENTITY.externalBookingId, mealStatus: 'unknown' },
    { reservationId: VALID_IDENTITY.reservationId, externalBookingId: VALID_IDENTITY.externalBookingId, mealStatus: 'unknown' },
    { reservationId: VALID_IDENTITY.reservationId, sourceId: VALID_IDENTITY.sourceId, mealStatus: 'unknown' },
  ]) {
    const result = await persistReservationActivityModality(bad);
    assert.equal(result.result, 'invalid_input');
  }
  assert.equal(fake.calls.rpcName, null);
});

test('this helper never calls .from(...).update(...) directly — only .rpc(...)', () => {
  const fs = require('fs');
  const implSource = fs.readFileSync(require.resolve('../../api/_civitatis/activityModalityPersistence.js'), 'utf8');
  // The header docblock legitimately mentions ".from('reservations').update(...)"
  // in prose, explaining what this file deliberately does NOT do — scope
  // the real guarantee to executable (non-comment) lines only.
  const codeLines = implSource.split('\n').filter((l) => {
    const t = l.trim();
    return !t.startsWith('*') && !t.startsWith('//') && !t.startsWith('/**');
  });
  const code = codeLines.join('\n');
  assert.doesNotMatch(code, /\.from\(/);
  assert.doesNotMatch(code, /\.update\(/);
  assert.match(code, /\.rpc\(/);
});

test('a genuine Supabase transport/query error is thrown, never swallowed', async () => {
  const fake = makeFakeSupabase(null, { message: 'connection reset' });
  const { persistReservationActivityModality } = loadPersistenceModuleWithFakeClient(fake);

  await assert.rejects(
    () => persistReservationActivityModality({ ...VALID_IDENTITY, purchasedActivityRaw: 'x', mealStatus: 'unknown' }),
    (err) => {
      assert.match(err.message, /set_reservation_activity_modality/);
      assert.match(err.message, /connection reset/);
      return true;
    }
  );
});

test('this module never mentions anything WhatsApp-related', () => {
  const fs = require('fs');
  const implSource = fs.readFileSync(require.resolve('../../api/_civitatis/activityModalityPersistence.js'), 'utf8');
  assert.doesNotMatch(implSource, /whatsapp/i);
});
