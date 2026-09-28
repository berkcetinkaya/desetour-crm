'use strict';
/**
 * tests/civitatis/portugueseOptionalHour.test.js
 * ─────────────────────────────────────────────────────────────────────────
 * Regression coverage for the production incident on booking A41596990
 * ("Bosforo y Barrio Sultanahmet", Português): this real Civitatis email
 * exposed FOUR simultaneous parser gaps, all fixed together —
 *   1. "Português"/"Portugues" had no entry in languageMap.js.
 *   2. HOUR was treated as always-required; this product's email never
 *      states one at all (a legitimate absence, not a parse failure).
 *   3. parseMoneyLine only recognized a trailing currency CODE
 *      ("4,800 TL"), not a leading currency SYMBOL ("€ 205.40").
 *   4. extractPassengers only recognized "Full name" as a passenger
 *      sub-label; this email uses separate "Name" / "Last Name"
 *      sub-labels, and the earlier code silently pushed the literal
 *      label text "Name" itself as the passenger's fullName.
 *
 * Also covers the companion UI fix: mapResFromDB no longer fabricates
 * "09:00" for a reservation whose check_in_time is genuinely NULL, and
 * every render site that used to show that fabricated time now shows an
 * honest "Saat belirtilmedi" placeholder (or, on the calendar, an
 * explicit "unknown time" label instead of a real clock reading) rather
 * than either inventing a time or silently dropping the reservation.
 * ─────────────────────────────────────────────────────────────────────────
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { parseCivitatisEmail, parseMoneyLine } = require('../../api/_civitatis/parser');
const { mapCivitatisLanguage } = require('../../api/_civitatis/languageMap');
const F = require('./fixtures');

const SOURCE_PATH = path.join(__dirname, '..', '..', 'DeseTourDashboard.jsx');
const SOURCE = fs.readFileSync(SOURCE_PATH, 'utf8');

// ── 1. A41596990: the real booking now parses to the expected shape ────

const parsed = parseCivitatisEmail(F.portugueseA41596990Booking);

test('A41596990: parses ok:true (previously needs_review on 4 simultaneous grounds)', () => {
  assert.equal(parsed.ok, true, `expected ok:true, got reasons: ${JSON.stringify(parsed.reasons)}`);
  assert.equal(parsed.status, 'parsed');
  assert.deepEqual(parsed.reasons, []);
});

test('A41596990: external booking id 41596990, internal code "Bosforo y Barrio Sultanahmet"', () => {
  assert.equal(parsed.externalBookingId, '41596990');
  assert.equal(parsed.internalCode, 'Bosforo y Barrio Sultanahmet');
});

test('A41596990: language Português normalizes to canonical Portekizce', () => {
  assert.equal(parsed.languageRaw, 'Português');
  assert.equal(parsed.tourLanguage, 'Portekizce');
  assert.equal(parsed.languageCode, 'pt');
});

test('A41596990: date parses as 2026-10-26', () => {
  assert.equal(parsed.date, '2026-10-26');
});

test('A41596990: time is NULL (no fabricated 09:00), timeStatus is "absent"', () => {
  assert.equal(parsed.time, null);
  assert.equal(parsed.timeStatus, 'absent');
});

test('A41596990: passengers are CARLOS ROBERTO LARRUBIA and AMANDA OLIVEIRA — never the literal label "Name"', () => {
  assert.deepEqual(parsed.passengers, [
    { fullName: 'CARLOS ROBERTO LARRUBIA', sortOrder: 0 },
    { fullName: 'AMANDA OLIVEIRA', sortOrder: 1 },
  ]);
});

test('A41596990: retail 205.40 EUR, net 154.05 EUR (€ symbol-prefixed prices)', () => {
  assert.equal(parsed.retailAmount, 205.40);
  assert.equal(parsed.retailCurrency, 'EUR');
  assert.equal(parsed.netAmount, 154.05);
  assert.equal(parsed.netCurrency, 'EUR');
});

// ── 2/3. Português / Portugues language mapping ─────────────────────────

test('Português maps to canonical Portekizce (pt)', () => {
  const r = mapCivitatisLanguage('Português');
  assert.deepEqual(r, { ok: true, code: 'pt', name: 'Portekizce' });
});

test('Portugues (accent-stripped) maps to the same canonical Portekizce (pt)', () => {
  const r = mapCivitatisLanguage('Portugues');
  assert.deepEqual(r, { ok: true, code: 'pt', name: 'Portekizce' });
});

test('existing Italian/Spanish language mappings are unchanged', () => {
  assert.deepEqual(mapCivitatisLanguage('Italiano'), { ok: true, code: 'it', name: 'İtalyanca' });
  assert.deepEqual(mapCivitatisLanguage('Español'), { ok: true, code: 'es', name: 'İspanyolca' });
  assert.deepEqual(mapCivitatisLanguage('Espanol'), { ok: true, code: 'es', name: 'İspanyolca' });
});

// ── 4/5/6. HOUR: absent (valid) / present-valid (unchanged) / present-
// malformed (still fails closed) ────────────────────────────────────────

test('missing HOUR field entirely: valid booking, time:null, timeStatus:"absent", no reason pushed', () => {
  const body = `Activity: Bosforo y Barrio Sultanahmet - Tour em português
Reservation number: 41999001
City: Istanbul
Language: Português
Internal code: Bosforo y Barrio Sultanahmet
Date: Monday, october 26, 2026
People: 1 Adultos
Passenger information 1:
Name
TEST
Last Name
PERSON
Retail price
€ 100.00
Net price
€ 75.00
Client details
Name: Test
Surname: Person`;
  const r = parseCivitatisEmail({
    from: F.FROM_CIVITATIS, subject: 'New booking A41999001: Bosforo y Barrio Sultanahmet',
    body, gmailMessageId: 'm-abs-1', gmailThreadId: 't-41999001', receivedAt: '2026-09-01T10:00:00.000Z',
  });
  assert.equal(r.ok, true, JSON.stringify(r.reasons));
  assert.equal(r.time, null);
  assert.equal(r.timeStatus, 'absent');
  assert.doesNotMatch(JSON.stringify(r.reasons), /[Hh]our/);
});

test('present, VALID HOUR: unchanged existing behavior (still parses to the exact HH:MM, timeStatus:"parsed")', () => {
  const r = parseCivitatisEmail(F.italianNewBooking);
  assert.equal(r.ok, true, JSON.stringify(r.reasons));
  assert.equal(r.time, '09:00');
  assert.equal(r.timeStatus, 'parsed');
});

test('present but MALFORMED HOUR: still fails closed (ok:false, needs_review) — never silently coerced to NULL', () => {
  const body = `Activity: Bosforo y Barrio Sultanahmet - Tour em português
Reservation number: 41999002
City: Istanbul
Language: Português
Internal code: Bosforo y Barrio Sultanahmet
Date: Monday, october 26, 2026
Hour: not-a-time
People: 1 Adultos
Passenger information 1:
Name
TEST
Last Name
PERSON
Retail price
€ 100.00
Net price
€ 75.00
Client details
Name: Test
Surname: Person`;
  const r = parseCivitatisEmail({
    from: F.FROM_CIVITATIS, subject: 'New booking A41999002: Bosforo y Barrio Sultanahmet',
    body, gmailMessageId: 'm-bad-1', gmailThreadId: 't-41999002', receivedAt: '2026-09-01T10:00:00.000Z',
  });
  assert.equal(r.ok, false);
  assert.equal(r.status, 'needs_review');
  assert.equal(r.time, null);
  assert.equal(r.timeStatus, 'invalid');
  assert.ok(r.reasons.some(x => /time text/i.test(x)), JSON.stringify(r.reasons));
});

// ── 7/8. Money parsing: € symbol-prefixed, TL trailing-code unchanged ──

test('€ symbol-prefixed prices parse correctly', () => {
  assert.deepEqual(parseMoneyLine('€ 205.40'), { amount: 205.40, currency: 'EUR' });
  assert.deepEqual(parseMoneyLine('€ 154.05'), { amount: 154.05, currency: 'EUR' });
});

test('existing trailing currency-CODE formats are unchanged', () => {
  assert.deepEqual(parseMoneyLine('4,800 TL'), { amount: 4800, currency: 'TL' });
  assert.deepEqual(parseMoneyLine('3,600 TL'), { amount: 3600, currency: 'TL' });
  assert.deepEqual(parseMoneyLine('4800.00 TL'), { amount: 4800, currency: 'TL' });
});

// ── 9/10/11. Passenger name formats ─────────────────────────────────────

test('Name + Last Name two-sub-label format concatenates into one fullName', () => {
  assert.deepEqual(parsed.passengers, [
    { fullName: 'CARLOS ROBERTO LARRUBIA', sortOrder: 0 },
    { fullName: 'AMANDA OLIVEIRA', sortOrder: 1 },
  ]);
});

test('existing "Full name" sub-label format is unchanged', () => {
  const r = parseCivitatisEmail(F.italianRealFormatBooking);
  assert.equal(r.ok, true, JSON.stringify(r.reasons));
  assert.ok(r.passengers.length >= 1);
  assert.ok(!r.passengers.some(p => /^(name|last name|full name)$/i.test(p.fullName)));
});

test('existing inline "Passenger N: NAME" format (Grand Bazaar bookings) is unchanged', () => {
  const r = parseCivitatisEmail(F.italianA41748096Booking);
  assert.equal(r.ok, true, JSON.stringify(r.reasons));
  assert.deepEqual(r.passengers, [
    { fullName: 'GIANGUGLIELMO DALMONTE', sortOrder: 0 },
    { fullName: 'COLETTE FICCHI', sortOrder: 1 },
  ]);
});

test('defensive rejection: a bare "Name" sub-label whose value cannot be found never itself becomes a passenger fullName', () => {
  const body = `Activity: Bosforo y Barrio Sultanahmet - Tour em português
Reservation number: 41999003
City: Istanbul
Language: Português
Internal code: Bosforo y Barrio Sultanahmet
Date: Monday, october 26, 2026
People: 1 Adultos
Passenger information 1:
Name
Last Name
Retail price
€ 100.00
Net price
€ 75.00
Client details
Name: Test
Surname: Person`;
  const r = parseCivitatisEmail({
    from: F.FROM_CIVITATIS, subject: 'New booking A41999003: Bosforo y Barrio Sultanahmet',
    body, gmailMessageId: 'm-guard-1', gmailThreadId: 't-41999003', receivedAt: '2026-09-01T10:00:00.000Z',
  });
  // "Name" immediately followed by "Last Name" (another known sub-label,
  // not a value) means neither sub-label finds a usable value -> no
  // passenger is recorded for this block at all. Critically, the literal
  // label text itself must NEVER appear as a fullName anywhere in the
  // result.
  assert.ok(!r.passengers.some(p => /^(name|last name|full name)$/i.test(p.fullName)),
    `passengers must never contain a literal label value: ${JSON.stringify(r.passengers)}`);
});

// ── 12/13. Compatible real-world shapes (same product/format family) ───

test('A41323338: compatible shape (Português, no Hour, Name/Last Name, € prices) parses ok:true', () => {
  const r = parseCivitatisEmail(F.portugueseA41323338Booking);
  assert.equal(r.ok, true, JSON.stringify(r.reasons));
  assert.equal(r.externalBookingId, '41323338');
  assert.equal(r.tourLanguage, 'Portekizce');
  assert.equal(r.time, null);
  assert.equal(r.timeStatus, 'absent');
  assert.deepEqual(r.passengers, [{ fullName: 'RICARDO MENDES', sortOrder: 0 }]);
  assert.equal(r.retailAmount, 102.70);
  assert.equal(r.retailCurrency, 'EUR');
});

test('A41330832: compatible shape, accent-stripped "Portugues" spelling, parses ok:true', () => {
  const r = parseCivitatisEmail(F.portuguesAccentStrippedA41330832Booking);
  assert.equal(r.ok, true, JSON.stringify(r.reasons));
  assert.equal(r.externalBookingId, '41330832');
  assert.equal(r.languageRaw, 'Portugues');
  assert.equal(r.tourLanguage, 'Portekizce');
  assert.equal(r.time, null);
  assert.deepEqual(r.passengers, [
    { fullName: 'JOANA COSTA', sortOrder: 0 },
    { fullName: 'PEDRO COSTA', sortOrder: 1 },
  ]);
});

// ── 14/15/16. UI: no fabricated 09:00, honest unknown-time display ─────

test('mapResFromDB no longer fabricates 09:00 for a NULL check_in_time', () => {
  const idx = SOURCE.indexOf('function mapResFromDB(');
  const body = SOURCE.slice(idx, SOURCE.indexOf('\nfunction mapPayFromDB', idx));
  assert.match(body, /time:\s*r\.check_in_time\s*\|\|\s*null/);
  assert.doesNotMatch(body, /time:\s*r\.check_in_time\s*\|\|\s*['"]09:00['"]/);
});

test('fmtResTime never returns a fabricated clock time — only the real value or the honest placeholder', () => {
  const idx = SOURCE.indexOf('function fmtResTime(');
  assert.ok(idx !== -1, 'fmtResTime must exist as a shared helper');
  const line = SOURCE.slice(idx, SOURCE.indexOf('\n', idx));
  assert.match(line, /return t \|\| UNKNOWN_TIME_LABEL/);
  assert.match(SOURCE, /const UNKNOWN_TIME_LABEL\s*=\s*"Saat belirtilmedi"/);
});

test('Reservation Detail: both the header breadcrumb and the "Tur Bilgileri" card use fmtResTime, never raw r.time', () => {
  const idx = SOURCE.indexOf('function ReservationDetailPage(');
  const body = SOURCE.slice(idx, SOURCE.indexOf('\nfunction ', idx + 10));
  const calls = body.match(/fmtResTime\(r\.time\)/g) || [];
  assert.ok(calls.length >= 3, `expected at least 3 fmtResTime(r.time) call sites (breadcrumb, tour card, Saat row), found ${calls.length}`);
  // No remaining bare, unguarded reservation time render.
  assert.doesNotMatch(body, /\{r\.time\}/);
});

test('the reservations table (desktop) and mobile reservation cards use fmtResTime, never raw r.time', () => {
  assert.match(SOURCE, /⏰ \{fmtResTime\(r\.time\)\}/);
  assert.match(SOURCE, /`🕐 \$\{fmtResTime\(r\.time\)\}`/);
});

test('Calendar: useCalendarEvents carries an explicit timeKnown flag derived from the real reservation time, never inferred from the date-anchor', () => {
  const idx = SOURCE.indexOf('function useCalendarEvents()');
  const body = SOURCE.slice(idx, SOURCE.indexOf('\nfunction ', idx + 10));
  assert.match(body, /timeKnown:\s*!!r\.time/);
});

test('Calendar: EventCard shows the unknown-time label instead of fmtHHMM(ev.date) when timeKnown is false — never a bare, unguarded time render', () => {
  const idx = SOURCE.indexOf('function EventCard(');
  const body = SOURCE.slice(idx, SOURCE.indexOf('\nfunction CalSidebar', idx));
  assert.match(body, /ev\.timeKnown \? fmtHHMM\(ev\.date\) : UNKNOWN_TIME_LABEL/);
  assert.doesNotMatch(body, /\{fmtHHMM\(ev\.date\)\}/, 'must never render fmtHHMM(ev.date) unguarded by timeKnown');
});

test('Calendar: an unknown-time reservation still lands in isSameDay/date-grouped filters — it is never excluded/hidden based on time', () => {
  // The date object used for every day/week/month grouping check
  // (isSameDay(e.date, ...)) is built from the reservation's DATE alone
  // (checkIn/date), never gated on whether check_in_time is known — the
  // same dateObj/anchor is used for both known- and unknown-time events.
  const idx = SOURCE.indexOf('function useCalendarEvents()');
  const body = SOURCE.slice(idx, SOURCE.indexOf('\nfunction ', idx + 10));
  assert.match(body, /const dateObj = new Date\(raw \+ \(raw\.includes\('T'\) \? '' : 'T09:00:00'\)\)/);
  assert.doesNotMatch(body, /if\s*\(!r\.time\)\s*return null/, 'an unknown-time reservation must not be filtered out of the calendar');
});

test('Calendar: month-view compact chip and sidebar clock box also guard against fabricating a time when unknown', () => {
  assert.match(SOURCE, /ev\.timeKnown \? fmtHHMM\(ev\.date\)\.slice\(0,5\) : "—:—"/);
  assert.match(SOURCE, /ev\.timeKnown \? fmtHHMM\(ev\.date\)\.split\(":"\)\[0\] : "--"/);
});

test('existing timed reservations still render their real time unchanged (fmtResTime/timeKnown are pass-through for a known time, not a redesign)', () => {
  // fmtResTime(t) returns t itself whenever it is truthy -- a known time
  // string is never altered.
  const idx = SOURCE.indexOf('function fmtResTime(');
  const line = SOURCE.slice(idx, SOURCE.indexOf('\n', idx));
  assert.match(line, /function fmtResTime\(t\) \{ return t \|\| UNKNOWN_TIME_LABEL; \}/);
});

// ── V11 migration + rollback: structural, never-executed sanity checks ─
// These do NOT connect to any database — pure text assertions on the
// prepared .sql files, confirming their shape without ever running them.

const V11_PATH = path.join(__dirname, '..', '..', 'supabase_migration_civitatis_write_v11_optional_check_in_time.sql');
const V11_ROLLBACK_PATH = path.join(__dirname, '..', '..', 'supabase_migration_civitatis_write_v11_ROLLBACK_to_v10.sql');
const V10_PATH = path.join(__dirname, '..', '..', 'supabase_migration_civitatis_write_v10_tour_auto_provisioning.sql');

test('V11 forward migration exists, permits NULL check_in_time, and keeps the 26-parameter signature (no DROP FUNCTION needed)', () => {
  const v11 = fs.readFileSync(V11_PATH, 'utf8');
  assert.doesNotMatch(v11, /\n\s*IF p_check_in_time IS NULL THEN\n\s*v_missing_fields := array_append\(v_missing_fields, 'check_in_time'\);\n\s*END IF;/,
    'V11 must not reject a NULL p_check_in_time as a missing field');
  assert.doesNotMatch(v11, /^DROP FUNCTION IF EXISTS public\.ingest_civitatis_booking/m,
    'V11 has the same 26-parameter signature as V10 — no DROP FUNCTION statement should exist');
  assert.match(v11, /^BEGIN;/m);
  assert.match(v11, /^COMMIT;/m);
  // V11 introduces no NEW data-mutating DML of its own — the one
  // pre-existing DELETE (replacing reservation_guests on the UPDATE
  // path, inherited unchanged from V9/V10) is untouched by this change.
  assert.equal((v11.match(/\bDELETE\s+FROM\b/gi) || []).length, 1);
  assert.doesNotMatch(v11, /\bTRUNCATE\b/i);
});

test('V11 rollback restores the exact V10 function body byte-for-byte', () => {
  const v10 = fs.readFileSync(V10_PATH, 'utf8');
  const rollback = fs.readFileSync(V11_ROLLBACK_PATH, 'utf8');
  const v10FuncStart = v10.indexOf('-- FUNCTION: ingest_civitatis_booking');
  const v10FuncBody = v10.slice(v10FuncStart);
  assert.ok(rollback.includes(v10FuncBody), 'the rollback file must contain the V10 function definition verbatim');
  assert.match(rollback, /^BEGIN;/m);
  assert.match(rollback, /^COMMIT;/m);
  // Same pre-existing, single DELETE as V10/V11 (reservation_guests
  // replacement on the UPDATE path) — restoring V10's body verbatim
  // necessarily restores this too; no schema-mutating statement exists.
  assert.equal((rollback.match(/\bDELETE\s+FROM\b/gi) || []).length, 1);
  assert.doesNotMatch(rollback, /^\s*TRUNCATE\b|^\s*ALTER TABLE\b/mi);
});
