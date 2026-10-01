/**
 * api/_civitatis/activityModality.js
 * ─────────────────────────────────────────────────────────────────────────
 * Tour Preparation Intelligence — Phase B1: deterministic, multilingual
 * Civitatis Activity → meal-modality normalizer.
 *
 * Pure function, zero I/O. Takes the already-extracted Activity string
 * (api/_civitatis/parser.js's `activityName`, untouched by this module),
 * the already-resolved canonical language code
 * (api/_civitatis/languageMap.js's `languageCode`, e.g. 'pt' — NEVER
 * derived from the Activity text itself here), and a caller-supplied list
 * of rule rows (the shape public.civitatis_activity_modality_map returns:
 * { id, language_code, match_type, match_text, meal_status, is_active }).
 * No database access, no network call, no AI/LLM, no fuzzy/edit-distance
 * matching — structurally impossible inside a function with no I/O.
 *
 * NORMALIZATION SEMANTICS — MUST MIRROR THE DATABASE EXACTLY
 * ─────────────────────────────────────────────────────────────
 * public.civitatis_activity_modality_map.match_text_normalized is a
 * generated column: `lower(btrim(match_text))` — lowercase + trim
 * surrounding whitespace ONLY. No accent folding, no internal-whitespace
 * collapsing, no Unicode NFC normalization applied by that migration.
 * This module normalizes identically: `.toLowerCase().trim()`. Diacritics
 * (ç, ã, í, …) are preserved exactly as typed on both sides of the
 * comparison — "português" and "portugues" remain two distinct strings
 * here, exactly as Phase A's own migration deliberately left them (see
 * that migration's comment on match_text_normalized: Civitatis itself
 * sends both accented and unaccented variants as genuinely distinct raw
 * strings, so silently folding them together would hide, not surface,
 * a case that may legitimately need its own explicit rule row).
 *
 * MATCH TYPES (the only two public.civitatis_activity_modality_map's own
 * CHECK constraint allows):
 *   suffix_exact — normalized Activity must END WITH the normalized
 *                  match_text.
 *   contains     — normalized Activity must CONTAIN the normalized
 *                  match_text anywhere.
 * Any other match_type value (should be structurally impossible given the
 * DB's own CHECK constraint, but this function never trusts the caller
 * alone) never matches — fails closed, not open.
 *
 * REASON PRECEDENCE (checked in this exact order):
 *   1. missing_activity     — activityName is not a non-blank string.
 *   2. missing_language     — languageCode is not a non-blank string.
 *   3. no_match              — zero active, language-matching rules hit.
 *   4. conflicting_matches  — matching rules disagree on meal_status.
 *   5. matched               — every matching rule agrees; that status wins.
 * Activity is checked before language because it is this feature's sole
 * authoritative source (per explicit business requirement) — a missing
 * Activity is the more fundamental gap even when language is also absent.
 *
 * matchedRuleId (only set on reason:'matched'): when multiple active,
 * language-matching rules all agree on the same meal_status, the MOST
 * SPECIFIC one (longest normalized match_text) is reported, tie-broken by
 * ascending rule id — a deterministic choice independent of the input
 * array's own order, used only for traceability/debugging. The returned
 * mealStatus never depends on which rule "wins" this tie-break, since all
 * matching rules already agree by the time this is computed.
 *
 * NEVER infers meal status from anything other than activityName +
 * languageCode + the supplied rules — no customer name, nationality,
 * phone, pickup instructions, tour description, itinerary, or any other
 * free text is read by this module; it has no parameters for any of
 * those, so it structurally cannot.
 * ─────────────────────────────────────────────────────────────────────────
 */
'use strict';

const MEAL_STATUS_UNKNOWN = 'unknown';

/** Mirrors public.civitatis_activity_modality_map.match_text_normalized
 * exactly: lower(btrim(x)) — lowercase + trim, nothing more. */
function normalizeForMatching(value) {
  return typeof value === 'string' ? value.toLowerCase().trim() : '';
}

/**
 * normalizeCivitatisActivityModality({ activityName, languageCode, rules })
 *
 * @param {string|null|undefined} activityName - verbatim parser.js activityName.
 * @param {string|null|undefined} languageCode - verbatim languageMap.js languageCode (e.g. 'pt').
 * @param {Array<{id:string,language_code:string,match_type:string,match_text:string,meal_status:string,is_active:boolean}>|null|undefined} rules
 * @returns {{ mealStatus: 'included'|'not_included'|'unknown', matchedRuleId: string|null, reason: 'matched'|'no_match'|'conflicting_matches'|'missing_activity'|'missing_language' }}
 */
function normalizeCivitatisActivityModality({ activityName, languageCode, rules } = {}) {
  const hasActivity = typeof activityName === 'string' && activityName.trim() !== '';
  if (!hasActivity) {
    return { mealStatus: MEAL_STATUS_UNKNOWN, matchedRuleId: null, reason: 'missing_activity' };
  }

  const hasLanguage = typeof languageCode === 'string' && languageCode.trim() !== '';
  if (!hasLanguage) {
    return { mealStatus: MEAL_STATUS_UNKNOWN, matchedRuleId: null, reason: 'missing_language' };
  }

  const normalizedActivity = normalizeForMatching(activityName);
  const candidateRules = Array.isArray(rules) ? rules : [];

  const matches = candidateRules.filter((rule) => {
    if (!rule || rule.is_active !== true) return false;
    if (rule.language_code !== languageCode) return false;
    const normalizedMatchText = normalizeForMatching(rule.match_text);
    // An empty normalized match_text must never match everything — guard
    // explicitly rather than relying on String.prototype.includes('')/
    // endsWith('') both being vacuously true for any input.
    if (!normalizedMatchText) return false;
    if (rule.match_type === 'suffix_exact') return normalizedActivity.endsWith(normalizedMatchText);
    if (rule.match_type === 'contains') return normalizedActivity.includes(normalizedMatchText);
    return false; // unrecognized match_type — fail closed, never match.
  });

  if (matches.length === 0) {
    return { mealStatus: MEAL_STATUS_UNKNOWN, matchedRuleId: null, reason: 'no_match' };
  }

  const distinctStatuses = Array.from(new Set(matches.map((m) => m.meal_status)));
  if (distinctStatuses.length > 1) {
    return { mealStatus: MEAL_STATUS_UNKNOWN, matchedRuleId: null, reason: 'conflicting_matches' };
  }

  const winner = matches.slice().sort((a, b) => {
    const lenDiff = normalizeForMatching(b.match_text).length - normalizeForMatching(a.match_text).length;
    if (lenDiff !== 0) return lenDiff;
    return String(a.id).localeCompare(String(b.id));
  })[0];

  return { mealStatus: distinctStatuses[0], matchedRuleId: winner.id, reason: 'matched' };
}

module.exports = {
  normalizeCivitatisActivityModality,
  MEAL_STATUS_UNKNOWN,
};
