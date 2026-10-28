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

// The real DeseTour outreach sender — every draft's sign-off must carry this
// name directly, never a bracketed placeholder the user has to remember to
// replace by hand before sending (that manual-edit step was the exact
// reported failure: an edited placeholder not being saved before Gönder,
// so the email still went out reading "[Name]"). Prompted below AND
// mechanically enforced by fillSenderNamePlaceholder as a safety net, same
// "don't just hope the prompt works" discipline as BANNED_PHRASES/emoji.
const OUTREACH_SENDER_NAME = 'Deniz Bulut';

// Catches a bracketed name placeholder in any of the 4 ALLOWED_LANGUAGES
// the model might produce it in: "name" (English), "nombre" (Spanish),
// "nome" (Portuguese and Italian share this word) — e.g. "[Name]",
// "[Your Name]", "[Nombre]", "[Su Nombre]", "[Nome]", "[Il Tuo Nome]".
const SENDER_NAME_PLACEHOLDER_PATTERN = /\[[^[\]]*\b(?:name|nombre|nome)\b[^[\]]*\]/gi;

/** Replaces any bracketed sender-name placeholder with the real sender
 * name. A plain, deterministic string substitution — never a content
 * rewrite of anything else — so the final draft always carries a real
 * name, with nothing left for the user to remember to edit by hand. */
function fillSenderNamePlaceholder(text) {
  if (typeof text !== 'string' || !text) return text;
  return text.replace(SENDER_NAME_PLACEHOLDER_PATTERN, OUTREACH_SENDER_NAME);
}

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
    '5. A closing sign-off appropriate to the target language (e.g. "Best regards," in English), followed by',
    `   the sender's name on its own line: write exactly "${OUTREACH_SENDER_NAME}" — a real person's name, never`,
    '   translated, abbreviated, or altered — then "DeseTour" on the line after. NEVER write a placeholder',
    '   like "[Name]", "[Your Name]", "[Nombre]", or "[Nome]": the sign-off must always be ready to send with',
    '   no further editing required.',
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
 * testability reason as researchProvider.js's fetchCandidatesFromProvider.
 *
 * max_tokens raised from 1024 to 2048 — proven, from the current output
 * contract, to be a real truncation risk, not a guess: the prompt asks for
 * ONLY a JSON object, but the model is not 100% reliable about omitting a
 * short preamble, a markdown fence, or a closing remark around it (the
 * exact same unreliability researchProvider.js's own max_tokens history
 * already documents). The JSON itself carries six fields, several of them
 * free-form sentences in the TARGET language (which, for Spanish/
 * Portuguese/Italian, commonly tokenizes less efficiently per word than
 * English) — subject, a 90-140 word body, personalization_signal,
 * angle_reason, fit_level, and up to three sentences of fit_reason. That
 * content alone can approach several hundred tokens before any wrapping
 * text is counted; add a plausible preamble/fence/postamble and 1024 left
 * little to no margin — exactly the shape of failure this phase's
 * production incident describes (an opening '{' with no closing '}'
 * anywhere after it, i.e. the response was cut off before finishing the
 * JSON). 2048 gives roughly double the content this request ever needs to
 * emit, without the much larger jump researchProvider.js needed for its
 * own fix (that request also carries web_search tool-use reasoning and up
 * to 20 multi-field candidates — a structurally bigger payload this
 * single-email draft never has).
 */
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
      max_tokens: 2048,
      system: buildSystemPrompt(),
      messages: [{ role: 'user', content: buildUserPrompt({ agency, language }) }],
    }),
  });

  if (!response.ok) {
    const bodyText = await response.text().catch(() => '');
    throw new ProviderError(`Draft provider request failed (${response.status}): ${bodyText.slice(0, 300)}`);
  }

  const data = await response.json();
  const blocks = data.content || [];
  // Collect EVERY type==="text" block, in order, ignoring any other block
  // type safely (e.g. a future tool-use block) — never assume the draft is
  // complete in block 0 alone; a long body can legitimately split across
  // more than one text block.
  const textBlocks = blocks.filter(b => b && b.type === 'text' && typeof b.text === 'string').map(b => b.text);
  if (textBlocks.length === 0) throw new ProviderError('Draft provider returned no text content.');
  return {
    rawText: textBlocks.join('\n'),
    // Safe structural diagnostics only — counts, types, lengths. Never the
    // raw response text itself (may contain the drafted email, which may
    // itself reflect agency contact context), never ANTHROPIC_API_KEY,
    // never any header. Logged by draftOutreach only if parsing/validation
    // later fails.
    diagnostics: {
      blockCount: blocks.length,
      blockTypes: blocks.map(b => (b && b.type) || 'unknown'),
      textBlockLengths: textBlocks.map(t => t.length),
    },
  };
}

