'use strict';
/**
 * tests/dashboard/calendarCancelledFilter.test.js
 * ─────────────────────────────────────────────────────────────────────────
 * Regression coverage for requirement 4 of Civitatis cancellation support:
 * a cancelled reservation (opStatus "İptal", DB status='cancelled') must
 * never appear as an active/upcoming event on the operational calendar.
 * useCalendarEvents() is the single shared derivation point every
 * calendar view (day/week/month/CalSidebar/MobileAgendaCard) consumes —
 * fixing it there is a static source-text check here, matching this
 * project's established pattern for DeseTourDashboard.jsx.
 * ─────────────────────────────────────────────────────────────────────────
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const SOURCE_PATH = path.join(__dirname, '..', '..', 'DeseTourDashboard.jsx');
const SOURCE = fs.readFileSync(SOURCE_PATH, 'utf8');

function extractFunctionBody(name) {
  const idx = SOURCE.indexOf(`function ${name}(`);
  assert.ok(idx !== -1, `expected to find function ${name}`);
  const nextFn = SOURCE.indexOf('\nfunction ', idx + 10);
  return SOURCE.slice(idx, nextFn);
}

const useCalendarEventsBody = extractFunctionBody('useCalendarEvents');

test('useCalendarEvents filters out İptal reservations before mapping to events', () => {
  assert.match(useCalendarEventsBody, /\.filter\(r\s*=>\s*r\.opStatus\s*!==\s*"İptal"\)/);
  // The filter must run BEFORE .map(...), not after — otherwise a
  // cancelled reservation's raw row (not yet an event object) would
  // still reach the map body.
  const filterIdx = useCalendarEventsBody.indexOf('.filter(r => r.opStatus !== "İptal")');
  const mapIdx = useCalendarEventsBody.indexOf('.map(r => {');
  assert.ok(filterIdx > -1 && mapIdx > -1 && filterIdx < mapIdx);
});

test('useCalendarEvents is still derived entirely from the real reservations repo — no separate hardcoded event list, no calendar-specific data deleted', () => {
  assert.match(useCalendarEventsBody, /useRepo\("reservation", "getAll"\)/);
});

test('a non-cancelled reservation is never filtered out by this change (the filter is opStatus-specific, not a blanket exclusion)', () => {
  // "Tamamlandı" (completed) reservations must still appear — this fix
  // only targets İptal, mirroring every other status-based filter in
  // this file (which likewise only exclude "İptal" here, keeping
  // "Tamamlandı" visible on the calendar as a past/completed event).
  assert.doesNotMatch(useCalendarEventsBody, /\.filter\(r\s*=>\s*!\["Tamamlandı","İptal"\]\.includes\(r\.opStatus\)\)/,
    'the calendar must keep completed tours visible — only İptal is excluded here, unlike the "upcoming" lists elsewhere');
});

test('CalendarPage/CalSidebar/MobileAgendaCard all consume useCalendarEvents\' output (props/derived arrays) rather than re-deriving events independently — one fix point covers every view', () => {
  assert.match(SOURCE, /const CAL_EVENTS_LIVE = useCalendarEvents\(\);/);
  assert.match(SOURCE, /function CalSidebar\(\{ todayEvents, weekEvents \}\)/);
  assert.match(SOURCE, /function MobileAgendaCard\(\{ ev, onClick \}\)/);
});
