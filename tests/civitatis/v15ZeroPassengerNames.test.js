'use strict';
/**
 * tests/civitatis/v15ZeroPassengerNames.test.js
 * ─────────────────────────────────────────────────────────────────────────
 * Regression coverage for the real production incident: Civitatis booking
 * A42463096 (a genuinely new product) arrived with a completely valid
 * email — People: 2 Adultos, Client details: Rafael Izquierdo Carrasco —
 * but NO passenger-name list anywhere in the body. pax_adult=2,
 * pax_child=0, and an empty p_passengers array are all correct, faithful
 * parses of what Civitatis actually sent; the parser is not failing. The
 * booking was still routed to needs_review, and its new-tour
 * auto-provisioning never ran, because Step 2's create-path
 * passenger-completeness guard (V7) required an EXACT match between
 * usable passenger names and pax_adult+pax_child, with no allowance for
 * "Civitatis supplied none at all" as a distinct, legitimate shape.
 *
 * supabase_migration_civitatis_write_v15_zero_passenger_names.sql fixes
 * this with two changes, both confined to the CREATE branch: (1) the
 * guard now also accepts usable_passenger_count = 0, and (2) a new,
 * additional activity_logs row is inserted when a reservation is created
 * with zero usable passenger names, so operations has a visible signal.
 * NOT YET APPLIED to any database (explicitly withheld pending manual
 * approval) — every test here is a pure, static, never-executed text
 * assertion against the prepared .sql files, exactly like
 * tests/civitatis/v12UuidRecheckFix.test.js. Nothing in this file
 * connects to a database or runs any SQL. Runtime/transactional claims
 * (actual reservation creation, actual reservation_guests row counts,
 * actual retry/idempotency, actual tour auto-provisioning) are covered
 * separately in tests/civitatis/sql/v15_zero_passenger_names_manual_tests.sql,
 * which requires a real staging database — the same split this project's
 * V10 tour-auto-provisioning work already established.
 * ─────────────────────────────────────────────────────────────────────────
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const V12_PATH = path.join(ROOT, 'supabase_migration_civitatis_write_v12_uuid_recheck_fix.sql');
const V15_PATH = path.join(ROOT, 'supabase_migration_civitatis_write_v15_zero_passenger_names.sql');
const V15_ROLLBACK_PATH = path.join(ROOT, 'supabase_migration_civitatis_write_v15_ROLLBACK_to_v12.sql');

const v12 = fs.readFileSync(V12_PATH, 'utf8');
const v15 = fs.readFileSync(V15_PATH, 'utf8');
const v15Rollback = fs.existsSync(V15_ROLLBACK_PATH) ? fs.readFileSync(V15_ROLLBACK_PATH, 'utf8') : null;

// ── A. File exists, is a forward-only migration, never edits V12 ───────

test('V15 migration file exists and V12 file is untouched (byte-identical to what V12 already was)', () => {
  assert.ok(fs.existsSync(V15_PATH), 'supabase_migration_civitatis_write_v15_zero_passenger_names.sql must exist');
  assert.match(v12, /IF v_usable_passenger_count <> v_expected_passenger_count THEN/,
    'V12 must still contain its own original (exact-match-only) guard verbatim — V15 is a NEW forward migration, not an edit of V12');
  assert.doesNotMatch(v12, /civitatis_missing_passenger_names/,
    'V12 must never have been edited to add the V15 warning activity_logs insert');
});

test('V15 is wrapped in an explicit transaction and introduces no schema-mutating statement', () => {
  assert.match(v15, /^BEGIN;/m);
  assert.match(v15, /^COMMIT;/m);
  assert.doesNotMatch(v15, /^\s*DROP FUNCTION\b/mi);
  assert.doesNotMatch(v15, /^\s*ALTER TABLE\b/mi);
  assert.doesNotMatch(v15, /^\s*CREATE TABLE\b/mi);
  assert.doesNotMatch(v15, /^\s*DROP TABLE\b/mi);
  assert.doesNotMatch(v15, /^\s*TRUNCATE\b/mi);
  // Same single pre-existing DELETE as every prior version (reservation_guests
  // replacement on the UPDATE path) — untouched, not a new one introduced.
  assert.equal((v15.match(/\bDELETE\s+FROM\b/gi) || []).length, 1);
});

// ── B. The exact guard change is present, and only there ───────────────

test('the old exact-match-only guard (no zero-allowance) is not present as live SQL in V15', () => {
  const liveLines = v15.split('\n').filter(l => !l.trim().startsWith('--'));
  const liveText = liveLines.join('\n');
  assert.doesNotMatch(liveText, /IF v_usable_passenger_count <> v_expected_passenger_count THEN\n\s*UPDATE public\.email_ingestions/,
    'the exact-match-only guard (no OR v_usable_passenger_count = 0) must not remain as the live create-path condition in V15');
});

test('the new guard accepts exactly v_usable_passenger_count = 0 as an additional case, alongside the unchanged exact-match case', () => {
  assert.match(v15, /IF v_usable_passenger_count <> v_expected_passenger_count\s*\n\s*AND v_usable_passenger_count <> 0 THEN/,
    'the create-path guard must reject only when usable differs from expected AND usable is not zero');
});

test('the guard change is scoped to the CREATE branch only — the UPDATE/modification branch guard is untouched', () => {
  const updateGuardIdx = v15.indexOf("ELSIF v_reservation_id IS NOT NULL AND p_event_type = 'modified' AND NOT v_newer_exists THEN");
  assert.ok(updateGuardIdx > -1, 'expected to find the modification UPDATE branch');
  const updateBody = v15.slice(updateGuardIdx, v15.indexOf('ingestion_mark_processed', updateGuardIdx));
  assert.match(updateBody, /IF v_usable_passenger_count = v_expected_passenger_count AND v_expected_passenger_count > 0 THEN/,
    'the modification branch\'s passenger-replace guard must remain the exact-match-only condition, unchanged by V15');
  assert.doesNotMatch(updateBody, /v_usable_passenger_count <> 0/,
    'V15\'s zero-allowance change must never appear inside the modification/UPDATE branch');
});

// ── C. The passenger INSERT itself is untouched — zero names -> zero rows,
// never a fabricated placeholder, never the booking contact copied in ──

test('the CREATE-path passenger INSERT statement is byte-for-byte unchanged from V12 (zero p_passengers naturally yields zero rows, no special-casing added)', () => {
  const extractInsert = (src) => {
    const idx = src.indexOf("v_stage := 'passenger_insert';");
    return src.slice(idx, src.indexOf('v_passengers_replaced := TRUE;', idx) + 'v_passengers_replaced := TRUE;'.length);
  };
  assert.equal(extractInsert(v15), extractInsert(v12),
    'the passenger INSERT statement must be untouched — zero usable passengers already yields zero reservation_guests rows via the existing WHERE clause, with no new code path needed');
});

test('no fabricated placeholder guest name ("Guest 1"/"Unknown Guest"/etc.) is introduced as LIVE SQL in V15 (the migration\'s own prose legitimately names these as examples of what must never appear)', () => {
  const liveText = v15.split('\n').filter(l => !l.trim().startsWith('--')).join('\n');
  assert.doesNotMatch(liveText, /Guest 1|Guest 2|Unknown Guest|Misafir 1|Misafir 2/i);
});

test('the booking contact is never inserted into reservation_guests — p_customer_full_name/p_customer_email/p_customer_phone never appear inside the reservation_guests INSERT statement', () => {
  const idx = v15.indexOf('INSERT INTO public.reservation_guests');
  const stmt = v15.slice(idx, v15.indexOf(';', idx) + 1);
  assert.doesNotMatch(stmt, /p_customer_full_name|p_customer_email|p_customer_phone/,
    'reservation_guests must only ever be populated from p_passengers, never from the booking contact fields');
});

// ── D. The new warning activity_logs insert: shape, scoping, no schema change ──

test('the new missing-passenger-names activity_logs insert exists, is guarded to usable=0/expected>0, and sits in the CREATE branch only', () => {
  const funcStart = v15.indexOf('CREATE OR REPLACE FUNCTION public.ingest_civitatis_booking(');
  const guardIdx = v15.indexOf('IF v_usable_passenger_count = 0 AND v_expected_passenger_count > 0 THEN', funcStart);
  assert.ok(guardIdx > -1, 'expected the new guard condition to exist inside the live function body');
  const block = v15.slice(guardIdx, v15.indexOf('END IF;', guardIdx) + 'END IF;'.length);
  assert.match(block, /INSERT INTO public\.activity_logs \(entity_type, entity_id, action, description, metadata, performed_by\)/);
  assert.match(block, /'reservation', v_reservation_id, 'note_added'/);
  assert.match(block, /'Civitatis yolcu isimleri eksik'/);
  assert.match(block, /'alert_type', 'civitatis_missing_passenger_names'/);
  assert.match(block, /'auto_ingested', true/);
  assert.match(block, /'source', 'civitatis'/);
  assert.match(block, /'external_booking_id', p_external_booking_id/);
  assert.match(block, /'reservation_number', v_reservation_number/);

  // Scoped inside the CREATE branch (new_booking, no existing reservation):
  // must appear strictly after the CREATE branch's own reservation INSERT
  // and strictly before the MODIFICATION branch begins.
  const createReservationInsertIdx = v15.indexOf('INSERT INTO public.reservations (');
  const modificationBranchIdx = v15.indexOf("ELSIF v_reservation_id IS NOT NULL AND p_event_type = 'modified' AND v_newer_exists THEN");
  assert.ok(createReservationInsertIdx > -1 && modificationBranchIdx > -1);
  assert.ok(guardIdx > createReservationInsertIdx, 'the warning insert must happen AFTER the reservation is actually created');
  assert.ok(guardIdx < modificationBranchIdx, 'the warning insert must be scoped to the CREATE branch, never the modification branch');
});

test('the warning insert carries no customer PII (no name/email/phone field anywhere in its metadata)', () => {
  const guardIdx = v15.indexOf('IF v_usable_passenger_count = 0 AND v_expected_passenger_count > 0 THEN');
  const block = v15.slice(guardIdx, v15.indexOf('END IF;', guardIdx) + 'END IF;'.length);
  assert.doesNotMatch(block, /p_customer_full_name|p_customer_email|p_customer_phone|customer_name|customer_email|customer_phone/,
    'the missing-passenger-names warning must never carry customer name/email/phone');
});

test('the warning insert reuses already-allowed CHECK values — no live ALTER TABLE/CHECK widening anywhere in V15 (the header prose legitimately names the constraints it is NOT touching)', () => {
  const liveText = v15.split('\n').filter(l => !l.trim().startsWith('--')).join('\n');
  assert.doesNotMatch(liveText, /ALTER TABLE public\.activity_logs|activity_logs_action_check|activity_logs_entity_type_check/,
    'entity_type=\'reservation\' and action=\'note_added\' must already be permitted — this migration must not touch either CHECK constraint');
});

test('the warning insert is a SEPARATE statement from the existing "Yeni Rezervasyon Geldi" activity_logs insert — the original insert\'s own metadata is untouched', () => {
  const originalIdx = v15.indexOf("'reservation', v_reservation_id, 'created',");
  const originalBlock = v15.slice(originalIdx, v15.indexOf(');', originalIdx) + 2);
  assert.match(originalBlock, /'Yeni Rezervasyon Geldi: ' \|\| v_reservation_number/);
  assert.doesNotMatch(originalBlock, /alert_type|civitatis_missing_passenger_names/,
    'the new warning marker must never be merged into the existing "created" activity_logs row\'s metadata');
  // Exactly two activity_logs INSERTs appear between the reservation
  // INSERT and the MODIFICATION branch: the original "created" row and
  // the new conditional warning row — never a third.
  const createReservationInsertIdx = v15.indexOf('INSERT INTO public.reservations (');
  const modificationBranchIdx = v15.indexOf("ELSIF v_reservation_id IS NOT NULL AND p_event_type = 'modified' AND v_newer_exists THEN");
  const createBranchText = v15.slice(createReservationInsertIdx, modificationBranchIdx);
  const activityInsertCount = (createBranchText.match(/INSERT INTO public\.activity_logs/g) || []).length;
  assert.equal(activityInsertCount, 2, 'expected exactly 2 activity_logs INSERTs in the CREATE branch: the original "created" row and the new conditional warning row');
});

// ── E. Tour auto-provisioning (Step 6a) is completely untouched ────────

test('Step 6a (tour auto-provisioning) and its V12 MIN(uuid) fix are byte-for-byte unchanged from V12', () => {
  const extractStep6a = (src) => {
    const start = src.indexOf('-- ── Step 6a (V10, CORRECTED PLACEMENT)');
    const end = src.indexOf('-- ── Step 6b (V10, CORRECTED PLACEMENT)');
    return src.slice(start, end);
  };
  assert.equal(extractStep6a(v15), extractStep6a(v12),
    'Step 6a must be completely untouched by V15 — the passenger guard that stopped A42463096 runs well before Step 6a is ever reached');
});

test('V12\'s MIN(tour_id::text)::uuid fix is still present and live in V15 (this migration carries it forward, never re-derives or removes it)', () => {
  assert.match(v15, /SELECT COUNT\(\*\), MIN\(tour_id::text\)::uuid INTO v_provision_match_count, v_provisioned_tour_id/);
  assert.doesNotMatch(v15, /^\s*SELECT COUNT\(\*\), MIN\(tour_id\) INTO/m,
    'the pre-V12 broken statement must not have been reintroduced');
});

test('V15 does not create or apply a second V12-shaped migration — no new "uuid recheck fix" framing appears in V15\'s own header', () => {
  assert.doesNotMatch(v15, /fix a live production SQL defect in Step 6a/,
    'V15 must not reintroduce V12\'s own problem statement as if it were new work');
});

// ── F. Everything else in the function body is untouched ───────────────

test('the ONLY functional changes in the function body are the Step 2 guard condition and the one new activity_logs INSERT (plus adjacent explanatory comments)', () => {
  const extractBody = (src) => {
    const start = src.indexOf('-- FUNCTION: ingest_civitatis_booking');
    const end = src.indexOf('COMMENT ON FUNCTION public.ingest_civitatis_booking IS');
    return src.slice(start, end);
  };
  let v15Body = extractBody(v15);
  const v12Body = extractBody(v12);

  // Known addition #1: the V15 explanatory comment block on the guard.
  const guardCommentBlock = v15Body.slice(
    v15Body.indexOf('      -- V7: passenger-completeness guard. V15:'),
    v15Body.indexOf("      v_stage := 'passenger_completeness_check';")
  );
  assert.ok(guardCommentBlock.includes('V15: Civitatis does not always'), 'sanity: located the V15 guard comment block');
  v15Body = v15Body.replace(guardCommentBlock, '      -- V7: passenger-completeness guard.\n');

  // Known change #2: the guard condition itself, reverted to V12's text.
  v15Body = v15Body.replace(
    'IF v_usable_passenger_count <> v_expected_passenger_count\n         AND v_usable_passenger_count <> 0 THEN',
    'IF v_usable_passenger_count <> v_expected_passenger_count THEN'
  );

  // Known addition #3: the entire new warning-insert block (comment + IF),
  // including the blank line separating it from the preceding statement
  // — that blank line is part of what V15 inserted, not pre-existing.
  const warningBlockStart = v15Body.indexOf('\n\n      -- V15: a SEPARATE, additional operational signal');
  const warningBlockEnd = v15Body.indexOf('      END IF;\n\n    ELSIF v_reservation_id IS NOT NULL AND p_event_type = \'modified\' AND v_newer_exists THEN');
  assert.ok(warningBlockStart > -1 && warningBlockEnd > -1, 'sanity: located the V15 warning-insert block');
  const warningBlock = v15Body.slice(warningBlockStart, warningBlockEnd + '      END IF;'.length);
  v15Body = v15Body.replace(warningBlock, '');

  assert.equal(v15Body, v12Body, 'after reverting the three known, deliberate V15 changes, the function body must be byte-for-byte identical to V12 — proving nothing else was touched');
});

// ── G. Function signature and permissions are byte-identical to V12 ────

test('V15 function signature is exactly the same 26 parameters, same names/types/order/defaults, as V12 (no DROP FUNCTION needed)', () => {
  const extractSignature = (src) => {
    const start = src.indexOf('CREATE OR REPLACE FUNCTION public.ingest_civitatis_booking(');
    const end = src.indexOf('RETURNS JSONB', start);
    return src.slice(start, end);
  };
  assert.equal(extractSignature(v15), extractSignature(v12), 'the CREATE OR REPLACE FUNCTION parameter list must be byte-for-byte identical between V12 and V15');
});

test('V15 REVOKE/GRANT tail matches the exact 26-parameter signature, service_role only', () => {
  assert.match(v15, /GRANT EXECUTE ON FUNCTION public\.ingest_civitatis_booking\(/);
  assert.match(v15, /\) TO service_role;/);
  assert.doesNotMatch(v15, /GRANT EXECUTE[\s\S]{0,400}TO (PUBLIC|anon|authenticated);/);
});

test('V15 preflight structurally confirms the expected 26-parameter signature before touching the function, same discipline as V12/V13', () => {
  const createIdx = v15.indexOf('CREATE OR REPLACE FUNCTION public.ingest_civitatis_booking(');
  const preflightIdx = v15.indexOf('V15 PREFLIGHT PASSED');
  assert.ok(preflightIdx > -1 && preflightIdx < createIdx, 'preflight must run and pass BEFORE CREATE OR REPLACE FUNCTION');
  assert.match(v15, /AND p\.proargtypes = array_to_string\(/);
  assert.match(v15, /\)::oidvector/);
});

test('V15 has a postflight that re-confirms the signature, the new guard, the new activity_logs insert, and that V12\'s fix is still intact — AFTER CREATE OR REPLACE and BEFORE COMMIT', () => {
  const createIdx = v15.indexOf('CREATE OR REPLACE FUNCTION public.ingest_civitatis_booking(');
  const postflightIdx = v15.indexOf('V15 POSTFLIGHT PASSED');
  const commitIdx = v15.lastIndexOf('COMMIT;');
  assert.ok(postflightIdx > createIdx, 'postflight must run AFTER CREATE OR REPLACE FUNCTION');
  assert.ok(postflightIdx < commitIdx, 'postflight must run BEFORE COMMIT');
  assert.match(v15, /V15 POSTFLIGHT FAILED: the zero-passenger-names create-path guard was not found/);
  assert.match(v15, /V15 POSTFLIGHT FAILED: the missing-passenger-names activity_logs INSERT was not found/);
  assert.match(v15, /V15 POSTFLIGHT FAILED: V12''s MIN\(tour_id::text\)::uuid tour-provisioning fix is no longer present/);
});

test('V15 does not alter parser behavior, cancellation, auth, scheduler, or frontend files', () => {
  // The header prose legitimately references V13's cancellation
  // migration by name (to explain why it never touched this function) —
  // scoped here to the LIVE function body only, where it actually
  // matters that no cancellation-related object is created/altered.
  const funcStart = v15.indexOf('CREATE OR REPLACE FUNCTION public.ingest_civitatis_booking(');
  const liveBody = v15.slice(funcStart);
  assert.doesNotMatch(liveBody, /cancel/i);
  assert.doesNotMatch(v15, /CREATE POLICY|GRANT[\s\S]{0,120}staff_users|auth\.users/i);
  assert.doesNotMatch(v15, /CIVITATIS_SCHEDULER_SECRET|CIVITATIS_MANUAL_WRITE_SECRET/);
});

// ── H. V15 -> V12 rollback restores V12 EXACTLY ─────────────────────────

test('V15 rollback file exists and declares itself a V15 -> V12 rollback', () => {
  assert.ok(v15Rollback, 'supabase_migration_civitatis_write_v15_ROLLBACK_to_v12.sql must exist');
  assert.match(v15Rollback, /ROLLBACK: V15 \(zero-passenger-names allowed on create\) -> V12/);
  assert.match(v15Rollback, /^BEGIN;/m);
  assert.match(v15Rollback, /^COMMIT;/m);
});

test('the rollback restores the exact V12 function body byte-for-byte', () => {
  const v12FuncStart = v12.indexOf('-- FUNCTION: ingest_civitatis_booking');
  const v12BlockStart = v12.lastIndexOf('-- ─────', v12FuncStart);
  const v12FuncBody = v12.slice(v12BlockStart);

  const rollbackFuncStart = v15Rollback.indexOf('-- FUNCTION: ingest_civitatis_booking');
  const rollbackBlockStart = v15Rollback.lastIndexOf('-- ─────', rollbackFuncStart);
  const rollbackFuncBody = v15Rollback.slice(rollbackBlockStart);

  assert.equal(rollbackFuncBody, v12FuncBody,
    'the rollback file must contain the V12 function definition (CREATE FUNCTION body, COMMENT ON FUNCTION, REVOKE/GRANT, COMMIT) verbatim, byte-for-byte');
});

test('the rollback reintroduces the exact pre-V15 exact-match-only guard in its LIVE (restored) SQL (restoring V12 means restoring its stricter guard too, by design)', () => {
  const funcStart = v15Rollback.indexOf('CREATE OR REPLACE FUNCTION public.ingest_civitatis_booking(');
  const funcBody = v15Rollback.slice(funcStart);
  assert.match(funcBody, /IF v_usable_passenger_count <> v_expected_passenger_count THEN/);
  assert.doesNotMatch(funcBody, /AND v_usable_passenger_count <> 0 THEN/,
    'the restored function body must NOT carry V15\'s zero-allowance forward');
  assert.doesNotMatch(funcBody, /civitatis_missing_passenger_names/,
    'the restored function body must NOT carry V15\'s warning insert forward');
  // The rollback's own HEADER (prose, never executed) legitimately
  // mentions V15's change for documentation purposes — already covered
  // by the header-text test above; this assertion is scoped to the
  // restored FUNCTION BODY only.
});

test('the rollback restores V12\'s own MIN(tour_id::text)::uuid fix unchanged — rolling back V15 must never reintroduce the V12 min(uuid) defect', () => {
  const funcStart = v15Rollback.indexOf('CREATE OR REPLACE FUNCTION public.ingest_civitatis_booking(');
  const funcBody = v15Rollback.slice(funcStart);
  assert.match(funcBody, /SELECT COUNT\(\*\), MIN\(tour_id::text\)::uuid INTO v_provision_match_count, v_provisioned_tour_id/);
});

test('the rollback is a function-definition-only change: no DELETE/TRUNCATE/ALTER TABLE/DROP TABLE beyond what V12 itself already contains', () => {
  assert.equal((v15Rollback.match(/\bDELETE\s+FROM\b/gi) || []).length, 1,
    'same single pre-existing DELETE as V12 (reservation_guests replacement on the UPDATE path) — no new one introduced');
  assert.doesNotMatch(v15Rollback, /^\s*TRUNCATE\b|^\s*ALTER TABLE\b|^\s*DROP TABLE\b/mi);
  assert.doesNotMatch(v15Rollback, /^\s*DROP FUNCTION\b/mi);
});

test('the rollback keeps the exact same 26-parameter signature and REVOKE/GRANT tail as V12', () => {
  const extractSignature = (src) => {
    const start = src.indexOf('CREATE OR REPLACE FUNCTION public.ingest_civitatis_booking(');
    const end = src.indexOf('RETURNS JSONB', start);
    return src.slice(start, end);
  };
  assert.equal(extractSignature(v15Rollback), extractSignature(v12));

  const extractTail = (src) => src.slice(src.indexOf('-- SECURITY: restrict EXECUTE to service_role only.'));
  assert.equal(extractTail(v15Rollback), extractTail(v12), 'REVOKE/GRANT/COMMENT ON FUNCTION/COMMIT tail must be byte-for-byte identical to V12');
});

test('the rollback explicitly documents that it reintroduces the stricter passenger guard, so a future operator cannot apply it unknowingly', () => {
  const collapsed = v15Rollback.split('\n').map(l => l.replace(/^\s*--\s?/, '')).join(' ').replace(/\s+/g, ' ');
  assert.match(collapsed, /REINTRODUCES the behavior V15 exists to fix/);
});

// ── I. The ingestion-pipeline JS layer is untouched by this change ─────
// The passenger guard lives entirely in SQL — writeAdapter.js only builds
// the RPC payload and trusts the RPC to validate, so no JS change is
// needed or expected for this fix.

test('api/_civitatis/writeAdapter.js is not modified by this change (no passenger-completeness logic exists there to touch)', () => {
  const src = fs.readFileSync(path.join(ROOT, 'api', '_civitatis', 'writeAdapter.js'), 'utf8');
  assert.doesNotMatch(src, /usable_passenger_count|expected_passenger_count|passenger.{0,20}completeness/i,
    'the passenger-completeness guard has always lived entirely in SQL (public.ingest_civitatis_booking) — the JS planning layer must never duplicate or shadow it');
});

test('api/_civitatis/parser.js is not modified by this change (p_passengers/pax extraction is already correct for a zero-passenger-name email)', () => {
  const src = fs.readFileSync(path.join(ROOT, 'api', '_civitatis', 'parser.js'), 'utf8');
  assert.doesNotMatch(src, /civitatis_missing_passenger_names/,
    'the missing-passenger-names signal is an RPC-side, post-creation activity_logs row — the parser itself has nothing to change, it already extracts pax/passengers correctly');
});
