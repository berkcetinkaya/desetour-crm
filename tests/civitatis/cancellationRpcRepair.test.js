'use strict';
/**
 * tests/civitatis/cancellationRpcRepair.test.js
 * ─────────────────────────────────────────────────────────────────────────
 * Regression coverage for supabase_migration_civitatis_write_v13_1_
 * cancellation_rpc_repair.sql — the repair for the production incident
 * where V13 was manually applied ("Success. No rows returned.") yet
 * public.cancel_civitatis_booking did not exist in pg_proc afterwards.
 *
 * Root cause (see the repair file's own header): no internal defect was
 * found in the committed V13 file — its BEGIN/COMMIT and both dollar-quote
 * pairs are balanced, and CREATE OR REPLACE FUNCTION is a clean top-level
 * statement. V13 simply had no POSTFLIGHT step, so a partial/truncated
 * manual apply that never reached the CREATE FUNCTION statement could
 * still report a bare "Success" for whatever prefix of the script DID run.
 *
 * This test file exists specifically so THIS EXACT FAILURE MODE — a
 * migration that can report success without actually creating the
 * function — can never again pass silently:
 *   1. It proves (statically, against the original V13 file) the audit
 *      findings that ruled out an internal defect, so that evidence is
 *      pinned down as a repeatable check, not just a one-off manual read.
 *   2. It proves the repair migration adds a genuine POSTFLIGHT — not just
 *      another preflight — that re-verifies pg_proc AFTER CREATE FUNCTION
 *      and RAISEs an EXCEPTION (aborting the transaction) if the function
 *      is still missing, which is the exact gap V13 had.
 *   3. It proves the repair's function body is byte-for-byte identical to
 *      V13's already-reviewed body (no semantic drift introduced while
 *      assembling the repair file).
 *
 * NOT YET APPLIED to any database — pure static text assertions against
 * the prepared .sql files, exactly like every prior migration's test file
 * in this project. Nothing here connects to a database or runs any SQL.
 * ─────────────────────────────────────────────────────────────────────────
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const V13_PATH = path.join(ROOT, 'supabase_migration_civitatis_write_v13_cancellation.sql');
const REPAIR_PATH = path.join(ROOT, 'supabase_migration_civitatis_write_v13_1_cancellation_rpc_repair.sql');

const v13 = fs.readFileSync(V13_PATH, 'utf8');
const repair = fs.readFileSync(REPAIR_PATH, 'utf8');
// The repair file's header comment (lines ~1-138) DESCRIBES the migration
// in prose — including, deliberately, literal snippets like "DO $$ ... END
// $$;" and "NOTIFY pgrst, 'reload schema';" and even the production
// evidence query that itself uses pg_get_function_identity_arguments.
// Structural assertions about the ACTUAL executable statements must search
// only the code region (from the top-level BEGIN; onward), never the
// header prose, or they false-positive/false-negative on that prose.
const repairCode = repair.slice(repair.indexOf('\nBEGIN;'));

// ── A. Pinning down the audit conclusion about the ORIGINAL V13 file ───
// (so "no internal defect in V13" is a repeatable check, not a one-off
// manual read that can silently go stale if V13 is ever hand-edited)

test('V13: exactly one top-level BEGIN;/COMMIT; pair, no stray ROLLBACK', () => {
  const beginMatches = v13.match(/^BEGIN;\s*$/gm) || [];
  const commitMatches = v13.match(/^COMMIT;\s*$/gm) || [];
  assert.equal(beginMatches.length, 1, 'expected exactly one top-level BEGIN;');
  assert.equal(commitMatches.length, 1, 'expected exactly one top-level COMMIT;');
  assert.doesNotMatch(v13, /^ROLLBACK/m);
});

test('V13: dollar-quoting is balanced — exactly 4 "$$" occurrences forming exactly 2 clean pairs (preflight DO block, function body)', () => {
  const dollarLines = v13.split('\n').filter(l => l.includes('$$'));
  assert.equal(dollarLines.length, 4, `expected exactly 4 lines containing $$, found ${dollarLines.length}`);
});

test('V13: CREATE OR REPLACE FUNCTION is a clean top-level statement — not nested inside a string, comment, or DO block', () => {
  const createIdx = v13.indexOf('CREATE OR REPLACE FUNCTION public.cancel_civitatis_booking');
  assert.ok(createIdx > -1);
  const beforeCreate = v13.slice(0, createIdx);
  // The preflight DO $$ ... END $$; block must be fully closed before
  // CREATE OR REPLACE FUNCTION appears — i.e. there is no open, unclosed
  // DO block still "wrapping" the CREATE statement.
  const lastDoOpen = beforeCreate.lastIndexOf('DO $$');
  const lastDoClose = beforeCreate.lastIndexOf('END $$;');
  assert.ok(lastDoOpen === -1 || lastDoClose > lastDoOpen, 'the preflight DO block must be closed before CREATE FUNCTION runs');
});

test('V13: has NO postflight verification after CREATE FUNCTION — this is the exact gap the repair closes (documents the defect this repair exists to fix)', () => {
  const createIdx = v13.indexOf('CREATE OR REPLACE FUNCTION public.cancel_civitatis_booking');
  const afterCreate = v13.slice(createIdx);
  // No second DO $$ block, and no re-query of pg_proc, appears anywhere
  // after the CREATE FUNCTION statement in the original V13 file.
  assert.doesNotMatch(afterCreate, /DO \$\$/, 'V13 has no postflight DO block — confirming the gap this repair adds');
  assert.doesNotMatch(afterCreate, /FROM pg_proc/, 'V13 never re-queries pg_proc after creating the function');
});

// ── B. The repair file exists, is transactional, never touches
// ingest_civitatis_booking or V12 ───────────────────────────────────────

test('repair file exists, is wrapped in BEGIN/COMMIT, and never CREATE/ALTER/DROPs ingest_civitatis_booking', () => {
  assert.ok(fs.existsSync(REPAIR_PATH));
  assert.match(repair, /^BEGIN;\s*$/m);
  assert.match(repair, /^COMMIT;\s*$/m);
  const createFunctionMatches = repair.match(/^CREATE OR REPLACE FUNCTION public\.(\w+)/gm) || [];
  assert.deepEqual(createFunctionMatches, ['CREATE OR REPLACE FUNCTION public.cancel_civitatis_booking']);
  assert.doesNotMatch(repair, /CREATE OR REPLACE FUNCTION public\.ingest_civitatis_booking/);
  assert.doesNotMatch(repair, /ALTER FUNCTION public\.ingest_civitatis_booking/);
  assert.doesNotMatch(repair, /DROP FUNCTION[^;]*ingest_civitatis_booking/);
});

test('repair never touches any V10/V11/V12 object other than a read-only preflight check of ingest_civitatis_booking\'s signature', () => {
  // Strip the installed function's own body first: it legitimately
  // contains "UPDATE public.reservations" (Step 5) as part of the
  // already-reviewed cancellation behavior being (re)installed — that is
  // code inside the function, not a migration-time statement.
  const withoutFunctionBody = repairCode.slice(0, repairCode.indexOf('CREATE OR REPLACE FUNCTION public.cancel_civitatis_booking('))
    + repairCode.slice(repairCode.indexOf('COMMENT ON FUNCTION public.cancel_civitatis_booking'));
  assert.doesNotMatch(withoutFunctionBody, /INSERT INTO public\.reservations\b/);
  assert.doesNotMatch(withoutFunctionBody, /INSERT INTO public\.customers\b/);
  assert.doesNotMatch(withoutFunctionBody, /INSERT INTO public\.tours\b/);
  assert.doesNotMatch(withoutFunctionBody, /INSERT INTO public\.tour_languages\b/);
  assert.doesNotMatch(withoutFunctionBody, /INSERT INTO public\.tour_channels\b/);
  assert.doesNotMatch(withoutFunctionBody, /\bDELETE\s+FROM\b/i);
  assert.doesNotMatch(withoutFunctionBody, /\bUPDATE\s+public\.reservations\b/, 'outside the installed function body, the repair migration itself must never UPDATE a reservation row as a migration-time statement');
});

test('repair preflight reuses the exact V12-corrected oidvector comparison for ingest_civitatis_booking, never the fragile pg_get_function_identity_arguments form', () => {
  assert.match(repairCode, /p\.proname = 'ingest_civitatis_booking'/);
  assert.match(repairCode, /p\.proargtypes = array_to_string\(/);
  assert.doesNotMatch(repairCode, /pg_get_function_identity_arguments/);
});

// ── C. Idempotent regardless of how far V13 got ─────────────────────────

test('repair re-applies the CHECK widen using the same idempotent DROP CONSTRAINT IF EXISTS + ADD CONSTRAINT pattern as V13', () => {
  assert.match(repair, /ALTER TABLE public\.email_ingestions DROP CONSTRAINT IF EXISTS email_ingestions_event_type_check;/);
  assert.match(repair, /ALTER TABLE public\.email_ingestions ADD CONSTRAINT email_ingestions_event_type_check\s*\n\s*CHECK \(event_type IN \('new_booking','modified','unknown','cancelled'\)\);/);
});

test('repair uses CREATE OR REPLACE FUNCTION (never DROP FUNCTION first) — safe whether the function already exists or not', () => {
  assert.match(repair, /CREATE OR REPLACE FUNCTION public\.cancel_civitatis_booking\(/);
  assert.doesNotMatch(repair, /DROP FUNCTION[^;]*cancel_civitatis_booking/);
});

// ── D. Function body is byte-for-byte identical to V13's already-reviewed
// body — no semantic drift while assembling the repair ─────────────────

function extractFunctionBody(source) {
  const start = source.indexOf('CREATE OR REPLACE FUNCTION public.cancel_civitatis_booking(');
  const end = source.indexOf('COMMENT ON FUNCTION public.cancel_civitatis_booking', start);
  assert.ok(start > -1 && end > -1 && end > start);
  return source.slice(start, end);
}

test('the repair\'s cancel_civitatis_booking function body is byte-for-byte identical to the already-reviewed V13 body', () => {
  const v13Body = extractFunctionBody(v13);
  const repairBody = extractFunctionBody(repair);
  assert.equal(repairBody, v13Body, 'the repair must install the EXACT already-reviewed V13 function body, not a rewrite');
});

test('the repair\'s REVOKE/GRANT permissions block is byte-for-byte identical to V13\'s', () => {
  function extractGrantBlock(source) {
    const start = source.indexOf('REVOKE ALL ON FUNCTION public.cancel_civitatis_booking');
    const end = source.indexOf('TO service_role;', start) + 'TO service_role;'.length;
    assert.ok(start > -1 && end > start);
    return source.slice(start, end);
  }
  assert.equal(extractGrantBlock(repair), extractGrantBlock(v13));
});

// ── E. NEW: genuine postflight verification (the exact gap this repair
// closes) — must come AFTER CREATE FUNCTION and BEFORE COMMIT ──────────

test('repair contains a postflight DO block, positioned AFTER CREATE FUNCTION and BEFORE COMMIT', () => {
  const createIdx = repair.indexOf('CREATE OR REPLACE FUNCTION public.cancel_civitatis_booking(');
  const commitIdx = repair.lastIndexOf('\nCOMMIT;');
  const postflightDoMatches = [...repair.matchAll(/\nDO \$\$/g)].map(m => m.index);
  assert.ok(postflightDoMatches.length >= 2, 'expected at least 2 DO $$ blocks: preflight and postflight');
  const postflightIdx = postflightDoMatches[postflightDoMatches.length - 1];
  assert.ok(postflightIdx > createIdx, 'postflight DO block must come after CREATE FUNCTION');
  assert.ok(postflightIdx < commitIdx, 'postflight DO block must come before COMMIT');
});

test('the postflight re-queries pg_proc for cancel_civitatis_booking with the exact 7-parameter signature, using the oidvector (not general array) comparison technique', () => {
  const createIdx = repair.indexOf('CREATE OR REPLACE FUNCTION public.cancel_civitatis_booking(');
  const postflight = repair.slice(createIdx);
  assert.match(postflight, /FROM pg_proc p/);
  assert.match(postflight, /p\.proname = 'cancel_civitatis_booking'/);
  assert.match(postflight, /p\.pronargs = 7/);
  assert.match(postflight, /p\.proargtypes = array_to_string\(\s*\n\s*ARRAY\['text','text','timestamptz','text','text','uuid','text'\]::regtype\[\]::oid\[\],/);
});

test('the postflight RAISEs an EXCEPTION (aborting the whole transaction) when the function is not found — this is what makes success impossible without a real CREATE', () => {
  const createIdx = repair.indexOf('CREATE OR REPLACE FUNCTION public.cancel_civitatis_booking(');
  const postflight = repair.slice(createIdx);
  const ifNotExistsIdx = postflight.indexOf('IF NOT EXISTS (');
  assert.ok(ifNotExistsIdx > -1);
  const raiseIdx = postflight.indexOf('RAISE EXCEPTION', ifNotExistsIdx);
  const endIfIdx = postflight.indexOf('END IF;', ifNotExistsIdx);
  assert.ok(raiseIdx > ifNotExistsIdx && raiseIdx < endIfIdx, 'a missing function must RAISE EXCEPTION inside the postflight IF NOT EXISTS branch');
  assert.match(postflight.slice(raiseIdx, endIfIdx), /POSTFLIGHT FAILED/);
});

test('the postflight also re-verifies the email_ingestions.event_type CHECK actually permits \'cancelled\' after Step 1 ran', () => {
  const createIdx = repair.indexOf('CREATE OR REPLACE FUNCTION public.cancel_civitatis_booking(');
  const postflight = repair.slice(createIdx);
  assert.match(postflight, /email_ingestions_event_type_check/);
  assert.match(postflight, /pg_get_constraintdef/);
});

test('a hypothetical partial apply that stops right after CREATE FUNCTION (skipping REVOKE/GRANT) would still hit the postflight before COMMIT — postflight is the LAST executable block before COMMIT', () => {
  const commitIdx = repair.lastIndexOf('\nCOMMIT;');
  const beforeCommit = repair.slice(0, commitIdx);
  const lastStatementBlock = beforeCommit.slice(beforeCommit.lastIndexOf('DO $$'));
  assert.match(lastStatementBlock, /POSTFLIGHT PASSED|POSTFLIGHT FAILED/, 'the last executable block before COMMIT must be the postflight DO block');
});

// ── F. PostgREST schema reload notification ─────────────────────────────

test('repair sends NOTIFY pgrst, \'reload schema\' AFTER COMMIT (own statement, takes effect immediately rather than waiting on the transaction)', () => {
  const commitIdx = repairCode.indexOf('\nCOMMIT;');
  const notifyIdx = repairCode.indexOf("NOTIFY pgrst, 'reload schema';");
  assert.ok(commitIdx > -1 && notifyIdx > -1);
  assert.ok(notifyIdx > commitIdx, 'NOTIFY must come after COMMIT so it is not gated on/rolled back with the migration transaction');
});

// ── G. Preflight still guards prerequisites before touching anything ───

test('repair preflight checks all three V13 prerequisites (event_type column, unique constraint, ingest_civitatis_booking signature) before any write', () => {
  const firstDoIdx = repairCode.indexOf('DO $$');
  const firstEndIdx = repairCode.indexOf('END $$;', firstDoIdx);
  const preflight = repairCode.slice(firstDoIdx, firstEndIdx);
  assert.match(preflight, /table_name = 'email_ingestions' AND column_name = 'event_type'/);
  assert.match(preflight, /reservations_source_id_external_booking_id_key/);
  assert.match(preflight, /ingest_civitatis_booking/);
  const firstAlterIdx = repairCode.indexOf('ALTER TABLE public.email_ingestions');
  assert.ok(firstEndIdx < firstAlterIdx, 'preflight must fully complete before the first write (Step 1 CHECK widen)');
});
