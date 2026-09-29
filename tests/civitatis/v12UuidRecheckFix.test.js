'use strict';
/**
 * tests/civitatis/v12UuidRecheckFix.test.js
 * ─────────────────────────────────────────────────────────────────────────
 * Regression coverage for the second live production defect discovered
 * after V11 shipped: bookings A41323338, A41330832, A41596990 (all
 * "Bosforo y Barrio Sultanahmet", Portekizce) passed V11's Step 2 field
 * validation cleanly, then failed at Step 6a's post-lock tour_channels
 * re-check with SQLSTATE 42883 ("function min(uuid) does not exist") —
 * stock PostgreSQL defines no MIN/MAX aggregate over the uuid type.
 *
 * supabase_migration_civitatis_write_v12_uuid_recheck_fix.sql fixes this
 * with a single-line change: MIN(tour_id) -> MIN(tour_id::text)::uuid.
 * NOT YET APPLIED to any database (explicitly withheld pending manual
 * approval) — every test here is a pure, static, never-executed text
 * assertion against the prepared .sql files, exactly like the existing
 * V11-generation tests in portugueseOptionalHour.test.js. Nothing in
 * this file connects to a database or runs any SQL.
 * ─────────────────────────────────────────────────────────────────────────
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const V11_PATH = path.join(ROOT, 'supabase_migration_civitatis_write_v11_optional_check_in_time.sql');
const V12_PATH = path.join(ROOT, 'supabase_migration_civitatis_write_v12_uuid_recheck_fix.sql');
const V12_ROLLBACK_PATH = path.join(ROOT, 'supabase_migration_civitatis_write_v12_ROLLBACK_to_v11.sql');

const v11 = fs.readFileSync(V11_PATH, 'utf8');
const v12 = fs.readFileSync(V12_PATH, 'utf8');
const v12Rollback = fs.existsSync(V12_ROLLBACK_PATH) ? fs.readFileSync(V12_ROLLBACK_PATH, 'utf8') : null;

const V12_SIGNATURE = 'text, text, timestamp with time zone, text, text, text, uuid, text, uuid, text, date, time without time zone, integer, integer, numeric, text, numeric, text, uuid, text, text, text, jsonb, boolean, text, text';

// ── A. File exists, is a forward-only migration, never edits V11 ───────

test('V12 migration file exists and V11 file is untouched (byte-identical to what V11 already was)', () => {
  assert.ok(fs.existsSync(V12_PATH), 'supabase_migration_civitatis_write_v12_uuid_recheck_fix.sql must exist');
  // V11 must still permit NULL check_in_time — this migration must never
  // have been edited/overwritten by the V12 work.
  assert.doesNotMatch(v11, /\n\s*IF p_check_in_time IS NULL THEN\n\s*v_missing_fields := array_append\(v_missing_fields, 'check_in_time'\);\n\s*END IF;/,
    'V11 must still permit NULL check_in_time — this file must never be edited by V12 work');
  assert.match(v11, /SELECT COUNT\(\*\), MIN\(tour_id\) INTO v_provision_match_count, v_provisioned_tour_id/,
    'V11 must still contain its own original (buggy) statement verbatim — V12 is a NEW forward migration, not an edit of V11');
});

test('V12 is wrapped in an explicit transaction and introduces no schema-mutating statement', () => {
  assert.match(v12, /^BEGIN;/m);
  assert.match(v12, /^COMMIT;/m);
  assert.doesNotMatch(v12, /^\s*DROP FUNCTION\b/mi);
  assert.doesNotMatch(v12, /^\s*ALTER TABLE\b/mi);
  assert.doesNotMatch(v12, /^\s*CREATE TABLE\b/mi);
  assert.doesNotMatch(v12, /^\s*DROP TABLE\b/mi);
  assert.doesNotMatch(v12, /^\s*TRUNCATE\b/mi);
  // Same single pre-existing DELETE as every prior version (reservation_guests
  // replacement on the UPDATE path) — untouched, not a new one introduced.
  assert.equal((v12.match(/\bDELETE\s+FROM\b/gi) || []).length, 1);
});

// ── B. The exact root cause is gone; the exact fix is present ──────────

test('the broken statement (bare MIN(tour_id)) is not present as live SQL in V12', () => {
  assert.doesNotMatch(v12, /^\s*SELECT COUNT\(\*\), MIN\(tour_id\) INTO/m,
    'the exact statement that raised SQLSTATE 42883 in production must not remain in V12');
});

test('the fixed statement (MIN(tour_id::text)::uuid) is present, and COUNT(*) is unchanged', () => {
  assert.match(v12, /^\s*SELECT COUNT\(\*\), MIN\(tour_id::text\)::uuid INTO v_provision_match_count, v_provisioned_tour_id$/m);
});

test('the fixed statement queries the exact same table/columns as V11 (no widening or narrowing of the re-check)', () => {
  const funcStart = v12.indexOf('CREATE OR REPLACE FUNCTION public.ingest_civitatis_booking(');
  const stmtIdx = v12.indexOf('SELECT COUNT(*), MIN(tour_id::text)::uuid INTO', funcStart);
  const stmtBody = v12.slice(stmtIdx, v12.indexOf(';', stmtIdx) + 1);
  assert.match(stmtBody, /FROM public\.tour_channels/);
  assert.match(stmtBody, /WHERE source_id = p_source_id/);
  assert.match(stmtBody, /AND external_product_id = p_civitatis_internal_code/);
  assert.match(stmtBody, /AND booking_language = p_tour_language/);
});

// ── C. No unsupported UUID aggregate remains anywhere in the RPC ───────

/** Live (non-comment, non-prose) MIN(...)/MAX(...) aggregates over an
 * apparently uuid-typed column (name ending _id/_uuid) with no cast
 * guarding it, found in one SQL source text. Skips every line whose
 * trimmed text starts with "--" (comment/prose), so a header or inline
 * comment quoting the OLD broken code for explanatory purposes is never
 * mistaken for live SQL. */
