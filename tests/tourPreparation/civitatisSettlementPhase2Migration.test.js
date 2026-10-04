'use strict';
/**
 * tests/tourPreparation/civitatisSettlementPhase2Migration.test.js
 * ─────────────────────────────────────────────────────────────────────────
 * Regression coverage for supabase_migration_civitatis_settlement_phase2.sql
 * and its rollback (Civitatis Settlement Engine — Phase 2: requested/paid
 * period-level transitions). Every test here is a pure, static, never-
 * executed text assertion against the prepared .sql files — nothing in
 * this file connects to a database or runs any SQL. The forward
 * migration (columns, both transition functions, eligibility predicates,
 * authorization, idempotency, immutability, audit logging) was
 * separately validated live against a throwaway local PostgreSQL
 * instance (never production/Supabase) during implementation, including
 * a real unauthenticated-caller bypass this live testing caught and the
 * forward file was fixed for — this file is the committed regression
 * suite, not that live validation.
 * ─────────────────────────────────────────────────────────────────────────
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const FORWARD_PATH  = path.join(ROOT, 'supabase_migration_civitatis_settlement_phase2.sql');
const ROLLBACK_PATH = path.join(ROOT, 'supabase_migration_civitatis_settlement_phase2_ROLLBACK.sql');

const forward  = fs.readFileSync(FORWARD_PATH, 'utf8');
const rollback = fs.readFileSync(ROLLBACK_PATH, 'utf8');

function fnBody(source, name) {
  const start = source.indexOf(`CREATE OR REPLACE FUNCTION public.${name}`);
  assert.ok(start !== -1, `${name} not found`);
  const end = source.indexOf('\n$$;', start);
  return source.slice(start, end);
}

// ── A. Explicit transaction wrapping ─────────────────────────────────────

test('the entire migration is wrapped in exactly one explicit BEGIN;/COMMIT; transaction', () => {
  const beginMatches = forward.match(/^BEGIN;\s*$/gm) || [];
  const commitMatches = forward.match(/^COMMIT;\s*$/gm) || [];
  assert.equal(beginMatches.length, 1, 'expected exactly one transaction-level BEGIN;');
  assert.equal(commitMatches.length, 1, 'expected exactly one transaction-level COMMIT;');

  const beginIdx = forward.search(/^BEGIN;\s*$/m);
  const commitIdx = forward.search(/^COMMIT;\s*$/m);
  const alterIdx = forward.indexOf('ALTER TABLE public.civitatis_settlement_items');
  const verificationIdx = forward.indexOf('POST-MIGRATION READ-ONLY VERIFICATION');

  assert.ok(beginIdx > -1 && beginIdx < alterIdx, 'BEGIN; must precede the ALTER TABLE');
  assert.ok(commitIdx > alterIdx, 'COMMIT; must come after the schema/function changes');
  assert.ok(commitIdx < verificationIdx, 'COMMIT; must come before the read-only verification section');
});

test('the rollback is also wrapped in exactly one explicit BEGIN;/COMMIT; transaction', () => {
  const beginMatches = rollback.match(/^BEGIN;\s*$/gm) || [];
  const commitMatches = rollback.match(/^COMMIT;\s*$/gm) || [];
  assert.equal(beginMatches.length, 1);
  assert.equal(commitMatches.length, 1);
});

// ── B. Additive columns ──────────────────────────────────────────────────

test('adds requested_at and paid_at as nullable TIMESTAMPTZ columns, additively (IF NOT EXISTS)', () => {
  assert.match(forward, /ALTER TABLE public\.civitatis_settlement_items\s*\n\s*ADD COLUMN IF NOT EXISTS requested_at TIMESTAMPTZ,\s*\n\s*ADD COLUMN IF NOT EXISTS paid_at\s*TIMESTAMPTZ;/);
});

test('never widens or alters activity_logs.entity_type or .action — both values this migration uses were already valid', () => {
  assert.doesNotMatch(forward, /ALTER TABLE public\.activity_logs/);
  assert.doesNotMatch(forward, /activity_logs_entity_type_check/);
  assert.doesNotMatch(forward, /activity_logs_action_check/);
});

// ── C. fn_mark_civitatis_settlement_period_requested ─────────────────────

test('both functions are declared DROP FUNCTION IF EXISTS before CREATE OR REPLACE — required because RETURNS JSONB cannot be applied by CREATE OR REPLACE alone over an old INTEGER-returning definition', () => {
  const dropReqIdx = forward.indexOf('DROP FUNCTION IF EXISTS public.fn_mark_civitatis_settlement_period_requested(DATE);');
  const createReqIdx = forward.indexOf('CREATE OR REPLACE FUNCTION public.fn_mark_civitatis_settlement_period_requested');
  const dropPaidIdx = forward.indexOf('DROP FUNCTION IF EXISTS public.fn_mark_civitatis_settlement_period_paid(DATE);');
  const createPaidIdx = forward.indexOf('CREATE OR REPLACE FUNCTION public.fn_mark_civitatis_settlement_period_paid');
  assert.ok(dropReqIdx > -1 && dropReqIdx < createReqIdx);
  assert.ok(dropPaidIdx > -1 && dropPaidIdx < createPaidIdx);
});

test('both functions return JSONB, never a bare INTEGER', () => {
  for (const name of ['fn_mark_civitatis_settlement_period_requested', 'fn_mark_civitatis_settlement_period_paid']) {
    const idx = forward.indexOf(`CREATE OR REPLACE FUNCTION public.${name}`);
    const header = forward.slice(idx, idx + 200);
    assert.match(header, /RETURNS JSONB/);
    assert.doesNotMatch(header, /RETURNS INTEGER/);
  }
});

test('requested-transition locks and classifies the whole actionable set (status NOT IN cancelled/adjusted) with FOR UPDATE before deciding anything', () => {
  const body = fnBody(forward, 'fn_mark_civitatis_settlement_period_requested');
  assert.match(body, /WHERE settlement_period = p_settlement_period\s*\n\s*AND status NOT IN \('cancelled', 'adjusted'\)\s*\n\s*FOR UPDATE/);
  // Classification counts: total, claimable-now, future-accrued, requested, paid.
  assert.match(body, /COUNT\(\*\) FILTER \(WHERE status IN \('accrued', 'claimable'\) AND claimable_at <= CURRENT_DATE\)/);
  assert.match(body, /COUNT\(\*\) FILTER \(WHERE status = 'accrued' AND claimable_at > CURRENT_DATE\)/);
  assert.match(body, /COUNT\(\*\) FILTER \(WHERE status = 'requested'\)/);
  assert.match(body, /COUNT\(\*\) FILTER \(WHERE status = 'paid'\)/);
});

test('requested-transition returns every distinct result value the brief requires, each gated on the right condition', () => {
  const body = fnBody(forward, 'fn_mark_civitatis_settlement_period_requested');
  assert.match(body, /IF v_total = 0 THEN/);
  assert.match(body, /'result', 'no_actionable_items'/);
  assert.match(body, /'result', 'period_not_found'/);
  assert.match(body, /IF v_requested_cnt = v_total THEN[\s\S]{0,80}'result', 'already_requested'/);
  assert.match(body, /IF v_paid_cnt = v_total THEN[\s\S]{0,80}'result', 'already_paid'/);
  assert.match(body, /IF v_future_cnt = v_total THEN[\s\S]{0,80}'result', 'not_yet_claimable'/);
  assert.match(body, /IF v_claimable_cnt <> v_total THEN[\s\S]{0,80}'result', 'mixed_or_ineligible_period'/);
  assert.match(body, /'result', 'requested', 'affected_count', v_count/);
});

test('requested-transition rejects the WHOLE period (zero mutation) unless every actionable row is claimable right now — this is what stops a late-arriving row from being silently folded into an already-requested/paid period', () => {
  const body = fnBody(forward, 'fn_mark_civitatis_settlement_period_requested');
  const rejectIdx = body.indexOf("IF v_claimable_cnt <> v_total THEN");
  const updateIdx = body.indexOf('UPDATE public.civitatis_settlement_items');
  assert.ok(rejectIdx > -1 && rejectIdx < updateIdx, 'the uniformity check must come before the UPDATE');
  // The actual mutating UPDATE is reached only after every early-return
  // branch above it, and once reached it acts on the WHOLE actionable
  // set (no longer filtered by claimable_at) because uniformity was
  // already proven.
  const setClauseStart = body.indexOf('SET status', updateIdx);
  const whereIdx = body.indexOf('WHERE settlement_period', setClauseStart);
  assert.match(body.slice(whereIdx, whereIdx + 150), /AND status NOT IN \('cancelled', 'adjusted'\)/);
});

test('requested-transition sets exactly status/requested_at/updated_at — never original_amount/original_currency/settlement_period/reservation_id/claimable_at/exchange_rate_used/exchange_rate_date/try_amount', () => {
  const body = fnBody(forward, 'fn_mark_civitatis_settlement_period_requested');
  const setClauseStart = body.lastIndexOf('SET status');
  const setClauseEnd = body.indexOf('WHERE settlement_period', setClauseStart);
  const setClause = body.slice(setClauseStart, setClauseEnd);
  assert.match(setClause, /status\s*=\s*'requested'/);
  assert.match(setClause, /requested_at\s*=\s*NOW\(\)/);
  assert.match(setClause, /updated_at\s*=\s*NOW\(\)/);
  for (const forbidden of ['original_amount', 'original_currency', 'settlement_period =', 'reservation_id =', 'claimable_at =', 'exchange_rate_used', 'exchange_rate_date', 'try_amount']) {
    assert.doesNotMatch(setClause, new RegExp(forbidden.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
});

test('requested-transition role check uses IS NOT TRUE, never bare NOT(...) — the NULL-auth bypass this project caught live', () => {
  const body = fnBody(forward, 'fn_mark_civitatis_settlement_period_requested');
  assert.match(body, /IF \(public\.is_admin\(\) OR public\.is_operations\(\)\) IS NOT TRUE THEN/);
  assert.doesNotMatch(body, /IF NOT \(public\.is_admin\(\) OR public\.is_operations\(\)\) THEN/);
});

test('requested-transition raises on unauthorized role with ERRCODE 42501 (insufficient_privilege), before touching any row', () => {
  const body = fnBody(forward, 'fn_mark_civitatis_settlement_period_requested');
  const roleCheckIdx = body.indexOf('IS NOT TRUE THEN');
  const updateIdx = body.indexOf('UPDATE public.civitatis_settlement_items');
  assert.match(body, /USING ERRCODE = '42501'/);
  assert.ok(roleCheckIdx > -1 && roleCheckIdx < updateIdx, 'the role check must come before the UPDATE');
});

test('requested-transition writes one activity_logs row per affected item, with actor/period/transition/batch-count in metadata, only on the success path (the result object is already built for every rejection branch, which returns before ever reaching the UPDATE/INSERT)', () => {
  const body = fnBody(forward, 'fn_mark_civitatis_settlement_period_requested');
  assert.match(body, /INSERT INTO public\.activity_logs \(entity_type, entity_id, action, description, metadata, performed_by\)/);
  assert.match(body, /'civitatis_settlement', csi\.id, 'status_changed'/);
  assert.match(body, /'settlement_period', p_settlement_period/);
  assert.match(body, /'from_status', 'accrued'/);
  assert.match(body, /'to_status', 'requested'/);
  assert.match(body, /'batch_affected_count', v_count/);
  assert.match(body, /auth\.uid\(\)/);
  // The INSERT is unconditional at this point in the function body
  // (not behind its own extra `IF v_count > 0`) because every rejection
  // branch above it already RETURNed — by the time control reaches the
  // UPDATE/INSERT pair, v_count is provably > 0.
  const insertIdx = body.indexOf('INSERT INTO public.activity_logs');
  const returnRequestedIdx = body.indexOf("'result', 'requested'");
  assert.ok(insertIdx > -1 && insertIdx < returnRequestedIdx);
});

test('requested-transition returns the actual affected count via array_agg/array_length, never a hardcoded value', () => {
  const body = fnBody(forward, 'fn_mark_civitatis_settlement_period_requested');
  assert.match(body, /SELECT array_agg\(id\) INTO v_ids FROM u;/);
  assert.match(body, /v_count := COALESCE\(array_length\(v_ids, 1\), 0\);/);
  assert.match(body, /RETURN jsonb_build_object\('result', 'requested', 'affected_count', v_count, 'settlement_period', p_settlement_period\);/);
});

// ── D. fn_mark_civitatis_settlement_period_paid ──────────────────────────

test('paid-transition locks and classifies the whole actionable set with FOR UPDATE, counting only total/requested/paid (no claimable/future distinction needed here)', () => {
  const body = fnBody(forward, 'fn_mark_civitatis_settlement_period_paid');
  assert.match(body, /WHERE settlement_period = p_settlement_period\s*\n\s*AND status NOT IN \('cancelled', 'adjusted'\)\s*\n\s*FOR UPDATE/);
  assert.match(body, /COUNT\(\*\) FILTER \(WHERE status = 'requested'\)/);
  assert.match(body, /COUNT\(\*\) FILTER \(WHERE status = 'paid'\)/);
});

test('paid-transition eligibility is exactly: every actionable row already requested — accrued/claimable/adjusted/cancelled can never match', () => {
  const body = fnBody(forward, 'fn_mark_civitatis_settlement_period_paid');
  assert.match(body, /IF v_requested_cnt <> v_total THEN/);
  assert.match(body, /'result', 'mixed_or_ineligible_period'/);
  assert.doesNotMatch(body, /status IN \('accrued'/);
});

test('paid-transition rejects the whole period unless every actionable row is uniformly requested — closes the same late-arrival gap for paid as for requested', () => {
  const body = fnBody(forward, 'fn_mark_civitatis_settlement_period_paid');
  const rejectIdx = body.indexOf('IF v_requested_cnt <> v_total THEN');
  const updateIdx = body.indexOf('UPDATE public.civitatis_settlement_items');
  assert.ok(rejectIdx > -1 && rejectIdx < updateIdx);
});

test('paid-transition returns already_paid (idempotent) and period_not_found/no_actionable_items the same way as the requested transition', () => {
  const body = fnBody(forward, 'fn_mark_civitatis_settlement_period_paid');
  assert.match(body, /IF v_paid_cnt = v_total THEN[\s\S]{0,80}'result', 'already_paid'/);
  assert.match(body, /'result', 'no_actionable_items'/);
  assert.match(body, /'result', 'period_not_found'/);
});

test('paid-transition sets exactly status/paid_at/updated_at — never the immutable financial columns', () => {
  const body = fnBody(forward, 'fn_mark_civitatis_settlement_period_paid');
  const setClauseStart = body.lastIndexOf('SET status');
  const setClauseEnd = body.indexOf('WHERE settlement_period', setClauseStart);
  const setClause = body.slice(setClauseStart, setClauseEnd);
  assert.match(setClause, /status\s*=\s*'paid'/);
  assert.match(setClause, /paid_at\s*=\s*NOW\(\)/);
  for (const forbidden of ['original_amount', 'original_currency', 'reservation_id =', 'claimable_at =', 'exchange_rate_used', 'exchange_rate_date', 'try_amount']) {
    assert.doesNotMatch(setClause, new RegExp(forbidden.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
});

test('paid-transition role check also uses IS NOT TRUE, same NULL-auth fix as the requested transition', () => {
  const body = fnBody(forward, 'fn_mark_civitatis_settlement_period_paid');
  assert.match(body, /IF \(public\.is_admin\(\) OR public\.is_operations\(\)\) IS NOT TRUE THEN/);
});

test('paid-transition logs from_status requested -> to_status paid, with batch_affected_count, only on the success path', () => {
  const body = fnBody(forward, 'fn_mark_civitatis_settlement_period_paid');
  assert.match(body, /'from_status', 'requested'/);
  assert.match(body, /'to_status', 'paid'/);
  assert.match(body, /'batch_affected_count', v_count/);
  const insertIdx = body.indexOf('INSERT INTO public.activity_logs');
  const returnPaidIdx = body.indexOf("'result', 'paid'");
  assert.ok(insertIdx > -1 && insertIdx < returnPaidIdx);
});

// ── E. Privilege lockdown ─────────────────────────────────────────────────

test('both transition functions REVOKE EXECUTE FROM PUBLIC and GRANT EXECUTE only to authenticated (never anon, never a bare PUBLIC grant)', () => {
  assert.match(forward, /REVOKE EXECUTE ON FUNCTION public\.fn_mark_civitatis_settlement_period_requested\(DATE\) FROM PUBLIC;/);
  assert.match(forward, /GRANT\s+EXECUTE ON FUNCTION public\.fn_mark_civitatis_settlement_period_requested\(DATE\) TO authenticated;/);
  assert.match(forward, /REVOKE EXECUTE ON FUNCTION public\.fn_mark_civitatis_settlement_period_paid\(DATE\) FROM PUBLIC;/);
  assert.match(forward, /GRANT\s+EXECUTE ON FUNCTION public\.fn_mark_civitatis_settlement_period_paid\(DATE\) TO authenticated;/);
  assert.doesNotMatch(forward, /TO anon/);
});

test('both functions are SECURITY DEFINER with search_path pinned to public', () => {
  for (const name of ['fn_mark_civitatis_settlement_period_requested', 'fn_mark_civitatis_settlement_period_paid']) {
    const body = fnBody(forward, name);
    assert.match(forward.slice(forward.indexOf(`CREATE OR REPLACE FUNCTION public.${name}`), forward.indexOf(`CREATE OR REPLACE FUNCTION public.${name}`) + 300), /SECURITY DEFINER\s*\nSET search_path = public/);
  }
});

// ── F. Do-not-touch guarantees ────────────────────────────────────────────

test('never touches reservations, public.payments, reservations.payment_status, exchange_rates, or RLS policies', () => {
  assert.doesNotMatch(forward, /ALTER TABLE public\.reservations/);
  assert.doesNotMatch(forward, /(INSERT INTO|UPDATE|DELETE FROM|ALTER TABLE)\s+public\.payments\b/);
  assert.doesNotMatch(forward, /\bpayment_status\s*=/);
  assert.doesNotMatch(forward, /public\.exchange_rates/);
  assert.doesNotMatch(forward, /CREATE POLICY|DROP POLICY|ENABLE ROW LEVEL SECURITY/);
});

test('never references retail_amount/retail_currency as a settlement figure', () => {
  assert.doesNotMatch(forward, /retail_amount|retail_currency/);
});

test('never redefines fn_ensure_civitatis_settlement_item, fn_cancel_civitatis_settlement_item_if_exists, or the Phase 1 trigger', () => {
  assert.doesNotMatch(forward, /CREATE OR REPLACE FUNCTION public\.fn_ensure_civitatis_settlement_item/);
  assert.doesNotMatch(forward, /CREATE OR REPLACE FUNCTION public\.fn_cancel_civitatis_settlement_item_if_exists/);
  assert.doesNotMatch(forward, /CREATE TRIGGER trg_civitatis_settlement_on_reservation_change/);
});

test('never writes exchange_rate_used/exchange_rate_date/try_amount anywhere — the fixed 55 TRY EUR rate (Phase 1.3) is presentation logic only, never persisted because of a display conversion', () => {
  assert.doesNotMatch(forward, /exchange_rate_used\s*=/);
  assert.doesNotMatch(forward, /exchange_rate_date\s*=/);
  assert.doesNotMatch(forward, /try_amount\s*=/);
});

// ── G. Rollback — exact symmetry ──────────────────────────────────────────

test('rollback drops exactly the two functions and the two columns this migration added, nothing else structural', () => {
  assert.match(rollback, /DROP FUNCTION IF EXISTS public\.fn_mark_civitatis_settlement_period_requested\(DATE\);/);
  assert.match(rollback, /DROP FUNCTION IF EXISTS public\.fn_mark_civitatis_settlement_period_paid\(DATE\);/);
  assert.match(rollback, /DROP COLUMN IF EXISTS requested_at,\s*\n\s*DROP COLUMN IF EXISTS paid_at;/);
});

test('rollback never touches civitatis_settlement_items.status, original_amount, original_currency, settlement_period, reservation_id, or claimable_at', () => {
  assert.doesNotMatch(rollback, /DROP COLUMN IF EXISTS status/);
  assert.doesNotMatch(rollback, /DROP COLUMN IF EXISTS original_amount/);
  assert.doesNotMatch(rollback, /DROP COLUMN IF EXISTS original_currency/);
  assert.doesNotMatch(rollback, /DROP COLUMN IF EXISTS settlement_period/);
  assert.doesNotMatch(rollback, /DROP COLUMN IF EXISTS reservation_id/);
  assert.doesNotMatch(rollback, /DROP COLUMN IF EXISTS claimable_at/);
});

test('rollback never touches reservations, public.payments, or activity_logs rows/constraints', () => {
  assert.doesNotMatch(rollback, /ALTER TABLE public\.reservations/);
  assert.doesNotMatch(rollback, /(INSERT INTO|UPDATE|DELETE FROM|ALTER TABLE|DROP TABLE)\s+public\.payments\b/);
  assert.doesNotMatch(rollback, /ALTER TABLE public\.activity_logs/);
  assert.doesNotMatch(rollback, /DELETE FROM public\.activity_logs/);
});

test('rollback never drops civitatis_settlement_items or exchange_rates themselves — only Phase 2 own additions', () => {
  assert.doesNotMatch(rollback, /DROP TABLE IF EXISTS public\.civitatis_settlement_items/);
  assert.doesNotMatch(rollback, /DROP TABLE IF EXISTS public\.exchange_rates/);
});

test('rollback has a postflight check confirming both columns and both functions are gone, and civitatis_settlement_items/reservations still exist', () => {
  assert.match(rollback, /requested_at still exists after DROP/);
  assert.match(rollback, /paid_at still exists after DROP/);
  assert.match(rollback, /fn_mark_civitatis_settlement_period_requested still exists after DROP/);
  assert.match(rollback, /fn_mark_civitatis_settlement_period_paid still exists after DROP/);
  assert.match(rollback, /civitatis_settlement_items table disappeared/);
  assert.match(rollback, /reservations table disappeared/);
});

// ── H. No sentence-level em/en dash in new Turkish copy ───────────────────

test('this migration introduces no sentence-level em or en dash in its activity_logs description strings', () => {
  const descriptionLines = forward.match(/'Civitatis hakedis[^']*'/g) || [];
  assert.ok(descriptionLines.length > 0);
  for (const line of descriptionLines) {
    assert.doesNotMatch(line, /[–—]/);
  }
});
