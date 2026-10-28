'use strict';
/**
 * tests/dashboard/agencyCanonicalDomainParity.test.js
 * ─────────────────────────────────────────────────────────────────────────
 * Agency canonical-domain uniqueness design — normalization parity fix.
 *
 * Production-preflight audit (not guessed) found a real mismatch: the
 * shipping JS normalizeWebsite (api/_agencies/duplicateMatching.js) and
 * its necessary frontend copy (DeseTourDashboard.jsx's
 * _normalizeAgencyWebsiteDomain) did NOT strip an explicit port, while the
 * proposed database-level canonical_agency_domain() SQL function (not yet
 * created — see the design report) does. "example.com" and
 * "example.com:443" were therefore silently treated as DIFFERENT agencies
 * by every existing app-level duplicate check.
 *
 * Decision: keep port-stripping in the SQL design, add it to BOTH JS
 * implementations so app-level and (eventual) database-level canonical
 * identity stay exactly consistent. Subdomain policy is unchanged — only
 * the literal "www." prefix collapses; a real subdomain like
 * "booking.example.com" stays distinct from "example.com".
 *
 * This file proves THREE things stay identical for every fixture:
 *   1. api/_agencies/duplicateMatching.js's normalizeWebsite (backend)
 *   2. DeseTourDashboard.jsx's _normalizeAgencyWebsiteDomain (frontend)
 *   3. sqlCanonicalAgencyDomain below — a faithful JS re-implementation of
 *      the PROPOSED (not yet created) canonical_agency_domain() SQL
 *      function's exact regex chain, used here ONLY as a parity oracle
 *      since no migration/live database exists yet to test against
 *      directly. Once the real migration is created, this should be
 *      re-verified against the actual Postgres function.
 * ─────────────────────────────────────────────────────────────────────────
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const duplicateMatching = require('../../api/_agencies/duplicateMatching');
const { extractTestableFn } = require('./extractTestableFn');

const { normalizeWebsite: backendNormalize } = duplicateMatching;
const frontendNormalize = extractTestableFn('_normalizeAgencyWebsiteDomain');

/**
 * Faithful JS re-implementation of the proposed SQL function's exact
 * regex chain, step for step, in the same order:
 *   lower+trim -> strip scheme -> strip "www." -> strip path/query/
 *   fragment -> strip port -> strip trailing dot -> NULLIF('').
 * Returns '' (not null) for an empty/unparseable result, matching the two
 * JS implementations' own return contract, so comparisons can use a plain
 * string equality everywhere below.
 */
function sqlCanonicalAgencyDomain(url) {
  if (url === null || url === undefined) return '';
  let s = String(url).trim().toLowerCase();
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, '');
  s = s.replace(/^www\./, '');
  s = s.replace(/[/?#].*$/, '');
  s = s.replace(/:[0-9]+$/, '');
  s = s.replace(/\.$/, '');
  return s;
}

// ── Fixtures: one per category explicitly required ──────────────────────

const FIXTURES = [
  ['plain domain',        'example.com',                   'example.com'],
  ['http',                'http://example.com',             'example.com'],
  ['https',                'https://example.com',            'example.com'],
  ['www',                 'www.example.com',                'example.com'],
  ['path',                'example.com/about',              'example.com'],
  ['query',               'example.com?utm=x',              'example.com'],
  ['fragment',            'example.com#section',            'example.com'],
  ['uppercase',           'EXAMPLE.com',                    'example.com'],
  ['port',                'example.com:443',                'example.com'],
  ['www + port',          'http://www.example.com:80/',     'example.com'],
  ['https + port + path', 'https://example.com:443/path',   'example.com'],
  ['uppercase + port + query', 'EXAMPLE.com:8080?x=1',      'example.com'],
  ['subdomain',           'booking.example.com',            'booking.example.com'],
  ['subdomain + port',    'booking.example.com:443',        'booking.example.com'],
];

for (const [label, input, expected] of FIXTURES) {
  test(`[${label}] "${input}" -> "${expected}", identically across backend JS, frontend JS, and the SQL parity oracle`, () => {
    const backend = backendNormalize(input);
    const frontend = frontendNormalize(input);
    const sql = sqlCanonicalAgencyDomain(input);
    assert.equal(backend, expected, `backend normalizeWebsite mismatch for "${input}"`);
    assert.equal(frontend, expected, `frontend _normalizeAgencyWebsiteDomain mismatch for "${input}"`);
    assert.equal(sql, expected, `SQL parity oracle mismatch for "${input}" (would mean the proposed SQL design itself needs revisiting)`);
    assert.equal(backend, frontend, 'backend and frontend must always agree with each other');
    assert.equal(frontend, sql, 'frontend and the proposed SQL normalization must always agree with each other');
  });
}

// ── The specific case this whole fix exists for ─────────────────────────

test('example.com and example.com:443 are now the SAME canonical domain in both JS implementations (the exact mismatch the preflight found)', () => {
  assert.equal(backendNormalize('example.com'), backendNormalize('example.com:443'));
  assert.equal(frontendNormalize('example.com'), frontendNormalize('example.com:443'));
});

// ── Subdomain policy explicitly reconfirmed unchanged ────────────────────

test('subdomain policy is unchanged by the port fix: booking.example.com stays distinct from example.com, with or without a port', () => {
  assert.notEqual(backendNormalize('booking.example.com'), backendNormalize('example.com'));
  assert.notEqual(backendNormalize('booking.example.com:443'), backendNormalize('example.com:443'));
  assert.notEqual(frontendNormalize('booking.example.com'), frontendNormalize('example.com'));
  assert.notEqual(frontendNormalize('booking.example.com:443'), frontendNormalize('example.com:443'));
});

test('only the literal "www." prefix is ever stripped — a non-www subdomain is never mistaken for it', () => {
  // "wwwx.example.com" starts with "www" but is NOT the www convention —
  // must stay completely untouched by the www-stripping step.
  assert.equal(backendNormalize('wwwx.example.com'), 'wwwx.example.com');
  assert.equal(frontendNormalize('wwwx.example.com'), 'wwwx.example.com');
});

// ── Non-port colons are not mistaken for a port ──────────────────────────

test('a non-trailing colon (not a port) is left alone — only a PORT at the very end of the host is stripped', () => {
  // No realistic website ever has this shape, but the regex is anchored
  // to the END of the string ($) specifically so a colon anywhere else
  // could never be misinterpreted as a port.
  const withTrailingTextAfterColon = 'example.com:notaport';
  assert.equal(backendNormalize(withTrailingTextAfterColon), 'example.com:notaport');
  assert.equal(frontendNormalize(withTrailingTextAfterColon), 'example.com:notaport');
});

// ── Empty/non-string input stays safe (pre-existing contract, unaffected) ─

test('empty, non-string, null, and undefined input remain a safe "" from both implementations, unaffected by the port fix', () => {
  for (const bad of ['', null, undefined, 123, {}]) {
    assert.equal(backendNormalize(bad), '');
    assert.equal(frontendNormalize(bad), '');
  }
});