function findUnguardedUuidAggregates(sqlText) {
  const found = [];
  for (const line of sqlText.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.startsWith('--') || trimmed === '') continue;
    const matches = trimmed.match(/\b(MIN|MAX)\(([a-zA-Z_][a-zA-Z0-9_]*)\)/g) || [];
    for (const m of matches) {
      const col = m.slice(4, -1); // strip "MIN(" / "MAX(" and ")"
      if (/_id$|_uuid$/i.test(col)) found.push({ line: trimmed, match: m });
    }
  }
  return found;
}

test('no unguarded MIN(uuid-column)/MAX(uuid-column) aggregate remains anywhere in the LIVE SQL of V12', () => {
  const found = findUnguardedUuidAggregates(v12);
  assert.deepEqual(found, [], `unexpected uuid-typed MIN/MAX aggregate(s) found in live V12 SQL: ${JSON.stringify(found)}`);
});

test('repository-wide: the unguarded MIN(uuid) defect is confined to exactly the known, already-identified files — nowhere new', () => {
  // V10 (where the defect originated) and the V11-ROLLBACK-to-V10 file
  // (which intentionally restores V10's body verbatim, bug included, as
  // its own documented job) are EXPECTED to still contain the raw
  // MIN(tour_id) — neither is live, neither is in scope for this fix
  // (V10 is superseded by V11; the rollback file is only ever meant to
  // be run in a rollback scenario). V11 (currently LIVE in production)
  // is also expected to still contain it — that is the exact defect this
  // V12 migration exists to fix, and V11 itself must not be edited (see
  // the test above confirming V11 is untouched). Only V12 must be clean
  // — confirmed by the dedicated V12-only test above. This test's real
  // job is to prove the defect exists NOWHERE ELSE in the repository
  // beyond this fully-accounted-for set — i.e. searching the whole repo
  // surfaces no surprise.
  const KNOWN_AFFECTED_FILES = new Set([
    'supabase_migration_civitatis_write_v10_tour_auto_provisioning.sql',
    'supabase_migration_civitatis_write_v11_optional_check_in_time.sql',
    'supabase_migration_civitatis_write_v11_ROLLBACK_to_v10.sql',
    // The V12->V11 rollback restores V11's function body verbatim BY
    // DESIGN (see its own header: "restoring V11 means restoring its
    // defect too") — expected, not in scope for V12's fix, exactly like
    // the V11-ROLLBACK-to-V10 file above.
    'supabase_migration_civitatis_write_v12_ROLLBACK_to_v11.sql',
  ]);
  const allSqlFiles = fs.readdirSync(ROOT).filter(f => f.endsWith('.sql'));
  assert.ok(allSqlFiles.length > 10, 'sanity check: expected many .sql files in the repository root');
  const unexpectedlyAffected = [];
  for (const file of allSqlFiles) {
    const text = fs.readFileSync(path.join(ROOT, file), 'utf8');
    const found = findUnguardedUuidAggregates(text);
    if (found.length === 0) continue;
    if (KNOWN_AFFECTED_FILES.has(file)) continue; // expected, not in scope for V12
    unexpectedlyAffected.push({ file, found });
  }
  assert.deepEqual(unexpectedlyAffected, [], `found the unguarded MIN(uuid) defect in file(s) outside the known/expected set: ${JSON.stringify(unexpectedlyAffected)}`);
});

