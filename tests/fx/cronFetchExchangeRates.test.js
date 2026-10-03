'use strict';
/**
 * tests/fx/cronFetchExchangeRates.test.js
 * ─────────────────────────────────────────────────────────────────────────
 * No network access, no real Supabase connection anywhere in this file —
 * same convention as tests/civitatis/cronWriteEndpoint.test.js. Only the
 * auth-gate rejection paths (405/401), which fail before any I/O, are
 * exercised against the real handler(req,res); a correctly-authenticated
 * call would reach ecbClient.fetchEcbDailyRates(), which performs a real
 * network call, so that path is deliberately NOT exercised here — this
 * suite never makes a real network call, matching every other test file
 * in this project.
 * ─────────────────────────────────────────────────────────────────────────
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const handler = require('../../api/cron-fetch-exchange-rates');
const fxAdmin = require('../../api/_fx/supabaseAdmin');

function makeRes() {
  const res = {
    statusCode: null,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
  };
  return res;
}

test('isAuthorizedSchedulerRequest requires the exact "Bearer <secret>" header against a configured, non-empty secret — same shape as the Civitatis scheduler predicate', () => {
  assert.equal(handler.isAuthorizedSchedulerRequest({ configuredSecret: 'xyz', authorizationHeader: 'Bearer xyz' }), true);
  assert.equal(handler.isAuthorizedSchedulerRequest({ configuredSecret: 'xyz', authorizationHeader: 'Bearer wrong' }), false);
  assert.equal(handler.isAuthorizedSchedulerRequest({ configuredSecret: 'xyz', authorizationHeader: 'xyz' }), false);
  assert.equal(handler.isAuthorizedSchedulerRequest({ configuredSecret: undefined, authorizationHeader: 'Bearer undefined' }), false);
  assert.equal(handler.isAuthorizedSchedulerRequest({ configuredSecret: '', authorizationHeader: 'Bearer ' }), false);
});

test('rejects non-GET methods with 405, before the auth check', async () => {
  const req = { method: 'POST', headers: {} };
  const res = makeRes();
  await handler(req, res);
  assert.equal(res.statusCode, 405);
});

test('rejects a request with no Authorization header at all with 401, before any ECB/Supabase call', async () => {
  delete process.env.FX_SCHEDULER_SECRET;
  const req = { method: 'GET', headers: {} };
  const res = makeRes();
  await handler(req, res);
  assert.equal(res.statusCode, 401);
});

test('rejects a request with a wrong Authorization value with 401', async () => {
  process.env.FX_SCHEDULER_SECRET = 'the-real-fx-secret';
  const req = { method: 'GET', headers: { authorization: 'Bearer someone-guessed-this' } };
  const res = makeRes();
  await handler(req, res);
  assert.equal(res.statusCode, 401);
  delete process.env.FX_SCHEDULER_SECRET;
});

test('rejects every request when FX_SCHEDULER_SECRET is not configured at all, even a plausible-looking header', async () => {
  delete process.env.FX_SCHEDULER_SECRET;
  const req = { method: 'GET', headers: { authorization: 'Bearer whatever-someone-tries' } };
  const res = makeRes();
  await handler(req, res);
  assert.equal(res.statusCode, 401);
});

// ── api/_fx/supabaseAdmin.js — fails closed with no network attempted ───

test('getServiceRoleClient throws ConfigurationError (never attempts a connection) when SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY are not set', () => {
  delete process.env.SUPABASE_URL;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  // Force a fresh module instance so an env var set by an earlier,
  // unrelated test file (module-level caching) can never leak a false
  // pass into this one.
  const freshPath = require.resolve('../../api/_fx/supabaseAdmin');
  delete require.cache[freshPath];
  const fresh = require('../../api/_fx/supabaseAdmin');
  assert.throws(() => fresh.getServiceRoleClient(), fresh.ConfigurationError);
});

test('upsertExchangeRates is a no-op (returns []) for an empty or missing rows array — never calls Supabase for nothing', async () => {
  const result = await fxAdmin.upsertExchangeRates([]);
  assert.deepEqual(result, []);
  const result2 = await fxAdmin.upsertExchangeRates(null);
  assert.deepEqual(result2, []);
});

test('the secret used to authenticate the scheduler is never the same env var name as the Civitatis one — two independently rotatable secrets', () => {
  // Structural guard: this project's two scheduled endpoints must never
  // share one secret, so rotating/revoking one can never silently affect
  // the other.
  const fs = require('fs');
  const source = fs.readFileSync(require.resolve('../../api/cron-fetch-exchange-rates'), 'utf8');
  assert.match(source, /FX_SCHEDULER_SECRET/);
  assert.doesNotMatch(source, /CIVITATIS_SCHEDULER_SECRET/);
});

test('no API secret of any kind is referenced for the ECB feed itself — it is a free, public, no-key endpoint (zero process.env reads in this module)', () => {
  const fs = require('fs');
  const source = fs.readFileSync(require.resolve('../../api/_fx/ecbClient'), 'utf8');
  assert.doesNotMatch(source, /process\.env/);
});
