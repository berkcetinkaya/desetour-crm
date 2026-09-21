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

// ── Label constants (exact text as observed in real Civitatis emails) ──────
const LABELS = {
  ACTIVITY: 'Activity:',
  RESERVATION_NUMBER: 'Reservation number:',
  CITY: 'City:',
  LANGUAGE: 'Language:',
  INTERNAL_CODE: 'Internal code:',
  DATE: 'Date:',
  HOUR: 'Hour:',
  DURATION: 'Duration:',
  PEOPLE: 'People:',
  RETAIL_PRICE: 'Retail price:',
  NET_PRICE: 'Net price:',
  CLIENT_DETAILS: 'Client details:',
};
const SIMPLE_LABELS = [
  LABELS.ACTIVITY, LABELS.RESERVATION_NUMBER, LABELS.CITY, LABELS.LANGUAGE,
  LABELS.INTERNAL_CODE, LABELS.DATE, LABELS.HOUR, LABELS.DURATION,
  LABELS.PEOPLE, LABELS.RETAIL_PRICE, LABELS.NET_PRICE,
];
const PASSENGER_LABEL = /^Passenger information (\d+):$/i;
const MODIFIED_INFO_LABEL = /^Modified information:?$/i;

function isKnownLabelLine(line) {
  return SIMPLE_LABELS.includes(line)
    || line === LABELS.CLIENT_DETAILS
    || PASSENGER_LABEL.test(line)
    || MODIFIED_INFO_LABEL.test(line);
}

/** Splits body text into non-empty, trimmed lines — blank lines in
 * Civitatis's format are pure visual separators with no data of their
 * own, so compacting them away simplifies every extraction rule below
 * without losing information. */
function compactLines(body) {
  return String(body || '')
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map(l => l.trim())
    .filter(l => l.length > 0);
}

/**
 * Finds a label's value, tolerating BOTH real Civitatis layouts:
 *   "Reservation number:"      (label alone, value on the next line —
 *   "41534177"                  the plain-text export's usual shape)
 * and:
 *   "Reservation number: 41534177"   (label + value on one line — how a
 *                                      single HTML table cell containing
 *                                      both often converts)
 * Never invents a value: if the label is found but no value follows
 * (either nothing on the same line, or the next line is itself another
 * known label / absent), returns null rather than guessing.
 */
function findLabelValue(lines, label) {
  const idx = lines.findIndex(l => l === label || (l.startsWith(label) && l.length > label.length));
  if (idx === -1) return null;
  const line = lines[idx];
  if (line === label) {
    const next = lines[idx + 1];
    if (next === undefined || isKnownLabelLine(next)) return null;
    return next;
  }
  const inline = line.slice(label.length).trim();
  return inline.length > 0 ? inline : null;
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

/** "Client details:" block: Name: X / Surname: Y, order-tolerant, scanned
 * only within the few lines immediately following the label so it never
 * accidentally consumes an unrelated later field. Email:/Phone: are
 * tolerated as optional additional lines in the same block — none of the
 * real examples supplied for this integration show them, so they are
 * never required or invented, but if a real Civitatis email does include
 * them here they are the only safe, non-fuzzy signal available for
 * matching the booking contact against an existing CRM customer (see
 * matching.js), so they are worth recognizing if present. */
const CLIENT_SUB_LABEL_LINE = /^(Name|Surname|Email|Phone):?\s*(.*)$/i;
const CLIENT_SUB_LABEL_BARE = /^(Name|Surname|Email|Phone):?\s*$/i;
const CLIENT_SUB_LABEL_KEY = { name: 'name', surname: 'surname', email: 'email', phone: 'phone' };

function extractClientDetails(lines) {
  const idx = lines.indexOf(LABELS.CLIENT_DETAILS);
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
      result[key] = inline;
      i += 1;
    } else {
      // "Name:" (or Surname/Email/Phone) alone on its own line -> the
      // value is on the next line, as long as that next line isn't
      // itself another bare sub-label or a top-level field boundary.
      const next = lines[i + 1];
      if (next !== undefined && !isKnownLabelLine(next) && !CLIENT_SUB_LABEL_BARE.test(next)) {
        result[key] = next.trim();
        i += 2;
      } else {
        i += 1;
      }
    }
  }
  return result;
}

/** "Modified information" / "Phone" block (modification emails only):
 * captures any consecutive phone-shaped lines following a "Phone"
 * sub-label as a raw list — this migration's parser output only needs
 * "phones if present", not which entry is old vs. new, which Civitatis
 * does not label explicitly. */
function extractModifiedPhones(lines) {
  const idx = lines.findIndex(l => MODIFIED_INFO_LABEL.test(l));
  if (idx === -1) return [];
  let cursor = idx + 1;
  if (cursor >= lines.length || !/^phone:?$/i.test(lines[cursor])) return [];
  cursor++;
  const phones = [];
  while (cursor < lines.length && /^\+?\d[\d\s-]{4,}$/.test(lines[cursor])) {
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

  // Reservation number: subject-derived value must be present in the body
  // too and the two must agree — this is the "validated against the body"
  // requirement, not just extracted from one place and trusted blindly.
  const bodyReservationNumber = findLabelValue(lines, LABELS.RESERVATION_NUMBER);
  const subjectReservationNumber = detection.externalBookingIdFromSubject;
  let externalBookingId = null;
  if (!subjectReservationNumber) {
    reasons.push('missing reservation number in subject');
  } else if (!bodyReservationNumber) {
    reasons.push('missing "Reservation number:" field in body');
  } else if (bodyReservationNumber.replace(/\D/g, '') !== subjectReservationNumber) {
    reasons.push(`reservation number mismatch between subject (${subjectReservationNumber}) and body (${bodyReservationNumber})`);
  } else {
    externalBookingId = subjectReservationNumber;
  }

  const activityName = findLabelValue(lines, LABELS.ACTIVITY);
  const city = findLabelValue(lines, LABELS.CITY);
  const languageRaw = findLabelValue(lines, LABELS.LANGUAGE);
  const internalCode = findLabelValue(lines, LABELS.INTERNAL_CODE);
  const dateRaw = findLabelValue(lines, LABELS.DATE);
  const hourRaw = findLabelValue(lines, LABELS.HOUR);
  const durationRaw = findLabelValue(lines, LABELS.DURATION);
  const peopleRaw = findLabelValue(lines, LABELS.PEOPLE);
  const retailRaw = findLabelValue(lines, LABELS.RETAIL_PRICE);
  const netRaw = findLabelValue(lines, LABELS.NET_PRICE);

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
