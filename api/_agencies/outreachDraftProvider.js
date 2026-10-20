/**
 * api/_agencies/outreachDraftProvider.js
 * ─────────────────────────────────────────────────────────────────────────
 * Acenteler Phase 2 — personalized first-contact email drafting. Takes an
 * EXISTING agency record (already in the CRM) plus a target language and
 * produces one draft. Deliberately does NOT call the web_search tool or
 * re-run researchProvider — drafting is grounded only in the agency row
 * already in the CRM (name/country/city/website/languages/fit_note), per
 * the brief: "It must NOT perform a second hidden research process unless
 * explicitly requested."
 *
 * Same boundary discipline as researchProvider.js: one small, dependency-
 * free live network call (fetchDraftFromProvider), separated from pure,
 * directly-testable validation/enforcement logic. Reads
 * ANTHROPIC_API_KEY from the environment only; fails closed with
 * ConfigurationError if unset.
 *
 * WRITING STANDARD (enforced where mechanically checkable; the rest is
 * prompted, not re-derived here — see buildSystemPrompt):
 *   - target 90-140 words — prompted; measured/exposed via countWords()
 *     for the caller/tests, not a hard retry loop (no autonomous loops).
 *   - a fixed list of banned corporate/AI-sounding phrases — HARD enforced
 *     below: if the provider's draft contains any of them, this throws
 *     ProviderError rather than silently shipping generic boilerplate.
 *   - no emojis — HARD enforced the same way.
 *   - exactly the 4 supported languages.
 *
 * LANGUAGE SEPARATION (UX follow-up to researchProvider.js): the grounding
 * context this module reads (agency.fitNote/researchEvidence) is now
 * Turkish by contract (DeseTour's internal CRM language — see
 * researchProvider.js's OUTPUT LANGUAGE RULE). This module's own output
 * language is unchanged: still exactly `language` from the request, never
 * Turkish, never the research language. The system prompt below gained one
 * clarifying note telling the model the context may be Turkish and must be
 * understood for its meaning, never copied verbatim into the (differently-
 * languaged) outgoing email. No change to ALLOWED_LANGUAGES, no change to
 * any enforcement function, no change to the output shape.
 * ─────────────────────────────────────────────────────────────────────────
 */
'use strict';

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_MODEL = 'claude-opus-5-5';

const ALLOWED_LANGUAGES = ['English', 'Spanish', 'Portuguese', 'Italian'];
const ALLOWED_FIT_LEVELS = ['Yüksek Uyum', 'Orta Uyum', 'Düşük Uyum', ''];

// Verbatim from the product brief — never ship a draft containing any of these.
const BANNED_PHRASES = [
  'i hope this email finds you well',
  'strategic partnership',
  'synergy',
  'exciting opportunity',
  'unlock value',
  'leverage',
  'transformative collaboration',
  'we are thrilled to',
  'mutually beneficial partnership',
];

const EMOJI_PATTERN = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u;

class ConfigurationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConfigurationError';
  }
}

class ValidationError extends Error {
  constructor(errors) {
    super('Invalid draft-outreach input.');
    this.name = 'ValidationError';
    this.errors = errors;
  }
}

class ProviderError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ProviderError';
  }
}

// ── Pure validation/enforcement — no I/O, fully unit-testable ───────────

/**
 * @returns {{agency: object, language: string}}
 * @throws {ValidationError}
 */
function validateDraftInput(input) {
  const body = input || {};
  const errors = {};

  const agency = body.agency && typeof body.agency === 'object' ? body.agency : null;
  if (!agency || !agency.name || typeof agency.name !== 'string' || !agency.name.trim()) {
    errors.agency = 'agency.name is required.';
  }

  const language = typeof body.language === 'string' ? body.language.trim() : '';
  if (!ALLOWED_LANGUAGES.includes(language)) {
    errors.language = `language must be one of: ${ALLOWED_LANGUAGES.join(', ')}.`;
  }

  if (Object.keys(errors).length > 0) throw new ValidationError(errors);

  return { agency, language };
}

function countWords(text) {
  if (typeof text !== 'string' || !text.trim()) return 0;
  return text.trim().split(/\s+/).length;
}

const TARGET_MIN_WORDS = 90;
const TARGET_MAX_WORDS = 140;

function isWithinTargetLength(body) {
  const n = countWords(body);
  return n >= TARGET_MIN_WORDS && n <= TARGET_MAX_WORDS;
}

/** Case-insensitive scan for any banned phrase. Returns the first match, or null. */
function findBannedPhrase(text) {
  if (typeof text !== 'string') return null;
  const lower = text.toLowerCase();
  return BANNED_PHRASES.find(p => lower.includes(p)) || null;
}

