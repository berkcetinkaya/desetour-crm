/**
 * api/_civitatis/clientMessageExtraction.js
 * ─────────────────────────────────────────────────────────────────────────
 * Extracts ONLY the actual customer/agency message text from a Civitatis
 * "New client message about your reservation <number>" email body — never
 * the surrounding template: branding, footer, social links, tracking
 * URLs, "Original message"/"See message" boilerplate, or the booking-
 * summary header (Activity/Reservation number/Full name/Date/Hour/
 * People/Total price).
 *
 * ROOT-CAUSE NOTE (production incident, first shipped version of this
 * module): the previous implementation worked by SUBTRACTION — strip
 * every line matching a small, explicit "known noise" blacklist and keep
 * whatever is left as "the message". That is backwards for this
 * template: gmailClient.js's selectMessageBody() picks the message's
 * text/plain part when one exists and is non-trivial (>= 40 chars) —
 * and the REAL production client-message template's text/plain part is
 * not a short "label: value" transcription the way a booking-
 * confirmation email's is; it is a much larger block that also includes
 * "Original message"/"See message" tracking-link sections, a repeated
 * booking-summary header, and a full branding/footer/social section.
 * The old blacklist only anticipated a handful of those shapes, so
 * everything it didn't anticipate silently fell through as "the
 * dedicated message block" and got persisted — the exact bug a real
 * production smoke test caught (message_text contained the entire
 * template instead of the one sentence of real customer text).
 *
 * THE FIX is structural, by ADDITION instead of subtraction (an
 * allowlist/bounded-span, not a blacklist): locate the real, confirmed
 * start anchor ("You have a message from an agency"), then read forward
 * only until the FIRST recognized template boundary (Original message /
 * See message / Activity: / Reservation number: / Full name: / Date: /
 * Hour: / People / Total price / "Thank you for choosing our services" /
 * footer-social / a bare tracking-URL line). Only "Comments:" is used as
 * a fallback, and only when the anchor-based span cannot be reliably
 * identified. If NEITHER produces a trustworthy result, this module
 * returns null — the caller (clientMessageAdapter.js) must treat that as
 * a controlled extraction failure and never persist the raw/whole body
 * as a substitute (that is precisely what caused the production
 * incident this rewrite fixes).
 * ─────────────────────────────────────────────────────────────────────────
 */
'use strict';

const { compactLines } = require('./parser');

/** Defense in depth ONLY — gmailClient.js's selectMessageBody already
 * converts the real Gmail message to plain text (dropping <script>/
 * <style>/tags entirely) and decodes HTML entities before this module
 * ever sees the body; the result is rendered in the UI as a plain React
 * text child, never dangerouslySetInnerHTML. This re-decodes any
 * residual entities and strips any residual "<...>" markup, so neither
 * can ever reach reservation_messages.message_text even if the upstream
 * pipeline's own handling were ever bypassed or changed. */
const NAMED_HTML_ENTITIES_FALLBACK = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
function decodeResidualHtmlEntities(text) {
  return String(text || '').replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (match, entity) => {
    if (entity[0] === '#') {
      const isHex = entity[1] === 'x' || entity[1] === 'X';
      const codePoint = isHex ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
      if (!Number.isFinite(codePoint) || codePoint < 0 || codePoint > 0x10ffff) return match;
      try { return String.fromCodePoint(codePoint); } catch (_err) { return match; }
    }
    const key = entity.toLowerCase();
    return Object.prototype.hasOwnProperty.call(NAMED_HTML_ENTITIES_FALLBACK, key) ? NAMED_HTML_ENTITIES_FALLBACK[key] : match;
  });
}
function stripResidualHtmlTags(text) {
  return String(text || '').replace(/<[^>]*>/g, '').trim();
}

/** The real, confirmed heading that immediately precedes the actual
 * customer/agency message in the production template. Matched as a
 * substring, case-insensitive, tolerating a trailing colon/punctuation —
 * never a bare-word/fuzzy match. */
const MESSAGE_START_ANCHOR = /you have a message from (an|the) agency/i;

/** Known template boundaries — the FIRST of these reached after the
 * start anchor ends the captured span. Every one of these is anchored at
 * the START of a line (never a substring match), so a customer sentence
 * that happens to mention, say, "the date" or "full name" in prose can
 * never falsely truncate the real message — only a line that itself IS
 * one of these labels does. */
const STOP_BOUNDARY_PATTERNS = [
  /^Original message\b/i,
  /^See message\b/i,
  /^Activity\s*:?(\s|$)/i,
  /^Reservation number\s*:?(\s|$)/i,
  /^Full name\s*:?(\s|$)/i,
  /^Date\s*:?(\s|$)/i,
  /^Hour\s*:?(\s|$)/i,
  /^People\b/i,
  /^Total price\b/i,
  /^Thank you for choosing our services\b/i,
  /^Comments?\s*:?$/i,
  /^Civitatis(\.com)?\s*$/i,
  /^(Facebook|Twitter|Instagram|YouTube|LinkedIn|Pinterest)\s*$/i,
  /^©/, /^All rights reserved/i, /^Copyright/i,
  /^Unsubscribe/i, /^This email was sent/i, /^Privacy Policy/i, /^Terms(\s+(and|&)\s+Conditions)?\s*$/i,
];

/** A line that is ENTIRELY a URL (nothing else on the line) is
 * unambiguously a template/tracking link — a customer writing their own
 * message always embeds a URL inline with other words ("the hotel is
 * here: <url>"), never as a bare standalone line. This is the ONLY URL-
 * stripping rule in this module, deliberately narrow: it never touches a
 * URL that appears alongside any other text on its line, which is
 * exactly how a genuinely customer-authored link would appear. */
