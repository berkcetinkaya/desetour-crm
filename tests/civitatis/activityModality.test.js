'use strict';
/**
 * tests/civitatis/activityModality.test.js
 * ─────────────────────────────────────────────────────────────────────────
 * Tour Preparation Intelligence — Phase B1 normalizer tests.
 *
 * Every rule fixture below is either (a) the two real, user-confirmed
 * production examples and their planned Phase B1 suffix_exact rows, or
 * (b) a deliberately synthetic, clearly-labeled rule/Activity string used
 * only to exercise a structural behavior (conflict detection, wrong-
 * language exclusion, generic-word false-positive protection). No
 * Spanish/Italian/French/English meal-modality phrase is fabricated here
 * — the "unknown" tests for those languages use the real production
 * Activity strings with NO rules configured for them at all, which is
 * the actual current (and correct) state.
 * ─────────────────────────────────────────────────────────────────────────
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { normalizeCivitatisActivityModality } = require('../../api/_civitatis/activityModality');

// The two Phase B1 production-evidenced rules, plus Phase A's two
// original rules — the full real rule set as it will exist in
// production after Phase B1 is applied.
const PT_RULES = [
  { id: 'rule-contains-com-almoco', language_code: 'pt', match_type: 'contains', match_text: 'com almoço', meal_status: 'included', is_active: true },
  { id: 'rule-contains-sem-almoco', language_code: 'pt', match_type: 'contains', match_text: 'sem almoço', meal_status: 'not_included', is_active: true },
  { id: 'rule-suffix-tour-com', language_code: 'pt', match_type: 'suffix_exact', match_text: 'Visita guiada pela Istambul imprescindível - Tour com', meal_status: 'included', is_active: true },
  { id: 'rule-suffix-tour-sem', language_code: 'pt', match_type: 'suffix_exact', match_text: 'Visita guiada pela Istambul imprescindível - Tour sem', meal_status: 'not_included', is_active: true },
];

// A. Real production Activity → included, via the new B1 suffix_exact rule.
test('A: real production Activity "...Tour com" resolves to included', () => {
  const result = normalizeCivitatisActivityModality({
    activityName: 'Visita guiada pela Istambul imprescindível - Tour com',
    languageCode: 'pt',
    rules: PT_RULES,
  });
  assert.equal(result.mealStatus, 'included');
  assert.equal(result.reason, 'matched');
  assert.equal(result.matchedRuleId, 'rule-suffix-tour-com');
});

// B. Real production Activity → not_included, via the new B1 suffix_exact rule.
test('B: real production Activity "...Tour sem" resolves to not_included', () => {
  const result = normalizeCivitatisActivityModality({
    activityName: 'Visita guiada pela Istambul imprescindível - Tour sem',
    languageCode: 'pt',
    rules: PT_RULES,
  });
  assert.equal(result.mealStatus, 'not_included');
  assert.equal(result.reason, 'matched');
  assert.equal(result.matchedRuleId, 'rule-suffix-tour-sem');
});

// C. Case variation of the same Activity → same classification.
test('C: case variation of the same Activity resolves identically', () => {
  const result = normalizeCivitatisActivityModality({
    activityName: 'VISITA GUIADA PELA ISTAMBUL IMPRESCINDÍVEL - TOUR COM',
    languageCode: 'pt',
    rules: PT_RULES,
  });
  assert.equal(result.mealStatus, 'included');
  assert.equal(result.reason, 'matched');
});

// D. Surrounding whitespace → same classification.
test('D: surrounding whitespace is trimmed before matching', () => {
  const result = normalizeCivitatisActivityModality({
    activityName: '   Visita guiada pela Istambul imprescindível - Tour com  \n',
    languageCode: 'pt',
    rules: PT_RULES,
  });
  assert.equal(result.mealStatus, 'included');
  assert.equal(result.reason, 'matched');
});

// E. Spanish real production Activity, zero configured es rules → unknown.
test('E: Spanish "Tour por el Gran Bazar - Tour en español" resolves to unknown (no evidenced rule)', () => {
  const result = normalizeCivitatisActivityModality({
    activityName: 'Tour por el Gran Bazar - Tour en español',
    languageCode: 'es',
    rules: PT_RULES, // no 'es' rules exist in the real rule set either
  });
  assert.equal(result.mealStatus, 'unknown');
  assert.equal(result.reason, 'no_match');
});

// F. Italian real production Activity, zero configured it rules → unknown.
test('F: Italian "Tour del Grande Bazar - Tour in italiano" resolves to unknown (no evidenced rule)', () => {
  const result = normalizeCivitatisActivityModality({
    activityName: 'Tour del Grande Bazar - Tour in italiano',
    languageCode: 'it',
    rules: PT_RULES,
  });
  assert.equal(result.mealStatus, 'unknown');
  assert.equal(result.reason, 'no_match');
});

// G. Portuguese Bosphorus family, no evidenced meal wording → unknown.
test('G: Portuguese Bosphorus Activity with no evidenced meal wording resolves to unknown', () => {
  const result = normalizeCivitatisActivityModality({
    activityName: 'Cruzeiro pelo Bósforo + Mesquita Azul + Santa Sofia -',
    languageCode: 'pt',
    rules: PT_RULES,
  });
  assert.equal(result.mealStatus, 'unknown');
  assert.equal(result.reason, 'no_match');
});

// H. Wrong language: the real Portuguese-matching Activity text, but
// tagged with a different language code, must not match the pt-only rules.
test('H: the Portuguese "Tour com" string under a different language code never matches', () => {
  const result = normalizeCivitatisActivityModality({
    activityName: 'Visita guiada pela Istambul imprescindível - Tour com',
    languageCode: 'es',
    rules: PT_RULES,
  });
  assert.equal(result.mealStatus, 'unknown');
  assert.equal(result.reason, 'no_match');
});

// I. Missing Activity → unknown / missing_activity.
test('I: missing activityName resolves to unknown/missing_activity', () => {
  for (const activityName of [null, undefined, '', '   ']) {
    const result = normalizeCivitatisActivityModality({ activityName, languageCode: 'pt', rules: PT_RULES });
    assert.equal(result.mealStatus, 'unknown');
    assert.equal(result.reason, 'missing_activity');
    assert.equal(result.matchedRuleId, null);
  }
});

// J. Missing language → unknown / missing_language.
test('J: missing languageCode resolves to unknown/missing_language', () => {
  for (const languageCode of [null, undefined, '', '   ']) {
    const result = normalizeCivitatisActivityModality({
      activityName: 'Visita guiada pela Istambul imprescindível - Tour com',
      languageCode,
      rules: PT_RULES,
    });
    assert.equal(result.mealStatus, 'unknown');
    assert.equal(result.reason, 'missing_language');
  }
});

// J (precedence): activity missing AND language missing → missing_activity wins.
test('J2: when both activity and language are missing, missing_activity takes precedence', () => {
  const result = normalizeCivitatisActivityModality({ activityName: '', languageCode: '', rules: PT_RULES });
  assert.equal(result.reason, 'missing_activity');
});

// K. Conflicting matching rules → unknown / conflicting_matches.
test('K: two active, language-matching rules that disagree on meal_status resolve to unknown/conflicting_matches', () => {
  const conflictingRules = [
    { id: 'rule-a', language_code: 'pt', match_type: 'contains', match_text: 'imprescindível', meal_status: 'included', is_active: true },
    { id: 'rule-b', language_code: 'pt', match_type: 'contains', match_text: 'Tour com', meal_status: 'not_included', is_active: true },
  ];
  const result = normalizeCivitatisActivityModality({
    activityName: 'Visita guiada pela Istambul imprescindível - Tour com',
    languageCode: 'pt',
    rules: conflictingRules,
  });
  assert.equal(result.mealStatus, 'unknown');
  assert.equal(result.reason, 'conflicting_matches');
  assert.equal(result.matchedRuleId, null);
});

// L. Multiple matching rules, same status → same status, deterministic matchedRuleId.
test('L: multiple matching rules that all agree resolve to that status, picking the most specific rule deterministically', () => {
  const agreeingRules = [
    { id: 'rule-short', language_code: 'pt', match_type: 'contains', match_text: 'Tour com', meal_status: 'included', is_active: true },
    { id: 'rule-long', language_code: 'pt', match_type: 'suffix_exact', match_text: 'Visita guiada pela Istambul imprescindível - Tour com', meal_status: 'included', is_active: true },
  ];
  const result = normalizeCivitatisActivityModality({
    activityName: 'Visita guiada pela Istambul imprescindível - Tour com',
    languageCode: 'pt',
    rules: agreeingRules,
  });
  assert.equal(result.mealStatus, 'included');
  assert.equal(result.reason, 'matched');
  // Longest normalized match_text wins the matchedRuleId tie-break.
  assert.equal(result.matchedRuleId, 'rule-long');
});

test('L2: matchedRuleId tie-break is independent of input array order', () => {
  const agreeingRules = [
    { id: 'rule-long', language_code: 'pt', match_type: 'suffix_exact', match_text: 'Visita guiada pela Istambul imprescindível - Tour com', meal_status: 'included', is_active: true },
    { id: 'rule-short', language_code: 'pt', match_type: 'contains', match_text: 'Tour com', meal_status: 'included', is_active: true },
  ];
  const result = normalizeCivitatisActivityModality({
    activityName: 'Visita guiada pela Istambul imprescindível - Tour com',
    languageCode: 'pt',
    rules: agreeingRules,
  });
  assert.equal(result.matchedRuleId, 'rule-long');
});

// M. Unicode/accent behavior: accents are never folded.
test('M: accented and unaccented variants are treated as distinct strings (no accent folding)', () => {
  const accentOnlyRule = [
    { id: 'rule-accented', language_code: 'pt', match_type: 'contains', match_text: 'português', meal_status: 'included', is_active: true },
  ];
  const unaccentedActivity = normalizeCivitatisActivityModality({
    activityName: 'Bosforo y Barrio Sultanahmet - Tour em portugues', // unaccented "portugues"
    languageCode: 'pt',
    rules: accentOnlyRule,
  });
  assert.equal(unaccentedActivity.mealStatus, 'unknown');
  assert.equal(unaccentedActivity.reason, 'no_match');

  const accentedActivity = normalizeCivitatisActivityModality({
    activityName: 'Bosforo y Barrio Sultanahmet - Tour em português', // accented
    languageCode: 'pt',
    rules: accentOnlyRule,
  });
  assert.equal(accentedActivity.mealStatus, 'included');
  assert.equal(accentedActivity.reason, 'matched');
});

test('M2: raw Activity casing/diacritics are never altered by the normalizer itself (caller preserves raw separately)', () => {
  // The normalizer has no return field that echoes back a "normalized
  // activity" string at all — only mealStatus/matchedRuleId/reason — so
  // there is structurally nothing here that could mutate or lose the
  // caller's own raw Activity value.
  const result = normalizeCivitatisActivityModality({
    activityName: 'Visita guiada pela Istambul imprescindível - Tour com',
    languageCode: 'pt',
    rules: PT_RULES,
  });
  assert.deepEqual(Object.keys(result).sort(), ['matchedRuleId', 'mealStatus', 'reason']);
});

// N. Generic unrelated Portuguese Activity containing the bare word "com" → unknown.
test('N: a generic Portuguese Activity containing the bare word "com" (not "com almoço") resolves to unknown', () => {
  const result = normalizeCivitatisActivityModality({
    activityName: 'Passeio de bicicleta com guia local - Tour em português',
    languageCode: 'pt',
    rules: PT_RULES,
  });
  assert.equal(result.mealStatus, 'unknown');
  assert.equal(result.reason, 'no_match');
});

// O. Generic unrelated Portuguese Activity containing the bare word "sem" → unknown.
test('O: a generic Portuguese Activity containing the bare word "sem" (not "sem almoço") resolves to unknown', () => {
  const result = normalizeCivitatisActivityModality({
    activityName: 'Tour sem guia - Tour em português',
    languageCode: 'pt',
    rules: PT_RULES,
  });
  assert.equal(result.mealStatus, 'unknown');
  assert.equal(result.reason, 'no_match');
});

// ── Additional structural tests ──────────────────────────────────────────

test('inactive rules are never matched, even if the text would otherwise match', () => {
  const inactiveRule = [
    { id: 'rule-inactive', language_code: 'pt', match_type: 'contains', match_text: 'com almoço', meal_status: 'included', is_active: false },
  ];
  const result = normalizeCivitatisActivityModality({
    activityName: 'Qualquer Tour - Tour com almoço',
    languageCode: 'pt',
    rules: inactiveRule,
  });
  assert.equal(result.mealStatus, 'unknown');
  assert.equal(result.reason, 'no_match');
});

test('an unrecognized match_type never matches (fails closed)', () => {
  const weirdRule = [
    { id: 'rule-weird', language_code: 'pt', match_type: 'fuzzy_match', match_text: 'com almoço', meal_status: 'included', is_active: true },
  ];
  const result = normalizeCivitatisActivityModality({
    activityName: 'Qualquer Tour - Tour com almoço',
    languageCode: 'pt',
    rules: weirdRule,
  });
  assert.equal(result.mealStatus, 'unknown');
  assert.equal(result.reason, 'no_match');
});

test('an empty match_text on a rule never matches everything', () => {
  const emptyTextRule = [
    { id: 'rule-empty', language_code: 'pt', match_type: 'contains', match_text: '   ', meal_status: 'included', is_active: true },
  ];
  const result = normalizeCivitatisActivityModality({
    activityName: 'Anything at all',
    languageCode: 'pt',
    rules: emptyTextRule,
  });
  assert.equal(result.mealStatus, 'unknown');
  assert.equal(result.reason, 'no_match');
});

test('rules is missing/not an array → treated as zero rules, never throws', () => {
  for (const rules of [undefined, null, 'not-an-array', 42]) {
    const result = normalizeCivitatisActivityModality({
      activityName: 'Visita guiada pela Istambul imprescindível - Tour com',
      languageCode: 'pt',
      rules,
    });
    assert.equal(result.mealStatus, 'unknown');
    assert.equal(result.reason, 'no_match');
  }
});

test('non-string activityName/languageCode are treated as missing, never throw', () => {
  const r1 = normalizeCivitatisActivityModality({ activityName: 12345, languageCode: 'pt', rules: PT_RULES });
  assert.equal(r1.reason, 'missing_activity');
  const r2 = normalizeCivitatisActivityModality({ activityName: 'Tour com', languageCode: { code: 'pt' }, rules: PT_RULES });
  assert.equal(r2.reason, 'missing_language');
});

test('suffix_exact requires the Activity to END WITH match_text, not merely contain it', () => {
  const suffixOnlyRule = [
    { id: 'rule-suffix', language_code: 'pt', match_type: 'suffix_exact', match_text: 'Tour com', meal_status: 'included', is_active: true },
  ];
  const endsWithMatch = normalizeCivitatisActivityModality({
    activityName: 'Qualquer coisa - Tour com',
    languageCode: 'pt',
    rules: suffixOnlyRule,
  });
  assert.equal(endsWithMatch.mealStatus, 'included');

  const containsButDoesNotEndWith = normalizeCivitatisActivityModality({
    activityName: 'Tour com almoço extra',
    languageCode: 'pt',
    rules: suffixOnlyRule,
  });
  assert.equal(containsButDoesNotEndWith.mealStatus, 'unknown');
  assert.equal(containsButDoesNotEndWith.reason, 'no_match');
});

test('the module never performs a network/database call — no require of a Supabase client', () => {
  const fs = require('fs');
  const selfSource = fs.readFileSync(require.resolve('../../api/_civitatis/activityModality.js'), 'utf8');
  assert.doesNotMatch(selfSource, /require\(['"]@supabase\/supabase-js['"]\)/);
  assert.doesNotMatch(selfSource, /\bfetch\(/);
  assert.doesNotMatch(selfSource, /createClient\(/);
});
