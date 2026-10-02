'use strict';
/**
 * tests/tourPreparation/hagiaSophiaPreparationRuleMigration.test.js
 * ─────────────────────────────────────────────────────────────────────────
 * Tour Preparation Intelligence — Phase C2B: static-assertion coverage for
 * supabase_migration_hagia_sophia_preparation_rule.sql and its ROLLBACK.
 *
 * This test file never opens a database connection or executes SQL —
 * every assertion is a static text match against the migration source,
 * same convention as tests/tourPreparation/civitatisActivityModalityPhaseB2Migration.test.js.
 * The LIVE behavior these assertions describe (resolution, ambiguity
 * failure, idempotency, rollback isolation) was separately proven this
 * session against a disposable local Postgres instance, seeded with
 * synthetic happy-path / wrong-language / zero-match / multi-match /
 * duplicate-rule / unrelated-rule scenarios, then destroyed — not
 * repeated here, since this suite runs in CI with no Postgres available.
 *
 * Assertions are scoped to CODE lines only (excluding `--` SQL comments)
 * wherever a check could otherwise false-positive on this file's own
 * header prose explaining what it deliberately does NOT do — the same
 * fix this codebase's earlier migration tests already established.
 * ─────────────────────────────────────────────────────────────────────────
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const FORWARD_PATH = path.join(__dirname, '..', '..', 'supabase_migration_hagia_sophia_preparation_rule.sql');
const ROLLBACK_PATH = path.join(__dirname, '..', '..', 'supabase_migration_hagia_sophia_preparation_rule_ROLLBACK.sql');
const PREFLIGHT_PATH = path.join(__dirname, '..', '..', 'phase_c2b_hagia_sophia_rule_preflight.sql');

const FORWARD = fs.readFileSync(FORWARD_PATH, 'utf8');
const ROLLBACK = fs.readFileSync(ROLLBACK_PATH, 'utf8');
const PREFLIGHT = fs.readFileSync(PREFLIGHT_PATH, 'utf8');

/** Strips `--` line comments so an assertion about executable SQL can
 * never false-positive on this file's own prose (which legitimately
 * names every excluded concept — Topkapı, Blue Mosque, etc. — to explain
 * why they are out of scope). */
function codeOnly(source) {
  return source
    .split('\n')
    .filter((l) => !l.trim().startsWith('--'))
    .join('\n');
}

const FORWARD_CODE = codeOnly(FORWARD);
const ROLLBACK_CODE = codeOnly(ROLLBACK);

// ═══════════════════════════════════════════════════════════════════════
// 1. Correct target resolution — never by tours.name alone
// ═══════════════════════════════════════════════════════════════════════

// Code-anchored block boundaries — "STEP N" markers live only inside
// `--` comments, which codeOnly() strips, so these slices are bounded by
// actual executable statements instead.
const TOUR_RESOLVE_BLOCK = FORWARD_CODE.slice(
  FORWARD_CODE.indexOf('SELECT COUNT(*) INTO v_tour_count'),
  FORWARD_CODE.indexOf('SELECT COUNT(*) INTO v_stop_count')
);
const STOP_RESOLVE_BLOCK = FORWARD_CODE.slice(
  FORWARD_CODE.indexOf('SELECT COUNT(*) INTO v_stop_count'),
  FORWARD_CODE.indexOf('SELECT COUNT(*) INTO v_total_rules_before')
);

test('1. the forward migration resolves the tour via source + booking_language + name TOGETHER, never tours.name alone', () => {
  // The resolving SELECT must filter on all three in the same WHERE
  // clause — proven by requiring tc.source_id, tc.booking_language, and
  // t.name all appear within the tour-resolution block, not merely
  // somewhere in the file.
  assert.match(TOUR_RESOLVE_BLOCK, /tc\.source_id\s*=\s*v_civitatis_source_id/);
  assert.match(TOUR_RESOLVE_BLOCK, /tc\.booking_language\s*=\s*'Portekizce'/);
  assert.match(TOUR_RESOLVE_BLOCK, /t\.name\s*=\s*'Bosforo y Barrio Sultanahmet'/);
});

test('1b. the itinerary stop is resolved ONLY against place_name, never description_tr/operational_note', () => {
  assert.match(STOP_RESOLVE_BLOCK, /WHERE tour_id = v_tour_id\s*\n\s*AND place_name ILIKE ANY/);
  assert.doesNotMatch(STOP_RESOLVE_BLOCK, /description_tr\s+ILIKE/);
  assert.doesNotMatch(STOP_RESOLVE_BLOCK, /operational_note\s+ILIKE/);
});

