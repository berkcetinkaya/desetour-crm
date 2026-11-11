'use strict';
/**
 * tests/finance/extraSales.test.js — ek satış (extra sales): payload rules
 * and the migration / rollback contract. Fake data only.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { extractTestableFn } = require('../dashboard/extractTestableFn');

const ROOT = path.join(__dirname, '..', '..');
const MIG = fs.readFileSync(path.join(ROOT, 'supabase_migration_reservation_extra_sales.sql'), 'utf8');
const RB = fs.readFileSync(path.join(ROOT, 'supabase_migration_reservation_extra_sales_ROLLBACK.sql'), 'utf8');
const payload = extractTestableFn('_financeExtraSalePayload');

const ok = { reservationId: 'R1', description: '  Türk lokumu kutusu ', amount: '450.5', currency: 'try', saleDate: '2026-11-12' };

test('payload: trims, normalizes currency, rounds amount, keeps only known columns', () => {
  assert.deepEqual(payload(ok), { reservation_id: 'R1', description: 'Türk lokumu kutusu', amount: 450.5, currency: 'TRY', sale_date: '2026-11-12', notes: '' });
});

test('payload refuses missing reservation, blank product, non-positive amount, unknown currency, missing date', () => {
  assert.throws(() => payload({ ...ok, reservationId: '' }), /Rezervasyon seçin/);
  assert.throws(() => payload({ ...ok, description: '   ' }), /Satılan ürünü/);
  for (const amount of [0, -5, 'abc', '']) assert.throws(() => payload({ ...ok, amount }), /sıfırdan büyük/);
  assert.throws(() => payload({ ...ok, currency: 'CHF' }), /para birimi/);
  assert.throws(() => payload({ ...ok, saleDate: '' }), /Satış tarihini/);
});

test('migration: one table tied to a reservation, positive amount, ISO currency, non-blank description, delete restricted', () => {
  assert.match(MIG, /CREATE TABLE IF NOT EXISTS public\.reservation_extra_sales \(/);
  assert.match(MIG, /reservation_id\s+UUID\s+NOT NULL REFERENCES public\.reservations\(id\) ON DELETE RESTRICT/);
  assert.match(MIG, /description\s+TEXT\s+NOT NULL CHECK \(length\(btrim\(description\)\) > 0\)/);
  assert.match(MIG, /amount\s+NUMERIC\(12,2\) NOT NULL CHECK \(amount > 0\)/);
  assert.match(MIG, /currency\s+TEXT\s+NOT NULL CHECK \(currency ~ '\^\[A-Z\]\{3\}\$'\)/);
  assert.match(MIG, /sale_date\s+DATE\s+NOT NULL/);
});

test('migration: RLS = admin + operations with aal2 only (same as reservation_expenses); postflight checks it', () => {
  assert.match(MIG, /ALTER TABLE public\.reservation_extra_sales ENABLE ROW LEVEL SECURITY;/);
  assert.match(MIG, /"reservation_extra_sales: admin full access"[^;]*USING \( is_admin\(\) AND is_aal2\(\) \) WITH CHECK \( is_admin\(\) AND is_aal2\(\) \);/);
  assert.match(MIG, /"reservation_extra_sales: operations full access"[^;]*USING \( is_operations\(\) AND is_aal2\(\) \) WITH CHECK \( is_operations\(\) AND is_aal2\(\) \);/);
  assert.equal((MIG.match(/CREATE POLICY/g) || []).length, 2);
  assert.match(MIG, /tablename = 'reservation_extra_sales'\) <> 2/);
});

test('migration: activity_logs CHECK keeps every live value and adds only reservation_extra_sale', () => {
  assert.match(MIG, /v_new := v_live \|\| ARRAY\['reservation_extra_sale'\];/);
  assert.match(MIG, /array_length\(v_live, 1\) < 10/, 'refuses to rebuild from an unreadable definition');
  assert.doesNotMatch(MIG, /v_new TEXT\[\] := ARRAY\[/, 'never a hard-coded list that could drop values');
  assert.match(MIG, /^BEGIN;/m); assert.match(MIG, /^COMMIT;/m);
});

test('rollback refuses while sales exist and only removes its own CHECK value when unused', () => {
  assert.match(RB, /EXTRA SALES ROLLBACK REFUSED/);
  assert.match(RB, /IF EXISTS \(SELECT 1 FROM public\.activity_logs WHERE entity_type = 'reservation_extra_sale'\)/);
  assert.match(RB, /WHERE x <> 'reservation_extra_sale'/);
  assert.match(RB, /DROP TABLE IF EXISTS public\.reservation_extra_sales;/);
});

const search = (() => {
  const SRC = fs.readFileSync(path.join(ROOT, 'DeseTourDashboard.jsx'), 'utf8');
  const a = SRC.indexOf('// TESTABLE:_searchReservationsForSale:start'), b = SRC.indexOf('// TESTABLE:_searchReservationsForSale:end');
  // eslint-disable-next-line no-new-func
  return new Function(SRC.slice(a, b) + '\nreturn _searchReservationsForSale;')();
})();
const R = [
  { id: '1', resNumber: 'R-2026-0001', externalBookingId: '41748096', name: 'Ana López', tour: 'Grand Bazaar Experience', checkIn: '2026-10-02', opStatus: 'Tamamlandı', statusRaw: 'completed' },
  { id: '2', resNumber: 'R-2026-0040', externalBookingId: 'A52000001', name: 'Íñigo Peña', tour: 'Topkapi Palace Complete Tour', checkIn: '2026-11-06', opStatus: 'Tamamlandı', statusRaw: 'completed' },
  { id: '3', resNumber: 'R-2026-0050', externalBookingId: 'A52000002', name: 'Maria Rossi', tour: 'Topkapi Palace Complete Tour', checkIn: '2026-12-13', opStatus: 'Onay Bekliyor', statusRaw: 'pending_confirmation' },
  { id: '4', resNumber: 'R-2026-0060', externalBookingId: 'A52000003', name: 'İptal Kişi', tour: 'Topkapi', checkIn: '2026-11-20', opStatus: 'İptal', statusRaw: 'cancelled' },
];

test('reservation search: Civitatis code (A…), reservation no, customer and tour — any date, newest first, cancelled excluded', () => {
  assert.deepEqual(search(R, 'A4174').map(r => r.id), ['1'], 'past (October) booking found by its A-code although only digits are stored');
  assert.deepEqual(search(R, '41748096').map(r => r.id), ['1'], 'bare digits also work');
  assert.deepEqual(search(R, 'a52').map(r => r.id), ['3', '2'], 'case-insensitive, newest tour date first, cancelled left out');
  assert.deepEqual(search(R, 'R-2026-0040').map(r => r.id), ['2']);
  assert.deepEqual(search(R, 'inigo pena').map(r => r.id), ['2'], 'accent-insensitive');
  assert.deepEqual(search(R, 'topkapi rossi').map(r => r.id), ['3'], 'every word must match');
  assert.deepEqual(search(R, 'a'), [], 'at least 2 characters');
  assert.equal(search(R.concat(Array.from({ length: 30 }, (_, i) => ({ ...R[0], id: 'x' + i }))), 'grand', 20).length, 20);
});
