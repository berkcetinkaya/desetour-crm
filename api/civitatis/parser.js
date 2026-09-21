/**
 * api/civitatis/parser.js
 * ─────────────────────────────────────────────────────────────────────────
 * The deterministic Civitatis reservation-email parser. No AI/LLM calls,
 * no network access, no Supabase access — a pure function from
 * { from, subject, body, gmailMessageId, gmailThreadId, receivedAt } to a
 * normalized structured object (or a needs_review/parse_error result).
 * Fully testable without Gmail: callers hand it plain strings already
 * extracted from a Gmail message by api/civitatis/gmailClient.js.
 *
 * Civitatis's plain-text body is a sequence of "Label:" lines each
 * followed by its value on the next non-blank line(s) — see the field-
 * by-field extraction helpers below. Nothing here ever invents a value
 * for a field that is missing or unrecognized in the source text; a
 * missing/unmappable field either stays null or routes the whole message
 * to needs_review, per field.
 * ─────────────────────────────────────────────────────────────────────────
 */
'use strict';

const { detectCivitatisEvent } = require('./eventDetector');
const { parseCivitatisDate, parseCivitatisTime } = require('./dateParser');
const { mapCivitatisLanguage } = require('./languageMap');

// ── Label names (canonical text, no trailing colon, real Civitatis emails
// observed) ─────────────────────────────────────────────────────────────
// The real Gmail plain-text export uses a MIXED format: some labels are
// followed by a colon with their value on the SAME line
// ("RESERVATION NUMBER: 41659924"), others are a bare label line — with
// or without a trailing colon — whose value is the next non-empty line
// ("PEOPLE" / "RETAIL PRICE" / "NET PRICE"), and casing varies (all-caps
// in real messages, Title Case in earlier examples used for this
// project). Every label below is matched against all of those shapes,
// case-insensitively, via buildLabelMatchers()/findLabelValue() — never
// a fuzzy match against arbitrary text, only these explicitly known
// label names.
const LABEL_NAMES = {
  ACTIVITY: 'Activity',
  RESERVATION_NUMBER: 'Reservation number',
  CITY: 'City',
  LANGUAGE: 'Language',
  INTERNAL_CODE: 'Internal code',
  DATE: 'Date',
  HOUR: 'Hour',
  DURATION: 'Duration',
  PEOPLE: 'People',
  RETAIL_PRICE: 'Retail price',
  NET_PRICE: 'Net price',
};
const SIMPLE_LABEL_LIST = Object.values(LABEL_NAMES);
const CLIENT_DETAILS_LABEL = 'Client details';

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Builds the two regexes used to recognize one label in any of its real
 * shapes: `bare` matches the label alone, with or without a trailing
 * colon and nothing else on the line ("PEOPLE" / "People:") — signaling
 * the value is the next line; `sameLine` matches the label followed by a
 * colon and the value on the same line ("Reservation number: 41629692")
 * and captures that value. Colon is REQUIRED for a same-line match so a
 * bare label line is never misread as if it carried an (absent) inline
 * value. `start` is used only for boundary detection (is this some OTHER
 * known label's line, in either shape) inside the block-scoped
 * extractors below. */
function buildLabelMatchers(label) {
  const escaped = escapeRegExp(label);
  return {
    bare: new RegExp(`^${escaped}\\s*:?$`, 'i'),
    sameLine: new RegExp(`^${escaped}\\s*:\\s*(.+)$`, 'i'),
    start: new RegExp(`^${escaped}\\s*:?`, 'i'),
  };
}

const LABEL_MATCHERS = new Map(SIMPLE_LABEL_LIST.map(name => [name, buildLabelMatchers(name)]));
const CLIENT_DETAILS_MATCHERS = buildLabelMatchers(CLIENT_DETAILS_LABEL);

const PASSENGER_LABEL = /^Passenger information (\d+):?$/i;
const MODIFIED_INFO_LABEL = /^Modified information:?$/i;

function isKnownLabelLine(line) {
  for (const label of SIMPLE_LABEL_LIST) {
    if (LABEL_MATCHERS.get(label).start.test(line)) return true;
  }
  return CLIENT_DETAILS_MATCHERS.start.test(line)
    || PASSENGER_LABEL.test(line)
    || MODIFIED_INFO_LABEL.test(line);
}

/**
 * Normalizes one line's whitespace WITHOUT touching its meaningful
 * content: non-breaking (and other Unicode) spaces become regular
 * spaces, runs of horizontal whitespace (spaces/tabs) collapse to a
 * single space, and a space immediately before a colon ("Reservation
 * number :") is removed so the line matches the plain "Label:" form
 * regardless of exactly how the source template padded it. Real
 * Civitatis plain-text bodies are not guaranteed to start a label at
 * column zero or to use single-space, single-tab separation — this is
 * what makes label matching tolerant of that without ever altering a
 * label or value's actual words/casing/digits. Applied uniformly to
 * every line, so an accidental double space inside a passenger name is
 * collapsed the same as anywhere else — real passenger names are not
 * expected to contain intentional multi-space runs.
 */
function normalizeLineWhitespace(line) {
  return String(line)
    .replace(/[\s ]+/g, ' ')
    .replace(/ :/g, ':')
    .trim();
}

/** Splits body text into non-empty, whitespace-normalized lines — blank
 * lines in Civitatis's format are pure visual separators with no data of
 * their own, so compacting them away simplifies every extraction rule
 * below without losing information. */
function compactLines(body) {
  return String(body || '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .split('\n')
    .map(l => normalizeLineWhitespace(l))
    .filter(l => l.length > 0);
}

/**
 * Finds a label's value, tolerating all three real Civitatis layouts,
 * case-insensitively:
 *   "RESERVATION NUMBER: 41659924"   (label + value, same line)
 *   "PEOPLE" / "4 Adultos ..."       (bare label, no colon at all, value
 *                                      on the next non-empty line)
 *   "Reservation number:" / "value"  (label with a trailing colon alone,
 *                                      value on the next non-empty line)
 * `label` is the canonical name from LABEL_NAMES (no colon) — only
 * these explicitly known labels are ever matched, never arbitrary text.
 * Never invents a value: if the label is found but no value follows
 * (nothing after the colon on the same line, or the next line is itself
 * another known label / absent), returns null rather than guessing.
 */
function findLabelValue(lines, label) {
  const matchers = LABEL_MATCHERS.get(label);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const sameLineMatch = matchers.sameLine.exec(line);
    if (sameLineMatch) return sameLineMatch[1].trim();
    if (matchers.bare.test(line)) {
      const next = lines[i + 1];
      if (next !== undefined && !isKnownLabelLine(next)) return next;
      return null;
    }
  }
  return null;
}

const FULL_NAME_LABEL_BARE = /^Full name:?$/i;
const FULL_NAME_LABEL_LINE = /^Full name:?\s*(.*)$/i;

/** Passenger blocks: "Passenger information N:" then either a "Full name"
 * sub-label (with or without a trailing colon, and with the name either
 * on the same line or the next line — both real layouts are observed
 * depending on plain-text vs. HTML-table-derived extraction) followed by
 * the name, or (tolerated variant) the name directly with no "Full name"
 * sub-label at all. Returned in the order encountered, sort_order is
 * 0-based position among passengers found — never re-derived from the
 * Civitatis "N" itself, which is display numbering, not guaranteed to
 * start at 1 or be contiguous. Supports any number of repeated
 * "Passenger information N:" sections. */
function extractPassengers(lines) {
  const passengers = [];
  for (let i = 0; i < lines.length; i++) {
    if (!PASSENGER_LABEL.test(lines[i])) continue;
    let cursor = i + 1;
    if (cursor < lines.length) {
      const m = FULL_NAME_LABEL_LINE.exec(lines[cursor]);
      if (m) {
        const inline = m[1].trim();
        if (inline) {
          passengers.push({ fullName: inline, sortOrder: passengers.length });
          continue;
        }
        cursor++; // "Full name:" alone -> the value is on the next line
      }
    }
    const nameLine = lines[cursor];
    if (
      nameLine !== undefined
      && !isKnownLabelLine(nameLine)
      && !PASSENGER_LABEL.test(nameLine)
      && !FULL_NAME_LABEL_BARE.test(nameLine)
    ) {
      passengers.push({ fullName: nameLine, sortOrder: passengers.length });
    }
  }
  return passengers;
}

/** "Client details" / "CLIENT DETAILS" block: Name: X / Surname: Y,
 * order-tolerant, scanned only within the few lines immediately
 * following the label so it never accidentally consumes an unrelated
 * later field. Email:/Phone: are tolerated as optional additional
 * lines in the same block — if a real Civitatis email includes them
 * here they are the only safe, non-fuzzy signal available for matching
 * the booking contact against an existing CRM customer (see
 * matching.js), so they are worth recognizing if present.
 *
 * Real messages append a literal "(Contact details)" marker to some
 * values (observed on Surname) — Civitatis presentation text, not part
 * of the actual value, so it is stripped from whichever sub-field
 * carries it. */
const CLIENT_SUB_LABEL_LINE = /^(Name|Surname|Email|Phone):?\s*(.*)$/i;
const CLIENT_SUB_LABEL_BARE = /^(Name|Surname|Email|Phone):?\s*$/i;
const CLIENT_SUB_LABEL_KEY = { name: 'name', surname: 'surname', email: 'email', phone: 'phone' };
const CONTACT_DETAILS_MARKER_RE = /\s*\(contact details\)\s*$/i;

function stripContactDetailsMarker(value) {
  return value == null ? value : value.replace(CONTACT_DETAILS_MARKER_RE, '').trim();
}

function extractClientDetails(lines) {
  const idx = lines.findIndex(l => CLIENT_DETAILS_MATCHERS.bare.test(l));
  const result = { name: null, surname: null, email: null, phone: null };
  if (idx === -1) return result;
  const end = Math.min(idx + 12, lines.length);
  let i = idx + 1;
  while (i < end) {
    const line = lines[i];
    if (isKnownLabelLine(line)) break;
    const m = CLIENT_SUB_LABEL_LINE.exec(line);
    if (!m) break;
    const key = CLIENT_SUB_LABEL_KEY[m[1].toLowerCase()];
    const inline = m[2].trim();
    if (inline) {
      result[key] = stripContactDetailsMarker(inline);
      i += 1;
    } else {
      // "Name:" (or Surname/Email/Phone) alone on its own line -> the
      // value is on the next line, as long as that next line isn't
      // itself another bare sub-label or a top-level field boundary.
      const next = lines[i + 1];
      if (next !== undefined && !isKnownLabelLine(next) && !CLIENT_SUB_LABEL_BARE.test(next)) {
        result[key] = stripContactDetailsMarker(next.trim());
        i += 2;
      } else {
        i += 1;
      }
    }
  }
  return result;
}

const PHONE_SUB_LABEL_LINE = /^phone:?\s*(.*)$/i;
const PHONE_SHAPE_RE = /^\+?\d[\d\s-]{4,}$/;

/** "Modified information" / "Phone" block (modification emails only):
 * captures phone-shaped values as a raw list, tolerating all three real
 * shapes — "PHONE" then next-line value(s), "PHONE:" then next-line
 * value(s), and "PHONE: value" inline — this migration's parser output
 * only needs "phones if present", not which entry is old vs. new, which
 * Civitatis does not label explicitly. Never invents a phone number:
 * if no "Phone" sub-label is found at all, returns an empty list. */
function extractModifiedPhones(lines) {
  const idx = lines.findIndex(l => MODIFIED_INFO_LABEL.test(l));
  if (idx === -1) return [];
  let cursor = idx + 1;
  if (cursor >= lines.length) return [];
  const m = PHONE_SUB_LABEL_LINE.exec(lines[cursor]);
  if (!m) return [];
  const phones = [];
  const inline = m[1].trim();
  cursor++;
  if (inline && PHONE_SHAPE_RE.test(inline)) phones.push(inline);
  while (cursor < lines.length && PHONE_SHAPE_RE.test(lines[cursor])) {
    phones.push(lines[cursor].trim());
    cursor++;
  }
  return phones;
}

/** "People:" line, e.g. "2 Adulti x € 43.02" or "2 Adultos". Only the
 * leading guest-count segment is parsed — the task explicitly forbids
 * using the euro amount shown here for anything financial; Retail
 * price / Net price are the sole authoritative money fields. */
function extractGuestCounts(peopleLine) {
  if (!peopleLine) return { adultCount: null, childCount: null };
  const segments = peopleLine.split(',').map(s => s.trim());
  let adultCount = null;
  let childCount = null;
  const adultMatch = /^(\d+)\s+(Adulti|Adultos|Adults?)\b/i.exec(segments[0] || '');
  if (adultMatch) adultCount = parseInt(adultMatch[1], 10);
  for (let i = 1; i < segments.length; i++) {
    const childMatch = /^(\d+)\s+(Bambini|Niños|Ninos|Children|Child)\b/i.exec(segments[i]);
    if (childMatch) { childCount = parseInt(childMatch[1], 10); break; }
  }
  return { adultCount, childCount };
}

/** "4,800 TL" -> { amount: 4800, currency: 'TL' }. Comma is a thousands
 * separator here (Civitatis's own formatting), not a decimal mark. */
function parseMoneyLine(raw) {
  if (!raw) return { amount: null, currency: null };
  const m = /^([\d,]+(?:\.\d+)?)\s*([A-Za-z]{2,3})$/.exec(raw.trim());
  if (!m) return { amount: null, currency: null };
  const amount = parseFloat(m[1].replace(/,/g, ''));
  if (!Number.isFinite(amount)) return { amount: null, currency: null };
  return { amount, currency: m[2].toUpperCase() };
}

/**
 * Parses one Civitatis email into a normalized structured object.
 * Never throws for malformed content — always returns a result object
 * with `ok` and, on failure, `needsReview` + `reasons`.
 *
 * @param {{
 *   from: string, subject: string, body: string,
 *   gmailMessageId: string, gmailThreadId: string, receivedAt: string,
 * }} message
 */
function parseCivitatisEmail(message) {
  const { from, subject, body, gmailMessageId, gmailThreadId, receivedAt } = message || {};
  const rawSubject = typeof subject === 'string' ? subject : '';

  const base = { rawSubject, gmailMessageId: gmailMessageId || null, gmailThreadId: gmailThreadId || null, receivedAt: receivedAt || null };

  const detection = detectCivitatisEvent({ from, subject });
  if (detection.classification === 'ignored') {
    return { ok: false, status: 'ignored', reasons: [detection.reason], ...base };
  }
  if (detection.classification === 'needs_review') {
    return { ok: false, status: 'needs_review', reasons: [detection.reason], externalBookingId: detection.externalBookingIdFromSubject, ...base };
  }

  const eventType = detection.classification; // 'new_booking' | 'modified'

  // A genuinely empty/unreadable body for a message we already know, from
  // its subject, is a reservation event is an infrastructure-level
  // problem (a fetch/decode failure upstream), not a content problem —
  // distinct from needs_review, where the body is present but some field
  // in it is missing or unrecognized.
  if (!body || !String(body).trim()) {
    return { ok: false, status: 'parse_error', reasons: ['message body is empty or unreadable'], externalBookingId: detection.externalBookingIdFromSubject, eventType, ...base };
  }

  const lines = compactLines(body);
  const reasons = [];

  // Reservation number: when the body states one, it must agree with the
  // subject-derived value ("validated against the body", not just
  // extracted from one place and trusted blindly) — a disagreement is
  // never silently resolved either way and always goes to needs_review.
  //
  // When the body's "Reservation number:" field cannot be found/parsed at
  // all, fall back to the numeric ID already extracted from the subject.
  // This is safe specifically because subjectReservationNumber only ever
  // has a value here as a result of eventDetector having matched one of
  // the two strictly-anchored, already-recognized subject patterns ("New
  // booking A########:" / "Booking A######## modified:") earlier in this
  // function — an unrecognized subject never reaches this point (it was
  // already routed to needs_review/ignored above), so this fallback can
  // never fire for an unknown subject shape.
  const bodyReservationNumber = findLabelValue(lines, LABEL_NAMES.RESERVATION_NUMBER);
  const subjectReservationNumber = detection.externalBookingIdFromSubject;
  let externalBookingId = null;
  let reservationNumberSource = null;
  if (!subjectReservationNumber) {
    reasons.push('missing reservation number in subject');
  } else if (!bodyReservationNumber) {
    externalBookingId = subjectReservationNumber;
    reservationNumberSource = 'subject_fallback';
  } else if (bodyReservationNumber.replace(/\D/g, '') !== subjectReservationNumber) {
    reasons.push(`reservation number mismatch between subject (${subjectReservationNumber}) and body (${bodyReservationNumber})`);
  } else {
    externalBookingId = subjectReservationNumber;
    reservationNumberSource = 'body';
  }

  const activityName = findLabelValue(lines, LABEL_NAMES.ACTIVITY);
  const city = findLabelValue(lines, LABEL_NAMES.CITY);
  const languageRaw = findLabelValue(lines, LABEL_NAMES.LANGUAGE);
  const internalCode = findLabelValue(lines, LABEL_NAMES.INTERNAL_CODE);
  const dateRaw = findLabelValue(lines, LABEL_NAMES.DATE);
  const hourRaw = findLabelValue(lines, LABEL_NAMES.HOUR);
  const durationRaw = findLabelValue(lines, LABEL_NAMES.DURATION);
  const peopleRaw = findLabelValue(lines, LABEL_NAMES.PEOPLE);
  const retailRaw = findLabelValue(lines, LABEL_NAMES.RETAIL_PRICE);
  const netRaw = findLabelValue(lines, LABEL_NAMES.NET_PRICE);

  if (!internalCode) reasons.push('missing "Internal code:" field — cannot match a DeseTour tour');

  let tourLanguage = null;
  let languageCode = null;
  if (!languageRaw) {
    reasons.push('missing "Language:" field');
  } else {
    const langResult = mapCivitatisLanguage(languageRaw);
    if (!langResult.ok) reasons.push(langResult.reason);
    else { tourLanguage = langResult.name; languageCode = langResult.code; }
  }

  let date = null;
  if (!dateRaw) {
    reasons.push('missing "Date:" field');
  } else {
    const dateResult = parseCivitatisDate(dateRaw);
    if (!dateResult.ok) reasons.push(dateResult.reason);
    else date = dateResult.isoDate;
  }

  let time = null;
  if (!hourRaw) {
    reasons.push('missing "Hour:" field');
  } else {
    const timeResult = parseCivitatisTime(hourRaw);
    if (!timeResult.ok) reasons.push(timeResult.reason);
    else time = timeResult.time;
  }

  const { adultCount, childCount } = extractGuestCounts(peopleRaw);
  if (adultCount === null) reasons.push('could not determine adult guest count from "People:" field');
  const totalGuestCount = adultCount === null ? null : adultCount + (childCount || 0);

  const passengers = extractPassengers(lines);
  // The "People:" field is the authoritative guest count — it is never
  // derived from how many "Passenger information N:" sections happened
  // to parse. If the two disagree, that is surfaced for manual review
  // rather than silently trusting (or "correcting" toward) either one.
  if (totalGuestCount !== null && passengers.length > 0 && passengers.length !== totalGuestCount) {
    reasons.push(`passenger count (${passengers.length}) does not match the "People:" field guest count (${totalGuestCount})`);
  }

  const retail = parseMoneyLine(retailRaw);
  if (retail.amount === null) reasons.push('missing or unparseable "Retail price:" field');
  const net = parseMoneyLine(netRaw);
  if (net.amount === null) reasons.push('missing or unparseable "Net price:" field');

  const { name: clientName, surname: clientSurname, email: clientEmail, phone: clientDetailsPhone } = extractClientDetails(lines);
  if (!clientName && !clientSurname) reasons.push('missing "Client details:" booking contact');
  const clientFullName = [clientName, clientSurname].filter(Boolean).join(' ').trim() || null;

  // "phones" merges any phone found directly in Client details with any
  // found in a modification email's "Modified information" block — both
  // are the same underlying signal (a contact phone number for the
  // booking), just surfaced in different places depending on event type.
  const modifiedPhones = extractModifiedPhones(lines);
  const phones = Array.from(new Set([clientDetailsPhone, ...modifiedPhones].filter(Boolean)));

  const parsed = {
    ...base,
    eventType,
    externalBookingId,
    reservationNumberSource,
    activityName,
    internalCode,
    city,
    languageRaw,
    tourLanguage,
    languageCode,
    date,
    time,
    durationRaw,
    adultCount,
    childCount,
    totalGuestCount,
    passengers,
    retailAmount: retail.amount,
    retailCurrency: retail.currency,
    netAmount: net.amount,
    netCurrency: net.currency,
    clientName,
    clientSurname,
    clientFullName,
    clientEmail,
    phones,
  };

  if (reasons.length > 0 || externalBookingId === null) {
    return { ok: false, status: 'needs_review', reasons, ...parsed };
  }

  return { ok: true, status: 'parsed', reasons: [], ...parsed };
}

module.exports = { parseCivitatisEmail, extractGuestCounts, parseMoneyLine, compactLines };
