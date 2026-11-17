'use strict';
/**
 * tests/dashboard/mobileOperations.test.js — the phone CRM must let the
 * owner DO the daily work, not only read it: assign a guide (with the fee),
 * message the guide, edit pickup, change status, see passengers, Civitatis
 * changes, the tour page and the WhatsApp card; find a booking fast; see
 * live signals and the month in money on the home screen; read Finance
 * without a sideways-scrolling table.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { extractTestableFn } = require('./extractTestableFn');

const SRC = fs.readFileSync(path.join(__dirname, '..', '..', 'DeseTourDashboard.jsx'), 'utf8');
const slice = (from, to) => SRC.slice(SRC.indexOf(from), SRC.indexOf(to, SRC.indexOf(from)));
const DETAIL = slice('function MobileReservationDetailPage', 'MOBILE MESSAGES');
const LIST = slice('function MobileReservationsPage', 'MOBILE GUESTS');
const HOME = slice('function MobileHomePage', 'function MobileReservationsPage');

test('phone reservation page: the same modals as desktop are reachable (guide + fee, guide WhatsApp, pickup, payment, reminder)', () => {
  for (const m of ['<AssignGuideModal r={r}', '<PickupEditModal res={r}', '<GuideWhatsAppModal res={r}', '<NewPaymentModal resId={r.id}', '<NewReminderModal resId={r.id}']) assert.ok(DETAIL.includes(m), m);
  assert.match(DETAIL, /const mobCanAct = !!mobAuth\.role && mobAuth\.role !== "Rehber";/, 'guides get no action buttons');
  assert.match(DETAIL, /const mobCanWa = \["Yönetici", "Operasyon"\]\.includes\(mobAuth\.role\);/);
  assert.match(DETAIL, /canAccess\(mobAuth\.role, "payments"\) \? \["Ödeme Kaydı Ekle"\]/);
});

test('phone reservation page: status is changed through the shared reservation mutation; cancelling is not offered', () => {
  assert.match(DETAIL, /mutResMobile\("update", r\.id, \{ opStatus: next \}\)/);
  assert.match(SRC, /const _MOB_RES_STATUSES = \["Hazırlanıyor", "Onaylandı", "Tur Günü", "Tamamlandı"\];/);
  assert.match(DETAIL, /window\.confirm\("Tur tamamlandı olarak işaretlensin mi\?"\)/);
});

test('phone reservation page shows passengers, Civitatis changes, the tour page and the WhatsApp card', () => {
  for (const m of ['useRepo("reservation", "getGuests", resId)', '<_ResCivitatisChanges activity={mobResActivity} r={r}/>', '<_ResTourPageLink r={r}/>', '<_ResWhatsAppCard r={r} customer={cust}/>', 'href={`tel:${r.guidePhone}`}']) assert.ok(DETAIL.includes(m), m);
  assert.match(SRC, /guidePhone:r\.guide\?\.phone\|\|''/);
});

test('phone reservation list: search (guest, R-no, Civitatis code with/without A, tour, guide) and day headings', () => {
  const blockStart = SRC.indexOf('// TESTABLE:_mobileResListHelpers:start'), blockEnd = SRC.indexOf('// TESTABLE:_mobileResListHelpers:end');
  // eslint-disable-next-line no-new-func
  const H = new Function(SRC.slice(blockStart, blockEnd) + '\nreturn { _mobileResMatches, _mobileResDayLabel, _mobileResGroupByDay };')();
  const r = { name: 'María Gómez', resNumber: 'R-2026-0058', externalBookingId: '42711975', tour: 'Topkapı Sarayı', guide: 'Ayşe Yılmaz', tourLanguage: 'İspanyolca' };
  for (const q of ['maría', 'r-2026-0058', '42711975', 'A42711975', 'topkapı ayşe', 'İSPANYOLCA', '']) assert.equal(H._mobileResMatches(r, q), true, q);
  assert.equal(H._mobileResMatches(r, 'bosforo'), false);
  assert.match(H._mobileResDayLabel('2026-11-17', '2026-11-17'), /^Bugün · 17 Kasım Salı$/);
  assert.match(H._mobileResDayLabel('2026-11-18', '2026-11-17'), /^Yarın · /);
  assert.match(H._mobileResDayLabel('2027-01-02', '2026-11-17'), /2027/);
  const g = H._mobileResGroupByDay([{ checkIn: '2026-11-17', pax: 2 }, { checkIn: '2026-11-17', pax: 3, paxChild: 1 }, { checkIn: '2026-11-19', pax: 2 }], '2026-11-17');
  assert.deepEqual(g.map(x => [x.key, x.items.length, x.pax]), [['2026-11-17', 2, 6], ['2026-11-19', 1, 2]]);
  assert.match(LIST, /\.filter\(r => _mobileResMatches\(r, query\)\)/);
  assert.match(LIST, /_mobileResGroupByDay\(filtered, _TODAY_ISO\)/);
  assert.match(LIST, /fontSize:16/, '16px input: iOS does not zoom the page on focus');
});

test('phone home: unread live signals only when present; the month in money for finance roles from the shared hooks', () => {
  assert.match(HOME, /<LiveSignalsPanel onlyLive\/>/);
  assert.match(SRC, /if \(onlyLive && \(loading \|\| defs\.length === 0\)\) return null;/);
  assert.match(HOME, /canAccess\(auth\.role, "finance"\) && <_MobileMonthMoney navigate=\{navigate\}\/>/);
  const money = slice('function _MobileMonthMoney', 'function MobileHomePage');
  assert.match(money, /useMonthlyRevenueSummary\(monthISO\)/);
  assert.match(money, /useHomeProjectedProfit\(monthISO\)/);
  assert.doesNotMatch(money, /_financeToTry|buildFinanceMonthSummary|\* *55|rate \*/, 'no money math on the phone card');
});

test('Finance overview on a phone: one card per operation instead of the 8-column table', () => {
  const o = slice('function _FinOverview', 'function _FinTourTable');
  assert.match(o, /const \{ isMobile \} = useBreakpoint\(\);/);
  assert.match(o, /\{isMobile \? \(\s*<div data-testid="finance-cash-week-cards"/);
  assert.match(o, /<table data-testid="finance-cash-week"/, 'desktop table kept');
});
