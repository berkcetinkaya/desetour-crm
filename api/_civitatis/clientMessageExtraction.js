/**
 * api/_civitatis/clientMessageExtraction.js
 * ─────────────────────────────────────────────────────────────────────────
 * Extracts ONLY the actual customer/agency message text from a Civitatis
 * "New client message about your reservation <number>" email body — never
 * the surrounding template: branding, footer, social links, price/
 * activity summary, or the generic "you have a message" framing copy.
 *
 * Confirmed on real production evidence (one example): the real Civitatis
 * template repeats the SAME message text in more than one visual area —
 * a dedicated message block AND a "Comments" section. This module must
 * never persist that duplicate twice: it prefers the dedicated message
 * block (everything left over after stripping every known template/noise
 * line) when that block is reliably identifiable (non-empty), and falls
 * back to the explicit "Comments" label's value only when no such block
 * remains. When both are present and normalize to the same text, only
 * ONE copy (the dedicated block's own original text) is ever kept.
 *
 * Pure, deterministic, no AI/LLM, no network access — same discipline as
 * api/_civitatis/parser.js, which this module reuses compactLines from.
 * The noise-line patterns below are deliberately conservative/exact
 * (never a broad heuristic that could eat real customer text); as more
 * real client-message emails are observed in production, this list
 * should be the one place to extend — never guessed in advance of real
 * evidence, per this codebase's established convention (see
 * eventDetector.js's own "Confirmed verbatim on real production
 * evidence" comments).
 * ─────────────────────────────────────────────────────────────────────────
 */
'use strict';

const { compactLines } = require('./parser');

// Exact, known-safe noise lines/line-shapes — explicitly the categories
// PART 4 of the design calls out: branding, footer, social links, price
// info, activity/booking-summary fields (the SAME labels parser.js
// already knows about, since a client-message email shares Civitatis's
// general booking-summary header), decorative copy, and the generic
// "you have a message" framing sentence that is never itself the
// message.
const NOISE_LINE_PATTERNS = [
  /^https?:\/\//i,                                   // any raw URL — voucher/unsubscribe/social links
  /^(Facebook|Twitter|Instagram|YouTube|LinkedIn|Pinterest)\s*$/i,
  /^Civitatis(\.com)?\s*$/i,
  /^©/, /^All rights reserved/i, /^Copyright/i,
  /^Unsubscribe/i, /^This email was sent/i, /^Privacy Policy/i, /^Terms(\s+(and|&)\s+Conditions)?\s*$/i,
  // Booking-summary / price fields — the same canonical labels
  // parser.js's LABEL_NAMES already recognizes for booking confirmation
  // emails; a client-message email repeats the same header block.
  /^(Activity|Reservation number|City|Language|Internal code|Date|Hour|Duration|People|Retail price|Net price)\s*:?(\s.*)?$/i,
  // The generic "you have a message" framing sentence itself is never
  // the actual message — only real free text that follows it is.
  /^You have (a|received a) (new )?message/i,
  /^(The )?(client|agency|customer) (has sent|sent|wrote|left)/i,
];

function isNoiseLine(line) {
  return NOISE_LINE_PATTERNS.some(re => re.test(line.trim()));
}

/** Lowercase + collapsed-whitespace comparison key — detects "the same
 * message, repeated" even if the two copies differ only in line-wrapping
 * or incidental spacing, never a fuzzy/approximate match otherwise. */
function normalizeForComparison(text) {
  return String(text || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

const COMMENTS_LABEL_BARE = /^Comments?\s*:?$/i;
const COMMENTS_LABEL_SAME_LINE = /^Comments?\s*:\s*(.+)$/i;

/** Finds the "Comments" section's value, tolerating the same two real
 * Civitatis layouts parser.js's findLabelValue already tolerates for
 * other labels: "Comments: <value>" on one line, or a bare "Comments"/
 * "Comments:" line with the value on the next non-empty line. Returns
 * {value, consumedIndices} — consumedIndices lists every line index
 * (the label line AND, in the bare-label layout, the separate value
 * line) that belongs to this Comments section alone, so the dedicated-
 * message-block candidate pass below can exclude the value line too,
 * not just the label line — otherwise a bare-layout Comments value
 * would leak into candidateLines as if it were separate, undetected
 * duplicate text. Returns {value:null, consumedIndices:[]} if no
 * "Comments" label is present at all — never invents a value. */
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

/**
 * @param {string} body plain-text (already HTML-stripped, see
 *   gmailClient.js's selectMessageBody) Civitatis client-message email
 *   body.
 * @returns {string|null} the actual customer/agency message text, never
 *   duplicated, never the surrounding template; null if nothing usable
 *   could be extracted (an email this classified as but with no readable
 *   message content — should be rare and worth investigating, never
 *   silently fabricated).
 */
// Defense in depth ONLY — gmailClient.js's selectMessageBody already
// converts the real Gmail message to plain text before this module ever
// sees it (dropping <script>/<style>/tags entirely), and the result is
// rendered in the UI as a plain React text child, never
// dangerouslySetInnerHTML. This strips any residual "<...>" markup that
// might still survive, so a raw HTML tag can never reach
// reservation_messages.message_text even if the upstream pipeline's own
// sanitization were ever bypassed or changed.
function stripResidualHtmlTags(text) {
  return String(text || '').replace(/<[^>]*>/g, '').trim();
}

function extractClientMessageText(body) {
  const lines = compactLines(body);
  const { value: commentsValue, consumedIndices: commentsIndices } = extractCommentsValue(lines);
  const commentsIndexSet = new Set(commentsIndices);

  // Everything left over after removing every known noise/label line and
  // the ENTIRE "Comments" section (both its label line and, in the
  // bare-label layout, its separate value line — see
  // extractCommentsValue's consumedIndices) — never re-collected here,
  // which is exactly what prevents the Comments value from silently
  // leaking into the dedicated block as if it were separate, undetected
  // duplicate text.
  const candidateLines = lines.filter((line, i) => {
    if (commentsIndexSet.has(i)) return false;
    if (isNoiseLine(line)) return false;
    return true;
  });
  const dedicatedBlock = candidateLines.join(' ').replace(/\s+/g, ' ').trim();

  // Prefer the dedicated block whenever it is reliably identifiable
  // (non-empty) — per PART 4's explicit priority. If it happens to be
  // exactly the same text Comments also carries, that is the expected
  // "Civitatis repeats it" case this module exists to de-duplicate: the
  // dedicated block's own text is kept, Comments' copy is simply never
  // additionally appended.
  if (dedicatedBlock) return stripResidualHtmlTags(dedicatedBlock) || null;

  // No dedicated block survived stripping — fall back to Comments only
  // when necessary, exactly as specified.
  if (commentsValue) return stripResidualHtmlTags(commentsValue) || null;

  return null;
}

module.exports = {
  extractClientMessageText,
  extractCommentsValue,
  isNoiseLine,
  normalizeForComparison,
  stripResidualHtmlTags,
  NOISE_LINE_PATTERNS,
};
