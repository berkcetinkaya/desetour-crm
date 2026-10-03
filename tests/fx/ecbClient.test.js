'use strict';
/**
 * tests/fx/ecbClient.test.js
 * ─────────────────────────────────────────────────────────────────────────
 * Civitatis Settlement Engine — Phase 1 exchange-rate architecture.
 * parseEcbDailyXml and buildTryCrossRates are pure (no network); tested
 * here against a fixture matching the real ECB daily feed's exact shape
 * (single-quoted attributes, the same structure captured live from
 * https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml during
 * implementation — USD/GBP/TRY rates below are that real snapshot).
 * fetchEcbDailyRates itself (the one function that performs network I/O)
 * is intentionally NOT exercised here — this suite never makes a real
 * network call, matching every other test file in this project.
 * ─────────────────────────────────────────────────────────────────────────
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const ecbClient = require('../../api/_fx/ecbClient');

const REAL_ECB_FIXTURE = `<?xml version="1.0" encoding="UTF-8"?>
<gesmes:Envelope xmlns:gesmes="http://www.gesmes.org/xml/2002-08-01" xmlns="http://www.ecb.int/vocabulary/2002-08-01/eurofxref">
	<gesmes:subject>Reference rates</gesmes:subject>
	<gesmes:Sender>
		<gesmes:name>European Central Bank</gesmes:name>
	</gesmes:Sender>
	<Cube>
		<Cube time='2026-10-02'>
			<Cube currency='USD' rate='1.1225'/>
			<Cube currency='JPY' rate='176.99'/>
			<Cube currency='GBP' rate='0.85033'/>
			<Cube currency='TRY' rate='55.1650'/>
			<Cube currency='CHF' rate='0.9279'/>
		</Cube>
	</Cube>
</gesmes:Envelope>`;

test('parseEcbDailyXml extracts the dated Cube and every currency rate, single-quoted attributes (the real feed\'s own style)', () => {
  const { rateDate, eurRates } = ecbClient.parseEcbDailyXml(REAL_ECB_FIXTURE);
  assert.equal(rateDate, '2026-10-02');
  assert.equal(eurRates.USD, 1.1225);
  assert.equal(eurRates.GBP, 0.85033);
  assert.equal(eurRates.TRY, 55.165);
  assert.equal(eurRates.JPY, 176.99);
});

test('parseEcbDailyXml also accepts double-quoted attributes (either is valid XML)', () => {
  const doubleQuoted = REAL_ECB_FIXTURE.replace(/'/g, '"');
  const { rateDate, eurRates } = ecbClient.parseEcbDailyXml(doubleQuoted);
  assert.equal(rateDate, '2026-10-02');
  assert.equal(eurRates.USD, 1.1225);
});

test('parseEcbDailyXml throws EcbFetchError (never returns a guessed result) on empty or non-string input', () => {
  assert.throws(() => ecbClient.parseEcbDailyXml(''), ecbClient.EcbFetchError);
  assert.throws(() => ecbClient.parseEcbDailyXml(null), ecbClient.EcbFetchError);
  assert.throws(() => ecbClient.parseEcbDailyXml(undefined), ecbClient.EcbFetchError);
});

test('parseEcbDailyXml throws EcbFetchError when no dated Cube element can be found at all', () => {
  assert.throws(() => ecbClient.parseEcbDailyXml('<Envelope><Cube></Cube></Envelope>'), ecbClient.EcbFetchError);
});

test('parseEcbDailyXml throws EcbFetchError when a dated Cube exists but contains no parseable currency rate', () => {
  assert.throws(() => ecbClient.parseEcbDailyXml("<Cube time='2026-10-02'></Cube>"), ecbClient.EcbFetchError);
});

test('buildTryCrossRates computes EUR->TRY directly and USD->TRY/GBP->TRY as cross rates, matching hand-calculated values from the real ECB snapshot', () => {
  const parsed = ecbClient.parseEcbDailyXml(REAL_ECB_FIXTURE);
  const rows = ecbClient.buildTryCrossRates(parsed);
  const byPair = Object.fromEntries(rows.map(r => [`${r.base_currency}->${r.quote_currency}`, r.rate]));

  assert.equal(byPair['EUR->TRY'], 55.165);
  // USD->TRY = EUR->TRY / EUR->USD = 55.165 / 1.1225
  assert.ok(Math.abs(byPair['USD->TRY'] - (55.165 / 1.1225)) < 1e-9);
  // GBP->TRY = EUR->TRY / EUR->GBP = 55.165 / 0.85033
  assert.ok(Math.abs(byPair['GBP->TRY'] - (55.165 / 0.85033)) < 1e-9);

  for (const row of rows) {
    assert.equal(row.quote_currency, 'TRY');
    assert.equal(row.source, 'ECB');
    assert.equal(row.rate_date, '2026-10-02');
  }
});

test('buildTryCrossRates returns zero rows (never a guessed EUR->TRY) when the feed has no TRY rate at all', () => {
  const parsed = { rateDate: '2026-10-02', eurRates: { USD: 1.1, GBP: 0.85 } };
  assert.deepEqual(ecbClient.buildTryCrossRates(parsed), []);
});

test('buildTryCrossRates still produces the EUR->TRY row even if USD or GBP is missing from the feed — never blocks on an unrelated currency', () => {
  const parsed = { rateDate: '2026-10-02', eurRates: { TRY: 55.165 } }; // no USD, no GBP
  const rows = ecbClient.buildTryCrossRates(parsed);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].base_currency, 'EUR');
  assert.equal(rows[0].rate, 55.165);
});

test('every produced row quotes TRY — this project never needs any other quote currency today', () => {
  const parsed = ecbClient.parseEcbDailyXml(REAL_ECB_FIXTURE);
  const rows = ecbClient.buildTryCrossRates(parsed);
  assert.ok(rows.every(r => r.quote_currency === 'TRY'));
  assert.ok(rows.every(r => ['EUR', 'USD', 'GBP'].includes(r.base_currency)));
});
