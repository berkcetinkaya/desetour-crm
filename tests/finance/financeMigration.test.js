'use strict';
/**
 * tests/finance/financeMigration.test.js
 * Static guarantees of the Finance Phase C migrations, data-access layer and
 * the gross-revenue label clarification. (The same migrations were also
 * executed against a throwaway PostgreSQL 16 database during review —
 * constraints, FX freezing, drift protection and RLS behaved as asserted
 * here.)
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { extractTestableFn } = require('../dashboard/extractTestableFn');

const ROOT = path.join(__dirname, '..', '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const MIG = read('supabase_migration_finance_center.sql');
const MIG_RB = read('supabase_migration_finance_center_ROLLBACK.sql');
const TOP = read('supabase_migration_finance_topkapi_rule.sql');
const TOP_RB = read('supabase_migration_finance_topkapi_rule_ROLLBACK.sql');
const BACKFILL = read('finance_topkapi_rule_backfill.sql');
const PREFLIGHT = read('finance_topkapi_rule_preflight.sql');
const SOURCE = read('DeseTourDashboard.jsx');
const sqlCode = (s) => s.split('\n').filter(l => !l.trim().startsWith('--')).join('\n');

// ── finance_cost_items ───────────────────────────────────────────────────

test('cost catalog: approved categories, bases and kinds', () => {
  assert.match(MIG, /category\s+TEXT\s+NOT NULL CHECK \(category IN \('ticket','guide','meal','transport','other'\)\)/);
  assert.match(MIG, /basis\s+TEXT\s+NOT NULL CHECK \(basis IN \('per_guest','per_adult','fixed_per_reservation','fixed','preparation_rule','guide_service_group'\)\)/);
  assert.match(MIG, /kind\s+TEXT\s+NOT NULL CHECK \(kind IN \('internal','public_reference'\)\)/);
  for (const col of ['label', 'amount', 'currency', 'tour_id', 'preparation_rule_id', 'valid_from', 'valid_to', 'is_active', 'source_note', 'source_url', 'last_verified_date', 'created_by', 'created_at', 'updated_at']) {
    assert.match(MIG.slice(MIG.indexOf('CREATE TABLE IF NOT EXISTS public.finance_cost_items'), MIG.indexOf('COMMENT ON TABLE public.finance_cost_items')), new RegExp(`\\n\\s+${col}\\s`), col);
  }
});

test('guide cost can only be a per-guide-service amount — never fixed_per_reservation / per_guest', () => {
  assert.match(MIG, /CONSTRAINT finance_cost_items_guide_basis CHECK \(\(category = 'guide'\) = \(basis = 'guide_service_group'\)\)/);
  assert.match(MIG, /CONSTRAINT finance_cost_items_rule_basis CHECK \(\(basis = 'preparation_rule'\) = \(preparation_rule_id IS NOT NULL\)\)/);
  assert.match(MIG, /CONSTRAINT finance_cost_items_scope CHECK \(category IN \('guide','meal'\) OR tour_id IS NOT NULL OR preparation_rule_id IS NOT NULL\)/);
});

test('internal seeds: Guide Service €150 per guide-service group, Included Meal €10 per guest — nothing else invented', () => {
  assert.match(MIG, /SELECT 'Guide Service', 'guide', 'guide_service_group', 150, 'EUR', DATE '2026-01-01', 'internal'/);
  assert.match(MIG, /SELECT 'Included Meal', 'meal', 'per_guest', 10, 'EUR', DATE '2026-01-01', 'internal'/);
  const inserts = sqlCode(MIG).match(/INSERT INTO public\.finance_cost_items/g) || [];
  assert.equal(inserts.length, 2);
  assert.doesNotMatch(sqlCode(MIG), /Ayasofya|Hagia|Bosphorus|Boğaz|çay|tea/i);
});

// ── reservation_expenses ────────────────────────────────────────────────

test('reservation_expenses structurally excludes guide (guide_payments stays the only guide ledger)', () => {
  assert.match(MIG, /category\s+TEXT\s+NOT NULL CHECK \(category IN \('ticket','meal','transport','other'\)\)/);
  const table = MIG.slice(MIG.indexOf('CREATE TABLE IF NOT EXISTS public.reservation_expenses'), MIG.indexOf('COMMENT ON TABLE public.reservation_expenses'));
  assert.doesNotMatch(sqlCode(table).replace(/'ticket','meal','transport','other'/, ''), /'guide'/);
  for (const col of ['reservation_id', 'description', 'quantity', 'unit_amount', 'total_amount', 'currency', 'expense_date', 'finance_cost_item_id', 'exchange_rate_used', 'exchange_rate_date', 'try_amount', 'notes', 'created_by']) {
    assert.match(table, new RegExp(`\\n\\s+${col}\\s`), col);
  }
  assert.match(table, /reservation_id\s+UUID\s+NOT NULL REFERENCES public\.reservations\(id\) ON DELETE RESTRICT/);
});

test('frozen FX set is all-or-nothing and internally consistent', () => {
  assert.match(MIG, /CONSTRAINT reservation_expenses_fx_frozen_set CHECK \(/);
  assert.match(MIG, /try_amount = ROUND\(total_amount \* exchange_rate_used, 2\)/);
});

test('FX freeze trigger: server-side, ignores client values, re-freezes only on monetary change, ≤7-day rate on/before the expense date, no hardcoded rate', () => {
  const fn = MIG.slice(MIG.indexOf('CREATE OR REPLACE FUNCTION public.fn_reservation_expenses_freeze_fx()'), MIG.indexOf('REVOKE ALL ON FUNCTION public.fn_reservation_expenses_freeze_fx()'));
  assert.match(fn, /SECURITY DEFINER\s+SET search_path = public/);
  assert.match(fn, /IF TG_OP = 'UPDATE'\s+AND NEW\.total_amount IS NOT DISTINCT FROM OLD\.total_amount\s+AND NEW\.currency IS NOT DISTINCT FROM OLD\.currency\s+AND NEW\.expense_date IS NOT DISTINCT FROM OLD\.expense_date THEN/);
  assert.match(fn, /NEW\.exchange_rate_used := OLD\.exchange_rate_used;/);
  assert.match(fn, /AND er\.rate_date <= NEW\.expense_date\s+AND er\.rate_date >= NEW\.expense_date - 7/);
  assert.match(fn, /IF NEW\.currency = 'TL' THEN NEW\.currency := 'TRY'; END IF;/);
  assert.doesNotMatch(fn, /\b55\b|_FIXED_/);
  assert.match(MIG, /CREATE TRIGGER trg_reservation_expenses_freeze_fx\s+BEFORE INSERT OR UPDATE ON public\.reservation_expenses/);
});

// ── RLS + activity log ──────────────────────────────────────────────────

test('RLS mirrors guide_payments: admin + operations, both AAL2; no sales / guide policy', () => {
  for (const t of ['finance_cost_items', 'reservation_expenses']) {
    assert.match(MIG, new RegExp(`ALTER TABLE public\\.${t} ENABLE ROW LEVEL SECURITY;`));
    assert.match(MIG, new RegExp(`CREATE POLICY "${t}: admin full access" ON public\\.${t} FOR ALL TO authenticated USING \\( is_admin\\(\\) AND is_aal2\\(\\) \\) WITH CHECK \\( is_admin\\(\\) AND is_aal2\\(\\) \\);`));
    assert.match(MIG, new RegExp(`CREATE POLICY "${t}: operations full access" ON public\\.${t} FOR ALL TO authenticated USING \\( is_operations\\(\\) AND is_aal2\\(\\) \\) WITH CHECK \\( is_operations\\(\\) AND is_aal2\\(\\) \\);`));
  }
  assert.doesNotMatch(MIG, /is_sales\(\)|is_guide\(\)|TO anon/);
});

test('activity_logs entity_type widened by exactly two values and refuses to drop any live value', () => {
  assert.match(MIG, /'agency','agency_email',\s*'finance_cost_item','reservation_expense'/);
  assert.match(MIG, /refusing to drop them/);
  assert.match(MIG, /m\[1\] LIKE '\{%\}'/, 'parses both constraint renderings');
});

test('migration is transactional with a preflight and a postflight', () => {
  assert.match(MIG, /^BEGIN;/m); assert.match(MIG, /^COMMIT;/m);
  assert.match(MIG, /FINANCE CENTER MIGRATION PREFLIGHT FAILED/);
  assert.match(MIG, /FINANCE CENTER POSTFLIGHT PASSED/);
});

test('rollback refuses to destroy actual expense history or manual catalog rows', () => {
  assert.match(MIG_RB, /ROLLBACK REFUSED: reservation_expenses holds % row\(s\)/);
  assert.match(MIG_RB, /ROLLBACK REFUSED: finance_cost_items holds % non-seed row\(s\)/);
});

// ── Topkapı rule ─────────────────────────────────────────────────────────

test('Topkapı rule: explicit approved tour ids (not display names), palace stop only, per_guest entrance ticket', () => {
  assert.match(TOP, /v_tour_ids UUID\[\] := ARRAY\[\s*'a4e4bf16-a108-4a45-9418-d849f5bb7917'::uuid/);
  assert.doesNotMatch(sqlCode(TOP), /t\.name\s*=|tours\.name\s*=/);
  assert.match(TOP, /AND place_name NOT ILIKE '%harem%'/);
  assert.match(TOP, /VALUES \(v_tour, v_stop, 'entrance_ticket', v_label, 'per_guest', NULL, TRUE\)/);
  assert.match(TOP, /an active rule is attached to a Harem stop/);
});

test('Topkapı €40 is INTERNAL and bound to the rule (basis preparation_rule) — no Harem / Hagia Irene charge', () => {
  assert.match(TOP, /VALUES \('Topkapı Combined Entry', 'ticket', 'preparation_rule', 40, 'EUR', v_tour, v_rule, DATE '2026-01-01', 'internal'/);
  const inserts = sqlCode(TOP).match(/INSERT INTO public\.finance_cost_items/g) || [];
  assert.equal(inserts.length, 1);
  // The only cost row is the combined entry; Harem/Hagia Irene appear only in its explanatory note.
  const labels = [...sqlCode(TOP).matchAll(/VALUES \('([^']+)', 'ticket'/g)].map(m => m[1]);
  assert.deepEqual(labels, ['Topkapı Combined Entry']);
  assert.doesNotMatch(sqlCode(TOP), /INSERT INTO public\.tour_preparation_rules[^;]*Harem/);
});

test('Topkapı migration never writes reservation_preparations; backfill is separate, uses the existing engine, upcoming + non-cancelled only', () => {
  assert.doesNotMatch(sqlCode(TOP), /INSERT INTO public\.reservation_preparations|UPDATE public\.reservation_preparations/);
  assert.match(BACKFILL, /public\.materialize_reservation_preparations\(r\.id\)/);
  assert.match(BACKFILL, /r\.status <> 'cancelled'/);
  assert.match(BACKFILL, /r\.check_in >= \(now\(\) AT TIME ZONE 'Europe\/Istanbul'\)::date/);
  assert.doesNotMatch(sqlCode(PREFLIGHT), /\b(INSERT|UPDATE|DELETE|ALTER|CREATE|DROP)\b/);
});

test('Topkapı rollback deactivates (never deletes) a rule that has preparation history', () => {
  assert.match(TOP_RB, /UPDATE public\.tour_preparation_rules SET is_active = FALSE WHERE id = v_rule\.id;/);
});

// ── Browser data-access layer ───────────────────────────────────────────

const payload = extractTestableFn('_financeExpensePayload');

test('expense payload rejects guide (and unknown) categories and never sends frozen FX columns', () => {
  assert.throws(() => payload({ category: 'guide', totalAmount: 150, currency: 'EUR', expenseDate: '2026-11-10', reservationId: 'R' }), /rehber ödemeleri/i);
  assert.throws(() => payload({ category: 'bribe', totalAmount: 1, currency: 'EUR' }), /Geçersiz/);
  const p = payload({ category: 'ticket', totalAmount: 400, currency: ' eur ', expenseDate: '2026-11-10', reservationId: 'R', exchangeRateUsed: 1, tryAmount: 1 });
  assert.equal(p.currency, 'EUR');
  assert.ok(!('exchange_rate_used' in p) && !('exchange_rate_date' in p) && !('try_amount' in p));
});

test('Finance repo: normal authenticated client, RLS-scoped reads, logged mutations, no service key in the browser', () => {
  const a = SOURCE.indexOf('const SupabaseFinanceRepo = {');
  const repo = SOURCE.slice(a, SOURCE.indexOf('\n};', a));
  assert.match(repo, /const sb = getSB\(\);/);
  assert.doesNotMatch(SOURCE, /SUPABASE_SERVICE_ROLE_KEY|service_role_key|sb_secret_/i);
  assert.match(repo, /_sbLog\('finance_cost_item', data\.id, 'created'/);
  assert.match(repo, /_sbLog\('reservation_expense', data\.id, 'created'/);
  assert.match(repo, /_sbLog\('reservation_expense', id, 'deleted'/);
  assert.match(repo, /try \{ rateRows = await SupabaseExchangeRateRepo\.getLatestToTry\(\); \} catch \(_\) \{ rateSourceError = true; \}/);
  assert.match(SOURCE, /if\(entity==='finance'\) return useReal \? SupabaseFinanceRepo : FinanceRepository;/);
  // raw DB values passed through so Finance never reverse-maps Turkish labels
  assert.match(SOURCE, /statusRaw:r\.status\|\|null, paymentTypeRaw:r\.payment_type\|\|null,/);
});

test('Home Dashboard label clarified as GROSS; calculation unchanged', () => {
  assert.match(SOURCE, /label:"Brüt Beklenen Ciro",/);
  assert.match(SOURCE, />\s*Brüt Beklenen Ciro\s*<\/span>/);
  assert.doesNotMatch(SOURCE, /label:"Bu Ay Beklenen Ciro"/);
  assert.match(SOURCE, /const useRetail = r\.retailAmount != null;/, 'the 13.03 gross rule is untouched');
});

// ── Phase C corrections ─────────────────────────────────────────────────

const REF = read('supabase_migration_finance_reference_costs.sql');
const REF_RB = read('supabase_migration_finance_reference_costs_ROLLBACK.sql');

test('is_provisional exists, is internal-only, and must carry its source', () => {
  assert.match(MIG, /is_provisional\s+BOOLEAN\s+NOT NULL DEFAULT FALSE,/);
  assert.match(MIG, /CONSTRAINT finance_cost_items_provisional_internal CHECK \(NOT is_provisional OR kind = 'internal'\)/);
  assert.match(MIG, /CONSTRAINT finance_cost_items_provisional_sourced CHECK \(NOT is_provisional OR \(btrim\(source_note\) <> '' AND source_url IS NOT NULL\)\)/);
});

test('Topkapı migration refuses to create a duplicate when the tour already has another active Topkapı ticket rule', () => {
  assert.match(TOP, /DUPLICATE GUARD/);
  assert.match(TOP, /AND label <> v_label AND label ILIKE ANY \(ARRAY\['%Topkapı%', '%Topkapi%'\]\)\) THEN\s+RAISE EXCEPTION 'TOPKAPI RULE MIGRATION FAILED: tour % already has another active Topkapı entrance-ticket rule/);
  // allowlist unchanged pending owner approval
  assert.match(TOP, /v_tour_ids UUID\[\] := ARRAY\[\s*'a4e4bf16-a108-4a45-9418-d849f5bb7917'::uuid\s+-- Estambul Histórica · Portekizce \(Civitatis\)\s*\];/);
});

test('reference costs: Topkapı ₺2,750 and Ayasofya €25 are public_reference only, bound by verified rule id, with sources', () => {
  assert.match(REF, /v_topkapi_rule\s+CONSTANT UUID := '4a9e8bc3-bb93-4394-9b40-48695cfb3dfa'/);
  assert.match(REF, /v_ayasofya_rule CONSTANT UUID := '0c888a99-9544-49b8-ac0f-f81008c48fc9'/);
  assert.match(REF, /VALUES \('Topkapı Palace Combine Ticket \(official tariff\)', 'ticket', 'preparation_rule', 2750, 'TRY', v_topkapi_tour, v_topkapi_rule,\s+DATE '2026-11-11', 'public_reference'/);
  assert.match(REF, /'https:\/\/www\.millisaraylar\.gov\.tr\/Lokasyon\/2\/Topkapi-Sarayi\?culture=en'/);
  assert.match(REF, /VALUES \('Hagia Sophia Visitor Gallery \(public price\)', 'ticket', 'preparation_rule', 25, 'EUR', v_ayasofya_tour, v_ayasofya_rule,\s+DATE '2026-11-11', 'public_reference'/);
  assert.match(REF, /'https:\/\/istanbul\.com\/hagia-sophia'/);
  assert.match(REF, /https:\/\/www\.vgm\.gov\.tr\/news\/with-the-director-general-of-foundations-mr-sinan-aksu/);
  assert.match(REF, /not the separate History and Experience Museum, not the free worship area/);
});

test('Ayasofya internal provisional €25 is gated behind explicit owner confirmation (off by default) and marked provisional', () => {
  assert.match(REF, /v_confirm_ayasofya_visitor_gallery CONSTANT BOOLEAN := FALSE;/);
  assert.match(REF, /IF v_confirm_ayasofya_visitor_gallery\s+AND NOT EXISTS/);
  assert.match(REF, /'internal', TRUE,\s+'PROVISIONAL:/);
});

test('reference migration never creates a Bosphorus or tea cost and never changes internal amounts', () => {
  const code = sqlCode(REF);
  assert.doesNotMatch(code, /Şehir Hatları|Bosphorus|Boğaz|340|640|730|tea|çay/i);
  assert.match(REF, /FINANCE REFERENCE COSTS POSTFLIGHT FAILED: internal cost totals changed unexpectedly/);
  assert.doesNotMatch(code, /UPDATE public\.finance_cost_items|DELETE FROM public\.finance_cost_items/);
  assert.match(REF_RB, /kind = 'public_reference' AND label = 'Topkapı Palace Combine Ticket \(official tariff\)'/);
});