/** Strips one outer ```json ... ``` or ``` ... ``` markdown fence, if
 * present; returns the text unchanged otherwise. Same primitive as
 * researchProvider.js's stripMarkdownFence — reused because it is exactly
 * what STEP 2 of the extraction strategy below needs, not because this
 * module's own response contract was blindly assumed to match research's. */
function stripMarkdownFence(text) {
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  return fenceMatch ? fenceMatch[1] : text;
}

/**
 * Parses `jsonText` and returns it only if it is a plain JSON object (not
 * an array, not null, not a primitive) — otherwise `null` (valid JSON,
 * wrong shape). Returns `undefined` if `jsonText` is not valid JSON at
 * all, so callers can tell "not JSON" apart from "JSON, but not an
 * object" — the same three-way distinction researchProvider.js's
 * parseCandidateJson makes for arrays.
 */
function parseDraftJson(jsonText) {
  let parsed;
  try {
    parsed = JSON.parse(jsonText);
  } catch (err) {
    return undefined;
  }
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
  return null;
}

/**
 * Walks `text` from the first occurrence of `openChar`, tracking
 * bracket-depth and skipping the contents of quoted strings (so a brace
 * inside a string literal, e.g. in generated email prose, is never
 * counted), returning the substring up to and including the matching
 * `closeChar` once depth returns to zero — or `null` if the brackets
 * never balance (the response was cut off mid-structure). Pure
 * character-by-character scanning, never a greedy regex over the whole
 * text — the same primitive as researchProvider.js's findBalancedJsonSpan,
 * generalized the same way there already is (parametrized open/close
 * characters), not a new one invented for this file.
 */
function findBalancedJsonSpan(text, openChar, closeChar) {
  const startIdx = text.indexOf(openChar);
  if (startIdx === -1) return null;
  let depth = 0;
  let inString = false;
  let escapeNext = false;
  for (let i = startIdx; i < text.length; i++) {
    const ch = text[i];
    if (escapeNext) { escapeNext = false; continue; }
    if (inString) {
      if (ch === '\\') escapeNext = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === openChar) depth++;
    else if (ch === closeChar) {
      depth--;
      if (depth === 0) return text.slice(startIdx, i + 1);
    }
  }
  return null;
}

/**
 * Deterministic 5-step extraction of the draft object from the provider's
 * raw combined text:
 *   1. Direct JSON.parse of the whole (trimmed) text.
 *   2. The same, after stripping one outer markdown fence, if present.
 *   3-4. Scan every '{' in the text, in order, for the first balanced
 *        brace span (never a naive greedy /\{.*\}/ — see
 *        findBalancedJsonSpan above) and JSON.parse that span. A span that
 *        parses but clearly isn't the draft (no subject/body keys at all)
 *        is kept only as a fallback in case nothing better is found, the
 *        same "best-effort, but prefer the right shape" rule
 *        researchProvider.js's extractCandidateArray already uses for
 *        candidate arrays — this never invents a new wrapper format, it
 *        just picks the most plausible of possibly several candidate
 *        objects in the text deterministically (first match wins).
 *   5. Shape/content validation against the full draft contract is
 *      enforceWritingStandard's job, not this function's — this function
 *      only ever returns a plain object or throws ProviderError; it never
 *      silently returns a fallback that isn't valid JSON.
 */
