'use strict';
/**
 * tests/dashboard/reservationTourLabel.test.js
 * ─────────────────────────────────────────────────────────────────────────
 * Regression coverage for the "Grand Bazaar Experience · İtalyanca"
 * presentation-only tour label: formatReservationTourLabel(tourName,
 * tourLanguage), applied wherever a reservation's tour name is shown
 * (Reservations list, Reservation Detail, Calendar cards/events) but
 * deliberately NOT on Tour management pages, which represent the tour
 * entity itself. See DeseTourDashboard.jsx's TESTABLE:formatReservationTourLabel
 * block for the full rationale.
 * ─────────────────────────────────────────────────────────────────────────
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { extractTestableFn } = require('./extractTestableFn');
const formatReservationTourLabel = extractTestableFn('formatReservationTourLabel');

const SOURCE_PATH = path.join(__dirname, '..', '..', 'DeseTourDashboard.jsx');
const SOURCE = fs.readFileSync(SOURCE_PATH, 'utf8');

// ── Pure function behavior ──────────────────────────────────────────────

test('Italian reservation: tour name gets "· İtalyanca" appended with a centered-dot separator', () => {
  assert.equal(
    formatReservationTourLabel('Grand Bazaar Experience', 'İtalyanca'),
    'Grand Bazaar Experience · İtalyanca'
  );
});

test('Spanish reservation: tour name gets "· İspanyolca" appended', () => {
  assert.equal(
    formatReservationTourLabel('Grand Bazaar Experience', 'İspanyolca'),
    'Grand Bazaar Experience · İspanyolca'
  );
});

test('reservation without tour_language: shows the plain tour name, no trailing separator, never "· null" or "· undefined"', () => {
  assert.equal(formatReservationTourLabel('Grand Bazaar Experience', null), 'Grand Bazaar Experience');
  assert.equal(formatReservationTourLabel('Grand Bazaar Experience', undefined), 'Grand Bazaar Experience');
  assert.equal(formatReservationTourLabel('Grand Bazaar Experience', ''), 'Grand Bazaar Experience');
});

test('no duplicate language rendering: a tour name that already spells out the language is not suffixed a second time', () => {
  assert.equal(
    formatReservationTourLabel('Grand Bazaar Experience (İtalyanca)', 'İtalyanca'),
    'Grand Bazaar Experience (İtalyanca)'
  );
  // Case-insensitive: still counts as already present.
  assert.equal(
    formatReservationTourLabel('grand bazaar experience İTALYANCA tour', 'İtalyanca'),
    'grand bazaar experience İTALYANCA tour'
  );
});

test('other canonical languages (İngilizce, Portekizce, Fransızca) are appended the same way — reuses the existing language vocabulary, not a new one', () => {
  assert.equal(formatReservationTourLabel('City Tour', 'İngilizce'), 'City Tour · İngilizce');
  assert.equal(formatReservationTourLabel('City Tour', 'Portekizce'), 'City Tour · Portekizce');
  assert.equal(formatReservationTourLabel('City Tour', 'Fransızca'), 'City Tour · Fransızca');
});

test('a missing/empty tour name never crashes and never produces "undefined"/"null" text', () => {
  assert.equal(formatReservationTourLabel(null, 'İtalyanca'), ' · İtalyanca');
  assert.equal(formatReservationTourLabel('', null), '');
  assert.doesNotMatch(formatReservationTourLabel(null, 'İtalyanca'), /undefined|null/);
});

test('the helper never mutates its inputs (pure function)', () => {
  const name = 'Grand Bazaar Experience';
  const lang = 'İtalyanca';
  formatReservationTourLabel(name, lang);
  assert.equal(name, 'Grand Bazaar Experience');
  assert.equal(lang, 'İtalyanca');
});

// ── actual tours.name data is never mutated ─────────────────────────────

test('formatReservationTourLabel never writes to any repo/Supabase table — it has no side effects, purely a display transform', () => {
  const idx = SOURCE.indexOf('// TESTABLE:formatReservationTourLabel:start');
  const end = SOURCE.indexOf('// TESTABLE:formatReservationTourLabel:end');
  const body = SOURCE.slice(idx, end);
  assert.doesNotMatch(body, /\.update\(|\.insert\(|\.delete\(|mutate\(/);
});

test('mapTourFromDB / mapTourToDB (the Tour entity\'s own read/write mapping) never call formatReservationTourLabel — the tours table and its name are untouched by this feature', () => {
  const mapTourFromDBIdx = SOURCE.indexOf('function mapTourFromDB(');
  const mapTourFromDBBody = SOURCE.slice(mapTourFromDBIdx, SOURCE.indexOf('\nfunction mapTourToDB', mapTourFromDBIdx));
  assert.doesNotMatch(mapTourFromDBBody, /formatReservationTourLabel/);

  const mapTourToDBIdx = SOURCE.indexOf('function mapTourToDB(');
  const mapTourToDBBody = SOURCE.slice(mapTourToDBIdx, SOURCE.indexOf('\n// Replace-all sync of a tour\'s tour_languages', mapTourToDBIdx));
  assert.doesNotMatch(mapTourToDBBody, /formatReservationTourLabel/);
});

test('Tour management pages (TourDetailPage, NewTourModal, TourFormFields) never call formatReservationTourLabel — they represent the tour entity itself and must keep showing the actual tour name', () => {
  for (const fnName of ['TourDetailPage', 'NewTourModal', 'TourFormFields']) {
    const idx = SOURCE.indexOf(`function ${fnName}(`);
    assert.ok(idx !== -1, `could not find function ${fnName}`);
    // Bound the search to a generous window rather than another exact
    // "next function" marker, since these components vary in length;
    // large enough to cover each one fully without spilling far past it.
    const body = SOURCE.slice(idx, idx + 20000);
    assert.doesNotMatch(body, /formatReservationTourLabel/, `${fnName} must not apply the reservation-language label to a tour's own name`);
  }
});

// ── Wiring: the label is actually applied at each named location ───────

function extractFunctionBody(name, nextMarker) {
  const idx = SOURCE.indexOf(`function ${name}(`);
  assert.ok(idx !== -1, `could not find function ${name}`);
  return SOURCE.slice(idx, SOURCE.indexOf(nextMarker, idx));
}

test('Reservations list (ReservationsPage): both the desktop table row and the mobile card apply the label', () => {
  const body = extractFunctionBody('ReservationsPage', '\nfunction ReservationDetailPage');
  const calls = body.match(/formatReservationTourLabel\(/g) || [];
  assert.equal(calls.length, 2, `expected exactly 2 call sites (table row + mobile card), found ${calls.length}`);
});

test('Reservation Detail (ReservationDetailPage): both the header breadcrumb and the "Tur Bilgileri" card apply the label', () => {
  const body = extractFunctionBody('ReservationDetailPage', '\nfunction ');
  const calls = body.match(/formatReservationTourLabel\(/g) || [];
  assert.ok(calls.length >= 2, `expected at least 2 call sites, found ${calls.length}`);
});

test('Reservation Detail: the "Tur Bilgileri" section header still shows the tour name (now via the shared label helper), and the separate "Tur Dili" row is untouched (no duplicate language display)', () => {
  const body = extractFunctionBody('ReservationDetailPage', '\nfunction ');
  assert.match(body, /Tur Bilgileri/);
  assert.match(body, /formatReservationTourLabel\(r\.tour, r\.tourLanguage\)/);
  // The existing standalone "Tur Dili" field (with its own edit button)
  // must still read tourLanguage directly, unwrapped — it IS the language
  // display, not a second copy of the tour-name label.
  assert.match(body, /Tur Dili/);
  assert.match(body, /r\.tourLanguage \|\| "Belirtilmemiş"/);
});

test('Calendar: useCalendarEvents carries tourLanguage alongside tour (kept separate so existing truncation logic still measures the plain name)', () => {
  const idx = SOURCE.indexOf('function useCalendarEvents()');
  const body = SOURCE.slice(idx, SOURCE.indexOf('\nfunction ', idx + 10));
  assert.match(body, /tourLanguage:\s*r\.tourLanguage \|\| null/);
});

test('Calendar: EventCard applies the label in both its compact and full layouts', () => {
  const body = extractFunctionBody('EventCard', '\nfunction CalSidebar');
  const calls = body.match(/formatReservationTourLabel\(/g) || [];
  assert.equal(calls.length, 2);
});

test('Calendar: CalSidebar\'s "what needs attention" list applies the label before its own length-based truncation', () => {
  const body = extractFunctionBody('CalSidebar', '\nfunction ');
  assert.match(body, /formatReservationTourLabel\(ev\.tour, ev\.tourLanguage\)/);
});

test('Mobile Calendar agenda card applies the label', () => {
  const body = extractFunctionBody('MobileAgendaCard', '\nfunction ');
  assert.match(body, /formatReservationTourLabel\(ev\.tour, ev\.tourLanguage\)/);
});

// ── No historical/production data touched ───────────────────────────────

test('this is presentation-only: no reservation, tour, or tour_channels write was introduced anywhere near these render sites', () => {
  const reservationsPageBody = extractFunctionBody('ReservationsPage', '\nfunction NewReservationModal');
  assert.doesNotMatch(reservationsPageBody, /\.update\(\s*\{[^}]*tour/i);
});
