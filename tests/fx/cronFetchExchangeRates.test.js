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

// ── fetched_at refresh + idempotent upsert ──────────────────────────────

test('withFetchedAt stamps every row with the same fresh timestamp and never mutates its input', () => {
  const rows = [{ rate_date: '2026-11-09', base_currency: 'EUR', quote_currency: 'TRY', rate: 1, source: 'ECB' }];
  const out = fxAdmin.withFetchedAt(rows, '2026-11-10T15:30:00.000Z');
  assert.deepEqual(out, [{ ...rows[0], fetched_at: '2026-11-10T15:30:00.000Z' }]);
  assert.equal('fetched_at' in rows[0], false);
});

test('upsertExchangeRates sends fetched_at on every upsert and keys on (rate_date, base_currency, quote_currency)', async () => {
  const calls = [];
  const fakeClient = {
    from(table) {
      return {
        upsert(payload, opts) {
          calls.push({ table, payload, opts });
          return { select: async () => ({ data: payload, error: null }) };
        },
      };
    },
  };
  const rows = [
    { rate_date: '2026-11-09', base_currency: 'EUR', quote_currency: 'TRY', rate: 2, source: 'ECB' },
    { rate_date: '2026-11-09', base_currency: 'USD', quote_currency: 'TRY', rate: 3, source: 'ECB' },
  ];
  // Two runs for the same ECB publication date: same conflict key, new fetched_at each time.
  await fxAdmin.upsertExchangeRates(rows, { client: fakeClient, now: '2026-11-10T15:30:00.000Z' });
  await fxAdmin.upsertExchangeRates(rows, { client: fakeClient, now: '2026-11-11T15:30:00.000Z' });
  assert.equal(calls.length, 2);
  for (const c of calls) {
    assert.equal(c.table, 'exchange_rates');
    assert.deepEqual(c.opts, { onConflict: 'rate_date,base_currency,quote_currency' });
  }
  assert.ok(calls[0].payload.every(r => r.fetched_at === '2026-11-10T15:30:00.000Z'));
  assert.ok(calls[1].payload.every(r => r.fetched_at === '2026-11-11T15:30:00.000Z'));
});

test('upsertExchangeRates surfaces a Supabase error instead of reporting success', async () => {
  const fakeClient = { from: () => ({ upsert: () => ({ select: async () => ({ data: null, error: { message: 'boom' } }) }) }) };
  await assert.rejects(
    fxAdmin.upsertExchangeRates([{ rate_date: '2026-11-09', base_currency: 'EUR', quote_currency: 'TRY', rate: 2, source: 'ECB' }], { client: fakeClient }),
    /boom/
  );
});

// ── Workflow: automatic business-day schedule, manual dispatch kept ──────

test('the FX workflow runs on business days after the ECB publication window and keeps workflow_dispatch', () => {
  const fs = require('fs');
  const path = require('path');
  const yml = fs.readFileSync(path.join(__dirname, '..', '..', '.github', 'workflows', 'exchange-rates-scheduled-fetch.yml'), 'utf8');
  assert.match(yml, /\n  schedule:\n    - cron: '30 15 \* \* 1-5'\n/);
  assert.match(yml, /\n  workflow_dispatch: \{\}\n/);
  assert.match(yml, /SCHEDULER_SECRET: \$\{\{ secrets\.FX_SCHEDULER_SECRET \}\}/);
  assert.match(yml, /FETCH_URL: \$\{\{ vars\.FX_CRON_URL \}\}/);
  assert.match(yml, /if \[ -z "\$\{SCHEDULER_SECRET\}" \]; then/, 'fails loudly when the secret is missing');
  assert.doesNotMatch(yml, /no active CRM module depends on\s+#?\s*live exchange rates/);
});

test('rate direction: buildTryCrossRates stores 1 base = rate TRY (EUR direct, USD/GBP as EUR→TRY ÷ EUR→X)', () => {
  const { buildTryCrossRates } = require('../../api/_fx/ecbClient');
  const rows = buildTryCrossRates({ rateDate: '2026-11-09', eurRates: { TRY: 50, USD: 1.25, GBP: 0.8 } });
  const byBase = Object.fromEntries(rows.map(r => [r.base_currency, r]));
  assert.equal(byBase.EUR.rate, 50);
  assert.equal(byBase.USD.rate, 40);
  assert.equal(byBase.GBP.rate, 62.5);
  assert.ok(rows.every(r => r.quote_currency === 'TRY' && r.rate_date === '2026-11-09' && r.source === 'ECB'));
});
