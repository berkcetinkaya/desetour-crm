/**
 * api/_civitatis/parser.js
 * ─────────────────────────────────────────────────────────────────────────
 * The deterministic Civitatis reservation-email parser. No AI/LLM calls,
 * no network access, no Supabase access — a pure function from
 * { from, subject, body, gmailMessageId, gmailThreadId, receivedAt } to a
 * normalized structured object (or a needs_review/parse_error result).
 * Fully testable without Gmail: callers hand it plain strings already
 * extracted from a Gmail message by api/_civitatis/gmailClient.js.
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

// Civitatis's own documented placeholder for "this product has no fixed
// structured check-in time" — semantically identical to the Hour field
// being entirely absent. WHITELISTED, exact match only (after
// whitespace/case normalization) — never a generic "any unrecognized
// Hour prose means no time" rule. Lowercase because the comparison site
// always lowercases hourRaw before comparing.
const HOUR_NO_FIXED_TIME_PLACEHOLDER = 'see more information in the voucher';

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

// "information" is optional: real Civitatis emails have been observed
// both as "Passenger information N:" (value on a following "Full name"
// sub-label or bare next line — see extractPassengers) and as a
// shorter "Passenger N: value" form with the name given directly on
// the same line. Group 2 captures whatever (if anything) follows the
// colon on that same line — empty when the value is on a later line.
const PASSENGER_LABEL_LINE = /^Passenger(?: information)? (\d+):?\s*(.*)$/i;
const MODIFIED_INFO_LABEL = /^Modified information:?$/i;

function isKnownLabelLine(line) {
  for (const label of SIMPLE_LABEL_LIST) {
    if (LABEL_MATCHERS.get(label).start.test(line)) return true;
  }
  return CLIENT_DETAILS_MATCHERS.start.test(line)
    || CLIENT_NAME_LABEL_LINE.test(line)
    || PASSENGER_LABEL_LINE.test(line)
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
// Alternate real-world passenger name shape: TWO separate sub-labels,
// "Name" and "Last Name", each independently either inline
// ("Name: CARLOS ROBERTO") or with its value on the next line ("Name" /
// "CARLOS ROBERTO") — distinct from the single "Full name" sub-label
// above. The two values are concatenated ("Name" + " " + "Last Name") to
// form one fullName, e.g. "CARLOS ROBERTO" + "LARRUBIA" ->
// "CARLOS ROBERTO LARRUBIA".
const PASSENGER_NAME_SUB_LABEL_BARE = /^Name:?$/i;
const PASSENGER_NAME_SUB_LABEL_LINE = /^Name:?\s*(.*)$/i;
const PASSENGER_LAST_NAME_SUB_LABEL_BARE = /^Last Name:?$/i;
const PASSENGER_LAST_NAME_SUB_LABEL_LINE = /^Last Name:?\s*(.*)$/i;

// Literal parser label TEXT that must NEVER itself become a passenger
// fullName value. This is the exact bug a real Civitatis message
// triggered: a bare "Name" sub-label line, misread by an earlier layout
// assumption as if it were itself the value, produced
// passengers:[{fullName:"Name"},...]. Checked as the final gate before
// ANY fullName is accepted, on every code path below — inline capture,
// next-line capture, and the no-sub-label fallback alike — regardless of
// which shape produced the candidate text.
const RESERVED_PASSENGER_LABEL_VALUES = new Set(['name', 'last name', 'full name', 'surname']);
function isReservedLabelValue(text) {
  return RESERVED_PASSENGER_LABEL_VALUES.has(String(text == null ? '' : text).trim().toLowerCase());
}

/** Reads one sub-label's value starting at lines[idx], tolerating both
 * "Label: value" (same line) and bare "Label" / "Label:" alone (value on
 * the next line) shapes — mirrors the tolerance every other label in
 * this parser already gets. Returns { value, nextIdx } when lines[idx]
 * matches this sub-label at all (value may itself be null if no usable
 * value follows); returns null if lines[idx] does not match the label.
 * Never filters for reserved-label text itself — callers apply
 * isReservedLabelValue to the result. */
function readSubLabelValue(lines, idx, bareRe, lineRe) {
  if (idx >= lines.length) return null;
  const m = lineRe.exec(lines[idx]);
  if (!m) return null;
  const inline = m[1].trim();
  if (inline) return { value: inline, nextIdx: idx + 1 };
  const next = lines[idx + 1];
  if (next !== undefined && !isKnownLabelLine(next) && !bareRe.test(next)) {
    return { value: next, nextIdx: idx + 2 };
  }
  return { value: null, nextIdx: idx + 1 };
}