// ═══════════════════════════════════════════════════════════════════════
// 2-3. Canonical Portekizce booking language required; wrong language
// never matches
// ═══════════════════════════════════════════════════════════════════════

test('2. the forward migration hardcodes the canonical Turkish language NAME "Portekizce", never a raw code or the Civitatis-native "Português"', () => {
  assert.match(FORWARD_CODE, /booking_language\s*=\s*'Portekizce'/);
  assert.doesNotMatch(FORWARD_CODE, /booking_language\s*=\s*'pt'/);
  assert.doesNotMatch(FORWARD_CODE, /booking_language\s*=\s*'Português'/);
});

test('3. the forward migration and the preflight both key the tour filter on booking_language — a different-language tour_channels row structurally cannot satisfy the WHERE clause', () => {
  assert.match(TOUR_RESOLVE_BLOCK, /booking_language = 'Portekizce'/);
  assert.match(codeOnly(PREFLIGHT), /booking_language = 'Portekizce'/);
});

// ═══════════════════════════════════════════════════════════════════════
// 4-5. Zero / multiple tour matches fail closed
// ═══════════════════════════════════════════════════════════════════════

test('4. zero tour matches raises an exception and aborts before any write', () => {
  assert.match(FORWARD_CODE, /IF v_tour_count = 0 THEN\s*\n\s*RAISE EXCEPTION 'HAGIA SOPHIA RULE MIGRATION FAILED: zero tour_channels rows match/);
});

test('5. multiple tour matches raises an exception and aborts before any write — never picks an arbitrary one', () => {
  assert.match(FORWARD_CODE, /IF v_tour_count > 1 THEN\s*\n\s*RAISE EXCEPTION 'HAGIA SOPHIA RULE MIGRATION FAILED: % tour_channels rows match .* ambiguous/);
  // Never a LIMIT 1 on the resolving SELECT INTO — an arbitrary pick
  // would silently hide ambiguity instead of failing on it.
  assert.doesNotMatch(TOUR_RESOLVE_BLOCK, /LIMIT 1/);
});

// ═══════════════════════════════════════════════════════════════════════
// 6-7. Zero / multiple Hagia Sophia stop matches fail closed
// ═══════════════════════════════════════════════════════════════════════

test('6. zero Hagia Sophia stop matches raises an exception and aborts before any write', () => {
  assert.match(FORWARD_CODE, /IF v_stop_count = 0 THEN\s*\n\s*RAISE EXCEPTION 'HAGIA SOPHIA RULE MIGRATION FAILED: zero tour_itinerary_stops rows/);
});

test('7. multiple Hagia Sophia stop matches raises an exception and aborts before any write — never picks an arbitrary one', () => {
  assert.match(FORWARD_CODE, /IF v_stop_count > 1 THEN\s*\n\s*RAISE EXCEPTION 'HAGIA SOPHIA RULE MIGRATION FAILED: % tour_itinerary_stops rows .* ambiguous/);
  assert.doesNotMatch(STOP_RESOLVE_BLOCK, /LIMIT 1/);
});

test('the Hagia Sophia spelling-variant list is explicit and bounded, never a generic fuzzy pattern', () => {
  const idx = FORWARD_CODE.indexOf("ARRAY[\n       '%Hagia Sophia%'");
  assert.notEqual(idx, -1, 'expected the exact bounded ARRAY literal');
  const variantBlock = FORWARD_CODE.slice(idx, idx + 200);
  for (const variant of ['Hagia Sophia', 'Ayasofya', 'Aya Sofya', 'Santa Sofía', 'Santa Sofia']) {
    assert.ok(variantBlock.includes(variant), `expected variant "${variant}" in the bounded list`);
  }
  // Never a broad single-token wildcard like '%sofia%' or '%sophia%' on
  // its own (which would match any "-sophia-" substring regardless of
  // context) — every entry pairs the place name with at least one other
  // word, per "never sophia-like fuzzy matching".
  assert.doesNotMatch(variantBlock, /'%[Ss]ofi?y?a%'/);
});

// ═══════════════════════════════════════════════════════════════════════
// 8-12. Exact inserted row shape
// ═══════════════════════════════════════════════════════════════════════

test('8. preparation_type is exactly entrance_ticket', () => {
  assert.match(FORWARD_CODE, /VALUES\s*\n\s*\(v_tour_id, v_stop_id, 'entrance_ticket', 'Ayasofya Giriş Bileti', 'per_guest', NULL, TRUE\);/);
});

test('9. label is exactly "Ayasofya Giriş Bileti" (no translation/rewrite)', () => {
  assert.match(FORWARD_CODE, /'Ayasofya Giriş Bileti'/);
});

test('10. quantity_rule is exactly per_guest', () => {
  const insertStmt = FORWARD_CODE.match(/VALUES\s*\n\s*\([^)]*\);/)[0];
  assert.match(insertStmt, /'per_guest'/);
});

test('11. fixed_quantity is NULL in the inserted row', () => {
  const insertStmt = FORWARD_CODE.match(/VALUES\s*\n\s*\([^)]*\);/)[0];
  assert.match(insertStmt, /,\s*NULL,\s*TRUE\);/);
});

test('12. is_active is TRUE in the inserted row', () => {
  const insertStmt = FORWARD_CODE.match(/VALUES\s*\n\s*\([^)]*\);/)[0];
  assert.match(insertStmt, /TRUE\);$/m);
});