function extractDraftObject(text) {
  if (typeof text !== 'string') throw new ProviderError('Draft provider returned no text content.');

  for (const candidateText of [text, stripMarkdownFence(text)]) {
    const trimmed = candidateText.trim();
    let parsed;
    try {
      parsed = JSON.parse(trimmed);
    } catch (err) {
      continue; // not valid JSON on its own — fall through to the balanced-brace scan below
    }
    // The whole (optionally fence-wrapped) response IS valid JSON by
    // itself. The draft contract requires a top-level OBJECT — a
    // top-level array must be rejected outright here, never reached into
    // for an object it happens to contain, even one that is otherwise a
    // fully valid draft (e.g. `[{"subject":"a","body":"b"}]`). That
    // reach-in-and-unwrap behavior is only correct for prose SURROUNDING
    // a JSON object (handled by the balanced-brace scan below, which
    // never runs for input that is already valid JSON on its own) — it
    // is never correct for a value NESTED one level inside a JSON
    // structure the model chose to return instead of an object.
    if (Array.isArray(parsed)) {
      throw new ProviderError('Draft provider response was a JSON array, not a draft object.');
    }
    if (parsed && typeof parsed === 'object') return parsed;
  }

  let firstValidObject = null;
  let searchFrom = 0;
  while (true) {
    const idx = text.indexOf('{', searchFrom);
    if (idx === -1) break;
    const span = findBalancedJsonSpan(text.slice(idx), '{', '}');
    if (span) {
      const result = parseDraftJson(span);
      if (result) {
        if (firstValidObject === null) firstValidObject = result;
        if ('subject' in result && 'body' in result) return result;
      }
    }
    searchFrom = idx + 1;
  }
  if (firstValidObject !== null) return firstValidObject;

  if (!text.includes('{')) {
    throw new ProviderError('Draft provider response did not contain a parseable draft object.');
  }
  throw new ProviderError('Draft provider response contained malformed JSON.');
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

  const { rawText, diagnostics } = await fetchDraftFromProvider(input, { apiKey, fetchImpl });

  try {
    const rawDraft = extractDraftObject(rawText);
    const draft = enforceWritingStandard(rawDraft);
    // Deterministic safety net (see fillSenderNamePlaceholder) — runs even
    // though the prompt already asks for the real name directly, so a
    // draft can never ship with an unresolved "[Name]"-style placeholder.
    return {
      ...draft,
      subject: fillSenderNamePlaceholder(draft.subject),
      body: fillSenderNamePlaceholder(draft.body),
    };
  } catch (err) {
    if (err instanceof ProviderError) {
      // Safe structural diagnostics only (see fetchDraftFromProvider) plus
      // the ProviderError's own message, which is always one of this
      // module's own fixed, non-content diagnostic sentences (e.g. "Draft
      // is missing a subject line.", "Draft contains a disallowed phrase:
      // ...") — never the Anthropic API key, the raw provider response,
      // the full generated email body, or any agency contact field.
      console.error('[agency-draft-outreach] draft provider response could not be used:', {
        reason: err.message,
        blockCount: diagnostics.blockCount,
        blockTypes: diagnostics.blockTypes,
        textBlockLengths: diagnostics.textBlockLengths,
      });
    }
    throw err;
  }
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
  OUTREACH_SENDER_NAME,
  validateDraftInput,
  countWords,
  isWithinTargetLength,
  findBannedPhrase,
  containsEmoji,
  enforceWritingStandard,
  fillSenderNamePlaceholder,
  extractDraftObject,
  stripMarkdownFence,
  findBalancedJsonSpan,
  draftOutreach,
};
