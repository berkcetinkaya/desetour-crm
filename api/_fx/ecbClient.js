/**
 * api/_fx/ecbClient.js
 * ─────────────────────────────────────────────────────────────────────────
 * Dese Tour Operations Center — Civitatis Settlement Engine, Phase 1.
 * Fetches and parses the European Central Bank's daily reference-rate
 * feed (https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml),
 * a free, public, no-API-key, officially-published XML feed — never
 * Google-search scraping, never an unofficial source. The ECB publishes
 * every rate against EUR as the base (1 EUR = X <currency>); this module
 * also computes the cross rates this project actually needs (USD->TRY,
 * GBP->TRY) from the two EUR-based legs, since the feed itself never
 * publishes a direct USD->TRY or GBP->TRY figure.
 *
 * Pure parsing/computation lives here with no I/O dependency beyond the
 * one fetch — fetchEcbDailyRates and parseEcbDailyXml are separately
 * exported and separately testable (parseEcbDailyXml takes a raw XML
 * string, no network at all).
 *
 * No secrets of any kind are involved — the ECB feed requires no API
 * key — so there is nothing here that could ever leak a credential.
 * ─────────────────────────────────────────────────────────────────────────
 */
'use strict';

const ECB_DAILY_FEED_URL = 'https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml';

class EcbFetchError extends Error {
  constructor(message) {
    super(message);
    this.name = 'EcbFetchError';
  }
}

/**
 * Parses the ECB daily XML into { rateDate: 'YYYY-MM-DD', eurRates: { USD: 1.1225, GBP: 0.85033, TRY: 55.165, ... } }.
 * Deliberately NOT a general-purpose XML parser — a small, bounded regex
 * extraction matching exactly the two shapes this one feed has always
 * used (a dated outer <Cube time='...'> and a flat list of inner
 * <Cube currency='XXX' rate='Y.YYYY'/> siblings), the same proportionate-
 * parsing philosophy api/_civitatis/parser.js already uses for Civitatis
 * email text. Attribute quoting (the ECB feed uses single quotes; XML
 * in general permits either) is matched with ['"] so either is accepted.
 * Throws EcbFetchError (never returns a guessed/partial result) if the
 * dated Cube or the currency list cannot be found at all.
 */
function parseEcbDailyXml(xml) {
  if (!xml || typeof xml !== 'string') {
    throw new EcbFetchError('ECB feed response was empty or not text.');
  }

  const dateMatch = /<Cube\s+time=['"]([\d]{4}-[\d]{2}-[\d]{2})['"]\s*>/.exec(xml);
  if (!dateMatch) {
    throw new EcbFetchError('Could not locate the dated <Cube time="..."> element in the ECB feed response.');
  }
  const rateDate = dateMatch[1];

  const eurRates = {};
  const currencyRe = /<Cube\s+currency=['"]([A-Z]{3})['"]\s+rate=['"]([\d.]+)['"]\s*\/>/g;
  let m;
  while ((m = currencyRe.exec(xml)) !== null) {
    const code = m[1];
    const rate = parseFloat(m[2]);
    if (Number.isFinite(rate) && rate > 0) {
      eurRates[code] = rate;
    }
  }

  if (Object.keys(eurRates).length === 0) {
    throw new EcbFetchError('ECB feed response contained a dated Cube but no parseable currency rates.');
  }

  return { rateDate, eurRates };
}

/**
 * Builds the exact set of exchange_rates rows this project needs today
 * (section 9 of the Phase 1 brief: EUR->TRY, USD->TRY, GBP->TRY) from one
 * parsed ECB snapshot. Silently SKIPS (never fabricates) any pair whose
 * required EUR-based leg is missing from the feed — e.g. if TRY is ever
 * absent from a future ECB publication, this returns zero rows rather
 * than a guessed one, consistent with this project's "never a false
 * converted total" fallback philosophy (Phase 1 brief, section 11).
 */
function buildTryCrossRates({ rateDate, eurRates }) {
  const rows = [];
  const eurTry = eurRates.TRY;
  if (!eurTry) return rows; // Nothing can be computed without the EUR->TRY leg at all.

  rows.push({ rate_date: rateDate, base_currency: 'EUR', quote_currency: 'TRY', rate: eurTry, source: 'ECB' });

  if (eurRates.USD) {
    rows.push({ rate_date: rateDate, base_currency: 'USD', quote_currency: 'TRY', rate: eurTry / eurRates.USD, source: 'ECB' });
  }
  if (eurRates.GBP) {
    rows.push({ rate_date: rateDate, base_currency: 'GBP', quote_currency: 'TRY', rate: eurTry / eurRates.GBP, source: 'ECB' });
  }

  return rows;
}

/**
 * Fetches the live ECB feed and returns the rows buildTryCrossRates
 * produces. The one function in this module that performs network I/O.
 */
async function fetchEcbDailyRates() {
  let response;
  try {
    response = await fetch(ECB_DAILY_FEED_URL, { method: 'GET' });
  } catch (err) {
    throw new EcbFetchError(`Failed to reach the ECB reference-rate feed: ${err.message}`);
  }
  if (!response.ok) {
    throw new EcbFetchError(`ECB reference-rate feed returned HTTP ${response.status}.`);
  }
  const xml = await response.text();
  const parsed = parseEcbDailyXml(xml);
  return buildTryCrossRates(parsed);
}

module.exports = {
  ECB_DAILY_FEED_URL,
  EcbFetchError,
  parseEcbDailyXml,
  buildTryCrossRates,
  fetchEcbDailyRates,
};