// ═══════════════════════════════════════════════════════════════════════
// 13-14. Exactly one rule inserted; no reservation_preparations write
// ═══════════════════════════════════════════════════════════════════════

test('13. exactly one INSERT INTO tour_preparation_rules statement exists in the whole file', () => {
  const matches = FORWARD_CODE.match(/INSERT INTO public\.tour_preparation_rules/g) || [];
  assert.equal(matches.length, 1);
});

test('13b. the row-count postflight guard forbids inserting more than one row, deterministically (never time-based)', () => {
  assert.match(FORWARD_CODE, /v_total_rules_after - v_total_rules_before\) NOT IN \(0, 1\)/);
  assert.doesNotMatch(FORWARD_CODE, /created_at\s*>=\s*\(?now\(\)/i);
});

test('14. no INSERT INTO reservation_preparations anywhere in the forward migration', () => {
  assert.doesNotMatch(FORWARD_CODE, /INSERT INTO public\.reservation_preparations/);
  assert.doesNotMatch(FORWARD_CODE, /INSERT INTO reservation_preparations/);
});

// ═══════════════════════════════════════════════════════════════════════
// 15. Existing equivalent rule never duplicates
// ═══════════════════════════════════════════════════════════════════════

test('15. the insert is guarded by an exact-shape existence check (idempotent WHERE NOT EXISTS pattern, never ON CONFLICT DO duplicate)', () => {
  assert.match(FORWARD_CODE, /IF v_existing_exact_count = 0 THEN\s*\n\s*INSERT INTO public\.tour_preparation_rules/);
  const existenceCheck = FORWARD_CODE.slice(FORWARD_CODE.indexOf('v_existing_exact_count'), FORWARD_CODE.indexOf('IF v_existing_exact_count = 0'));
  assert.match(existenceCheck, /preparation_type = 'entrance_ticket'/);
  assert.match(existenceCheck, /label = 'Ayasofya Giriş Bileti'/);
  assert.match(existenceCheck, /quantity_rule = 'per_guest'/);
  assert.match(existenceCheck, /fixed_quantity IS NULL/);
  assert.match(existenceCheck, /is_active = TRUE/);
});

// ═══════════════════════════════════════════════════════════════════════
// 16-17. Rollback removes only the intended rule; preserves unrelated
// rules
// ═══════════════════════════════════════════════════════════════════════

test('16. the rollback DELETE is scoped to tour_id + itinerary_stop_id + preparation_type + label together — never a broader delete', () => {
  const deleteStmt = ROLLBACK_CODE.match(/DELETE FROM public\.tour_preparation_rules[\s\S]*?label = 'Ayasofya Giriş Bileti';/)[0];
  assert.match(deleteStmt, /tour_id = v_tour_id/);
  assert.match(deleteStmt, /itinerary_stop_id = v_stop_id/);
  assert.match(deleteStmt, /preparation_type = 'entrance_ticket'/);
  assert.match(deleteStmt, /label = 'Ayasofya Giriş Bileti'/);
  // Exactly one DELETE statement in the whole rollback file.
  const allDeletes = ROLLBACK_CODE.match(/DELETE FROM/g) || [];
  assert.equal(allDeletes.length, 1);
});