function containsEmoji(text) {
  return typeof text === 'string' && EMOJI_PATTERN.test(text);
}

/**
 * Validates a raw draft object from the provider against every mechanical
 * rule. Throws ProviderError (never silently rewrites/strips the content)
 * on any violation — the caller (api/agency-draft-outreach.js) surfaces
 * that as a clear error, never a silent fallback to template text.
 */
function enforceWritingStandard(draft) {
  if (!draft || typeof draft !== 'object') {
    throw new ProviderError('Draft provider returned no usable content.');
  }
  const { subject, body, personalization_signal, angle_reason, fit_level, fit_reason } = draft;

  if (typeof subject !== 'string' || !subject.trim()) {
    throw new ProviderError('Draft is missing a subject line.');
  }
  if (typeof body !== 'string' || !body.trim()) {
    throw new ProviderError('Draft is missing a body.');
  }
  if (fit_level !== undefined && fit_level !== null && !ALLOWED_FIT_LEVELS.includes(fit_level)) {
    throw new ProviderError(`Draft returned an invalid fit_level: "${fit_level}".`);
  }

  const bannedInSubject = findBannedPhrase(subject);
  const bannedInBody = findBannedPhrase(body);
  if (bannedInSubject || bannedInBody) {
    throw new ProviderError(`Draft contains a disallowed phrase: "${bannedInSubject || bannedInBody}".`);
  }
  if (containsEmoji(subject) || containsEmoji(body)) {
    throw new ProviderError('Draft contains an emoji, which is not allowed.');
  }

  return {
    subject: subject.trim(),
    body: body.trim(),
    personalization_signal: typeof personalization_signal === 'string' ? personalization_signal.trim() : '',
    angle_reason: typeof angle_reason === 'string' ? angle_reason.trim() : '',
    fit_level: typeof fit_level === 'string' ? fit_level.trim() : '',
    fit_reason: typeof fit_reason === 'string' ? fit_reason.trim() : '',
  };
}

function buildSystemPrompt() {
  return [
    'You write first-contact business-development emails for DeseTour, an Istanbul-based tour operator that',
    'supports overseas travel agencies with local Türkiye tour operations (private tours, small groups,',
    'guiding, custom itineraries, group handling, transfers, shore excursions, ground handling).',
    '',
    'You are drafting ONE email to ONE specific agency, using ONLY the agency information you are given below',
    '— do not invent any fact about the agency that is not present in what you were given, and do not perform',
    'a new web search. If the given context is sparse, write a shorter, more general (but still honest) email',
    'rather than inventing detail to fill space.',
    '',
    'If a "Research evidence" line is given below, you may use it as your ONE personalization signal — it is',
    'a factual finding from an earlier research pass, already verified. Do not claim you personally visited,',
    'saw, browsed, or checked anything (the website, a page, a program) beyond what that evidence line states.',
    'Never phrase the opening as a first-person claim of having looked something up yourself — state the fact,',
    'do not narrate the act of finding it. If no research evidence is given, do not pretend any exists.',
    '',
    'WRITE LIKE A REAL PERSON AT DESETOUR, NOT LIKE AI-GENERATED OR COLD-EMAIL-AUTOMATION COPY. Never use any',
    'of these phrases or anything equivalent to them: "I hope this email finds you well", "strategic',
    'partnership", "synergy", "exciting opportunity", "unlock value", "leverage", "transformative',
    'collaboration", "we are thrilled to", "mutually beneficial partnership". No emojis. No fake urgency.',
    'Avoid exclamation marks unless genuinely natural.',
    '',
    `Target length: ${TARGET_MIN_WORDS}-${TARGET_MAX_WORDS} words for the body. Do not write a long company`,
    'profile. Do not mention or imply any attachment (no brochures, rate sheets, decks, or files).',
    '',
    'STRUCTURE:',
    '1. Personal opening using ONE strong, verified personalization signal from the given agency context',
    '   (only if the context actually supports one — otherwise open more generally, honestly).',
    '2. Brief DeseTour introduction, 1-2 sentences maximum: based in Istanbul/Türkiye, supports overseas',
    '   agencies with local tour operations.',
    '3. ONE relevant cooperation angle that fits this specific agency (pick one: Istanbul operations, small',
    '   groups, private tours, local guides, custom itineraries, group handling, shore excursions) — never',
    '   list every possible service.',
    '4. A low-pressure call to action, e.g. asking if a short conversation would make sense, or offering to',
    '   send a short overview if useful.',
    '',
    'Write the email in the target language given in the user message below — it must read as naturally',
    'written by a native business speaker of that language, never like a literal machine translation.',
    'The agency context below (fit/context notes, research evidence) may be written in Turkish — that is',
    "DeseTour's own internal CRM language, not the outreach language. Understand its MEANING and write the",
    'email entirely in the target language; never copy Turkish words or phrases into the email, and never',
    'switch languages mid-email.',
    '',
    'Respond with ONLY a JSON object (no prose before or after) with exactly these keys: subject, body,',
    'personalization_signal (the one specific fact you used to open, or "" if you opened generally),',
    'angle_reason (one short sentence on why you chose that cooperation angle for this agency), fit_level',
    '(restate the fit level implied by the given context — exactly "Yüksek Uyum", "Orta Uyum", "Düşük Uyum",',
    'or "" if no fit context was given), fit_reason (1-3 sentences, or "" if fit_level is "").',
  ].join('\n');
}

