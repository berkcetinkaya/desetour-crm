'use strict';
/**
 * tests/dashboard/calendarQuickView.test.js
 * Calendar Reservation Quick View: clicking a calendar reservation opens an
 * overlay on the SAME Calendar page (right drawer desktop / bottom sheet
 * mobile) built from the existing repositories and helpers — never a second
 * reservation data model, never a navigation away.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { extractTestableFn } = require('./extractTestableFn');

const SOURCE = fs.readFileSync(path.join(__dirname, '..', '..', 'DeseTourDashboard.jsx'), 'utf8');
const vmFn = extractTestableFn('_reservationQuickViewModel');

function body(name) {
  const idx = SOURCE.indexOf(`function ${name}(`);
  assert.ok(idx !== -1, `function ${name} not found`);
  return SOURCE.slice(idx, SOURCE.indexOf('\nfunction ', idx + 10));
}

function res(o) {
  return {
    id: 'R1', resNumber: 'RES-1', opStatus: 'Onaylandı', payStatus: 'Ödeme Bekliyor',
    tour: 'Topkapı', tourLanguage: 'İspanyolca', date: '12 Kas 2026', time: '09:30',
    pax: 8, paxChild: 2, name: 'Lucia', pickup: 'Hotel', pickupTime: '09:00',
    guide: '', guideId: null, assignedGuideName: '', opNotes: '', ...o,
  };
}

// ── View model ───────────────────────────────────────────────────────────

test('view model: reference, adult/child/total pax, language, time, pickup', () => {
  const vm = vmFn({ r: res(), customer: null, preparations: [], sourceName: 'Civitatis' });
  assert.equal(vm.ref, 'RES-1');
  assert.equal(vm.paxAdult, 8);
  assert.equal(vm.paxChild, 2);
  assert.equal(vm.paxTotal, 10);
  assert.equal(vm.tourLanguage, 'İspanyolca');
  assert.equal(vm.time, '09:30');
  assert.equal(vm.pickup, 'Hotel');
  assert.equal(vm.pickupTime, '09:00');
  assert.equal(vm.sourceLabel, 'Civitatis');
  assert.equal(vm.isCancelled, false);
});

test('view model: missing values stay honest (no invented time, language, pickup time)', () => {
  const vm = vmFn({ r: res({ time: null, tourLanguage: '', pickup: '', pickupTime: '—', paxChild: 0 }), customer: null, preparations: null });
  assert.equal(vm.time, null);
  assert.equal(vm.tourLanguage, null);
  assert.equal(vm.pickup, null);
  assert.equal(vm.pickupTime, null);
  assert.equal(vm.paxTotal, 8);
  assert.equal(vm.sourceLabel, null);
});

test('view model: cancelled reservation is flagged', () => {
  assert.equal(vmFn({ r: res({ opStatus: 'İptal' }) }).isCancelled, true);
});

test('view model: phone only when the customer read (under the viewer\'s RLS) returned one', () => {
  assert.equal(vmFn({ r: res(), customer: { phone: '+34 600' } }).phone, '+34 600');
  assert.equal(vmFn({ r: res(), customer: { phone: '' } }).phone, null);
  assert.equal(vmFn({ r: res(), customer: null }).phone, null);
});

test('view model: guide assignment state from guide_id or legacy guide name', () => {
  assert.equal(vmFn({ r: res() }).guideAssigned, false);
  const a = vmFn({ r: res({ guideId: 'G1', assignedGuideName: 'Ayşe' }) });
  assert.equal(a.guideAssigned, true);
  assert.equal(a.guideName, 'Ayşe');
  assert.equal(vmFn({ r: res({ guide: 'Mehmet' }) }).guideName, 'Mehmet');
});

test('view model: ticket state uses ACTIVE entrance_ticket preparations only', () => {
  const t = (status, type = 'entrance_ticket') => ({ id: Math.random(), preparationType: type, status, label: 'x' });
  assert.equal(vmFn({ r: res(), preparations: [] }).ticketState, 'none');
  assert.equal(vmFn({ r: res(), preparations: [t('pending'), t('completed')] }).ticketState, 'pending');
  assert.equal(vmFn({ r: res(), preparations: [t('completed')] }).ticketState, 'completed');
  assert.equal(vmFn({ r: res(), preparations: [t('superseded'), t('cancelled')] }).ticketState, 'none', 'history is not work');
  const vm = vmFn({ r: res(), preparations: [t('pending'), t('pending', 'meal'), t('cancelled', 'meal')] });
  assert.equal(vm.ticketPreparations.length, 1);
  assert.equal(vm.otherPreparations.length, 1);
  assert.equal(vm.pendingPrepCount, 2);
});

test('view model: notes are trimmed and empty notes hidden', () => {
  assert.equal(vmFn({ r: res({ opNotes: '  Wheelchair  ' }) }).notes, 'Wheelchair');
  assert.equal(vmFn({ r: res({ opNotes: '   ' }) }).notes, null);
  assert.equal(vmFn({ r: null }), null);
});

// ── Same data model as the detail page ──────────────────────────────────

test('Quick View reads the same repositories as ReservationDetailPage — no direct Supabase query, no new data model', () => {
  const b = body('ReservationQuickView');
  assert.match(b, /useRepo\("reservation", "getById", resId\)/);
  assert.match(b, /useRepo\("customer", "getById", r\?\.customerId \|\| null\)/);
  assert.match(b, /useRepo\("reservationPreparation", "getByReservation", resId\)/);
  assert.match(b, /useOperationalNotifications\(\)/);
  assert.doesNotMatch(b, /getSB\(\)|sb\.from\(|\.from\('reservations'\)/);
  // reuses existing helpers/labels
  for (const helper of ['_ResOperationalSummary', 'getMealStatusDisplay', '_preparationViewModel', '_canCompletePreparation', '_completePreparationWithFeedback', 'formatReservationTourLabel', 'RES_STATUS', '_reservationHasUnreadCivitatisMessage']) {
    assert.ok(b.includes(helper), `reuses ${helper}`);
  }
});

test('no finance calculation inside the Calendar or the Quick View', () => {
  const calendar = body('CalendarPage') + body('ReservationQuickView') + body('EventCard') + body('MonthlyView') + body('MobileCalendarPage');
  assert.doesNotMatch(calendar, /exchange_rates|summarizeMonthlyExpectedRevenue|guide_payments|\b150\b/);
});

// ── Dialog semantics + closing ───────────────────────────────────────────

test('ARIA dialog semantics, labelled title, close button, backdrop close and "Rezervasyonu Aç"', () => {
  const b = body('ReservationQuickView');
  assert.match(b, /role="dialog" aria-modal="true" aria-labelledby=\{titleId\}/);
  assert.match(b, /<h2 id=\{titleId\}/);
  assert.match(b, /className="qv-backdrop" aria-hidden="true" onClick=\{onClose\}/);
  assert.match(b, /aria-label="Kapat"/);
  assert.match(b, /Rezervasyonu Aç/);
  assert.match(b, /NAV_REF\.fn\('\/reservations\/' \+ resId\)/);
  assert.match(b, /_useDialogFocus\(panelRef, onClose\);/);
});

test('focus management: Escape closes, Tab is trapped, focus and scroll are restored', () => {
  const b = body('_useDialogFocus');
  assert.match(b, /e\.key === 'Escape'/);
  assert.match(b, /e\.key !== 'Tab'/);
  assert.match(b, /\.focus\(\{ preventScroll:true \}\)/);
  assert.match(b, /opener\.focus\(\{ preventScroll:true \}\)/);
  assert.match(b, /window\.scrollTo\(scrollX, scrollY\)/);
  assert.match(b, /document\.body\.style\.overflow = prevOverflow;/);
});

test('cancelled reservations are visually explicit (banner + struck-through title), no completion actions', () => {
  const b = body('ReservationQuickView');
  assert.match(b, /\{vm\.isCancelled && \(/);
  assert.match(b, /Bu rezervasyon iptal edildi\./);
  assert.match(b, /textDecoration: vm && vm\.isCancelled \? "line-through" : "none"/);
  assert.match(b, /const canComplete = !vm\.isCancelled && _canCompletePreparation\(auth\.role, p\);/);
});

test('desktop drawer vs mobile bottom sheet', () => {
  const b = body('ReservationQuickView');
  assert.match(b, /const panelStyle = isMobile \? \{\s*position:"absolute", left:0, right:0, bottom:0, maxHeight:"92vh"/);
  assert.match(b, /position:"absolute", top:0, right:0, bottom:0, width:"min\(460px, 100vw\)"/);
});

// ── Calendar wiring: same page, context preserved ───────────────────────

test('CalendarPage keeps the Quick View in its own state and provides open() to every event surface', () => {
  const b = body('CalendarPage');
  assert.match(b, /const \[quickViewResId, setQuickViewResId\] = useState\(null\);/);
  assert.match(b, /<CalendarQuickViewContext\.Provider value=\{openQuickView\}>/);
  assert.match(b, /\{quickViewResId && <ReservationQuickView resId=\{quickViewResId\} onClose=\{\(\)=>setQuickViewResId\(null\)\}\/>\}/);
  // view / offsets are untouched by opening or closing
  const open = b.slice(b.indexOf('const openQuickView'), b.indexOf('\n', b.indexOf('const openQuickView')));
  assert.doesNotMatch(open, /setView|setWeekOffset|setDayOffset|setMonthOffset/);
});

test('event cards, side lists and month chips open the Quick View (click + Enter/Space), month chip never switches to day view', () => {
  for (const fn of ['EventCard', 'CalSidebar', 'MonthlyView']) {
    const b = body(fn);
    assert.match(b, /useContext\(CalendarQuickViewContext\)/, fn);
    assert.match(b, /_quickViewTriggerProps\(openQuickView, ev\.id/, fn);
  }
  const trig = SOURCE.slice(SOURCE.indexOf('function _quickViewTriggerProps('), SOURCE.indexOf('function _QvRow('));
  assert.match(trig, /role: "button"/);
  assert.match(trig, /tabIndex: 0/);
  assert.match(trig, /"aria-haspopup": "dialog"/);
  assert.match(trig, /onClick: \(e\) => \{ e\.stopPropagation\(\); open\(id\); \}/, 'stops the month cell from switching to the daily view');
  assert.match(trig, /e\.key === "Enter" \|\| e\.key === " "/);
});

test('mobile calendar opens the bottom sheet on the same page instead of navigating away', () => {
  const b = body('MobileCalendarPage');
  assert.match(b, /const \[quickViewResId, setQuickViewResId\] = useState\(null\);/);
  assert.match(b, /if \(target\) setQuickViewResId\(target\);/);
  assert.doesNotMatch(b, /navigate\('\/reservations\/'\+target\)/);
  assert.match(b, /\{quickViewResId && <ReservationQuickView resId=\{quickViewResId\} onClose=\{\(\)=>setQuickViewResId\(null\)\}\/>\}/);
});

test('cancelled reservations are still excluded from calendar events at the single derivation point', () => {
  assert.match(body('useCalendarEvents'), /\.filter\(r => r\.opStatus !== "İptal"\)/);
});
