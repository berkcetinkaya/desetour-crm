'use strict';
/**
 * tests/dashboard/tourChannelBookingLanguage.test.js
 * ─────────────────────────────────────────────────────────────────────────
 * Regression coverage for the Tour Detail / New Tour "Satış Kanalları"
 * (TourChannelRows) UI addition: a per-channel "Rezervasyon Dili" field
 * that sets tour_channels.booking_language (see
 * supabase_migration_tour_channels_v2_booking_language.sql), so a
 * Civitatis mapping can be scoped to one booking language.
 *
 * DeseTourDashboard.jsx is a browser-only React script with no CommonJS
 * export (see extractTestableFn.js's own header for why) — these are
 * static source-region assertions, the same convention already used for
 * SidebarVersionInfo/GuidesPage/GuestDetailPage elsewhere in this suite,
 * not a rendered-DOM test.
 * ─────────────────────────────────────────────────────────────────────────
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const SOURCE_PATH = path.join(__dirname, '..', '..', 'DeseTourDashboard.jsx');
const SOURCE = fs.readFileSync(SOURCE_PATH, 'utf8');

function extractFunctionBody(name, nextMarker) {
  const idx = SOURCE.indexOf(`function ${name}(`);
  assert.ok(idx !== -1, `could not find function ${name}`);
  return SOURCE.slice(idx, SOURCE.indexOf(nextMarker, idx));
}

const TOUR_CHANNEL_ROWS_BODY = extractFunctionBody('TourChannelRows', '\nfunction TourFormFields');
const MAP_TOUR_CHANNEL_FROM_DB_BODY = extractFunctionBody('mapTourChannelFromDB', '\nfunction mapTourFromDB');
const SYNC_TOUR_CHANNELS_IDX = SOURCE.indexOf('async function _syncTourChannels(');
const SYNC_TOUR_CHANNELS_BODY = SOURCE.slice(SYNC_TOUR_CHANNELS_IDX, SOURCE.indexOf('\nconst _TOUR_SELECT', SYNC_TOUR_CHANNELS_IDX));

// ── The UI lets an operator set a per-channel booking language ─────────────

test('TourChannelRows renders a "Rezervasyon Dili" select for each channel row, using the CRM\'s existing controlled language list (never a free-text field)', () => {
  assert.match(TOUR_CHANNEL_ROWS_BODY, /Rezervasyon Dili/);
  assert.match(TOUR_CHANNEL_ROWS_BODY, /LANGUAGE_OPTIONS\.map\(l=>\[l,l\]\)/, 'must reuse the canonical LANGUAGE_OPTIONS dataset, not invent a second language list');
  assert.match(TOUR_CHANNEL_ROWS_BODY, /bookingLanguage/);
});

test('the empty/default option explicitly means "generic — applies to all languages", not an accidental omission', () => {
  assert.match(TOUR_CHANNEL_ROWS_BODY, /— Genel \(tüm diller\) —/);
});

test('the field\'s hint text makes clear it controls automatic external reservation mapping', () => {
  assert.match(TOUR_CHANNEL_ROWS_BODY, /otomatik.*eşleş/i);
});

test('a newly added channel row defaults bookingLanguage to empty (generic), not a guessed/preselected language', () => {
  assert.match(TOUR_CHANNEL_ROWS_BODY, /function addRow\(\) \{ setChannels\(prev => \[\.\.\.prev, \{[^}]*bookingLanguage:""[^}]*\}\]\); \}/);
});

// ── DB round-trip: mapTourChannelFromDB / _syncTourChannels ────────────────

test('mapTourChannelFromDB reads tour_channels.booking_language, defaulting a NULL (generic) row to an empty string, never fabricating a language', () => {
  assert.match(MAP_TOUR_CHANNEL_FROM_DB_BODY, /bookingLanguage:\s*c\.booking_language\s*\|\|\s*''/);
});

test('_syncTourChannels writes bookingLanguage back to tour_channels.booking_language, defaulting empty/unset to NULL (never an empty string) — the generic-mapping state', () => {
  assert.match(SYNC_TOUR_CHANNELS_BODY, /booking_language:\s*c\.bookingLanguage\s*\|\|\s*null/);
});

test('_syncTourChannels is still the single replace-all sync point for tour_channels — no second/duplicate write path was introduced', () => {
  const deleteMatches = SYNC_TOUR_CHANNELS_BODY.match(/sb\.from\('tour_channels'\)\.delete\(\)/g) || [];
  const insertMatches = SYNC_TOUR_CHANNELS_BODY.match(/sb\.from\('tour_channels'\)\.insert\(rows\)/g) || [];
  assert.equal(deleteMatches.length, 1);
  assert.equal(insertMatches.length, 1);
});

// ── No historical reservation is ever remapped automatically ───────────────

test('no application code bulk-updates reservations.tour_id — a tour association can only ever be set by creating a reservation (SupabaseReservationRepo.create) or explicit user edit, never by a mapping/config change', () => {
  const bulkTourIdUpdate = /\.update\(\s*\{[^}]*tour_id/;
  assert.doesNotMatch(SOURCE, bulkTourIdUpdate, 'found a reservations.tour_id UPDATE outside the one deliberate per-row create/edit path');
});

test('this migration/feature touches no reservation data: DeseTourDashboard.jsx has no reference to the two already-corrected real booking IDs', () => {
  // The two Civitatis bookings the task states were ALREADY manually
  // corrected in Supabase (A41629692, A41534177) must never be
  // hardcoded/re-touched anywhere in application code.
  assert.doesNotMatch(SOURCE, /41629692/);
  assert.doesNotMatch(SOURCE, /41534177/);
});

// ── No hardcoded tour/product names or IDs in the mapping architecture ─────

test('the language-aware mapping is a reusable platform architecture, never hardcoded to "Grand Bazaar" or a specific tour/product', () => {
  assert.doesNotMatch(TOUR_CHANNEL_ROWS_BODY, /Grand Bazaar/i);
  assert.doesNotMatch(MAP_TOUR_CHANNEL_FROM_DB_BODY, /Grand Bazaar/i);
  assert.doesNotMatch(SYNC_TOUR_CHANNELS_BODY, /Grand Bazaar/i);
});
