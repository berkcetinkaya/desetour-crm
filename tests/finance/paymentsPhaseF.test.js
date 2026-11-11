'use strict';
/**
 * tests/finance/paymentsPhaseF.test.js — Finance Center Phase F.
 * Payments moved under Finans → Tahsilatlar (/payments stays an alias) and
 * regression tests for the four pre-existing payment bugs fixed with it.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { extractTestableFn } = require('../dashboard/extractTestableFn');

const ROOT = path.join(__dirname, '..', '..');
const SOURCE = fs.readFileSync(path.join(ROOT, 'DeseTourDashboard.jsx'), 'utf8');
const SCHEMA = fs.readFileSync(path.join(ROOT, 'supabase_schema.sql'), 'utf8');
function body(name) {
  const idx = SOURCE.indexOf(`function ${name}(`);
  assert.ok(idx !== -1, `function ${name} not found`);
  return SOURCE.slice(idx, SOURCE.indexOf('\nfunction ', idx + 10));
}
function extractCombined(names) {
  const bodies = names.map(n => SOURCE.slice(SOURCE.indexOf(`// TESTABLE:${n}:start`) + `// TESTABLE:${n}:start`.length, SOURCE.indexOf(`// TESTABLE:${n}:end`)));
  // eslint-disable-next-line no-new-func
  return new Function(`${bodies.join('\n')}\nreturn { _directPaymentState, _summarizeDirectPayments, _directPaymentRowView };`)();
}

// ── Bug: "Ek Ödeme" violated payments.payment_type CHECK ──────────────────
const toDB = extractTestableFn('_paymentTypeToDB');
const CHECK_VALUES = (SCHEMA.match(/CHECK \(payment_type IN \(([^)]+)\)\)/) || [])[1];

test('every UI payment type maps to a value allowed by the payments.payment_type CHECK — "Ek Ödeme" → extra', () => {
  assert.ok(CHECK_VALUES, 'payment_type CHECK found in supabase_schema.sql');
  const allowed = CHECK_VALUES.split(',').map(x => x.trim().replace(/'/g, ''));
  for (const label of ['Kapora', 'Kalan Ödeme', 'Tam Ödeme', 'İade', 'Ek Ödeme']) {
    assert.ok(allowed.includes(toDB(label)), `${label} → ${toDB(label)}`);
  }
  assert.equal(toDB('Ek Ödeme'), 'extra');
  assert.equal(toDB('extra'), 'extra');
  assert.throws(() => toDB('ek ödeme bonus'), /Geçersiz ödeme türü/);
});

test('payment create uses _paymentTypeToDB and records "Ek Ödeme" as paid', () => {
  const repo = SOURCE.slice(SOURCE.indexOf('const SupabasePaymentRepo = {'), SOURCE.indexOf('\n};', SOURCE.indexOf('const SupabasePaymentRepo = {')));
  assert.match(repo, /payment_type:_paymentTypeToDB\(d\.paymentType\|\|'Kapora'\),/);
  assert.match(repo, /'Ek Ödeme':'paid'/);
  assert.doesNotMatch(repo, /d\.paymentType\?\.toLowerCase\(\)/);
});

// ── Bug: Reports counted cancelled payments as collected ──────────────────
const bucket = extractTestableFn('_reportPaymentBucket');

test('Reports payment bucket: cancelled is never "collected"', () => {
  assert.equal(bucket({ status: 'cancelled' }), 'cancelled');
  assert.equal(bucket({ status: 'Ödendi', statusRaw: 'cancelled' }), 'cancelled');
  assert.equal(bucket({ status: 'Ödendi', statusRaw: 'paid' }), 'collected');
  assert.equal(bucket({ status: 'Kapora Ödendi' }), 'collected');
  assert.equal(bucket({ status: 'Bekliyor' }), 'pending');
  assert.equal(bucket({ status: 'Gecikmiş', statusRaw: 'overdue' }), 'pending');
  assert.equal(bucket({ status: 'İade Edildi', statusRaw: 'refunded' }), 'refunded');
  assert.equal(bucket({ status: 'Kısmi Ödendi' }), 'partial');
});

test('calculateReportMetrics skips cancelled payments before any bucket', () => {
  const crm = SOURCE.slice(SOURCE.indexOf('function calculateReportMetrics('), SOURCE.indexOf('\nconst EMPTY_REPORT_METRICS'));
  assert.match(crm, /if \(bucket === 'cancelled'\) return; \/\/ a cancelled payment is not money in any bucket/);
});

// ── Bug: Direct Payments KPIs were blank with real data ──────────────────
const D = extractCombined(['_summarizeDirectPayments']);
const real = (o) => ({ _fromDB: true, id: Math.random(), amount: 100, currency: 'EUR', status: 'Ödendi', statusRaw: 'paid', paymentTypeRaw: 'deposit', paymentType: 'Kapora', customerName: 'Lucia', resRef: 'RES-1', resTour: 'Topkapı', paidAt: '2026-11-03T10:00:00Z', ...o });

test('Direct Payments KPIs come from real payment rows, per currency; refunds subtract; cancelled is never money', () => {
  const s = D._summarizeDirectPayments([
    real({}), real({ amount: 2000, currency: 'TRY', paidAt: '2026-10-20T10:00:00Z' }),
    real({ statusRaw: 'pending', status: 'Bekliyor', paidAt: null }), real({ statusRaw: 'overdue', status: 'Gecikmiş', amount: 50, paidAt: null }),
    real({ paymentTypeRaw: 'refund', paymentType: 'İade', statusRaw: 'refunded', status: 'İade Edildi', amount: 30 }),
    real({ statusRaw: 'cancelled', status: 'cancelled', amount: 999 }),
  ], '2026-11');
  assert.deepEqual(s.collected, { EUR: 70, TRY: 2000 });
  assert.deepEqual(s.pending, { EUR: 150 });
  assert.deepEqual(s.refunded, { EUR: 30 });
  assert.deepEqual(s.thisMonth, { EUR: 70 }, 'only paid_at in the selected month, minus refunds in it');
  assert.deepEqual(s.counts, { all: 6, paid: 2, pending: 2, refund: 1, cancelled: 1 });
});

test('legacy demo rows (Tamamlandı / Kısmi Ödendi labels, no statusRaw) are still understood', () => {
  assert.equal(D._directPaymentState({ status: 'Tamamlandı' }), 'paid');
  assert.equal(D._directPaymentState({ status: 'Kısmi Ödendi' }), 'paid');
  assert.equal(D._directPaymentState({ status: 'İade Edildi' }), 'refund');
  assert.equal(D._directPaymentState({ status: 'Bekliyor' }), 'pending');
});

test('real rows render with guest, tour and per-payment amounts instead of blanks', () => {
  const v = D._directPaymentRowView(real({ statusRaw: 'pending', status: 'Bekliyor', amount: 80 }));
  assert.equal(v.guest, 'Lucia');
  assert.equal(v.tour, 'Topkapı');
  assert.equal(v.total, 80);
  assert.equal(v.remaining, 80);
  assert.equal(v.paid, 0);
  const demo = { id: 'x', guest: 'Demo', total: 500 };
  assert.equal(D._directPaymentRowView(demo), demo, 'demo rows untouched');
});

test('Direct Payments view: KPIs + tabs from the helpers; search never crashes on missing fields', () => {
  const v = body('_DogrudanOdemelerView');
  assert.match(v, /const sum = _summarizeDirectPayments\(_rawPays, _istanbulISODate\(\)\.slice\(0, 7\)\);/);
  assert.match(v, /const _allPays = _rawPays\.map\(_directPaymentRowView\);/);
  assert.match(v, /\[p\.guest, p\.customerName, p\.resRef, p\.resId, p\.tour, p\.payNumber\]\.filter\(Boolean\)/);
  assert.doesNotMatch(v, /p\.guest\.toLowerCase\(\)|p\.tour\.toLowerCase\(\)/);
  for (const l of ['label:"Tahsil Edilen"', 'label:"Bekleyen Ödemeler"', 'label:"İade Edilen"', 'label:"Bu Ayki Tahsilat"']) assert.ok(v.includes(l), l);
  assert.doesNotMatch(v, /Beklenen Toplam Gelir|totalExp|eurPayments/, 'no EUR-only or reservation-shaped totals');
  assert.match(v, /useRepo\("payment", "getAll"\)/, 'still reads public.payments through the payment repo');
});

// ── Bug: desktop nav exposed pages to roles that cannot open them ─────────
test('desktop sidebar filters every nav group by canAccess (no unfiltered NAV_* map)', () => {
  for (const g of ['NAV_TOP', 'NAV_BOT', 'NAV_SETTINGS']) {
    assert.match(SOURCE, new RegExp(`\\{${g}\\.filter\\(it => canAccess\\(auth\\.role, it\\.id\\)\\)\\.map\\(`), g);
    assert.doesNotMatch(SOURCE, new RegExp(`\\{${g}\\.map\\(it=><NavItem`), `${g} rendered unfiltered`);
  }
});

test('with the real permissions, Satış and Rehber see no Finans entry and Operasyon does', () => {
  const permStart = SOURCE.indexOf('const ROLE_PERMISSIONS');
  const perms = new Function(`${SOURCE.slice(permStart, SOURCE.indexOf('\n};', permStart) + 3)}\n${SOURCE.slice(SOURCE.indexOf('function canAccess('), SOURCE.indexOf('\n}', SOURCE.indexOf('function canAccess(')) + 2)}\nreturn canAccess;`)();
  const navBot = SOURCE.slice(SOURCE.indexOf('const NAV_BOT = ['), SOURCE.indexOf('];', SOURCE.indexOf('const NAV_BOT = [')));
  const ids = [...navBot.matchAll(/id:"([a-z]+)"/g)].map(m => m[1]);
  assert.ok(ids.includes('finance') && !ids.includes('payments'), 'Finans replaces Ödemeler in the nav');
  const visible = (role) => ids.filter(id => perms(role, id));
  assert.ok(!visible('Satış').includes('finance'));
  assert.ok(!visible('Rehber').includes('finance'));
  assert.ok(visible('Operasyon').includes('finance'));
  assert.ok(visible('Yönetici').includes('finance'));
});

// ── Move + backward compatibility ───────────────────────────────────────
test('legacy /payments deep links replace history and land on Finans → Tahsilatlar', () => {
  assert.match(body('_LegacyRedirect'), /window\.location\.replace\(window\.location\.pathname \+ window\.location\.search \+ '#' \+ to\)/);
  assert.match(SOURCE, /payment:\s+'\/finance\/tahsilatlar',/);
  assert.doesNotMatch(SOURCE, /NAV_REF\.fn\('\/payments'\)|navigate\("\/payments"\)/);
});

test('the payments table and the Payments components are kept (moved, not deleted)', () => {
  for (const c of ['PaymentsPage', 'MobilePaymentsPage', '_CivitatisHakedisleriView', '_DogrudanOdemelerView', '_MobileDogrudanOdemelerView']) {
    assert.ok(SOURCE.includes(`function ${c}(`), c);
  }
  const migrations = fs.readdirSync(ROOT).filter(f => /^supabase_migration_finance.*\.sql$/.test(f)).map(f => fs.readFileSync(path.join(ROOT, f), 'utf8')).join('\n');
  assert.doesNotMatch(migrations, /DROP TABLE[^;]*\bpayments\b|ALTER TABLE public\.payments/);
});

test('payment rows show the reservation number (resRef), not the internal id', () => {
  assert.match(body('PaymentRow'), /\{p\.resRef \|\| p\.resId\}/);
  assert.match(body('PaySidebar'), /\{p\.resRef \|\| p\.resId\} · \{p\.dueDate\}/);
});
