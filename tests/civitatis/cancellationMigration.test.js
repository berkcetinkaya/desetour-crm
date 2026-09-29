'use strict';
/**
 * tests/civitatis/cancellationMigration.test.js
 * ─────────────────────────────────────────────────────────────────────────
 * Regression coverage for supabase_migration_civitatis_write_v13_
 * cancellation.sql and its rollback. NOT YET APPLIED to any database —
 * explicitly withheld pending manual approval. Every test here is a pure,
 * static, never-executed text assertion against the prepared .sql files,
 * exactly like every prior V10/V11/V12 migration's own test file. Nothing
 * in this file connects to a database or runs any SQL.
 * ─────────────────────────────────────────────────────────────────────────
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const V12_PATH = path.join(ROOT, 'supabase_migration_civitatis_write_v12_uuid_recheck_fix.sql');
const V13_PATH = path.join(ROOT, 'supabase_migration_civitatis_write_v13_cancellation.sql');
const V13_ROLLBACK_PATH = path.join(ROOT, 'supabase_migration_civitatis_write_v13_ROLLBACK_to_v12.sql');

const v12 = fs.readFileSync(V12_PATH, 'utf8');
const v13 = fs.readFileSync(V13_PATH, 'utf8');
const v13Rollback = fs.readFileSync(V13_ROLLBACK_PATH, 'utf8');

// ── A. File exists, transactional, never touches V12/ingest_civitatis_booking

test('V13 migration file exists, is wrapped in BEGIN/COMMIT, and never modifies ingest_civitatis_booking', () => {
  assert.ok(fs.existsSync(V13_PATH));
  assert.match(v13, /^BEGIN;/m);
  assert.match(v13, /^COMMIT;/m);
  // The only CREATE OR REPLACE FUNCTION in this file must be the NEW
  // cancellation function — never a second definition of
  // ingest_civitatis_booking.
  const createFunctionMatches = v13.match(/^CREATE OR REPLACE FUNCTION public\.(\w+)/gm) || [];
  assert.deepEqual(createFunctionMatches, ['CREATE OR REPLACE FUNCTION public.cancel_civitatis_booking']);
});

test('V12 (ingest_civitatis_booking) file itself is untouched — V13 is a NEW, separate migration, never an edit of V12', () => {
  assert.match(v12, /MIN\(tour_id::text\)::uuid/, 'V12 must still contain its own approved fix, unedited by V13 work');
  assert.doesNotMatch(v13, /CREATE OR REPLACE FUNCTION public\.ingest_civitatis_booking/);
});

test('the V13 preflight confirms V12 (ingest_civitatis_booking) is live before creating anything', () => {
  const preflightIdx = v13.indexOf('DO $$');
  const createIdx = v13.indexOf('CREATE OR REPLACE FUNCTION public.cancel_civitatis_booking');
  assert.ok(preflightIdx > -1 && preflightIdx < createIdx);
  assert.match(v13, /p\.proname = 'ingest_civitatis_booking'/);
  assert.match(v13, /p\.proargtypes = array_to_string\(/, 'must reuse the V12-corrected oidvector comparison, never the earlier fragile forms');
  assert.doesNotMatch(v13, /pg_get_function_identity_arguments/, 'must not reintroduce the proven-fragile formatted-string preflight comparison');
});

// ── B. email_ingestions.event_type widened correctly, purely additively

test('email_ingestions.event_type CHECK is widened to include "cancelled", purely additively (all prior values retained)', () => {
  assert.match(v13, /ALTER TABLE public\.email_ingestions DROP CONSTRAINT IF EXISTS email_ingestions_event_type_check;/);
  assert.match(v13, /ALTER TABLE public\.email_ingestions ADD CONSTRAINT email_ingestions_event_type_check\s*\n\s*CHECK \(event_type IN \('new_booking','modified','unknown','cancelled'\)\);/);
});

// ── C. No unsupported UUID aggregate, no MIN(uuid)-style defect ────────

test('no MIN(uuid)/MAX(uuid)-style aggregate defect anywhere in V13 — the exact reservation match uses two plain queries, never a combined COUNT+aggregate', () => {
  const lines = v13.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('--')) continue;
    const matches = trimmed.match(/\b(MIN|MAX)\(([a-zA-Z_][a-zA-Z0-9_]*)\)/g) || [];
    for (const m of matches) {
      const col = m.slice(4, -1);
      assert.ok(!/_id$|_uuid$/i.test(col), `unexpected uuid-typed aggregate "${m}" found: ${line}`);
    }
  }
  assert.match(v13, /SELECT COUNT\(\*\) INTO v_match_count/);
  assert.doesNotMatch(v13, /SELECT COUNT\(\*\),\s*(MIN|MAX)\(/, 'must never combine COUNT(*) with MIN/MAX(id) in one statement — the exact V12 defect pattern');
});

// ── D. Exact reservation matching: 0 / 1 / >1 ────────────────────────────

test('0 matches: manual_review_required, retryable (needs_review), never creates a reservation/customer/tour', () => {
  const idx = v13.indexOf('IF v_match_count = 0 THEN');
  const body = v13.slice(idx, v13.indexOf('ELSIF v_match_count > 1 THEN', idx));
  assert.match(body, /processing_status = 'needs_review'/);
  assert.match(body, /'result', 'manual_review_required'/);
  assert.doesNotMatch(body, /INSERT INTO/);
});

test('the 0-match / needs_review outcome is retryable via the SAME failed/needs_review reclaim as ingest_civitatis_booking (never permanently terminal)', () => {
  assert.match(v13, /ON CONFLICT \(gmail_message_id\) DO UPDATE\s*\n\s*SET processing_status = 'received',\s*\n\s*error_reason\s*=\s*NULL,\s*\n\s*processed_at\s*=\s*NULL\s*\n\s*WHERE public\.email_ingestions\.processing_status IN \('failed', 'needs_review'\)/);
});

test('more than 1 match: manual_review_required, fail-closed, never arbitrarily chooses one', () => {
  const idx = v13.indexOf('ELSIF v_match_count > 1 THEN');
  const body = v13.slice(idx, v13.indexOf("v_stage := 'reservation_lookup';", idx));
  assert.match(body, /processing_status = 'needs_review'/);
  assert.match(body, /'result', 'manual_review_required'/);
  assert.match(body, /ambiguous/i);
  assert.doesNotMatch(body, /INSERT INTO/);
});

test('exactly 1 match: the reservation is looked up and locked (FOR UPDATE) before any branch on its status', () => {
  assert.match(v13, /SELECT id, status, reservation_number, customer_id, tour_id, check_in\s*\n\s*INTO v_reservation_id, v_current_status, v_reservation_number, v_customer_id, v_tour_id, v_check_in\s*\n\s*FROM public\.reservations\s*\n\s*WHERE source_id = p_source_id AND external_booking_id = p_external_booking_id\s*\n\s*FOR UPDATE;/);
});

// ── E. Never deletes, never creates a reservation/customer/tour, never
// auto-provisions ────────────────────────────────────────────────────────

test('V13 contains no DELETE statement anywhere', () => {
  assert.doesNotMatch(v13, /\bDELETE\s+FROM\b/i);
});

test('V13 never inserts into reservations, customers, tours, tour_languages, or tour_channels — no creation of any kind, no auto-provisioning', () => {
  assert.doesNotMatch(v13, /INSERT INTO public\.reservations\b/);
  assert.doesNotMatch(v13, /INSERT INTO public\.customers\b/);
  assert.doesNotMatch(v13, /INSERT INTO public\.tours\b/);
  assert.doesNotMatch(v13, /INSERT INTO public\.tour_languages\b/);
  assert.doesNotMatch(v13, /INSERT INTO public\.tour_channels\b/);
  assert.doesNotMatch(v13, /INSERT INTO public\.reservation_guests\b/);
  assert.doesNotMatch(v13, /auto_provision/i);
});

test('V13 never writes to payments, guide_payments, or reservation_guests — financial/passenger/guide-history data is completely untouched', () => {
  assert.doesNotMatch(v13, /\bpublic\.payments\b/);
  assert.doesNotMatch(v13, /\bpublic\.guide_payments\b/);
  assert.doesNotMatch(v13, /\bpublic\.reservation_guests\b/);
});

test('the ONLY write to reservations is the Step-5 UPDATE, touching exactly status/cancelled_at/cancel_reason — no other column, guide_name included, is ever assigned', () => {
  const idx = v13.indexOf('UPDATE public.reservations');
  assert.ok(idx > -1);
  const stmt = v13.slice(idx, v13.indexOf(';', idx) + 1);
  assert.match(stmt, /SET status = 'cancelled',/);
  assert.match(stmt, /cancelled_at = NOW\(\),/);
  assert.match(stmt, /cancel_reason = /);
  assert.doesNotMatch(stmt, /guide_name\s*=/);
  assert.doesNotMatch(stmt, /customer_id\s*=/);
  assert.doesNotMatch(stmt, /tour_id\s*=/);
  assert.doesNotMatch(stmt, /total_amount\s*=/);
  assert.doesNotMatch(stmt, /deposit_amount\s*=/);
  // Exactly one UPDATE targeting reservations in the whole file.
  const allReservationUpdates = (v13.match(/UPDATE public\.reservations\b/g) || []).length;
  assert.equal(allReservationUpdates, 1);
});

test('cancel_reason is always the SAME fixed string — never derived from parsing the cancellation email body (p_raw_body_snapshot is stored for audit, never inspected for content)', () => {
  assert.match(v13, /cancel_reason = 'Civitatis cancellation email received \(external booking id ' \|\| p_external_booking_id \|\| '\)'/);
  // p_raw_body_snapshot is only ever used as a stored value, never
  // scanned/parsed (no regex/string function applied to it anywhere).
  assert.doesNotMatch(v13, /p_raw_body_snapshot\)[^,;]*(~|LIKE|position|substring)/i);
});

test('exactly 1 match, NOT already cancelled: the success path updates the reservation, inserts the notification, marks the ingestion processed, and returns result:cancelled with reservation_id/customer_id/tour_id', () => {
  const alreadyIdx = v13.indexOf("IF v_current_status = 'cancelled' THEN");
  const endAlreadyIdx = v13.indexOf('END IF;', alreadyIdx);
  const successBody = v13.slice(endAlreadyIdx, v13.indexOf('EXCEPTION WHEN OTHERS'));

  assert.match(successBody, /UPDATE public\.reservations\s*\n\s*SET status = 'cancelled',/);
  assert.match(successBody, /INSERT INTO public\.activity_logs/);
  assert.match(successBody, /processing_status = 'processed', reservation_id = v_reservation_id, processed_at = NOW\(\)/);
  assert.match(successBody, /'result', 'cancelled',/);
  assert.match(successBody, /'reservation_id', v_reservation_id,/);
  assert.match(successBody, /'customer_id', v_customer_id,/);
  assert.match(successBody, /'tour_id', v_tour_id/);

  // Ordering: the UPDATE must happen BEFORE the notification is inserted
  // (never notify about a cancellation that didn't actually commit).
  const updateIdx = successBody.indexOf('UPDATE public.reservations');
  const insertIdx = successBody.indexOf('INSERT INTO public.activity_logs');
  assert.ok(updateIdx > -1 && insertIdx > -1 && updateIdx < insertIdx);
});

// ── F. Guide assignment / historical context preserved ─────────────────

test('guide_name (or any guide-assignment column) is never referenced in any UPDATE statement in V13 — the assignment is preserved by simply never being touched', () => {
  const updates = v13.match(/UPDATE public\.\w+[\s\S]*?;/g) || [];
  for (const stmt of updates) {
    if (!/^UPDATE public\.reservations\b/.test(stmt)) continue;
    assert.doesNotMatch(stmt, /guide_name/);
  }
});

// ── G. Idempotency: already-cancelled short-circuits, no duplicate write

test('an already-cancelled reservation short-circuits to already_cancelled BEFORE the Step-5 UPDATE or the activity_logs INSERT — zero additional writes, zero duplicate notification', () => {
  const alreadyIdx = v13.indexOf("IF v_current_status = 'cancelled' THEN");
  const updateIdx = v13.indexOf('UPDATE public.reservations');
  assert.ok(alreadyIdx > -1 && alreadyIdx < updateIdx, 'the already-cancelled check must run BEFORE the reservation UPDATE');
  const body = v13.slice(alreadyIdx, updateIdx);
  assert.match(body, /'result', 'already_cancelled'/);
  assert.doesNotMatch(body, /INSERT INTO public\.activity_logs/);
});

test('a duplicate email_ingestions row (same gmail_message_id, already processed) short-circuits to already_processed before Step 2 even runs', () => {
  const idx = v13.indexOf('IF v_ingestion_id IS NULL THEN');
  const body = v13.slice(idx, v13.indexOf('END IF;', idx));
  assert.match(body, /'result', 'already_processed'/);
});

// ── H. Notification: activity_logs shape matches the existing "Yeni
// Rezervasyon Geldi" convention exactly (auto_ingested, performed_by NULL)

test('the cancellation notification uses entity_type=reservation, action=cancelled, metadata.auto_ingested=true, performed_by=NULL — the EXACT existing notification shape', () => {
  const idx = v13.indexOf('INSERT INTO public.activity_logs');
  const stmt = v13.slice(idx, v13.indexOf(');', idx) + 2);
  assert.match(stmt, /'reservation', v_reservation_id, 'cancelled',/);
  assert.match(stmt, /'Civitatis Rezervasyonu İptal Edildi: ' \|\| v_reservation_number/);
  assert.match(stmt, /'auto_ingested', true/);
  assert.match(stmt, /'source', 'civitatis'/);
  assert.match(stmt, /'external_booking_id', p_external_booking_id/);
  assert.match(stmt, /'reservation_number', v_reservation_number/);
  assert.match(stmt, /'customer_name', v_customer_name/);
  assert.match(stmt, /'tour_name', v_tour_name/);
  assert.match(stmt, /'tour_date', v_check_in/);
  assert.match(stmt, /\n\s*NULL\n/, 'performed_by must be NULL, same as the existing auto-ingested notification');
});

test('exactly one activity_logs INSERT exists in V13 (no duplicate/second notification path)', () => {
  const count = (v13.match(/INSERT INTO public\.activity_logs/g) || []).length;
  assert.equal(count, 1);
});

// ── I. Ordering/retry: booking-level lock reuses the SAME namespace as
// ingest_civitatis_booking's own Step 3 ─────────────────────────────────

test('the booking-level advisory lock uses the EXACT SAME key/seed as ingest_civitatis_booking\'s own Step 3 — guaranteeing mutual exclusion between a cancellation and a concurrent new_booking/modified write for the same booking', () => {
  const v13LockMatch = v13.match(/PERFORM pg_advisory_xact_lock\(\s*\n\s*hashtextextended\(p_source_id::text \|\| ':' \|\| p_external_booking_id, 0\)\s*\n\s*\);/);
  const v12LockMatch = v12.match(/PERFORM pg_advisory_xact_lock\(\s*\n\s*hashtextextended\(p_source_id::text \|\| ':' \|\| p_external_booking_id, 0\)\s*\n\s*\);/);
  assert.ok(v13LockMatch, 'expected the booking-level lock statement in V13');
  assert.ok(v12LockMatch, 'expected the SAME lock statement to still exist in V12 (ingest_civitatis_booking Step 3)');
  assert.equal(v13LockMatch[0], v12LockMatch[0], 'the lock key construction must be byte-for-byte identical between the two functions');
});

// ── J. Signature / permissions ──────────────────────────────────────────

test('cancel_civitatis_booking has exactly 7 parameters, SECURITY DEFINER, EXECUTE restricted to service_role only', () => {
  const sigStart = v13.indexOf('CREATE OR REPLACE FUNCTION public.cancel_civitatis_booking(');
  const sigEnd = v13.indexOf('RETURNS JSONB', sigStart);
  const sig = v13.slice(sigStart, sigEnd);
  const paramCount = (sig.match(/^\s*p_\w+\s+\w+/gm) || []).length;
  assert.equal(paramCount, 7);
  assert.match(v13, /SECURITY DEFINER/);
  assert.match(v13, /GRANT EXECUTE ON FUNCTION public\.cancel_civitatis_booking\(/);
  assert.match(v13, /\) TO service_role;/);
  assert.doesNotMatch(v13, /GRANT EXECUTE ON FUNCTION public\.cancel_civitatis_booking[\s\S]{0,200}TO (PUBLIC|anon|authenticated);/);
});

// ── K. Rollback file ─────────────────────────────────────────────────────

test('the rollback drops ONLY cancel_civitatis_booking, wrapped in BEGIN/COMMIT, contains no live DML', () => {
  assert.match(v13Rollback, /^BEGIN;/m);
  assert.match(v13Rollback, /^COMMIT;/m);
  assert.match(v13Rollback, /DROP FUNCTION IF EXISTS public\.cancel_civitatis_booking\(/);
  const liveDml = v13Rollback.split('\n').filter(line => {
    const trimmed = line.trim();
    if (trimmed.startsWith('--') || trimmed === '') return false;
    return /\bDELETE\s+FROM\b|\bUPDATE\s+public\.|\bTRUNCATE\b|\bINSERT\s+INTO\b/i.test(trimmed);
  });
  assert.deepEqual(liveDml, [], `expected no live DML statements in the rollback, found: ${JSON.stringify(liveDml)}`);
  assert.doesNotMatch(v13Rollback, /DROP FUNCTION IF EXISTS public\.ingest_civitatis_booking/);
});

test('the rollback deliberately does NOT narrow email_ingestions.event_type back — and documents why', () => {
  assert.doesNotMatch(v13Rollback, /DROP CONSTRAINT.*email_ingestions_event_type_check/);
  assert.match(v13Rollback, /never narrowed|never rolled back|deliberately \*not\* rolled back/i);
});