function buildUserPrompt({ agency, language }) {
  const lines = [
    `Target language: ${language}.`,
    `Agency name: ${agency.name}`,
  ];
  if (agency.country) lines.push(`Country: ${agency.country}`);
  if (agency.city) lines.push(`City: ${agency.city}`);
  if (agency.website) lines.push(`Website: ${agency.website}`);
  if (Array.isArray(agency.languages) && agency.languages.length) lines.push(`Agency's operating languages: ${agency.languages.join(', ')}`);
  if (agency.fitNote) lines.push(`Known fit/context notes: ${agency.fitNote}`);
  // Persisted from Acenteler Phase 2 market research (public.agencies.research_evidence/
  // research_source_url), set only if this agency was imported via "CRM'e Ekle" — never
  // re-researched here (see buildSystemPrompt: no web_search tool is attached to this call).
  if (agency.researchEvidence) lines.push(`Research evidence: ${agency.researchEvidence}`);
  if (agency.researchSourceUrl) lines.push(`Research source: ${agency.researchSourceUrl}`);
  return lines.join('\n');
}

/** The one live network call in this module — separated for the same DI/
 * testability reason as researchProvider.js's fetchCandidatesFromProvider. */
async function fetchDraftFromProvider({ agency, language }, { apiKey, fetchImpl }) {
  const response = await fetchImpl(ANTHROPIC_API_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: ANTHROPIC_MODEL,
      max_tokens: 1024,
      system: buildSystemPrompt(),
      messages: [{ role: 'user', content: buildUserPrompt({ agency, language }) }],
    }),
  });

  if (!response.ok) {
    const bodyText = await response.text().catch(() => '');
    throw new ProviderError(`Draft provider request failed (${response.status}): ${bodyText.slice(0, 300)}`);
  }

  const data = await response.json();
  const textBlocks = (data.content || []).filter(b => b && b.type === 'text').map(b => b.text);
  if (textBlocks.length === 0) throw new ProviderError('Draft provider returned no text content.');
  return textBlocks.join('\n');
}

function extractDraftObject(text) {
  if (typeof text !== 'string') throw new ProviderError('Draft provider returned no text content.');
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new ProviderError('Draft provider response did not contain a parseable draft object.');
  try {
    return JSON.parse(match[0]);
  } catch (err) {
    throw new ProviderError('Draft provider response contained malformed JSON.');
  }
}

/**
 * @param {{agency: object, language: string}} input - already validated
 * @param {{apiKey?:string, fetchImpl?:Function}} [deps]
 * @returns {Promise<{subject, body, personalization_signal, angle_reason, fit_level, fit_reason}>}
 */
async function draftOutreach(input, deps = {}) {
  const apiKey = deps.apiKey !== undefined ? deps.apiKey : process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new ConfigurationError(
      'Outreach drafting is not configured: missing environment variable ANTHROPIC_API_KEY. ' +
      'Set it as a server-side Vercel environment variable — never in browser-reachable config.'
    );
  }
  const fetchImpl = deps.fetchImpl || fetch;

  const rawText = await fetchDraftFromProvider(input, { apiKey, fetchImpl });
  const rawDraft = extractDraftObject(rawText);
  return enforceWritingStandard(rawDraft);
}

module.exports = {
  ConfigurationError,
  ValidationError,
  ProviderError,
  ALLOWED_LANGUAGES,
  ALLOWED_FIT_LEVELS,
  BANNED_PHRASES,
  TARGET_MIN_WORDS,
  TARGET_MAX_WORDS,
  validateDraftInput,
  countWords,
  isWithinTargetLength,
  findBannedPhrase,
  containsEmoji,
  enforceWritingStandard,
  extractDraftObject,
  draftOutreach,
};