test('17. the rollback never references reservation_preparations, and resolves identity with the same fail-closed zero/multiple checks as the forward migration', () => {
  assert.doesNotMatch(ROLLBACK_CODE, /(DELETE|UPDATE|INSERT)[\s\S]{0,80}reservation_preparations/);
  assert.match(ROLLBACK_CODE, /IF v_tour_count = 0 THEN/);
  assert.match(ROLLBACK_CODE, /IF v_tour_count > 1 THEN/);
  assert.match(ROLLBACK_CODE, /IF v_stop_count = 0 THEN/);
  assert.match(ROLLBACK_CODE, /IF v_stop_count > 1 THEN/);
});

test('rollback is idempotent — a zero-row delete is reported as a NOTICE no-op, never an exception', () => {
  assert.match(ROLLBACK_CODE, /ELSE\s*\n\s*RAISE NOTICE 'HAGIA SOPHIA RULE ROLLBACK: no matching rule existed/);
});

// ═══════════════════════════════════════════════════════════════════════
// 18-21. No rule for anything out of scope
// ═══════════════════════════════════════════════════════════════════════

test('18. no Topkapı rule is created by this migration', () => {
  assert.doesNotMatch(FORWARD_CODE, /Topkap/i);
});

test('19. no Blue Mosque rule is created by this migration', () => {
  assert.doesNotMatch(FORWARD_CODE, /Blue Mosque|Mavi Cami/i);
});

test('20. no Bosphorus Cruise rule is created by this migration', () => {
  assert.doesNotMatch(FORWARD_CODE, /Bosphorus Cruise|Boğaz Turu/i);
});

test('21. no meal/lunch preparation rule is created by this migration — the single INSERT is entrance_ticket only', () => {
  assert.doesNotMatch(FORWARD_CODE, /'meal'/);
  assert.doesNotMatch(FORWARD_CODE, /lunch|almoço|yemek/i);
});

test('the rollback file also never mentions any out-of-scope concept in executable code', () => {
  for (const name of [/Topkap/i, /Blue Mosque|Mavi Cami/i, /Bosphorus Cruise|Boğaz Turu/i, /'meal'/, /lunch|almoço|yemek/i]) {
    assert.doesNotMatch(ROLLBACK_CODE, name);
  }
});

// ═══════════════════════════════════════════════════════════════════════
// Structural / regression safety
// ═══════════════════════════════════════════════════════════════════════

test('this migration never touches Civitatis ingestion code/RPC definitions, only re-checks the ingest_civitatis_booking signature read-only', () => {
  assert.doesNotMatch(FORWARD_CODE, /CREATE OR REPLACE FUNCTION public\.ingest_civitatis_booking/);
  assert.doesNotMatch(FORWARD_CODE, /CREATE OR REPLACE FUNCTION public\.cancel_civitatis_booking/);
  assert.doesNotMatch(FORWARD_CODE, /DROP FUNCTION/);
});

test('this migration and its rollback never mention WhatsApp or auth', () => {
  assert.doesNotMatch(FORWARD_CODE, /whatsapp/i);
  assert.doesNotMatch(ROLLBACK_CODE, /whatsapp/i);
  assert.doesNotMatch(FORWARD_CODE, /auth\.(uid|jwt)/i);
  assert.doesNotMatch(ROLLBACK_CODE, /auth\.(uid|jwt)/i);
});

test('the preflight file contains only WITH/SELECT — no write/DDL keyword anywhere in executable code', () => {
  const preflightCode = codeOnly(PREFLIGHT);
  for (const kw of ['INSERT', 'UPDATE', 'DELETE', 'UPSERT', 'MERGE', 'ALTER', 'CREATE', 'DROP', 'TRUNCATE', 'GRANT', 'REVOKE']) {
    assert.doesNotMatch(preflightCode, new RegExp(`\\b${kw}\\b`));
  }
});

test('the forward migration and rollback are both wrapped in an explicit BEGIN/COMMIT transaction', () => {
  assert.match(FORWARD, /^BEGIN;/m);
  assert.match(FORWARD, /^COMMIT;/m);
  assert.match(ROLLBACK, /^BEGIN;/m);
  assert.match(ROLLBACK, /^COMMIT;/m);
});
