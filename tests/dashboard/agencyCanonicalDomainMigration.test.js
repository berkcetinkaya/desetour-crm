'use strict';
/**
 * tests/dashboard/agencyCanonicalDomainMigration.test.js
 * ─────────────────────────────────────────────────────────────────────────
 * Agency canonical-domain uniqueness — REAL migration parity.
 *
 * supabase_migration_agencies_canonical_domain_uniqueness.sql now exists.
 * This file verifies the actual SQL text, not a hand-written guess at it:
 * it reads the migration file, extracts the exact regexp_replace() pattern
 * strings canonical_agency_domain() uses for each normalization stage, and
 * replays those EXACT patterns (not independently retyped copies) against
 * both JS implementations' outputs. There is no live Postgres in this
 * environment to execute the function directly, so parsing the real
 * function body's own patterns out of the file is the strongest parity
 * check available — strictly more than the earlier hand-written SQL
 * simulation in agencyCanonicalDomainParity.test.js (kept, unchanged,
 * alongside this file).
 *
 * Also statically verifies (from the same file, no live DB required):
 *   - the partial UNIQUE expression index's defining properties (unique,
 *     partial, on canonical_agency_domain(website), never CONCURRENTLY)
 *   - the function is IMMUTABLE and not SECURITY DEFINER, per its own
 *     CREATE FUNCTION clause (volatility/secdef runtime checks live in the
 *     migration's own POSTFLIGHT, which only runs against a real Postgres
 *     instance when the migration is actually applied by hand).
 * ─────────────────────────────────────────────────────────────────────────
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const duplicateMatching = require('../../api/_agencies/duplicateMatching');
const { extractTestableFn } = require('./extractTestableFn');

const { normalizeWebsite: backendNormalize } = duplicateMatching;
const frontendNormalize = extractTestableFn('_normalizeAgencyWebsiteDomain');

const MIGRATION_PATH = path.join(__dirname, '..', '..', 'supabase_migration_agencies_canonical_domain_uniqueness.sql');
const migrationSql = fs.readFileSync(MIGRATION_PATH, 'utf8');

// ── Extract the real function body and its real regexp_replace patterns ──

const FUNCTION_HEADER_RE = /CREATE OR REPLACE FUNCTION public\.canonical_agency_domain\(url TEXT\)\s*\nRETURNS TEXT\s*\nLANGUAGE sql\s*\nIMMUTABLE\s*\nAS \$\$([\s\S]*?)\$\$;/;

function extractFunctionBody() {
  const m = migrationSql.match(FUNCTION_HEADER_RE);
  assert.ok(m, 'could not locate CREATE OR REPLACE FUNCTION public.canonical_agency_domain(url TEXT) ... RETURNS TEXT ... LANGUAGE sql ... IMMUTABLE header in the migration file');
  return m[1];
}

function extractRegexpReplacePatterns(body) {
  // Matches regexp_replace(<arg>, '<pattern>', '') calls, capturing <pattern>
  // exactly as written in the SQL source (backslash-escapes preserved
  // verbatim), in the order they appear in the file.
  const re = /regexp_replace\(\s*s,\s*'((?:[^'\\]|\\.)*)'\s*,\s*''\s*\)/g;
  const patterns = [];
  let m;
  while ((m = re.exec(body)) !== null) {
    patterns.push(m[1]);
  }
  return patterns;
}

test('migration file exists and defines canonical_agency_domain as IMMUTABLE LANGUAGE sql', () => {
  assert.ok(fs.existsSync(MIGRATION_PATH), `expected migration file at ${MIGRATION_PATH}`);
  const body = extractFunctionBody();
  assert.ok(body.length > 0, 'function body must not be empty');
});

test('migration function body starts with lowercase + trim (step0)', () => {
  const body = extractFunctionBody();
  assert.match(body, /lower\(\s*trim\(\s*url\s*\)\s*\)/, 'expected lower(trim(url)) as the first normalization stage');
});

test('migration function body contains exactly 5 regexp_replace stages, in the agreed order', () => {
  const body = extractFunctionBody();
  const patterns = extractRegexpReplacePatterns(body);
  assert.equal(patterns.length, 5, `expected 5 regexp_replace(...) stages (scheme, www, path/query/fragment, port, trailing dot), found ${patterns.length}: ${JSON.stringify(patterns)}`);

  const [schemeStrip, wwwStrip, pathStrip, portStrip, trailingDotStrip] = patterns;
  assert.equal(schemeStrip, '^[a-z][a-z0-9+.-]*://', 'stage 1 must strip the URL scheme');
  assert.equal(wwwStrip, '^www\\.', 'stage 2 must strip a leading literal "www." only');
  assert.equal(pathStrip, '[/?#].*$', 'stage 3 must strip path, query string, and fragment');
  assert.equal(portStrip, ':[0-9]+$', 'stage 4 must strip an explicit trailing port');
  assert.equal(trailingDotStrip, '\\.$', 'stage 5 must strip a trailing dot');
});

test('migration function body returns NULL (via NULLIF) for an empty normalized result', () => {
  const body = extractFunctionBody();
  assert.match(body, /NULLIF\(\s*s\s*,\s*''\s*\)/, 'expected NULLIF(s, \'\') as the function\'s final SELECT');
});

// ── Replay the REAL extracted patterns (not a hand-typed copy) as the ─────
// ── parity oracle, and prove they agree with both JS implementations ─────

function buildMigrationCanonicalFn() {
  const body = extractFunctionBody();
  const patterns = extractRegexpReplacePatterns(body);
  assert.equal(patterns.length, 5, 'expected exactly 5 extracted regexp_replace stages to build the parity oracle from');
  return function migrationCanonicalDomain(url) {
    if (url === null || url === undefined) return '';
    let s = String(url).trim().toLowerCase();
    for (const pattern of patterns) {
      s = s.replace(new RegExp(pattern), '');
    }
    return s;
  };
}

const migrationNormalize = buildMigrationCanonicalFn();

const FIXTURES = [
  ['plain domain',             'example.com',                 'example.com'],
  ['http',                     'http://example.com',          'example.com'],
  ['https',                    'https://example.com',         'example.com'],
  ['www',                      'www.example.com',             'example.com'],
  ['path',                     'example.com/about',           'example.com'],
  ['query',                    'example.com?utm=x',           'example.com'],
  ['fragment',                 'example.com#section',         'example.com'],
  ['uppercase',                'EXAMPLE.com',                 'example.com'],
  ['port',                     'example.com:443',             'example.com'],
  ['www + port',               'http://www.example.com:80/',  'example.com'],
  ['https + port + path',      'https://example.com:443/path', 'example.com'],
  ['subdomain',                'booking.example.com',          'booking.example.com'],
  ['subdomain + port',         'booking.example.com:443',      'booking.example.com'],
  ['null',                     null,                            ''],
  ['blank',                    '',                              ''],
];

for (const [label, input, expected] of FIXTURES) {
  test(`[${label}] "${input}" -> "${expected}" identically across backend JS, frontend JS, and the REAL migration function's own extracted patterns`, () => {
    const backend = backendNormalize(input);
    const frontend = frontendNormalize(input);
    const migration = migrationNormalize(input);
    assert.equal(backend, expected, `backend normalizeWebsite mismatch for ${JSON.stringify(input)}`);
    assert.equal(frontend, expected, `frontend _normalizeAgencyWebsiteDomain mismatch for ${JSON.stringify(input)}`);
    assert.equal(migration, expected, `the REAL migration function's own patterns produced a different result for ${JSON.stringify(input)} — migration SQL and JS have drifted out of parity`);
  });
}

test('example.com and example.com:443 collapse to the same canonical domain under the REAL migration patterns too', () => {
  assert.equal(migrationNormalize('example.com'), migrationNormalize('example.com:443'));
});

test('booking.example.com stays distinct from example.com under the REAL migration patterns too, with or without a port', () => {
  assert.notEqual(migrationNormalize('booking.example.com'), migrationNormalize('example.com'));
  assert.notEqual(migrationNormalize('booking.example.com:443'), migrationNormalize('example.com:443'));
});

// ── Partial UNIQUE expression index — static properties from the real SQL ─

function extractIndexStatement() {
  const m = migrationSql.match(/CREATE UNIQUE INDEX idx_agencies_canonical_domain_unique[\s\S]*?;/);
  assert.ok(m, 'could not locate CREATE UNIQUE INDEX idx_agencies_canonical_domain_unique statement in the migration file');
  return m[0];
}

test('migration creates idx_agencies_canonical_domain_unique as a UNIQUE index', () => {
  const stmt = extractIndexStatement();
  assert.match(stmt, /CREATE UNIQUE INDEX/, 'index must be declared UNIQUE');
});

test('migration index is on public.agencies, keyed on canonical_agency_domain(website)', () => {
  const stmt = extractIndexStatement();
  assert.match(stmt, /ON public\.agencies/);
  assert.match(stmt, /public\.canonical_agency_domain\(website\)/);
});

test('migration index is PARTIAL: WHERE canonical_agency_domain(website) IS NOT NULL (null/blank websites stay unconstrained)', () => {
  const stmt = extractIndexStatement();
  assert.match(stmt, /WHERE public\.canonical_agency_domain\(website\) IS NOT NULL/);
});

test('migration index is never CREATE INDEX CONCURRENTLY (incompatible with this repo\'s BEGIN/COMMIT convention)', () => {
  const stmt = extractIndexStatement();
  assert.doesNotMatch(stmt, /CONCURRENTLY/i);
});

test('migration function is declared IMMUTABLE and LANGUAGE sql (required for use in an expression index)', () => {
  assert.match(migrationSql, /CREATE OR REPLACE FUNCTION public\.canonical_agency_domain\(url TEXT\)\s*\nRETURNS TEXT\s*\nLANGUAGE sql\s*\nIMMUTABLE/);
});

test('migration function is never declared SECURITY DEFINER', () => {
  const body = extractFunctionBody();
  assert.doesNotMatch(migrationSql, /FUNCTION public\.canonical_agency_domain[\s\S]{0,400}SECURITY DEFINER/);
  assert.doesNotMatch(body, /SECURITY DEFINER/);
});

test('migration does not add a canonical_domain column (Option C: function + index only, no stored column)', () => {
  assert.doesNotMatch(migrationSql, /ADD COLUMN\s+canonical_domain/i);
});

test('migration never alters RLS (no CREATE POLICY / DROP POLICY / ALTER POLICY statements)', () => {
  assert.doesNotMatch(migrationSql, /\b(CREATE|DROP|ALTER)\s+POLICY\b/i);
});

test('migration is wrapped in BEGIN/COMMIT, not CREATE INDEX CONCURRENTLY, matching this repo\'s migration convention', () => {
  assert.match(migrationSql, /^\s*BEGIN;/m);
  assert.match(migrationSql, /\nCOMMIT;\s*$/);
});

test('rollback file drops the index before the function it depends on', () => {
  const rollbackPath = path.join(__dirname, '..', '..', 'supabase_migration_agencies_canonical_domain_uniqueness_ROLLBACK.sql');
  const rollbackSql = fs.readFileSync(rollbackPath, 'utf8');
  const indexDropPos = rollbackSql.indexOf('DROP INDEX IF EXISTS public.idx_agencies_canonical_domain_unique');
  const functionDropPos = rollbackSql.indexOf('DROP FUNCTION IF EXISTS public.canonical_agency_domain(TEXT)');
  assert.notEqual(indexDropPos, -1, 'rollback must drop the index');
  assert.notEqual(functionDropPos, -1, 'rollback must drop the function');
  assert.ok(indexDropPos < functionDropPos, 'the index must be dropped before the function it depends on');
});