test('no equivalent unsupported UUID aggregate pattern exists in the JS ingestion path (api/_civitatis/*)', () => {
  const dir = path.join(ROOT, 'api', '_civitatis');
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.js'));
  for (const file of files) {
    const text = fs.readFileSync(path.join(dir, file), 'utf8');
    assert.doesNotMatch(text, /\bMIN\(\s*[a-zA-Z_]*(?:tour_id|uuid)[a-zA-Z_]*\s*\)/i,
      `${file}: unexpected SQL-shaped MIN(uuid) reference in application code`);
  }
});

// ── D. Function signature and permissions are byte-identical to V11 ────

test('V12 function signature is exactly the same 26 parameters, same names/types/order/defaults, as V11 (no DROP FUNCTION needed)', () => {
  const extractSignature = (src) => {
    const start = src.indexOf('CREATE OR REPLACE FUNCTION public.ingest_civitatis_booking(');
    const end = src.indexOf('RETURNS JSONB', start);
    return src.slice(start, end);
  };
  const v11Sig = extractSignature(v11);
  const v12Sig = extractSignature(v12);
  assert.equal(v12Sig, v11Sig, 'the CREATE OR REPLACE FUNCTION parameter list must be byte-for-byte identical between V11 and V12');
});

test('V12 preflight confirms the pre-existing signature exists (structural safety check) before CREATE OR REPLACE runs', () => {
  assert.match(v12, /pg_get_function_identity_arguments\(p\.oid\) =\s*\n?\s*'text, text, timestamp with time zone/);
  assert.ok(v12.includes(V12_SIGNATURE), 'preflight must check the exact 26-parameter identity signature');
  const createIdx = v12.indexOf('CREATE OR REPLACE FUNCTION public.ingest_civitatis_booking(');
  const preflightIdx = v12.indexOf('V12 PREFLIGHT PASSED');
  assert.ok(preflightIdx > -1 && preflightIdx < createIdx, 'preflight must run and pass BEFORE CREATE OR REPLACE FUNCTION');
});

test('V12 REVOKE/GRANT tail matches the exact 26-parameter signature and is otherwise unchanged from V11', () => {
  const extractTail = (src) => src.slice(src.indexOf('-- SECURITY: restrict EXECUTE to service_role only.'));
  assert.equal(extractTail(v12), extractTail(v11), 'REVOKE/GRANT/COMMENT ON FUNCTION/COMMIT tail must be byte-for-byte identical to V11');
  assert.match(v12, /GRANT EXECUTE ON FUNCTION public\.ingest_civitatis_booking\(/);
  assert.match(v12, /\) TO service_role;/);
  assert.doesNotMatch(v12, /GRANT EXECUTE[\s\S]{0,400}TO (PUBLIC|anon|authenticated);/);
});

// ── E. Everything else in the function body is untouched ───────────────

test('the ONLY functional change in the function body is the one Step 6a re-check statement (plus its adjacent explanatory comments)', () => {
  // Reconstruct V12's function body with the KNOWN V12-only additions
  // normalized back to their V11 text, then assert byte-equality with
  // V11's own function body. Any OTHER divergence fails this test.
  const extractBody = (src) => {
    const start = src.indexOf('-- FUNCTION: ingest_civitatis_booking');
    const end = src.indexOf('COMMENT ON FUNCTION public.ingest_civitatis_booking IS');
    return src.slice(start, end);
  };
  let v12Body = extractBody(v12);
  const v11Body = extractBody(v11);

  // Known addition #1: the V12 explanatory comment block just above the
  // re-check statement.
  const v12CommentBlock = v12Body.slice(
    v12Body.indexOf('        --\n        -- V12: MIN(tour_id) alone'),
    v12Body.indexOf("        v_stage := 'tour_provision_recheck';")
  );
  assert.ok(v12CommentBlock.includes('V12: MIN(tour_id) alone does not exist'), 'sanity: located the V12-only comment block');
  v12Body = v12Body.replace(v12CommentBlock, '');

  // Known change #2: the fixed statement itself, reverted to V11's text
  // for comparison purposes only.
  v12Body = v12Body.replace(
    'SELECT COUNT(*), MIN(tour_id::text)::uuid INTO v_provision_match_count, v_provisioned_tour_id',
    'SELECT COUNT(*), MIN(tour_id) INTO v_provision_match_count, v_provisioned_tour_id'
  );

  // Known change #3: the adjacent ambiguous-branch comment referencing
  // the statement, reverted to V11's single-line text for comparison.
  v12Body = v12Body.replace(
    '          -- (MIN(tour_id::text)::uuid above is never used as a real\n          -- answer in this branch) and p_tour_id is deliberately left\n          -- NULL so the\n',
    '          -- (MIN(tour_id) above is never used as a real answer in this\n          -- branch) and p_tour_id is deliberately left NULL so the\n'
  );

  assert.equal(v12Body, v11Body, 'after reverting the three known, deliberate V12 changes, the function body must be byte-for-byte identical to V11 — proving nothing else was touched');
});

// ── F. Tour-provisioning semantics (0 / 1 / >1) are preserved exactly ──
// No live database in this test environment — these are logic/structural
// traces proving the REQUIRED semantics are still encoded exactly as
// specified, immediately around the fixed statement.

test('0 matches: v_provision_match_count = 0 still creates a new tour/tour_language/tour_channel, v_provisioned_tour_id may be NULL going in', () => {
  const idx = v12.indexOf("ELSIF v_provision_match_count = 0 THEN");
  assert.ok(idx > -1);
  const body = v12.slice(idx, v12.indexOf('END IF;', idx));
  assert.match(body, /INSERT INTO public\.tours \(name, category, status, base_price, currency\)/);
  assert.match(body, /VALUES \(p_civitatis_internal_code, 'other', 'draft', 0, 'EUR'\)/);
  assert.match(body, /RETURNING id INTO v_provisioned_tour_id;/);
  assert.match(body, /INSERT INTO public\.tour_languages \(tour_id, language_code, language_name\)/);
  assert.match(body, /INSERT INTO public\.tour_channels \(tour_id, source_id, external_product_id, booking_language, is_active\)/);
  // MIN() over zero rows is SQL NULL for either a uuid or text-cast uuid
  // aggregate — the 0-match branch's starting point (before the INSERT
  // overwrites it) is unaffected by the V12 cast, so this branch is
  // reached under the exact same condition as before.
});

test('exactly 1 match: v_provision_match_count = 1 reuses the existing tour_id verbatim, with zero writes', () => {
  // No explicit "ELSIF v_provision_match_count = 1" branch exists BY
  // DESIGN — v_provisioned_tour_id already holds the single existing
  // match straight from the fixed SELECT, reused as-is. Documented by
  // the comment immediately after the IF/ELSIF block's closing END IF;,
  // between it and the final p_tour_id assignment — the exact gap where
  // the implicit "count = 1" case falls through with no branch of its
  // own. Isolate exactly that gap and prove it contains no write.
  const zeroMatchIdx = v12.indexOf('ELSIF v_provision_match_count = 0 THEN');
  const zeroMatchEndIdx = v12.indexOf('END IF;', zeroMatchIdx);
  const assignIdx = v12.indexOf('p_tour_id := v_provisioned_tour_id;', zeroMatchEndIdx);
  const implicitReuseGap = v12.slice(zeroMatchEndIdx, assignIdx);

  assert.match(implicitReuseGap, /ELSE \(v_provision_match_count = 1\): v_provisioned_tour_id\s*\n\s*-- already holds the single existing match from the SELECT above\s*\n\s*-- — reused as-is, nothing written\./);
  assert.doesNotMatch(implicitReuseGap, /\bINSERT INTO\b/, 'the implicit 1-match reuse path must write nothing — no branch of its own, no write of its own');
  assert.doesNotMatch(implicitReuseGap, /\bUPDATE\b/);
  assert.doesNotMatch(implicitReuseGap, /\bDELETE\b/);
});

test('more than 1 match: v_provision_match_count > 1 still fails closed — value discarded, p_tour_id left NULL, reported as manual_review_required, never an arbitrary pick', () => {
  const idx = v12.indexOf('IF v_provision_match_count > 1 THEN');
  const body = v12.slice(idx, v12.indexOf("ELSIF v_provision_match_count = 0 THEN", idx));
  assert.match(body, /v_stage := 'tour_provision_ambiguous';/);
  assert.match(body, /v_provisioned_tour_id := NULL;/);
  assert.doesNotMatch(body, /INSERT INTO/, 'the ambiguous branch must never write anything');

  // Downstream: p_tour_id, left NULL by the ambiguous branch, is caught
  // by Step 6b's existing "tour still unresolved" check and reported as
  // manual_review_required — unchanged by V12.
  const step6bIdx = v12.indexOf('IF p_tour_id IS NULL THEN', idx);
  const step6bBody = v12.slice(step6bIdx, v12.indexOf('END IF;', step6bIdx));
  assert.match(step6bBody, /'result', 'manual_review_required'/);
  assert.match(step6bBody, /tour_id \(Internal code did not match tour_channels\)/);
});

test('the >1 branch never arbitrarily reuses a MIN-selected tour_id as a real answer (fail-closed, not fail-open)', () => {
  const idx = v12.indexOf('IF v_provision_match_count > 1 THEN');
  const body = v12.slice(idx, v12.indexOf('v_provisioned_tour_id := NULL;', idx) + 40);
  // p_tour_id is set from v_provisioned_tour_id only AFTER this whole
  // IF/ELSIF block, at "p_tour_id := v_provisioned_tour_id;" — by the
  // time that line runs for an ambiguous case, v_provisioned_tour_id has
  // already been overwritten to NULL right here, so the MIN-selected
  // value (from either the old or the V12-fixed statement) can never
  // reach p_tour_id in the ambiguous case.
  assert.match(body, /v_provisioned_tour_id := NULL;/);
});

// ── G. V11's optional check_in_time behavior survives into V12 ─────────

test('V12 still permits NULL check_in_time exactly as V11 introduced it (Step 2 unchanged)', () => {
  assert.doesNotMatch(v12, /\n\s*IF p_check_in_time IS NULL THEN\n\s*v_missing_fields := array_append\(v_missing_fields, 'check_in_time'\);\n\s*END IF;/,
    'V12 must not reintroduce V11-fixed check_in_time-missing-field rejection');
  assert.match(v12, /V11: check_in_time is now OPTIONAL\./,
    'V12 must retain V11\'s own explanatory comment for the check_in_time field, proving that section of Step 2 is untouched');
  const step2Idx = v12.indexOf('IF p_check_in IS NULL THEN');
  const step2End = v12.indexOf("IF p_pax_adult IS NULL", step2Idx);
  const step2Body = v12.slice(step2Idx, step2End);
  assert.doesNotMatch(step2Body, /v_missing_fields := array_append\(v_missing_fields, 'check_in_time'\)/);
  assert.doesNotMatch(v12, /v_missing_fields := array_append\(v_missing_fields, 'check_in_time'\)/);
});

test('V12 does not alter parser behavior, cancellation, auth, scheduler, or frontend files', () => {
  // This migration touches exactly one .sql file plus this test file —
  // confirmed at the git-diff level by the delivering report, not
  // re-derivable from a single file's own content. This test instead
  // asserts the negative from inside the file itself: no reference to
  // cancellation, auth tables/functions, or scheduler concerns appears
  // anywhere in the new migration.
  assert.doesNotMatch(v12, /cancel/i);
  assert.doesNotMatch(v12, /CREATE POLICY|GRANT[\s\S]{0,120}staff_users|auth\.users/i);
  assert.doesNotMatch(v12, /CIVITATIS_SCHEDULER_SECRET|CIVITATIS_MANUAL_WRITE_SECRET/);
});

// ── H. V12 -> V11 rollback restores V11 EXACTLY ─────────────────────────
// Same convention as portugueseOptionalHour.test.js's own
// "V11 rollback restores the exact V10 function body byte-for-byte" test.
// Nothing here executes SQL — pure text assertions on the prepared file.

test('V12 rollback file exists and declares itself a V12 -> V11 rollback', () => {
  assert.ok(v12Rollback, 'supabase_migration_civitatis_write_v12_ROLLBACK_to_v11.sql must exist');
  assert.match(v12Rollback, /ROLLBACK: V12 \(uuid recheck fix\) -> V11/);
  assert.match(v12Rollback, /^BEGIN;/m);
  assert.match(v12Rollback, /^COMMIT;/m);
});

test('the rollback restores the exact V11 function body byte-for-byte', () => {
  const v11FuncStart = v11.indexOf('-- FUNCTION: ingest_civitatis_booking');
  // Back up to the divider line immediately preceding the marker, same
  // slice boundary the rollback file itself was built from.
  const v11BlockStart = v11.lastIndexOf('-- ─────', v11FuncStart);
  const v11FuncBody = v11.slice(v11BlockStart);

  const rollbackFuncStart = v12Rollback.indexOf('-- FUNCTION: ingest_civitatis_booking');
  const rollbackBlockStart = v12Rollback.lastIndexOf('-- ─────', rollbackFuncStart);
  const rollbackFuncBody = v12Rollback.slice(rollbackBlockStart);

  assert.equal(rollbackFuncBody, v11FuncBody,
    'the rollback file must contain the V11 function definition (CREATE FUNCTION body, COMMENT ON FUNCTION, REVOKE/GRANT, COMMIT) verbatim, byte-for-byte');
});

test('the rollback reintroduces the exact pre-V12 MIN(tour_id) statement in its LIVE (restored) SQL (restoring V11 means restoring its defect too, by design)', () => {
  const funcStart = v12Rollback.indexOf('CREATE OR REPLACE FUNCTION public.ingest_civitatis_booking(');
  const funcBody = v12Rollback.slice(funcStart);
  assert.match(funcBody, /^\s*SELECT COUNT\(\*\), MIN\(tour_id\) INTO v_provision_match_count, v_provisioned_tour_id$/m);
  // The rollback's own HEADER (prose, never executed) legitimately
  // mentions V12's fixed statement text for documentation purposes —
  // this assertion is scoped to the restored FUNCTION BODY only, where
  // it matters: V12's fix must not have leaked into the actual restored
  // SQL.
  assert.doesNotMatch(funcBody, /MIN\(tour_id::text\)::uuid/,
    'the restored function body must NOT carry V12\'s fix forward — it restores V11\'s SQL exactly, defect included');
});

test('the rollback is a function-definition-only change: no DELETE/TRUNCATE/ALTER TABLE/DROP TABLE beyond what V11 itself already contains', () => {
  // The byte-for-byte identity test above already proves the restored
  // function body is EXACTLY V11's — so any DML/DDL inside it is by
  // definition already-reviewed V11 behavior (e.g. the legitimate
  // "UPDATE public.reservations SET ..." on the modification path).
  // This test only needs to confirm the ROLLBACK FILE AS A WHOLE (header
  // included) introduces no schema-mutating statement of its own, same
  // as every other migration/rollback in this series.
  assert.equal((v12Rollback.match(/\bDELETE\s+FROM\b/gi) || []).length, 1,
    'same single pre-existing DELETE as V11 (reservation_guests replacement on the UPDATE path) — no new one introduced');
  assert.doesNotMatch(v12Rollback, /^\s*TRUNCATE\b|^\s*ALTER TABLE\b|^\s*DROP TABLE\b/mi);
  assert.doesNotMatch(v12Rollback, /^\s*DROP FUNCTION\b/mi);
});

test('the rollback keeps the exact same 26-parameter signature and REVOKE/GRANT tail as V11 and V12', () => {
  const extractSignature = (src) => {
    const start = src.indexOf('CREATE OR REPLACE FUNCTION public.ingest_civitatis_booking(');
    const end = src.indexOf('RETURNS JSONB', start);
    return src.slice(start, end);
  };
  assert.equal(extractSignature(v12Rollback), extractSignature(v11));
  assert.equal(extractSignature(v12Rollback), extractSignature(v12));

  const extractTail = (src) => src.slice(src.indexOf('-- SECURITY: restrict EXECUTE to service_role only.'));
  assert.equal(extractTail(v12Rollback), extractTail(v11), 'REVOKE/GRANT/COMMENT ON FUNCTION/COMMIT tail must be byte-for-byte identical to V11');
});

test('the rollback explicitly documents that it reintroduces the min(uuid) defect, so a future operator cannot apply it unknowingly', () => {
  assert.match(v12Rollback, /REINTRODUCES the live defect/);
});