/** Passenger blocks: "Passenger information N:" (or the shorter
 * "Passenger N:") then one of three real shapes: the name directly on
 * the SAME line ("Passenger 1: JOHN DOE" — no sub-label at all); a
 * "Full name" sub-label (same-line or next-line value); or separate
 * "Name" + "Last Name" sub-labels (each same-line or next-line,
 * concatenated into one fullName — see PASSENGER_NAME_SUB_LABEL_LINE
 * above); or (tolerated variant) the name directly on the line following
 * the bare passenger label with no sub-label at all. Returned in the
 * order encountered, sort_order is 0-based position among passengers
 * found — never re-derived from the Civitatis "N" itself, which is
 * display numbering, not guaranteed to start at 1 or be contiguous.
 * Supports any number of repeated "Passenger [information] N:" sections.
 * A candidate fullName that is itself literal label text (isReservedLabelValue)
 * is NEVER pushed — that passenger is skipped rather than recorded with
 * garbage data. */
function extractPassengers(lines) {
  const passengers = [];
  for (let i = 0; i < lines.length; i++) {
    const passengerMatch = PASSENGER_LABEL_LINE.exec(lines[i]);
    if (!passengerMatch) continue;
    const inlineName = passengerMatch[2].trim();
    if (inlineName && !FULL_NAME_LABEL_BARE.test(inlineName)) {
      if (!isReservedLabelValue(inlineName)) {
        passengers.push({ fullName: inlineName, sortOrder: passengers.length });
      }
      continue;
    }

    let cursor = i + 1;
    if (cursor < lines.length) {
      const m = FULL_NAME_LABEL_LINE.exec(lines[cursor]);
      if (m) {
        const inline = m[1].trim();
        if (inline) {
          if (!isReservedLabelValue(inline)) {
            passengers.push({ fullName: inline, sortOrder: passengers.length });
          }
          continue;
        }
        cursor++; // "Full name:" alone -> the value is on the next line
        const nameLine = lines[cursor];
        if (
          nameLine !== undefined
          && !isKnownLabelLine(nameLine)
          && !PASSENGER_LABEL_LINE.test(nameLine)
          && !FULL_NAME_LABEL_BARE.test(nameLine)
          && !isReservedLabelValue(nameLine)
        ) {
          passengers.push({ fullName: nameLine, sortOrder: passengers.length });
        }
        continue;
      }
    }

    const nameSub = readSubLabelValue(lines, cursor, PASSENGER_NAME_SUB_LABEL_BARE, PASSENGER_NAME_SUB_LABEL_LINE);
    if (nameSub) {
      const lastSub = readSubLabelValue(lines, nameSub.nextIdx, PASSENGER_LAST_NAME_SUB_LABEL_BARE, PASSENGER_LAST_NAME_SUB_LABEL_LINE);
      const nameValue = nameSub.value && !isReservedLabelValue(nameSub.value) ? nameSub.value : null;
      const lastNameValue = lastSub && lastSub.value && !isReservedLabelValue(lastSub.value) ? lastSub.value : null;
      const combined = [nameValue, lastNameValue].filter(Boolean).join(' ').trim();
      if (combined && !isReservedLabelValue(combined)) {
        passengers.push({ fullName: combined, sortOrder: passengers.length });
      }
      continue;
    }

    const nameLine = lines[cursor];
    if (
      nameLine !== undefined
      && !isKnownLabelLine(nameLine)
      && !PASSENGER_LABEL_LINE.test(nameLine)
      && !FULL_NAME_LABEL_BARE.test(nameLine)
      && !isReservedLabelValue(nameLine)
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
// Real-world variant with no "Client details:" block header at all: the
// contact's given name arrives as its own top-level "Client name:" line
// instead of a "Name:" sub-label nested under that header. Surname/
// Email/Phone, when present, still follow as their own top-level
// "Label: value" lines, scanned the same way as the block form below.
const CLIENT_NAME_LABEL_LINE = /^Client name:?\s*(.*)$/i;

function stripContactDetailsMarker(value) {
  return value == null ? value : value.replace(CONTACT_DETAILS_MARKER_RE, '').trim();
}

/** Scans up to 12 lines starting at `startIdx` for Name/Surname/Email/
 * Phone sub-labels (order-tolerant, same-line or next-line value),
 * writing into `result` — shared by both the "Client details:" block
 * shape and the headerless "Client name:" shape below. Never overwrites
 * a field `result` already carries (relevant only for the headerless
 * path, where `name` is already set from "Client name:" itself before
 * this runs). Stops at the first line that either fails to match a
 * sub-label or is itself a top-level field boundary — never scans past
 * the contact block into unrelated content. */
function scanClientSubFields(lines, startIdx, result) {
  const end = Math.min(startIdx + 12, lines.length);
  let i = startIdx;
  while (i < end) {
    const line = lines[i];
    if (isKnownLabelLine(line)) break;
    const m = CLIENT_SUB_LABEL_LINE.exec(line);
    if (!m) break;
    const key = CLIENT_SUB_LABEL_KEY[m[1].toLowerCase()];
    const inline = m[2].trim();
    if (inline) {
      if (result[key] == null) result[key] = stripContactDetailsMarker(inline);
      i += 1;
    } else {
      // "Name:" (or Surname/Email/Phone) alone on its own line -> the
      // value is on the next line, as long as that next line isn't
      // itself another bare sub-label or a top-level field boundary.
      const next = lines[i + 1];
      if (next !== undefined && !isKnownLabelLine(next) && !CLIENT_SUB_LABEL_BARE.test(next)) {
        if (result[key] == null) result[key] = stripContactDetailsMarker(next.trim());
        i += 2;
      } else {
        i += 1;
      }
    }
  }
}

function extractClientDetails(lines) {
  const result = { name: null, surname: null, email: null, phone: null };

  const detailsIdx = lines.findIndex(l => CLIENT_DETAILS_MATCHERS.bare.test(l));
  if (detailsIdx !== -1) {
    scanClientSubFields(lines, detailsIdx + 1, result);
    return result;
  }

  // No "Client details:" header found — try the headerless "Client
  // name:" variant instead. Exact label text only, same-line or
  // next-line value, never inferred from surrounding prose.
  const clientNameIdx = lines.findIndex(l => CLIENT_NAME_LABEL_LINE.test(l));
  if (clientNameIdx === -1) return result;
  const m = CLIENT_NAME_LABEL_LINE.exec(lines[clientNameIdx]);
  const inline = m[1].trim();
  if (inline) {
    result.name = stripContactDetailsMarker(inline);
    scanClientSubFields(lines, clientNameIdx + 1, result);
  } else {
    const next = lines[clientNameIdx + 1];
    if (next !== undefined && !isKnownLabelLine(next)) {
      result.name = stripContactDetailsMarker(next.trim());
      scanClientSubFields(lines, clientNameIdx + 2, result);
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

// Recognized leading currency symbols -> ISO currency code. Deterministic
// lookup only — never a heuristic/guessed mapping. Extend only when a
// new symbol has actually been observed in a real Civitatis email.
const CURRENCY_SYMBOL_TO_CODE = {
  '€': 'EUR',
};

/** "4,800 TL" -> { amount: 4800, currency: 'TL' } (trailing currency
 * CODE — comma is a thousands separator here, Civitatis's own
 * formatting, not a decimal mark). "€ 205.40" -> { amount: 205.40,
 * currency: 'EUR' } (leading currency SYMBOL, mapped via
 * CURRENCY_SYMBOL_TO_CODE — decimal point, no thousands separator
 * observed in this form). Exactly one of the two shapes must match;
 * anything else (unrecognized symbol, both/neither present) returns
 * null/null rather than guessing. */
function parseMoneyLine(raw) {
  if (!raw) return { amount: null, currency: null };
  const text = raw.trim();

  const trailingCode = /^([\d,]+(?:\.\d+)?)\s*([A-Za-z]{2,3})$/.exec(text);
  if (trailingCode) {
    const amount = parseFloat(trailingCode[1].replace(/,/g, ''));
    if (!Number.isFinite(amount)) return { amount: null, currency: null };
    return { amount, currency: trailingCode[2].toUpperCase() };
  }

  const leadingSymbol = /^([^\s\d])\s*([\d,]+(?:\.\d+)?)$/.exec(text);
  if (leadingSymbol) {
    const code = CURRENCY_SYMBOL_TO_CODE[leadingSymbol[1]];
    if (!code) return { amount: null, currency: null };
    const amount = parseFloat(leadingSymbol[2].replace(/,/g, ''));
    if (!Number.isFinite(amount)) return { amount: null, currency: null };
    return { amount, currency: code };
  }

  return { amount: null, currency: null };
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
  // Cancellation emails are a structurally different event — no Date/
  // People/Retail/Net-price fields to extract, no reservation to create
  // or update. They are deliberately NEVER routed through the rest of
  // this function (which exists to parse a booking creation/modification
  // email's body) — that is exactly why this returns here, before any
  // body-field parsing begins. Handled entirely by the separate
  // api/_civitatis/cancellationAdapter.js + the dedicated
  // cancel_civitatis_booking RPC, which planCivitatisIngestion never
  // even sees (see runCivitatisWriteOrchestration's cancellation/
  // non-cancellation split) — this branch is defense in depth so that IF
  // a cancellation message were ever handed to this function anyway
  // (e.g. the single-booking manual-mode filter, which calls this
  // function on every fetched message to read externalBookingId off the
  // result), it still fails closed with ok:false rather than being
  // silently mis-parsed as a new_booking/modified event, while still
  // correctly surfacing externalBookingId so that filter keeps working.
  if (detection.classification === 'cancelled') {
    return {
      ok: false, status: 'cancellation_event',
      reasons: ['this is a Civitatis cancellation email, handled by the separate cancellation pipeline — never by parseCivitatisEmail/ingest_civitatis_booking'],
      externalBookingId: detection.externalBookingIdFromSubject, ...base,
    };
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

  // HOUR is OPTIONAL: a Civitatis product that never states a check-in
  // hour (e.g. "Bosforo y Barrio Sultanahmet") is a legitimate booking,
  // not a parse failure — time stays null and NOTHING is pushed to
  // reasons. A HOUR field that IS present but does not match a
  // recognized time pattern is a different situation entirely (still
  // fails closed, exactly as before) — the three possible states are
  // distinguished via timeStatus so downstream layers (the write RPC)
  // can tell "intentionally unknown" apart from "malformed": 'absent'
  // (valid, time stays null), 'parsed' (valid, time is the parsed
  // HH:MM), 'invalid' (fails closed, ok:false, never reaches the RPC).
  //
  // Civitatis has ONE further documented case: the Hour field is
  // PRESENT but its exact value is its own placeholder sentence stating
  // there is no fixed structured time ("See more information in the
  // voucher" — confirmed verbatim on real production booking
  // A40466869, "Estambul Historica" / Português). Semantically this
  // means the SAME thing as an absent Hour field, so it is treated
  // identically: time stays null, timeStatus stays 'absent', nothing is
  // pushed to reasons, and parseCivitatisTime is never even called for
  // it. This is a WHITELIST match against this one known, exact
  // Civitatis sentence (case/whitespace-normalized only — collapsing
  // internal whitespace runs and comparing case-insensitively, never a
  // fuzzy/substring/keyword match), never a general "any unrecognized
  // Hour text means no time" rule — any OTHER non-time text in the Hour
  // field still falls through to parseCivitatisTime below and still
  // fails closed exactly as before. This value is read ONLY from the
  // structured "Hour:" label (via hourRaw = findLabelValue(...) above) —
  // never inferred from pickup-point text, voucher prose, the activity
  // description, or any other field.
  let time = null;
  let timeStatus = 'absent';
  if (hourRaw) {
    const normalizedHour = hourRaw.trim().replace(/\s+/g, ' ').toLowerCase();
    if (normalizedHour === HOUR_NO_FIXED_TIME_PLACEHOLDER) {
      // Same as an absent Hour field — time/timeStatus stay at their
      // 'absent' defaults, no reason pushed.
    } else {
      const timeResult = parseCivitatisTime(hourRaw);
      if (!timeResult.ok) {
        reasons.push(timeResult.reason);
        timeStatus = 'invalid';
      } else {
        time = timeResult.time;
        timeStatus = 'parsed';
      }
    }
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
    timeStatus,
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

// findLabelValue/LABEL_NAMES are additionally exported (Tour Preparation
// Intelligence Phase B2) so the backfill dry-run tool can extract the
// Activity field using the EXACT SAME label-matching logic normal
// ingestion already uses, without re-implementing it and without needing
// a synthetic `from` header to run the full event-classification path
// parseCivitatisEmail itself requires (email_ingestions never stored
// that header — see activityModalityBackfillDryRun.js). No existing
// behavior of this file is changed by adding these two names.
module.exports = { parseCivitatisEmail, extractGuestCounts, parseMoneyLine, compactLines, findLabelValue, LABEL_NAMES };
