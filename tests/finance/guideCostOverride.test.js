'use strict';
/**
 * tests/finance/guideCostOverride.test.js — per-operation guide cost
 * override: payload rules, migration / rollback contract, UI wiring.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { extractTestableFn } = require('../dashboard/extractTestableFn');

const ROOT = path.join(__dirname, '..', '..');
const SOURCE = fs.readFileSync(path.join(ROOT, 'DeseTourDashboard.jsx'), 'utf8');
const MIG = fs.readFileSync(path.join(ROOT, 'supabase_migration_guide_operation_cost_overrides.sql'), 'utf8');
const RB = fs.readFileSync(path.join(ROOT, 'supabase_migration_guide_operation_cost_overrides_ROLLBACK.sql'), 'utf8');
const payload = extractTestableFn('_financeGuideCostOverridePayload');
function body(name) { const i = SOURCE.indexOf(`function ${name}(`); assert.ok(i !== -1, name); return SOURCE.slice(i, SOURCE.indexOf('\nfunction ', i + 10)); }

const ok = { operationKey: '2026-11-12|T1|İspanyolca', tourDate: '2026-11-12', tourId: 'T1', language: 'İspanyolca', reservationId: 'R1', amount: '120,5', currency: 'eur', reason: ' yarım gün ' };

test('payload: keyed by operation, comma decimals, currency normalized, 0 allowed', () => {
  assert.deepEqual(payload(ok), { operation_key: '2026-11-12|T1|İspanyolca', tour_date: '2026-11-12', tour_id: 'T1', language: 'İspanyolca', reservation_id: 'R1', amount: 120.5, currency: 'EUR', reason: 'yarım gün' });
  assert.equal(payload({ ...ok, amount: '0' }).amount, 0);
});

test('payload refuses missing operation / date, negative or empty amount, unknown currency', () => {
  assert.throws(() => payload({ ...ok, operationKey: '' }), /Operasyon bulunamadı/);
  assert.throws(() => payload({ ...ok, tourDate: '' }), /tarihi eksik/);
  for (const amount of ['-1', '', 'abc', null]) assert.throws(() => payload({ ...ok, amount }), /0 veya daha büyük/);
  assert.throws(() => payload({ ...ok, currency: 'CHF' }), /para birimi/);
});

test('migration: one override per operation (UNIQUE key), amount >= 0, RLS admin + operations with aal2, CHECK only widened', () => {
  assert.match(MIG, /operation_key\s+TEXT\s+NOT NULL UNIQUE/);
  assert.match(MIG, /amount\s+NUMERIC\(12,2\) NOT NULL CHECK \(amount >= 0\)/);
  assert.match(MIG, /ENABLE ROW LEVEL SECURITY/);
  assert.equal((MIG.match(/CREATE POLICY/g) || []).length, 2);
  assert.match(MIG, /USING \( is_admin\(\) AND is_aal2\(\) \)/);
  assert.match(MIG, /USING \( is_operations\(\) AND is_aal2\(\) \)/);
  assert.match(MIG, /v_new := v_live \|\| ARRAY\['guide_operation_cost'\];/);
  assert.match(RB, /GUIDE COST OVERRIDE ROLLBACK REFUSED/);
  assert.match(RB, /WHERE x <> 'guide_operation_cost'/);
});

test('repo upserts by operation_key and logs; a missing table leaves the standard cost and disables editing', () => {
  const a = SOURCE.indexOf('const SupabaseFinanceRepo = {');
  const repo = SOURCE.slice(a, SOURCE.indexOf('\n};', a));
  assert.match(repo, /\.upsert\(row, \{ onConflict: 'operation_key' \}\)/);
  assert.match(repo, /_sbLog\('guide_operation_cost', data\.id, 'updated'/);
  assert.match(repo, /if \(error\) return \{ overrides: \[\], unavailable: true \};/);
  assert.match(repo, /guideCostOverrides: ov\.overrides, guideCostOverridesUnavailable: ov\.unavailable/);
});

test('editor: opened from a reservation, applies to the whole operation, can return to standard', () => {
  const e = body('_GuideCostOverrideEditor');
  assert.match(e, /mutate\("setGuideCostOverride", \{ operationKey: group\.key, tourDate: group\.date, tourId: group\.tourId, language: group\.language,/);
  assert.match(e, /mutate\("clearGuideCostOverride", group\.key\)/);
  assert.match(e, /Bu tutar operasyonun tamamına uygulanır/);
  assert.match(e, /window\.confirm\(/);
  assert.match(body('ReservationFinanceCard'), /<_GuideCostOverrideEditor r=\{r\} group=\{group\} unavailable=\{summary && summary\.guideCostOverridesUnavailable\}\/>/);
});
