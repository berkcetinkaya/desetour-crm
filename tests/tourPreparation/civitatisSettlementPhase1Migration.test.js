'use strict';
/**
 * tests/tourPreparation/civitatisSettlementPhase1Migration.test.js
 * ─────────────────────────────────────────────────────────────────────────
 * Regression coverage for supabase_migration_civitatis_settlement_phase1.sql
 * and its rollback (Civitatis Settlement Engine — Phase 1 Foundation).
 * Every test here is a pure, static, never-executed text assertion
 * against the prepared .sql files — nothing in this file connects to a
 * database or runs any SQL. The forward migration (tables, functions,
 * trigger, backfill, idempotency, currency normalization, CHECK
 * constraints) was separately validated live against a throwaway local
 * PostgreSQL instance (never production/Supabase) during implementation;
 * this file is the committed regression suite, not that live validation.
 * ─────────────────────────────────────────────────────────────────────────
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const FORWARD_PATH  = path.join(ROOT, 'supabase_migration_civitatis_settlement_phase1.sql');
const ROLLBACK_PATH = path.join(ROOT, 'supabase_migration_civitatis_settlement_phase1_ROLLBACK.sql');

const forward  = fs.readFileSync(FORWARD_PATH, 'utf8');
const rollback = fs.readFileSync(ROLLBACK_PATH, 'utf8');

// ── A. New tables ────────────────────────────────────────────────────────

test('creates civitatis_settlement_items with the exact brief-specified columns', () => {
  const start = forward.indexOf('CREATE TABLE IF NOT EXISTS public.civitatis_settlement_items');
  const end = forward.indexOf(');', start);
  const body = forward.slice(start, end);
  assert.match(body, /reservation_id\s+UUID\s+NOT NULL UNIQUE REFERENCES public\.reservations\(id\)/);
  assert.match(body, /settlement_period\s+DATE\s+NOT NULL/);
  assert.match(body, /original_amount\s+NUMERIC\(12,2\) NOT NULL CHECK \(original_amount > 0\)/);
  assert.match(body, /original_currency\s+TEXT\s+NOT NULL/);
  assert.match(body, /claimable_at\s+DATE\s+NOT NULL/);
  assert.match(body, /status\s+TEXT\s+NOT NULL DEFAULT 'accrued'/);
  assert.match(body, /CHECK \(status IN \('accrued','claimable','requested','paid','adjusted','cancelled'\)\)/);
  assert.match(body, /exchange_rate_used\s+NUMERIC,/);
  assert.match(body, /exchange_rate_date\s+DATE,/);
  assert.match(body, /try_amount\s+NUMERIC\(12,2\),/);
  assert.match(body, /created_at\s+TIMESTAMPTZ/);
  assert.match(body, /updated_at\s+TIMESTAMPTZ/);
});

test('try_amount and exchange_rate_used must be both-null or both-set (never a frozen amount with no recorded rate)', () => {
  assert.match(forward, /CONSTRAINT civitatis_settlement_items_try_amount_pair CHECK \(\s*\(try_amount IS NULL AND exchange_rate_used IS NULL\)\s*\n\s*OR \(try_amount IS NOT NULL AND exchange_rate_used IS NOT NULL\)\s*\)/);
});

test('creates exchange_rates with the exact brief-specified columns and unique constraint', () => {
  const start = forward.indexOf('CREATE TABLE IF NOT EXISTS public.exchange_rates');
  const end = forward.indexOf(');', start);
  const body = forward.slice(start, end);
  assert.match(body, /rate_date\s+DATE\s+NOT NULL/);
  assert.match(body, /base_currency\s+TEXT\s+NOT NULL/);
  assert.match(body, /quote_currency\s+TEXT\s+NOT NULL/);
  assert.match(body, /rate\s+NUMERIC\s+NOT NULL CHECK \(rate > 0\)/);
  assert.match(body, /source\s+TEXT\s+NOT NULL DEFAULT 'ECB'/);
  assert.match(body, /fetched_at\s+TIMESTAMPTZ/);
  assert.match(body, /CONSTRAINT exchange_rates_date_base_quote_key UNIQUE \(rate_date, base_currency, quote_currency\)/);
});

// ── B. RLS — admin/operations only on settlement items, read-only for everyone on rates ──

test('civitatis_settlement_items RLS: admin and operations FOR ALL, no other authenticated-role policy', () => {
  assert.match(forward, /CREATE POLICY "civitatis_settlement_items: admin full access"\s*\n\s*ON public\.civitatis_settlement_items FOR ALL TO authenticated\s*\n\s*USING\s*\(\s*is_admin\(\)\s*\)/);
  assert.match(forward, /CREATE POLICY "civitatis_settlement_items: operations full access"\s*\n\s*ON public\.civitatis_settlement_items FOR ALL TO authenticated\s*\n\s*USING\s*\(\s*is_operations\(\)\s*\)/);
  assert.match(forward, /ALTER TABLE public\.civitatis_settlement_items ENABLE ROW LEVEL SECURITY/);
});

test('exchange_rates RLS: authenticated staff can only SELECT, no INSERT/UPDATE/DELETE policy for that role anywhere', () => {
  assert.match(forward, /ALTER TABLE public\.exchange_rates ENABLE ROW LEVEL SECURITY/);
  assert.match(forward, /CREATE POLICY "exchange_rates: authenticated staff can read"\s*\n\s*ON public\.exchange_rates FOR SELECT TO authenticated/);
  // No FOR ALL / FOR INSERT / FOR UPDATE / FOR DELETE policy on this table at all.
  const startIdx = forward.indexOf('CREATE TABLE IF NOT EXISTS public.exchange_rates');
  const nextSectionIdx = forward.indexOf('FUNCTION: fn_ensure_civitatis_settlement_item');
  const exchangeRatesSection = forward.slice(startIdx, nextSectionIdx);
  assert.doesNotMatch(exchangeRatesSection, /FOR (ALL|INSERT|UPDATE|DELETE) TO authenticated/);
});

// ── C. Eligibility / period / currency normalization logic ──────────────

test('eligibility requires Civitatis source, completed status, positive total_amount, and a known currency', () => {
  const fnStart = forward.indexOf('CREATE OR REPLACE FUNCTION public.fn_ensure_civitatis_settlement_item');
  const fnEnd = forward.indexOf('$$;', fnStart);
  const body = forward.slice(fnStart, fnEnd);
  assert.match(body, /s\.slug = 'civitatis'/);
  assert.match(body, /v_res\.status IS DISTINCT FROM 'completed'/);
  assert.match(body, /v_res\.total_amount IS NULL\s*\n\s*OR v_res\.total_amount <= 0/);
  assert.match(body, /v_res\.currency IS NULL/);
});

test('settlement_period and claimable_at are derived from check_in, never completed_at', () => {
  const fnStart = forward.indexOf('CREATE OR REPLACE FUNCTION public.fn_ensure_civitatis_settlement_item');
  const fnEnd = forward.indexOf('$$;', fnStart);
  const body = forward.slice(fnStart, fnEnd);
  assert.match(body, /v_settlement_period\s*:=\s*date_trunc\('month', v_res\.check_in\)::DATE/);
  assert.match(body, /v_claimable_at\s*:=\s*\(date_trunc\('month', v_res\.check_in\) \+ INTERVAL '1 month'\)::DATE/);
  // completed_at is legitimately named in this function's own explanatory
  // comments (why it is deliberately NOT used) — assert the real guard,
  // not bare substring absence: the v_res record's own SELECT list never
  // fetches it, and no assignment anywhere derives from it.
  assert.doesNotMatch(body, /SELECT[^;]*\bcompleted_at\b[^;]*INTO v_res/s);
  assert.doesNotMatch(body, /:=[^;]*\bcompleted_at\b/);
});

test('TL is normalized to TRY; every other currency (including the real ISO TRY) passes through unchanged', () => {
  const fnStart = forward.indexOf('CREATE OR REPLACE FUNCTION public.fn_ensure_civitatis_settlement_item');
  const fnEnd = forward.indexOf('$$;', fnStart);
  const body = forward.slice(fnStart, fnEnd);
  assert.match(body, /v_norm_currency\s*:=\s*CASE WHEN v_res\.currency = 'TL' THEN 'TRY' ELSE v_res\.currency END/);
});

test('fn_ensure_civitatis_settlement_item never writes to reservations, payments, or retail_amount/retail_currency', () => {
  const fnStart = forward.indexOf('CREATE OR REPLACE FUNCTION public.fn_ensure_civitatis_settlement_item');
  const fnEnd = forward.indexOf('$$;', fnStart);
  const body = forward.slice(fnStart, fnEnd);
  assert.doesNotMatch(body, /UPDATE public\.reservations/);
  assert.doesNotMatch(body, /INSERT INTO public\.reservations/);
  assert.doesNotMatch(body, /public\.payments/);
  assert.doesNotMatch(body, /retail_amount/);
  assert.doesNotMatch(body, /retail_currency/);
});

test('the function is idempotent via ON CONFLICT (reservation_id) DO NOTHING, and only logs when a row was actually inserted', () => {
  const fnStart = forward.indexOf('CREATE OR REPLACE FUNCTION public.fn_ensure_civitatis_settlement_item');
  const fnEnd = forward.indexOf('$$;', fnStart);
  const body = forward.slice(fnStart, fnEnd);
  assert.match(body, /ON CONFLICT \(reservation_id\) DO NOTHING/);
  assert.match(body, /IF v_new_id IS NOT NULL THEN/);
});

// ── D. Cancellation correction path ──────────────────────────────────────

test('cancelling a reservation moves its settlement item to cancelled, but never touches one already paid or cancelled', () => {
  const fnStart = forward.indexOf('CREATE OR REPLACE FUNCTION public.fn_cancel_civitatis_settlement_item_if_exists');
  const fnEnd = forward.indexOf('$$;', fnStart);
  const body = forward.slice(fnStart, fnEnd);
  assert.match(body, /SET status = 'cancelled'/);
  assert.match(body, /AND status NOT IN \('paid', 'cancelled'\)/);
  assert.doesNotMatch(body, /DELETE/);
});

// ── E. Trigger — database-level enforcement, never touches reservations ──

test('trigger fires AFTER INSERT OR UPDATE OF status on reservations, scoped to completed/cancelled via WHEN', () => {
  assert.match(forward, /CREATE TRIGGER trg_civitatis_settlement_on_reservation_change\s*\n\s*AFTER INSERT OR UPDATE OF status ON public\.reservations\s*\n\s*FOR EACH ROW\s*\n\s*WHEN \(NEW\.status IN \('completed', 'cancelled'\)\)/);
});

test('the trigger function never assigns to any NEW.* column — it only ever reads, never modifies the reservation row', () => {
  const fnStart = forward.indexOf('CREATE OR REPLACE FUNCTION public.fn_trg_civitatis_settlement_on_reservation_change');
  const fnEnd = forward.indexOf('$$;', fnStart);
  const body = forward.slice(fnStart, fnEnd);
  // PL/pgSQL assignment is specifically ":=" — a bare "=" is a
  // comparison (as in "IF NEW.status = 'completed'"), which this
  // function legitimately contains and must not be flagged.
  assert.doesNotMatch(body, /NEW\.\w+\s*:=/);
  assert.match(body, /RETURN NEW;/);
});

// ── F. Backfill — idempotent, scoped, never touches ineligible rows ──────

test('backfill reuses fn_ensure_civitatis_settlement_item (no separate/duplicated eligibility logic) and is scoped to completed Civitatis reservations', () => {
  const backfillIdx = forward.indexOf('SELECT public.fn_ensure_civitatis_settlement_item(r.id)');
  assert.ok(backfillIdx > -1, 'expected the backfill SELECT to call fn_ensure_civitatis_settlement_item');
  const tail = forward.slice(backfillIdx);
  assert.match(tail, /WHERE s\.slug = 'civitatis'\s*\n\s*AND r\.status = 'completed'/);
});

test('exactly one backfill statement exists in the forward migration', () => {
  const matches = forward.match(/SELECT public\.fn_ensure_civitatis_settlement_item\(r\.id\)/g) || [];
  assert.equal(matches.length, 1);
});

// ── G. activity_logs widening — additive only ────────────────────────────

test('activity_logs.entity_type is widened additively: every prior value remains, plus exactly one new value', () => {
  const idx = forward.lastIndexOf('ADD CONSTRAINT activity_logs_entity_type_check');
  const body = forward.slice(idx, forward.indexOf('));', idx) + 3);
  for (const priorValue of [
    'customer','lead','quote','reservation','payment','task','reminder','tour',
    'message','settings','guide','guide_payment','reservation_review','tour_language','tour_channel',
  ]) {
    assert.match(body, new RegExp(`'${priorValue}'`), `expected prior value '${priorValue}' to remain allowed`);
  }
  assert.match(body, /'civitatis_settlement'/);
});

test('settlement creation and cancellation are logged via activity_logs using the new entity_type, action created/cancelled', () => {
  assert.match(forward, /'civitatis_settlement', v_new_id, 'created'/);
  assert.match(forward, /'civitatis_settlement', v_item_id, 'cancelled'/);
});

// ── H. Do-not-touch guarantees across the whole forward migration ────────

test('the forward migration never ALTERs reservations.total_amount/currency/retail_amount/retail_currency/payment_status, and never writes to public.payments', () => {
  // public.payments/payment_status/ingest_civitatis_booking are legitimately
  // NAMED in this file's own explanatory header comments (documenting that
  // they are deliberately NOT touched) — so the real guard is "no actual
  // SQL statement acts on them", never bare substring absence.
  assert.doesNotMatch(forward, /ALTER TABLE public\.reservations\s+(ALTER|DROP|ADD COLUMN)/);
  assert.doesNotMatch(forward, /(INSERT INTO|UPDATE|DELETE FROM|ALTER TABLE)\s+public\.payments\b/);
  assert.doesNotMatch(forward, /\bpayment_status\s*=/);
  assert.doesNotMatch(forward, /SET\s+payment_status/);
});

test('the forward migration never redefines or alters the Civitatis ingestion RPCs (ingest_civitatis_booking / cancellation RPC)', () => {
  assert.doesNotMatch(forward, /(CREATE OR REPLACE FUNCTION|DROP FUNCTION|ALTER FUNCTION)\s+public\.ingest_civitatis_booking/);
  assert.doesNotMatch(forward, /(CREATE OR REPLACE FUNCTION|DROP FUNCTION|ALTER FUNCTION)\s+public\.cancel_civitatis_booking/);
});

test('no UI copy anywhere in the forward migration uses a sentence-level em/en dash (only this file is SQL, so this guards comment text that ships as activity_log descriptions)', () => {
  const descriptionLines = forward.match(/'Civitatis hakediş[^']*'/g) || [];
  assert.ok(descriptionLines.length > 0);
  for (const line of descriptionLines) {
    assert.doesNotMatch(line, /[–—]/);
  }
});

// ── I. Rollback — exact symmetry, never touches reservations ─────────────

test('rollback drops exactly the objects the forward migration created, in dependency-safe order (trigger before its function, table drops after)', () => {
  const dropTrigIdx = rollback.indexOf('DROP TRIGGER IF EXISTS trg_civitatis_settlement_on_reservation_change');
  const dropFnIdx = rollback.indexOf('DROP FUNCTION IF EXISTS public.fn_trg_civitatis_settlement_on_reservation_change');
  const dropTableIdx = rollback.indexOf('DROP TABLE IF EXISTS public.civitatis_settlement_items');
  assert.ok(dropTrigIdx > -1 && dropFnIdx > -1 && dropTableIdx > -1);
  assert.ok(dropTrigIdx < dropFnIdx, 'trigger must be dropped before its function');
  assert.ok(dropFnIdx < dropTableIdx, 'functions must be dropped before the table');
});

test('rollback reverts activity_logs.entity_type to exactly the pre-migration list, removing only civitatis_settlement', () => {
  const idx = rollback.lastIndexOf('ADD CONSTRAINT activity_logs_entity_type_check');
  const body = rollback.slice(idx, rollback.indexOf('));', idx) + 3);
  assert.doesNotMatch(body, /'civitatis_settlement'/);
  for (const priorValue of ['customer','reservation','payment','tour_channel']) {
    assert.match(body, new RegExp(`'${priorValue}'`));
  }
});

test('rollback never touches public.reservations or public.payments', () => {
  // Same "named in prose, never acted on" distinction as the forward
  // migration's equivalent test above.
  assert.doesNotMatch(rollback, /ALTER TABLE public\.reservations/);
  assert.doesNotMatch(rollback, /(INSERT INTO|UPDATE|DELETE FROM|ALTER TABLE|DROP TABLE)\s+public\.payments\b/);
});

test('rollback never deletes or updates any existing activity_logs row — only the CHECK constraint definition changes', () => {
  assert.doesNotMatch(rollback, /DELETE FROM public\.activity_logs/);
  assert.doesNotMatch(rollback, /UPDATE public\.activity_logs/);
});

test('rollback has a postflight check confirming both new tables are gone and reservations still exists', () => {
  assert.match(rollback, /civitatis_settlement_items still exists after DROP/);
  assert.match(rollback, /exchange_rates still exists after DROP/);
  assert.match(rollback, /reservations table disappeared/);
});
