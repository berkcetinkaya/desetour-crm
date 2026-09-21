/**
 * api/civitatis/languageMap.js
 * ─────────────────────────────────────────────────────────────────────────
 * Deterministic mapping from Civitatis's own "Language:" body-field text
 * to the CRM's canonical language dataset (DeseTourDashboard.jsx's
 * LANGUAGES / LANGUAGE_NAME_BY_CODE — audited, not re-invented: reservation
 * language always maps to reservations.tour_language, which stores the
 * canonical Turkish NAME, e.g. "İtalyanca", not a raw code).
 *
 * The canonical table is duplicated here (not imported) because
 * DeseTourDashboard.jsx is a browser-only React module with no CommonJS
 * export — copying the fixed, rarely-changing (code, name) pairs keeps
 * this server-side module dependency-free and directly testable. If the
 * canonical list in DeseTourDashboard.jsx is ever edited, this copy must
 * be updated to match — both are audited against each other, not derived
 * from one another automatically. Only a language actually present here
 * can ever be produced by this mapper.
 *
 * Unknown Civitatis language values are NEVER guessed or coerced — the
 * caller receives { ok:false } and must route the message to
 * needs_review instead.
 * ─────────────────────────────────────────────────────────────────────────
 */
'use strict';

// Verbatim copy of DeseTourDashboard.jsx's LANGUAGES table.
const CANONICAL_LANGUAGES = [
  ['tr', 'Türkçe'], ['en', 'İngilizce'], ['es', 'İspanyolca'], ['pt', 'Portekizce'], ['it', 'İtalyanca'],
  ['fr', 'Fransızca'], ['de', 'Almanca'], ['ru', 'Rusça'], ['ar', 'Arapça'], ['fa', 'Farsça'],
  ['he', 'İbranice'], ['el', 'Yunanca'], ['nl', 'Felemenkçe'], ['pl', 'Lehçe'], ['cs', 'Çekçe'],
  ['sk', 'Slovakça'], ['hu', 'Macarca'], ['ro', 'Romence'], ['bg', 'Bulgarca'], ['sr', 'Sırpça'],
  ['hr', 'Hırvatça'], ['bs', 'Boşnakça'], ['sq', 'Arnavutça'], ['uk', 'Ukraynaca'], ['ka', 'Gürcüce'],
  ['hy', 'Ermenice'], ['az', 'Azerbaycanca'], ['kk', 'Kazakça'], ['uz', 'Özbekçe'], ['zh', 'Çince'],
  ['ja', 'Japonca'], ['ko', 'Korece'], ['hi', 'Hintçe'], ['ur', 'Urduca'], ['bn', 'Bengalce'],
  ['id', 'Endonezce'], ['ms', 'Malayca'], ['th', 'Tayca'], ['vi', 'Vietnamca'], ['tl', 'Filipince'],
  ['sv', 'İsveççe'], ['no', 'Norveççe'], ['da', 'Danca'], ['fi', 'Fince'], ['et', 'Estonca'],
  ['lv', 'Letonca'], ['lt', 'Litvanca'],
];

const LANGUAGE_NAME_BY_CODE = Object.fromEntries(CANONICAL_LANGUAGES);

// Known Civitatis "Language:" values -> canonical language code.
// Extend only when a new Civitatis value has actually been observed in a
// real email — never speculatively, per "do not invent a new language
// vocabulary".
const CIVITATIS_LANGUAGE_TO_CODE = {
  'italiano': 'it',
  'español': 'es',
  'espanol': 'es', // accent-stripped variant, seen in some plain-text exports
};

function normalizeKey(raw) {
  return String(raw || '').trim().toLowerCase();
}

/**
 * @param {string} civitatisLanguageRaw - e.g. "Italiano", "Español"
 * @returns {{ ok:true, code:string, name:string } | { ok:false, reason:string }}
 */
function mapCivitatisLanguage(civitatisLanguageRaw) {
  const key = normalizeKey(civitatisLanguageRaw);
  if (!key) {
    return { ok: false, reason: 'language text is empty' };
  }
  const code = CIVITATIS_LANGUAGE_TO_CODE[key];
  if (!code) {
    return { ok: false, reason: `unrecognized Civitatis language value "${civitatisLanguageRaw}" — no deterministic mapping to a canonical language` };
  }
  const name = LANGUAGE_NAME_BY_CODE[code];
  if (!name) {
    // Defensive only — would mean CIVITATIS_LANGUAGE_TO_CODE points at a
    // code that doesn't exist in CANONICAL_LANGUAGES, a bug in this file,
    // never something live input can trigger on its own.
    return { ok: false, reason: `mapped code "${code}" has no canonical name entry` };
  }
  return { ok: true, code, name };
}

module.exports = { mapCivitatisLanguage, CANONICAL_LANGUAGES, LANGUAGE_NAME_BY_CODE };