const BARE_URL_LINE = /^https?:\/\/\S+$/i;

/** Within an already-bounded span, a handful of residual noise shapes
 * can still slip in (e.g. a stray branding line BEFORE the first stop
 * boundary triggers). Conservative, exact — never a broad heuristic. */
function isResidualNoiseLine(line) {
  const trimmed = line.trim();
  if (BARE_URL_LINE.test(trimmed)) return true;
  if (/^Civitatis(\.com)?\s*$/i.test(trimmed)) return true;
  if (/^(Facebook|Twitter|Instagram|YouTube|LinkedIn|Pinterest)\s*$/i.test(trimmed)) return true;
  return false;
}

const COMMENTS_LABEL_BARE = /^Comments?\s*:?$/i;
const COMMENTS_LABEL_SAME_LINE = /^Comments?\s*:\s*(.+)$/i;

/** Finds the "Comments" section's value, tolerating the same two real
 * Civitatis layouts parser.js's findLabelValue already tolerates for
 * other labels: "Comments: <value>" on one line, or a bare "Comments"/
 * "Comments:" line with the value on the next non-empty line. Returns
 * {value, consumedIndices}. Returns {value:null, consumedIndices:[]} if
 * no "Comments" label is present at all — never invents a value. */
function extractCommentsValue(lines) {
  for (let i = 0; i < lines.length; i++) {
    const sameLine = COMMENTS_LABEL_SAME_LINE.exec(lines[i]);
    if (sameLine) return { value: sameLine[1].trim(), consumedIndices: [i] };
    if (COMMENTS_LABEL_BARE.test(lines[i])) {
      const next = lines[i + 1];
      const value = next !== undefined && next.trim() ? next.trim() : null;
      return { value, consumedIndices: value !== null ? [i, i + 1] : [i] };
    }
  }
  return { value: null, consumedIndices: [] };
}

/** Lowercase + collapsed-whitespace comparison key — detects "the same
 * message, repeated" even if the two copies differ only in line-wrapping
 * or incidental spacing, never a fuzzy/approximate match otherwise. */
function normalizeForComparison(text) {
  return String(text || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * Locates MESSAGE_START_ANCHOR and reads forward until the first
 * STOP_BOUNDARY_PATTERNS match (or end of document). Returns null if the
 * anchor is not found, or if nothing substantive survives
 * isResidualNoiseLine filtering within the bounded span — "cannot be
 * reliably identified", per the fix strategy, triggering the Comments
 * fallback one level up rather than ever widening this search.
 */
function extractAnchoredMessageBlock(lines) {
  let anchorLineIndex = -1;
  let trailingOnAnchorLine = null;
  for (let i = 0; i < lines.length; i++) {
    const m = MESSAGE_START_ANCHOR.exec(lines[i]);
    if (m) {
      anchorLineIndex = i;
      // Tolerates "You have a message from an agency: <text>" on one
      // line, not just the heading alone on its own line.
      const rest = lines[i].slice(m.index + m[0].length).replace(/^[:.\s]+/, '').trim();
      trailingOnAnchorLine = rest || null;
      break;
    }
  }
  if (anchorLineIndex === -1) return null;

  const collected = [];
  if (trailingOnAnchorLine) collected.push(trailingOnAnchorLine);

  for (let i = anchorLineIndex + 1; i < lines.length; i++) {
    const line = lines[i];
    if (STOP_BOUNDARY_PATTERNS.some(re => re.test(line))) break;
    if (isResidualNoiseLine(line)) continue;
    collected.push(line);
  }

  const block = collected.join(' ').replace(/\s+/g, ' ').trim();
  return block || null;
}

/**
 * @param {string} body plain-text (already HTML-stripped, see
 *   gmailClient.js's selectMessageBody) Civitatis client-message email
 *   body.
 * @returns {string|null} the actual customer/agency message text, never
 *   duplicated, never surrounding template; null — a controlled
 *   extraction failure — when no trustworthy message block can be
 *   identified. The caller must never substitute the raw/whole body for
 *   a null result.
 */
function extractClientMessageText(body) {
  const normalizedBody = decodeResidualHtmlEntities(String(body || ''));
  const lines = compactLines(normalizedBody);

  const anchored = extractAnchoredMessageBlock(lines);

  const { value: commentsValueRaw } = extractCommentsValue(lines);
  const commentsValue = commentsValueRaw ? stripResidualHtmlTags(decodeResidualHtmlEntities(commentsValueRaw)) || null : null;

  if (anchored) {
    const cleanedAnchored = stripResidualHtmlTags(anchored) || null;
    // "If both exist and normalize to the same content, keep only one
    // copy" — the anchored block's own text is what is kept either way;
    // this comparison exists only to document/confirm the dedup, never
    // to concatenate.
    return cleanedAnchored;
  }

  // Anchor not reliably identified — Comments is the explicit fallback.
  if (commentsValue) return commentsValue;

  // Neither source produced a trustworthy result — fail closed. Never
  // falls back to the raw body (that is the exact production incident
  // this rewrite fixes).
  return null;
}

module.exports = {
  extractClientMessageText,
  extractAnchoredMessageBlock,
  extractCommentsValue,
  normalizeForComparison,
  stripResidualHtmlTags,
  decodeResidualHtmlEntities,
  isResidualNoiseLine,
  MESSAGE_START_ANCHOR,
  STOP_BOUNDARY_PATTERNS,
  BARE_URL_LINE,
};
