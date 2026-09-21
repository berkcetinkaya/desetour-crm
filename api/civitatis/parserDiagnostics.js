/**
 * api/civitatis/parserDiagnostics.js
 * ─────────────────────────────────────────────────────────────────────────
 * Powers the safe ?debugParser=1 diagnostic mode on /api/ingest-civitatis.
 * Takes the already-extracted, already-selected body text for one message
 * (produced by api/civitatis/gmailClient.js — never raw HTML, never a
 * full MIME payload) and reduces it to a small, sanitized set of lines
 * relevant to diagnosing the deterministic parser (api/civitatis/
 * parser.js) against real Civitatis formatting, without exposing the
 * full message body.
 *
 * No AI/LLM involved — fixed keyword matching plus regex-based
 * redaction, fully deterministic and independently testable without any
 * Gmail or Supabase access.
 * ─────────────────────────────────────────────────────────────────────────
 */
'use strict';

// Case-insensitive substring keywords identifying a line as relevant to
// diagnosing the parser's field extraction. Deliberately broader than
// the parser's own exact label constants (api/civitatis/parser.js), so
// this still surfaces a line even if the real formatting doesn't match
// the parser's current assumptions — which is exactly the case this
// diagnostic mode exists to investigate.
const PARSER_DIAGNOSTIC_KEYWORDS = [
  'activity',
  'reservation number',
  'city',
  'language',
  'internal code',
  'date',
  'hour',
  'duration',
  'people',
  'passenger',
  'full name',
  'retail price',
  'net price',
  'client details',
  'name',
  'surname',
  'phone',
  'modified information',
];

// Redaction is a safety net applied to every returned line, independent
// of which keyword matched — an Email:/URL value can appear as context
// (the line immediately before/after a matched line) even though "email"
// and "url" are not themselves diagnostic keywords.
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const URL_RE = /\bhttps?:\/\/\S+/gi;

function redactSensitiveText(text) {
  return String(text == null ? '' : text)
    .replace(EMAIL_RE, '[redacted-email]')
    .replace(URL_RE, '[redacted-url]');
}

function lineMatchesKeyword(line) {
  const lower = line.toLowerCase();
  return PARSER_DIAGNOSTIC_KEYWORDS.some(keyword => lower.includes(keyword));
}

/**
 * Reduces a message body to a sanitized diagnostic line list: every line
 * that case-insensitively contains a booking-field keyword, plus at most
 * one immediately preceding and one immediately following non-empty
 * line for context (so the caller can see whether a value sits on the
 * same line as its label or the next one). Line numbers are 1-indexed
 * against the ORIGINAL body (blank lines are not removed before
 * numbering), matching what a person reading the raw body would count.
 *
 * Never returns: the full body, HTML, headers, OAuth data, or anything
 * matching an email address / URL pattern (redacted in place).
 */
function buildParserRelevantLines(bodyText) {
  const rawLines = String(bodyText == null ? '' : bodyText).split('\n');
  const keepIndexes = new Set();

  for (let i = 0; i < rawLines.length; i++) {
    if (!lineMatchesKeyword(rawLines[i])) continue;
    keepIndexes.add(i);
    for (let p = i - 1; p >= 0; p--) {
      if (rawLines[p].trim().length > 0) { keepIndexes.add(p); break; }
    }
    for (let n = i + 1; n < rawLines.length; n++) {
      if (rawLines[n].trim().length > 0) { keepIndexes.add(n); break; }
    }
  }

  return Array.from(keepIndexes)
    .sort((a, b) => a - b)
    .map(i => ({ lineNumber: i + 1, text: redactSensitiveText(rawLines[i]) }));
}

module.exports = { buildParserRelevantLines, redactSensitiveText, PARSER_DIAGNOSTIC_KEYWORDS };
