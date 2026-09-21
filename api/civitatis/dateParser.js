/**
 * api/civitatis/dateParser.js
 * ─────────────────────────────────────────────────────────────────────────
 * Deterministic parsing for Civitatis's date/time text. Civitatis always
 * sends English weekday/month names regardless of the activity's own
 * language (Italian and Spanish bookings both show e.g.
 * "Monday, november 2, 2026") — so this is a fixed English-name lookup,
 * never new Date(string) / Date.parse, which are locale- and engine-
 * dependent and explicitly forbidden for this parser.
 *
 * Every function here is pure and synchronous: given the same input
 * string it always returns the same result, with no reliance on the
 * runtime's locale, timezone default, or the current date.
 * ─────────────────────────────────────────────────────────────────────────
 */
'use strict';

const MONTH_INDEX = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
  july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
};

const WEEKDAY_INDEX = {
  sunday: 0, monday: 1, tuesday: 2, wednesday: 3,
  thursday: 4, friday: 5, saturday: 6,
};

function pad2(n) { return String(n).padStart(2, '0'); }

/**
 * Computes the day-of-week (0=Sunday..6=Saturday) for a Y-M-D date using
 * Zeller-independent, UTC-anchored arithmetic (Date.UTC never applies a
 * local timezone offset, so this is deterministic regardless of the
 * server's TZ env var).
 */
function computedWeekday(year, month, day) {
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

function isValidCalendarDate(year, month, day) {
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return false;
  if (month < 1 || month > 12) return false;
  if (day < 1 || day > 31) return false;
  // Round-trip through UTC: if the day overflowed into the next month
  // (e.g. day=31 in a 30-day month), the reconstructed date won't match.
  const d = new Date(Date.UTC(year, month - 1, day));
  return d.getUTCFullYear() === year && d.getUTCMonth() === month - 1 && d.getUTCDate() === day;
}

/**
 * Parses Civitatis's "Weekday, month day, year" date line, e.g.
 * "Monday, november 2, 2026". Returns { ok:true, isoDate, year, month, day }
 * or { ok:false, reason }.
 *
 * The stated weekday is cross-validated against the weekday actually
 * computed from year/month/day — a mismatch is treated as an invalid/
 * ambiguous date (per requirement: reject impossible or ambiguous dates)
 * rather than trusting either value blindly.
 */
function parseCivitatisDate(raw) {
  if (typeof raw !== 'string' || !raw.trim()) {
    return { ok: false, reason: 'date text is empty' };
  }
  const text = raw.trim();
  const m = /^([A-Za-z]+),\s*([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})$/.exec(text);
  if (!m) {
    return { ok: false, reason: `date text "${text}" does not match the expected "Weekday, month day, year" pattern` };
  }
  const [, weekdayRaw, monthRaw, dayRaw, yearRaw] = m;
  const weekdayKey = weekdayRaw.toLowerCase();
  const monthKey = monthRaw.toLowerCase();
  if (!(weekdayKey in WEEKDAY_INDEX)) {
    return { ok: false, reason: `unrecognized weekday name "${weekdayRaw}"` };
  }
  if (!(monthKey in MONTH_INDEX)) {
    return { ok: false, reason: `unrecognized month name "${monthRaw}"` };
  }
  const year = parseInt(yearRaw, 10);
  const month = MONTH_INDEX[monthKey];
  const day = parseInt(dayRaw, 10);
  if (!isValidCalendarDate(year, month, day)) {
    return { ok: false, reason: `"${text}" is not a real calendar date` };
  }
  const actualWeekday = computedWeekday(year, month, day);
  if (actualWeekday !== WEEKDAY_INDEX[weekdayKey]) {
    return {
      ok: false,
      reason: `stated weekday "${weekdayRaw}" does not match the actual weekday for ${year}-${pad2(month)}-${pad2(day)}`,
    };
  }
  return { ok: true, isoDate: `${year}-${pad2(month)}-${pad2(day)}`, year, month, day };
}

/**
 * Parses Civitatis's "Hour" line. Two observed forms:
 *   "9:00 (9:00 am)"  — a bare leading time plus an explicit 12h+am/pm
 *                        parenthetical. The parenthetical is authoritative
 *                        whenever present, since it is the only
 *                        unambiguous signal.
 *   "9:00"             — bare time only, no am/pm marker at all. Taken
 *                        literally as an already-24-hour value (0-23) —
 *                        never guessed into am or pm, since Civitatis
 *                        gives no basis to choose between them here.
 * Returns { ok:true, time:'HH:MM' } or { ok:false, reason }.
 */
function parseCivitatisTime(raw) {
  if (typeof raw !== 'string' || !raw.trim()) {
    return { ok: false, reason: 'time text is empty' };
  }
  const text = raw.trim();

  const withAmPm = /^(\d{1,2}):(\d{2})\s*\(\s*(\d{1,2}):(\d{2})\s*(am|pm)\s*\)$/i.exec(text);
  if (withAmPm) {
    const [, , , h12Raw, minRaw, meridiem] = withAmPm;
    let h12 = parseInt(h12Raw, 10);
    const min = parseInt(minRaw, 10);
    if (h12 < 1 || h12 > 12 || min < 0 || min > 59) {
      return { ok: false, reason: `"${text}" contains an out-of-range 12-hour time` };
    }
    let hour24 = h12 % 12;
    if (meridiem.toLowerCase() === 'pm') hour24 += 12;
    return { ok: true, time: `${pad2(hour24)}:${pad2(min)}` };
  }

  const bare = /^(\d{1,2}):(\d{2})$/.exec(text);
  if (bare) {
    const hour = parseInt(bare[1], 10);
    const min = parseInt(bare[2], 10);
    if (hour < 0 || hour > 23 || min < 0 || min > 59) {
      return { ok: false, reason: `"${text}" is not a valid 24-hour time` };
    }
    return { ok: true, time: `${pad2(hour)}:${pad2(min)}` };
  }

  return { ok: false, reason: `time text "${text}" does not match a recognized pattern` };
}

module.exports = { parseCivitatisDate, parseCivitatisTime, MONTH_INDEX, WEEKDAY_INDEX };
