'use strict';
/**
 * tests/dashboard/heroNextOperation.test.js
 * ─────────────────────────────────────────────────────────────────────────
 * Regression coverage for the Ana Sayfa hero refinement: replacing the
 * "Yeni Rezervasyon Ekle" CTA with a compact "Sıradaki Operasyon"
 * (next-operation) summary. Pure-logic pieces (computeNextOperation,
 * nextOperationDayLabel, _viewNextOperationReservation) are extracted via
 * extractTestableFn and actually executed — these exercise the REAL
 * shipping implementation, not a hand-copied duplicate. The presentational
 * JSX (NextOperationPanel/Welcome) is verified via static source
 * assertions, matching the convention used throughout this repository's
 * other dashboard test files for React-heavy code that can't be mounted
 * outside a browser.
 * ─────────────────────────────────────────────────────────────────────────
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { extractTestableFn } = require('./extractTestableFn');

const SOURCE_PATH = path.join(__dirname, '..', '..', 'DeseTourDashboard.jsx');
const SOURCE = fs.readFileSync(SOURCE_PATH, 'utf8');

// computeNextOperation's extracted body calls istanbulNowParts, which lives
// outside its own TESTABLE markers (it's a separate, independently-tested
// helper) — new Function bodies resolve unrecognized identifiers through
// the global object, so the REAL implementation is exposed here once, the
// same way importantAlerts.test.js exposes global.NAV_REF for
// _viewReservationFromAlert's own free-variable reference.
global.istanbulNowParts = extractTestableFn('istanbulNowParts');

function fnBody(name, source) {
  const idx = source.indexOf(`function ${name}(`);
  assert.ok(idx !== -1, `expected to find function ${name}`);
  const nextFnIdx = source.indexOf('\nfunction ', idx + 10);
  return source.slice(idx, nextFnIdx === -1 ? undefined : nextFnIdx);
}

function res(overrides) {
  return {
    id: 'r-' + Math.random().toString(36).slice(2),
    checkIn: '2026-09-20',
    time: null,
    opStatus: 'Hazırlanıyor',
    guide: '',
    tour: 'Test Tour',
    tourLanguage: 'İngilizce',
    pax: 2,
    ...overrides,
  };
}

// computeNextOperation no longer takes a caller-supplied "todayISO" — it
// derives its own authoritative Europe/Istanbul "today" internally via
// istanbulNowParts. Every test below therefore fixes a specific absolute
// instant (nowMs) rather than relying on the real wall clock, so results
// stay fully deterministic regardless of when the suite actually runs.
// REF_NOW_MS = 2026-09-15T09:00:00Z = 12:00 in Europe/Istanbul that day.
const REF_NOW_MS = new Date('2026-09-15T09:00:00Z').getTime();
const TODAY_ISO = '2026-09-15'; // the Istanbul calendar date at REF_NOW_MS

// ── computeNextOperation: real execution via extractTestableFn ─────────

test('computeNextOperation excludes cancelled ("İptal") reservations even when chronologically nearest', () => {
  const computeNextOperation = extractTestableFn('computeNextOperation');
  const cancelled = res({ checkIn: '2026-09-16', opStatus: 'İptal' });
  const valid = res({ checkIn: '2026-09-20', opStatus: 'Hazırlanıyor' });
  const result = computeNextOperation([cancelled, valid], REF_NOW_MS);
  assert.equal(result.id, valid.id);
});

test('computeNextOperation excludes completed ("Tamamlandı") reservations', () => {
  const computeNextOperation = extractTestableFn('computeNextOperation');
  const completed = res({ checkIn: '2026-09-16', opStatus: 'Tamamlandı' });
  const valid = res({ checkIn: '2026-09-20', opStatus: 'Hazırlanıyor' });
  const result = computeNextOperation([completed, valid], REF_NOW_MS);
  assert.equal(result.id, valid.id);
});

test('computeNextOperation excludes past reservations (checkIn before Istanbul\'s today) even if not cancelled/completed', () => {
  const computeNextOperation = extractTestableFn('computeNextOperation');
  const past = res({ checkIn: '2026-09-01', opStatus: 'Hazırlanıyor' });
  const valid = res({ checkIn: '2026-09-20', opStatus: 'Hazırlanıyor' });
  const result = computeNextOperation([past, valid], REF_NOW_MS);
  assert.equal(result.id, valid.id);
});

test('computeNextOperation includes today\'s reservation (checkIn === Istanbul\'s today is eligible, not excluded)', () => {
  const computeNextOperation = extractTestableFn('computeNextOperation');
  const today = res({ checkIn: TODAY_ISO, opStatus: 'Hazırlanıyor' });
  const result = computeNextOperation([today], REF_NOW_MS);
  assert.equal(result.id, today.id);
});

test('computeNextOperation selects the chronologically nearest upcoming reservation among several candidates', () => {
  const computeNextOperation = extractTestableFn('computeNextOperation');
  const far = res({ checkIn: '2026-10-05' });
  const nearest = res({ checkIn: '2026-09-18' });
  const middle = res({ checkIn: '2026-09-25' });
  const result = computeNextOperation([far, middle, nearest], REF_NOW_MS);
  assert.equal(result.id, nearest.id);
});

test('computeNextOperation orders same-day reservations with two known times chronologically', () => {
  const computeNextOperation = extractTestableFn('computeNextOperation');
  const later = res({ checkIn: '2026-09-20', time: '16:00' });
  const earlier = res({ checkIn: '2026-09-20', time: '09:30' });
  const result = computeNextOperation([later, earlier], REF_NOW_MS);
  assert.equal(result.id, earlier.id);
});

test('an unknown-time reservation does NOT sort ahead of a known future-time reservation on the same date — known times always come first', () => {
  const computeNextOperation = extractTestableFn('computeNextOperation');
  const noTime = res({ checkIn: '2026-09-20', time: null });
  const timed = res({ checkIn: '2026-09-20', time: '09:30' });
  const result = computeNextOperation([noTime, timed], REF_NOW_MS);
  assert.equal(result.id, timed.id, 'the known-time reservation must be selected first, never the unknown-time one');
});

test('computeNextOperation never fabricates a time for a reservation whose time is NULL — the returned object keeps time === null', () => {
  const computeNextOperation = extractTestableFn('computeNextOperation');
  const onlyCandidate = res({ checkIn: '2026-09-20', time: null });
  const result = computeNextOperation([onlyCandidate], REF_NOW_MS);
  assert.equal(result.time, null, 'time must remain NULL, never coerced to a fabricated value');
});

test('when every same-day candidate has an unknown time, ordering falls back deterministically to a stable existing field (reservation number, else id) — never a fabricated time', () => {
  const computeNextOperation = extractTestableFn('computeNextOperation');
  const b = res({ checkIn: '2026-09-20', time: null, resNumber: 'RES-B' });
  const a = res({ checkIn: '2026-09-20', time: null, resNumber: 'RES-A' });
  const result1 = computeNextOperation([b, a], REF_NOW_MS);
  const result2 = computeNextOperation([a, b], REF_NOW_MS);
  // Deterministic: the same two candidates always resolve to the same
  // winner regardless of input order.
  assert.equal(result1.resNumber, result2.resNumber);
  assert.equal(result1.resNumber, 'RES-A');
});

test('a future-date reservation with no structured time at all remains eligible to be selected as the next operation (never dropped for lacking a time)', () => {
  const computeNextOperation = extractTestableFn('computeNextOperation');
  const onlyCandidate = res({ checkIn: '2026-09-20', time: null });
  const result = computeNextOperation([onlyCandidate], REF_NOW_MS);
  assert.equal(result.id, onlyCandidate.id);
});

// ── istanbulNowParts: real execution, explicit Europe/Istanbul, TZ-agnostic ─

test('istanbulNowParts derives Istanbul wall-clock date/time from a UTC instant — 09:00Z on 2026-09-15 is 12:00 in Europe/Istanbul (UTC+3, no DST since 2016)', () => {
  const istanbulNowParts = extractTestableFn('istanbulNowParts');
  const nowMs = new Date('2026-09-15T09:00:00Z').getTime();
  const parts = istanbulNowParts(nowMs);
  assert.equal(parts.dateISO, '2026-09-15');
  assert.equal(parts.hhmm, '12:00');
});

test('istanbulNowParts gives the IDENTICAL result no matter what timezone the Node/browser process itself is running in — proving the calculation does not depend on the device timezone', () => {
  const istanbulNowParts = extractTestableFn('istanbulNowParts');
  const nowMs = new Date('2026-09-15T09:00:00Z').getTime();
  const prevTZ = process.env.TZ;
  try {
    process.env.TZ = 'Pacific/Kiritimati'; // UTC+14 — about as far from Istanbul as possible
    const farAhead = istanbulNowParts(nowMs);
    process.env.TZ = 'Etc/GMT+12'; // UTC-12
    const farBehind = istanbulNowParts(nowMs);
    process.env.TZ = 'America/Los_Angeles';
    const losAngeles = istanbulNowParts(nowMs);
    for (const parts of [farAhead, farBehind, losAngeles]) {
      assert.equal(parts.dateISO, '2026-09-15');
      assert.equal(parts.hhmm, '12:00');
    }
  } finally {
    process.env.TZ = prevTZ;
  }
});

// ── TODAY (Istanbul) + structured time: past-time exclusion ────────────

test('a clearly past structured time today (Europe/Istanbul) cannot become the next operation — proven with "now" fixed at 12:00 Istanbul', () => {
  const computeNextOperation = extractTestableFn('computeNextOperation');
  const pastToday = res({ checkIn: TODAY_ISO, time: '11:00' }); // 11:00 Istanbul — before "now"
  const futureLater = res({ checkIn: '2026-09-20', time: null });
  const result = computeNextOperation([pastToday, futureLater], REF_NOW_MS);
  assert.equal(result.id, futureLater.id, 'the past-timed today reservation must be excluded, falling through to the next real candidate');
});

test('a future structured time today (Europe/Istanbul) CAN become the next operation — proven with "now" fixed at 12:00 Istanbul', () => {
  const computeNextOperation = extractTestableFn('computeNextOperation');
  const futureToday = res({ checkIn: TODAY_ISO, time: '13:00' }); // 13:00 Istanbul — after "now"
  const result = computeNextOperation([futureToday], REF_NOW_MS);
  assert.equal(result.id, futureToday.id);
});

test('the past-time-today decision does not depend on the Node/browser process timezone — same "now" instant, same result, under a non-Istanbul TZ assumption', () => {
  const computeNextOperation = extractTestableFn('computeNextOperation');
  const pastToday = res({ checkIn: TODAY_ISO, time: '11:00' });
  const futureToday = res({ checkIn: TODAY_ISO, time: '13:00' });
  const prevTZ = process.env.TZ;
  try {
    // Under America/Los_Angeles, the SAME instant is 02:00 local — if the
    // implementation ever used the process/browser local time instead of
    // an explicit Europe/Istanbul conversion, an "11:00" reservation would
    // wrongly look like it's still hours in the future. It must not.
    process.env.TZ = 'America/Los_Angeles';
    const result = computeNextOperation([pastToday, futureToday], REF_NOW_MS);
    assert.equal(result.id, futureToday.id, 'must still exclude the Istanbul-past reservation and select the Istanbul-future one, regardless of process TZ');
  } finally {
    process.env.TZ = prevTZ;
  }
});

test('today\'s reservation with NO structured time remains eligible regardless of the current clock — an unknown time is never assumed to be in the past', () => {
  const computeNextOperation = extractTestableFn('computeNextOperation');
  const nowMs = new Date('2026-09-15T20:00:00Z').getTime(); // 23:00 Europe/Istanbul, late in the day
  const todayNoTime = res({ checkIn: TODAY_ISO, time: null });
  const result = computeNextOperation([todayNoTime], nowMs);
  assert.equal(result.id, todayNoTime.id);
});

test('a structured time today exactly equal to "now" (Istanbul) is treated as not-yet-past (boundary is exclusive on the past side)', () => {
  const computeNextOperation = extractTestableFn('computeNextOperation');
  const nowMs = new Date('2026-09-15T07:00:00Z').getTime(); // 10:00 Europe/Istanbul
  const exactlyNow = res({ checkIn: TODAY_ISO, time: '10:00' });
  const result = computeNextOperation([exactlyNow], nowMs);
  assert.equal(result.id, exactlyNow.id);
});

test('a past structured time on a FUTURE date is not affected by the today-only past-time check (only applies to checkIn === Istanbul\'s today)', () => {
  const computeNextOperation = extractTestableFn('computeNextOperation');
  const nowMs = new Date('2026-09-15T20:00:00Z').getTime(); // 23:00 Europe/Istanbul
  const earlyMorningNextWeek = res({ checkIn: '2026-09-22', time: '06:00' });
  const result = computeNextOperation([earlyMorningNextWeek], nowMs);
  assert.equal(result.id, earlyMorningNextWeek.id);
});

test('around an Istanbul calendar-day boundary, the past-time-today decision uses ISTANBUL\'S date, not UTC\'s — "now" is 01:00 Istanbul on the 16th, which is still 22:00 UTC on the 15th', () => {
  const computeNextOperation = extractTestableFn('computeNextOperation');
  // 2026-09-15T22:00:00Z = 2026-09-16T01:00:00 in Europe/Istanbul (UTC+3):
  // the UTC calendar date is still the 15th, but Istanbul has already
  // rolled over to the 16th. A correct implementation identifies "today"
  // as the 16th here (there is no separate caller-supplied todayISO to
  // disagree with it any more) and applies the past-time check to a 16th
  // reservation accordingly.
  const nowMs = new Date('2026-09-15T22:00:00Z').getTime();
  const pastAfterRollover = res({ checkIn: '2026-09-16', time: '00:30' }); // before 01:00 Istanbul "now"
  const futureAfterRollover = res({ checkIn: '2026-09-16', time: '02:00' }); // after 01:00 Istanbul "now"
  const result = computeNextOperation([pastAfterRollover, futureAfterRollover], nowMs);
  assert.equal(result.id, futureAfterRollover.id, 'the 00:30 reservation on the Istanbul-rolled-over date must be excluded as already past');
});

// ── Cross-timezone VIEWER scenarios (the actual bug this turn fixes) ────

test('a viewer opening the CRM from Bali (device date already "1 October") does not lose a still-valid 30 September 23:00 Istanbul reservation — the general past-date filter must use Istanbul\'s date, not the device\'s', () => {
  const computeNextOperation = extractTestableFn('computeNextOperation');
  // Europe/Istanbul 30 Sep 22:00 = UTC 19:00 30 Sep = Asia/Makassar (UTC+8)
  // 03:00 1 Oct — exactly the scenario given: Istanbul still reads
  // "30 September 22:00" while a Bali device's calendar already reads
  // "1 October".
  const nowMs = new Date('2026-09-30T19:00:00Z').getTime();
  const stillFutureInIstanbul = res({ checkIn: '2026-09-30', time: '23:00' });
  const prevTZ = process.env.TZ;
  try {
    process.env.TZ = 'Asia/Makassar';
    const result = computeNextOperation([stillFutureInIstanbul], nowMs);
    assert.equal(result.id, stillFutureInIstanbul.id, 'the 30 September 23:00 Istanbul reservation must remain eligible — it has not happened yet in Istanbul');
  } finally {
    process.env.TZ = prevTZ;
  }
});

test('a device timezone BEHIND Istanbul cannot make an Istanbul-previous-day reservation eligible — the inverse of the Bali case', () => {
  const computeNextOperation = extractTestableFn('computeNextOperation');
  // Europe/Istanbul 2026-09-15 00:30 = UTC 2026-09-14 21:30 = America/Los_Angeles
  // (UTC-7, PDT) 2026-09-14 14:30 — LA's local calendar date is still the
  // 14th while Istanbul has already rolled over to the 15th. A reservation
  // dated the 14th is therefore ALREADY PAST in Istanbul and must never
  // resurface as eligible just because a Los Angeles device's calendar
  // still reads "the 14th".
  const nowMs = new Date('2026-09-14T21:30:00Z').getTime();
  const istanbulYesterday = res({ checkIn: '2026-09-14', time: '18:00' });
  const prevTZ = process.env.TZ;
  try {
    process.env.TZ = 'America/Los_Angeles';
    const result = computeNextOperation([istanbulYesterday], nowMs);
    assert.equal(result, null, 'an Istanbul-previous-day reservation must never become eligible, regardless of what the viewing device\'s own calendar date says');
  } finally {
    process.env.TZ = prevTZ;
  }
});

test('the general past-date filter is based on Europe/Istanbul\'s date under several different process timezones, not whichever one happens to be running', () => {
  const computeNextOperation = extractTestableFn('computeNextOperation');
  const nowMs = new Date('2026-09-15T09:00:00Z').getTime(); // 12:00 Istanbul, 15 Sep
  const istanbulYesterday = res({ checkIn: '2026-09-14' }); // must always be "past"
  const istanbulToday = res({ checkIn: '2026-09-15' });     // must always be "today or future"
  const prevTZ = process.env.TZ;
  try {
    for (const tz of ['Asia/Makassar', 'Europe/Istanbul', 'America/Los_Angeles', 'Pacific/Kiritimati']) {
      process.env.TZ = tz;
      const result = computeNextOperation([istanbulYesterday, istanbulToday], nowMs);
      assert.equal(result.id, istanbulToday.id, `expected the Istanbul-yesterday reservation to be excluded under TZ=${tz}`);
    }
  } finally {
    process.env.TZ = prevTZ;
  }
});

test('the selected next operation is IDENTICAL under Asia/Makassar, Europe/Istanbul, and America/Los_Angeles for the same absolute instant and the same dataset', () => {
  const computeNextOperation = extractTestableFn('computeNextOperation');
  const nowMs = new Date('2026-09-15T09:00:00Z').getTime(); // 12:00 Istanbul, 15 Sep
  const dataset = [
    res({ checkIn: '2026-09-14', time: '10:00' }), // past — always excluded
    res({ checkIn: '2026-09-15', time: '11:00' }), // today, already past the hour — excluded
    res({ checkIn: '2026-09-15', time: '14:00' }), // today, still upcoming — the expected winner
    res({ checkIn: '2026-09-18', time: null }),    // future, unknown time — eligible but further out
  ];
  const expectedWinner = dataset[2];
  const prevTZ = process.env.TZ;
  const results = [];
  try {
    for (const tz of ['Asia/Makassar', 'Europe/Istanbul', 'America/Los_Angeles']) {
      process.env.TZ = tz;
      results.push(computeNextOperation(dataset, nowMs).id);
    }
  } finally {
    process.env.TZ = prevTZ;
  }
  assert.deepEqual(results, [expectedWinner.id, expectedWinner.id, expectedWinner.id]);
});

test('computeNextOperation returns null when there is no eligible upcoming reservation', () => {
  const computeNextOperation = extractTestableFn('computeNextOperation');
  const cancelled = res({ checkIn: '2026-09-20', opStatus: 'İptal' });
  const past = res({ checkIn: '2026-09-01', opStatus: 'Hazırlanıyor' });
  assert.equal(computeNextOperation([cancelled, past], REF_NOW_MS), null);
  assert.equal(computeNextOperation([], REF_NOW_MS), null);
  assert.equal(computeNextOperation(null, REF_NOW_MS), null);
});

test('computeNextOperation ignores reservations with no checkIn at all', () => {
  const computeNextOperation = extractTestableFn('computeNextOperation');
  const noCheckIn = res({ checkIn: null });
  const valid = res({ checkIn: '2026-09-20' });
  const result = computeNextOperation([noCheckIn, valid], REF_NOW_MS);
  assert.equal(result.id, valid.id);
});

// ── nextOperationDayLabel: real execution ───────────────────────────────
// Signature is now (checkInISO, nowMs) — it derives Istanbul's own "today"
// internally (istanbulNowParts), the same authoritative date
// computeNextOperation itself uses, never a caller-supplied todayISO.

test('nextOperationDayLabel returns "Bugün" for a reservation dated Istanbul\'s today', () => {
  const nextOperationDayLabel = extractTestableFn('nextOperationDayLabel');
  assert.equal(nextOperationDayLabel(TODAY_ISO, REF_NOW_MS), 'Bugün');
});

test('nextOperationDayLabel returns "Yarın" for a reservation dated Istanbul\'s tomorrow', () => {
  const nextOperationDayLabel = extractTestableFn('nextOperationDayLabel');
  assert.equal(nextOperationDayLabel('2026-09-16', REF_NOW_MS), 'Yarın');
});

test('nextOperationDayLabel returns null for dates further out — caller falls back to the actual date, no fabricated relative label', () => {
  const nextOperationDayLabel = extractTestableFn('nextOperationDayLabel');
  assert.equal(nextOperationDayLabel('2026-09-25', REF_NOW_MS), null);
});

test('nextOperationDayLabel returns null for a falsy checkIn', () => {
  const nextOperationDayLabel = extractTestableFn('nextOperationDayLabel');
  assert.equal(nextOperationDayLabel(null, REF_NOW_MS), null);
  assert.equal(nextOperationDayLabel('', REF_NOW_MS), null);
});

test('a viewer in Bali may already be on the next calendar day while Istanbul still shows the reservation as "Bugün" — the label must agree with Istanbul, not the device', () => {
  const nextOperationDayLabel = extractTestableFn('nextOperationDayLabel');
  // Europe/Istanbul 30 Sep 22:00 = UTC 19:00 30 Sep = Asia/Makassar (UTC+8)
  // 03:00 1 Oct — Istanbul still reads "30 September", a Bali device's
  // calendar already reads "1 October". The reservation is dated the 30th.
  const nowMs = new Date('2026-09-30T19:00:00Z').getTime();
  const prevTZ = process.env.TZ;
  try {
    process.env.TZ = 'Asia/Makassar';
    assert.equal(nextOperationDayLabel('2026-09-30', nowMs), 'Bugün');
  } finally {
    process.env.TZ = prevTZ;
  }
});

test('a reservation on Istanbul\'s tomorrow shows "Yarın" even when the process timezone is far ahead of Istanbul', () => {
  const nextOperationDayLabel = extractTestableFn('nextOperationDayLabel');
  const nowMs = new Date('2026-09-30T19:00:00Z').getTime(); // 22:00 Istanbul, 30 Sep
  const prevTZ = process.env.TZ;
  try {
    process.env.TZ = 'Asia/Makassar';
    assert.equal(nextOperationDayLabel('2026-10-01', nowMs), 'Yarın');
  } finally {
    process.env.TZ = prevTZ;
  }
});

test('nextOperationDayLabel gives the IDENTICAL result under several different process/browser timezones for the same instant and checkIn — proving it never depends on the device timezone', () => {
  const nextOperationDayLabel = extractTestableFn('nextOperationDayLabel');
  const nowMs = new Date('2026-09-15T09:00:00Z').getTime(); // 12:00 Istanbul, 15 Sep
  const prevTZ = process.env.TZ;
  const results = { today: [], tomorrow: [], further: [] };
  try {
    for (const tz of ['Asia/Makassar', 'Europe/Istanbul', 'America/Los_Angeles', 'Pacific/Kiritimati']) {
      process.env.TZ = tz;
      results.today.push(nextOperationDayLabel('2026-09-15', nowMs));
      results.tomorrow.push(nextOperationDayLabel('2026-09-16', nowMs));
      results.further.push(nextOperationDayLabel('2026-09-25', nowMs));
    }
  } finally {
    process.env.TZ = prevTZ;
  }
  assert.deepEqual(results.today, ['Bugün', 'Bugün', 'Bugün', 'Bugün']);
  assert.deepEqual(results.tomorrow, ['Yarın', 'Yarın', 'Yarın', 'Yarın']);
  assert.deepEqual(results.further, [null, null, null, null]);
});

test('non-today/non-tomorrow date formatting is unaffected by this correction — nextOperationDayLabel still returns null so the caller falls back to the actual formatted date, exactly as before', () => {
  const nextOperationDayLabel = extractTestableFn('nextOperationDayLabel');
  // A reservation a week out, checked under three different timezones —
  // always null, never a fabricated/incorrect relative label.
  const nowMs = new Date('2026-09-15T09:00:00Z').getTime();
  const prevTZ = process.env.TZ;
  try {
    for (const tz of ['Europe/Istanbul', 'Asia/Makassar', 'America/Los_Angeles']) {
      process.env.TZ = tz;
      assert.equal(nextOperationDayLabel('2026-09-22', nowMs), null);
    }
  } finally {
    process.env.TZ = prevTZ;
  }
});

// ── _viewNextOperationReservation: same navigation mechanism as the rest of the dashboard ─

test('_viewNextOperationReservation navigates via NAV_REF.fn to /reservations/<id> — the same mechanism OnemliUyarilar\'s "Rezervasyonu Gör" already uses, no new routing mechanism', () => {
  const prevNav = global.NAV_REF;
  global.NAV_REF = { fn: (p) => { global.__lastNav = p; } };
  global.__lastNav = null;
  const _viewNextOperationReservation = extractTestableFn('_viewNextOperationReservation');
  _viewNextOperationReservation({ id: 'RES-77' });
  assert.equal(global.__lastNav, '/reservations/RES-77');
  global.NAV_REF = prevNav;
});

test('_viewNextOperationReservation is a safe no-op when there is no operation (empty state) — never throws, never navigates', () => {
  const prevNav = global.NAV_REF;
  global.NAV_REF = { fn: (p) => { global.__lastNav = p; } };
  global.__lastNav = null;
  const _viewNextOperationReservation = extractTestableFn('_viewNextOperationReservation');
  assert.doesNotThrow(() => _viewNextOperationReservation(null));
  assert.equal(global.__lastNav, null);
  global.NAV_REF = prevNav;
});

// ── Static source assertions: the hero JSX itself ───────────────────────

test('the hero (Welcome) no longer renders the "Yeni Rezervasyon Ekle" CTA, its state, or NewReservationModal', () => {
  const body = fnBody('Welcome', SOURCE);
  assert.doesNotMatch(body, /Yeni Rezervasyon Ekle/);
  assert.doesNotMatch(body, /showNewRes/);
  assert.doesNotMatch(body, /NewReservationModal/);
});

test('manual reservation creation is not removed from the CRM — NewReservationModal is still wired up elsewhere (multiple other entry points)', () => {
  const occurrences = SOURCE.match(/<NewReservationModal\b/g) || [];
  assert.ok(occurrences.length >= 2, 'expected NewReservationModal to still be rendered from at least one non-hero location');
});

test('the hero renders the Sıradaki Operasyon (next operation) section, reusing the existing repoRes data with no second/redundant reservation fetch', () => {
  const body = fnBody('Welcome', SOURCE);
  assert.match(body, /<NextOperationPanel operation=\{nextOperation\}\/>/);
  // computeNextOperation is called with ONLY repoRes — it deliberately
  // derives its own Europe/Istanbul "today" internally (istanbulNowParts)
  // rather than being fed a browser-local date from here.
  assert.match(body, /computeNextOperation\(repoRes\)/);
  assert.doesNotMatch(body, /computeNextOperation\(repoRes,\s*_TODAY_ISO/, 'must not pass a browser-local todayISO back into computeNextOperation');
  // Exactly one useRepo("reservation", ...) call inside Welcome — the same
  // one already used for the urgent-item count, not a second fetch.
  const reservationFetches = body.match(/useRepo\("reservation",\s*"getAll"\)/g) || [];
  assert.equal(reservationFetches.length, 1, 'expected the next-operation panel to reuse the single existing reservation fetch, not add a second one');
});

test('computeNextOperation no longer accepts a caller-supplied todayISO — its signature is (reservations, nowMs), removing the misleading browser-local-date argument entirely', () => {
  const body = fnBody('computeNextOperation', SOURCE);
  assert.match(body, /function computeNextOperation\(reservations, nowMs\)/);
});

test('NextOperationPanel calls nextOperationDayLabel with ONLY the reservation\'s checkIn — no browser-local _TODAY_ISO is passed in, so the "Bugün"/"Yarın" label agrees with Istanbul, not the viewing device', () => {
  const body = fnBody('NextOperationPanel', SOURCE);
  assert.match(body, /nextOperationDayLabel\(operation\.checkIn\)/);
  assert.doesNotMatch(body, /nextOperationDayLabel\(operation\.checkIn,\s*_TODAY_ISO/);
});

test('NextOperationPanel renders the "Sıradaki Operasyon" label and the exact specified empty-state copy with no fabricated data', () => {
  const body = fnBody('NextOperationPanel', SOURCE);
  assert.match(body, /Sıradaki Operasyon/);
  assert.match(body, /Planlanmış yaklaşan operasyon bulunmuyor\./);
  assert.doesNotMatch(body, /NewReservationModal|showNewRes|Yeni Rezervasyon Ekle/);
});

test('NextOperationPanel shows the restrained "Rehber Ataması Bekliyor" warning when the reservation has no guide, and the reservation\'s own real opStatus (not an invented "Operasyona Hazır") when a guide is assigned', () => {
  const body = fnBody('NextOperationPanel', SOURCE);
  assert.match(body, /Rehber Ataması Bekliyor/);
  assert.doesNotMatch(body, /Operasyona Hazır/);
  // The assigned-guide branch displays operation.opStatus verbatim, coloured
  // via the existing RES_STATUS map — not a newly invented readiness value.
  assert.match(body, /label=\{operation\.opStatus \|\| "—"\}/);
  assert.match(body, /RES_STATUS\[operation\.opStatus\]/);
});

test('NextOperationPanel never fabricates a time — it calls the existing fmtResTime helper (which already falls back to "Saat belirtilmedi"), it does not hardcode a clock value', () => {
  const body = fnBody('NextOperationPanel', SOURCE);
  assert.match(body, /fmtResTime\(operation\.time\)/);
  assert.doesNotMatch(body, /09:00/);
});

test('NextOperationPanel navigates to reservation detail via _viewNextOperationReservation on click', () => {
  const body = fnBody('NextOperationPanel', SOURCE);
  assert.match(body, /onClick=\{\(\)=>_viewNextOperationReservation\(operation\)\}/);
});

test('the next-operation block reuses the existing subtle row-hover class (dt-row) instead of a new bordered/shadowed button-card treatment', () => {
  const body = fnBody('NextOperationPanel', SOURCE);
  assert.match(body, /className="dt-row"/);
  assert.doesNotMatch(body, /boxShadow/);
});

// ── Scope guards: everything outside the hero is untouched ─────────────

test('scope guard: Önemli Uyarılar (OnemliUyarilar) is completely untouched by the hero refinement', () => {
  const body = fnBody('OnemliUyarilar', SOURCE);
  assert.match(body, /if \(loading \|\| error \|\| alerts\.length === 0\) return null;/);
  assert.match(body, /<SectionHeader title="Önemli Uyarılar"\/>/);
});

test('scope guard: the ada18af dashboard grid classnames (dash-kpi-grid, dash-row-2, dash-row-3, dash-guide-kpi) are still present, unmodified', () => {
  assert.match(SOURCE, /className="dash-kpi-grid"/);
  assert.match(SOURCE, /className="dash-row-2"/);
  assert.match(SOURCE, /className="dash-row-3"/);
  assert.match(SOURCE, /className="dash-guide-kpi"/);
});

test('scope guard: Dashboard() still renders every section in the same order, untouched by this hero-only change', () => {
  const body = fnBody('Dashboard', SOURCE);
  const order = ['<Welcome/>', '<OnemliUyarilar/>', '<KpiRow/>', '<TodayTours/>', '<UrgentPanel/>', '<UpcomingReservations/>', '<PendingPaymentsWidget/>', '<ActivityFeed/>', '<GuideOpsPanel/>', '<RecentReviewsPanel/>'];
  let cursor = -1;
  for (const token of order) {
    const idx = body.indexOf(token);
    assert.ok(idx > cursor, `expected ${token} to appear in order`);
    cursor = idx;
  }
});

test('scope guard: MobileHomePage (the separate mobile hero implementation) is untouched by this desktop-only change', () => {
  const idx = SOURCE.indexOf('function MobileHomePage({ navigate }) {');
  assert.ok(idx !== -1);
  const body = SOURCE.slice(idx, SOURCE.indexOf('\nfunction MobileEntityCard', idx));
  assert.doesNotMatch(body, /NextOperationPanel|computeNextOperation/);
});

test('scope guard: no SQL, schema, RPC, Civitatis ingestion, or auth identifier appears anywhere in the hero-related source (Welcome/NextOperationPanel)', () => {
  for (const fnName of ['Welcome', 'NextOperationPanel']) {
    const body = fnBody(fnName, SOURCE);
    assert.doesNotMatch(body, /\.sql|CREATE TABLE|ALTER TABLE|ingest_civitatis|supabase\.auth|BEGIN;|COMMIT;/);
  }
});

test('this test file itself never connects to a database or imports a Supabase client', () => {
  const selfSrc = fs.readFileSync(__filename, 'utf8');
  assert.doesNotMatch(selfSrc, /createClient\(/);
  assert.doesNotMatch(selfSrc, /require\(\s*['"]@supabase\/supabase-js['"]\s*\)/);
});
