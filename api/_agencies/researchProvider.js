/**
 * api/_agencies/researchProvider.js
 * ─────────────────────────────────────────────────────────────────────────
 * Acenteler Phase 2 — B2B agency market research. Finds tourism agencies/
 * tour operators in a chosen market and evaluates each one's fit as a
 * DeseTour partner, grounded in public web evidence.
 *
 * NEVER runs from the browser (see api/agency-research.js) — this module
 * is the one place that calls the external research provider, same
 * boundary discipline as api/_fx/ecbClient.js and api/_civitatis/
 * gmailClient.js: a small, dependency-free client (plain fetch, no SDK),
 * with its one live network call separated from the pure validation/
 * parsing logic so the latter is directly unit-testable with zero network
 * access — see fetchCandidatesFromProvider vs. the pure helpers below.
 *
 * PROVIDER: Anthropic's Messages API with its server-side web_search tool
 * (model does its own grounded web search; this module never implements
 * scraping or a search-engine client itself). Reads ANTHROPIC_API_KEY
 * from the environment only — never hard-coded, never logged, never
 * returned in any response body. If unset, fails closed with
 * ConfigurationError (see api/agency-research.js, which turns that into a
 * clear 503 — never fake candidates).
 *
 * EVIDENCE DISCIPLINE: the prompt instructs the model to leave a field
 * blank rather than guess, to never invent company size/revenue/awards/
 * client profile, and to prefer the agency's own official website over
 * directories/aggregators. This module cannot independently verify a
 * claim is true — that instruction is enforced at the prompt level, not
 * re-derived here — but it DOES mechanically enforce everything that can
 * be checked without re-browsing the web: output shape, the exact three
 * fit levels (never a numeric score), the requested minimum-fit filter,
 * and the hard cap on candidate count.
 *
 * LANGUAGE SEPARATION (UX follow-up): research/search still happens in the
 * requested market's own language/sources (e.g. Portuguese sources for
 * Brazil) — that part of buildUserPrompt is unchanged. But the five
 * analytical fields a DeseTour (Turkish-speaking) CRM user actually reads —
 * travel_focus, turkiye_signal, fit_reason, evidence_summary,
 * cooperation_angle — must be written in Turkish by the prompt, regardless
 * of the research language. name/website/city/contact_person/email/phone/
 * source_url are never translated. This is a prompt-level instruction only
 * (same caveat as EVIDENCE DISCIPLINE above — not independently verified
 * here) plus one new field, cooperation_angle, sanitized the same way as
 * every other free-text field. It does NOT participate in the Yüksek Uyum
 * evidence gate below — only evidence_summary + source_url do, unchanged.
 * ─────────────────────────────────────────────────────────────────────────
 */
'use strict';

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_MODEL = 'claude-opus-5-5';

const MAX_CANDIDATES = 20;

const ALLOWED_LANGUAGES = ['English', 'Spanish', 'Portuguese', 'Italian'];
const ALLOWED_MINIMUM_FIT = ['Yüksek Uyum', 'Orta Uyum ve Üzeri'];
const ALLOWED_FIT_LEVELS = ['Yüksek Uyum', 'Orta Uyum', 'Düşük Uyum'];

class ConfigurationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConfigurationError';
  }
}

class ValidationError extends Error {
  constructor(errors) {
    super('Invalid research input.');
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

// ── Pure validation — no I/O, fully unit-testable ───────────────────────

/**
 * @returns {{country:string, language:string, limit:number, minimumFit:string}}
 * @throws {ValidationError}
 */
function validateResearchInput(input) {
  const body = input || {};
  const errors = {};

  const country = typeof body.country === 'string' ? body.country.trim() : '';
  if (!country) errors.country = 'country is required.';

  const language = typeof body.language === 'string' ? body.language.trim() : '';
  if (!ALLOWED_LANGUAGES.includes(language)) {
    errors.language = `language must be one of: ${ALLOWED_LANGUAGES.join(', ')}.`;
  }

  const limitRaw = body.limit;
  const limit = typeof limitRaw === 'number' ? limitRaw : parseInt(limitRaw, 10);
  if (!Number.isInteger(limit) || limit < 1) {
    errors.limit = 'limit must be a positive integer.';
  } else if (limit > MAX_CANDIDATES) {
    errors.limit = `limit cannot exceed ${MAX_CANDIDATES}.`;
  }

  const minimumFit = typeof body.minimumFit === 'string' ? body.minimumFit.trim() : '';
  if (!ALLOWED_MINIMUM_FIT.includes(minimumFit)) {
    errors.minimumFit = `minimumFit must be one of: ${ALLOWED_MINIMUM_FIT.join(', ')}.`;
  }

  if (Object.keys(errors).length > 0) throw new ValidationError(errors);

  return { country, language, limit, minimumFit };
}

/** Which fit levels satisfy a given minimumFit filter, strongest first. */
function allowedFitLevelsFor(minimumFit) {
  if (minimumFit === 'Yüksek Uyum') return ['Yüksek Uyum'];
  if (minimumFit === 'Orta Uyum ve Üzeri') return ['Yüksek Uyum', 'Orta Uyum'];
  return [];
}

/**
 * Normalizes one raw candidate object from the provider into the exact
 * shape the CRM expects, defaulting every unverified field to '' rather
 * than passing through null/undefined/a guess. Returns null if the
 * candidate is missing a usable name or has a fit_level outside the
 * three allowed values (never silently coerced to a guessed level).
 *
 * HARD EVIDENCE RULE FOR "Yüksek Uyum": the prompt instructing the model
 * is not sufficient on its own — a model can still return "Yüksek Uyum"
 * with no evidence_summary/source_url. This function mechanically
 * downgrades such a candidate to "Orta Uyum" (never lets an evidence-free
 * claim keep the strongest fit level) rather than rejecting it outright —
 * the candidate may still be a reasonable Orta Uyum lead even without
 * Türkiye-specific proof, so dropping it entirely would discard a
 * legitimate, lower-confidence result instead of just correcting its label.
 */
function sanitizeCandidate(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const name = typeof raw.name === 'string' ? raw.name.trim() : '';
  if (!name) return null;

  const fitLevel = typeof raw.fit_level === 'string' ? raw.fit_level.trim() : '';
  if (!ALLOWED_FIT_LEVELS.includes(fitLevel)) return null;

  const str = (v) => (typeof v === 'string' ? v.trim() : '');

  const evidenceSummary = str(raw.evidence_summary);
  const sourceUrl = str(raw.source_url);
  const hasEvidence = Boolean(evidenceSummary) && Boolean(sourceUrl);
  const effectiveFitLevel = (fitLevel === 'Yüksek Uyum' && !hasEvidence) ? 'Orta Uyum' : fitLevel;

  return {
    name,
    website: str(raw.website),
    country: str(raw.country),
    city: str(raw.city),
    contact_person: str(raw.contact_person),
    email: str(raw.email),
    phone: str(raw.phone),
    language: str(raw.language),
    travel_focus: str(raw.travel_focus),
    turkiye_signal: str(raw.turkiye_signal),
    fit_level: effectiveFitLevel,
    fit_reason: str(raw.fit_reason),
    evidence_summary: evidenceSummary,
    cooperation_angle: str(raw.cooperation_angle),
    source_url: sourceUrl,
  };
}

/**
 * Applies the minimum-fit filter and the hard candidate-count cap. Pure —
 * takes the already-sanitized candidate array and the validated input.
 */
function filterAndCapCandidates(candidates, { limit, minimumFit }) {
  const allowedLevels = allowedFitLevelsFor(minimumFit);
  return candidates
    .filter(c => c && allowedLevels.includes(c.fit_level))
    .slice(0, Math.min(limit, MAX_CANDIDATES));
}

/** Extracts the first JSON array literal found in a block of text. Thrown
 * as ProviderError (never silently returns []) if none is found — a
 * provider response that cannot be parsed is a failure, not zero results. */
function extractCandidateArray(text) {
  if (typeof text !== 'string') throw new ProviderError('Research provider returned no text content.');
  const match = text.match(/\[[\s\S]*\]/);
  if (!match) throw new ProviderError('Research provider response did not contain a parseable candidate list.');
  let parsed;
  try {
    parsed = JSON.parse(match[0]);
  } catch (err) {
    throw new ProviderError('Research provider response contained malformed JSON.');
  }
  if (!Array.isArray(parsed)) throw new ProviderError('Research provider response was not a list of candidates.');
  return parsed;
}

function buildSystemPrompt() {
  return [
    'You are a B2B market-research assistant for DeseTour, an Istanbul-based tour operator.',
    'Find real tourism agencies / tour operators in the requested country that could plausibly become',
    'cooperation partners for Türkiye and Istanbul tour operations (private tours, small groups, guiding,',
    'custom itineraries, group handling, transfers, shore excursions, Türkiye ground handling).',
    '',
    "Research using the requested country's own local sources and the requested market language (e.g.",
    'Portuguese-language sources for Brazil, Italian-language sources for Italy) — this is how you find and',
    'verify real, relevant companies. This research-language rule is separate from the OUTPUT LANGUAGE RULE',
    'below; follow both at once.',
    '',
    'Positive signals: Türkiye tours, Istanbul tours, Cappadocia/Türkiye cultural programs, outbound travel,',
    'cultural tourism, small-group travel, private/tailor-made travel, premium leisure travel, organized',
    'groups, cruise/shore-excursion customers, international travel programs, local-partner/ground-handling needs.',
    'Negative/weak signals: domestic-only agency, flight-ticket-only or hotel-booking-only business,',
    'affiliate/blog/content site, generic travel directory, inactive/dead website, no evidence of real tour',
    'operation, a Türkiye DMC that already runs its own full local operation, or any business model with no',
    'realistic need for a Türkiye ground partner. Do not classify a company as suitable merely because it is',
    'a travel agency.',
    '',
    'EVIDENCE RULES — follow exactly:',
    '- Every claim must be supported by something you actually found on the public web, preferably the',
    "  agency's own official website (homepage, about page, destination/tour pages, contact page). Use",
    '  secondary sources only when the official site is unavailable or insufficient.',
    '- If you cannot find a contact person, leave contact_person as an empty string.',
    '- If you cannot find a public business email, leave email as an empty string. Never guess an email',
    '  address pattern (e.g. never invent info@domain.com unless you actually saw it published).',
    '- Never fabricate company size, number of customers, annual revenue, awards, specialization, destination',
    '  list, group volume, or client profile. Only state what you found evidence for.',
    '- evidence_summary must be short (one or two factual sentences) and specific, e.g. "Resmi web sitesinde',
    '  İstanbul ve Kapadokya kültür turları ile küçük grup uluslararası programları listeleniyor."',
    '',
    'OUTPUT LANGUAGE RULE — CRITICAL, applies regardless of the research language above:',
    "DeseTour's own CRM staff work in Turkish. The following five analytical fields must be written in",
    'natural, fluent TURKISH: travel_focus, turkiye_signal, fit_reason, evidence_summary, cooperation_angle.',
    'Write them the way a Turkish business-development colleague would explain the company to a teammate —',
    'never a literal machine translation, never generic, never marketing language. Each must explain',
    'something SPECIFIC about this company, not a generic statement true of any travel agency.',
    'Bad (never write like this): "Bu şirket yüksek uyumludur çünkü Türkiye turları sunmaktadır."',
    'Good (write like this): "Türkiye paketlerinde İstanbul konaklaması, rehberlik ve transfer hizmetleri',
    'bulunuyor. Bu operasyonları yerel bir partner üzerinden yürütme ihtiyacı DeseTour için doğrudan iş',
    'birliği fırsatı oluşturuyor."',
    '',
    'Do NOT translate or alter these fields — keep them exactly as found, in their original language/script,',
    'never inventing a Turkish version of a name: name, website, city, contact_person, email, phone,',
    'source_url.',
    '',
    'FIT LEVELS — use exactly one of these three strings, never a number or any other label:',
    '"Yüksek Uyum": clear evidence the agency already works with Türkiye/Istanbul, or a business model',
    "  strongly aligned with DeseTour's local operations.",
    '"Orta Uyum": no direct Türkiye evidence, but the agency clearly runs outbound cultural/private/group',
    '  travel and could reasonably need a Türkiye partner.',
    '"Düşük Uyum": weak commercial overlap, domestic-only, ticket/hotel-only, non-agency, inactive, or',
    '  otherwise a poor match.',
    'fit_reason must be 1 to 3 concise, concrete Turkish sentences — never abstract scoring language, never',
    'a literal translation of a generic template.',
    '',
    'cooperation_angle: ONE concise Turkish sentence describing a realistic, specific commercial angle —',
    'what DeseTour could concretely offer THIS company (e.g. local Istanbul ground handling, private',
    'guiding, group transfers, shore-excursion handling) based specifically on what you found. Leave it as',
    'an empty string if the evidence is too thin to support a specific angle — never invent one.',
    '',
    'Respond with ONLY a JSON array (no prose before or after), where each element has exactly these keys:',
    'name, website, country, city, contact_person, email, phone, language, travel_focus, turkiye_signal,',
    'fit_level, fit_reason, evidence_summary, cooperation_angle, source_url. Use an empty string "" for',
    'anything you could not verify — never null, never a guess.',
  ].join('\n');
}

function buildUserPrompt({ country, language, limit, minimumFit }) {
  return `Research up to ${limit} tourism agencies / tour operators based in ${country}, operating primarily ` +
    `in ${language}, that meet at least the "${minimumFit}" fit bar. Return the JSON array described in your ` +
    `instructions, ranked strongest fit first.`;
}

/**
 * The one live network call in this module. Deliberately separated from
 * researchAgencies() below so tests can inject a fake fetchImpl/apiKey and
 * never touch the network, mirroring gmailClient.js's own DI pattern.
 */
async function fetchCandidatesFromProvider({ country, language, limit, minimumFit }, { apiKey, fetchImpl }) {
  const response = await fetchImpl(ANTHROPIC_API_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: ANTHROPIC_MODEL,
      max_tokens: 4096,
      system: buildSystemPrompt(),
      tools: [{ type: 'web_search_20250305', name: 'web_search' }],
      messages: [{ role: 'user', content: buildUserPrompt({ country, language, limit, minimumFit }) }],
    }),
  });

  if (!response.ok) {
    const bodyText = await response.text().catch(() => '');
    throw new ProviderError(`Research provider request failed (${response.status}): ${bodyText.slice(0, 300)}`);
  }

  const data = await response.json();
  const textBlocks = (data.content || []).filter(b => b && b.type === 'text').map(b => b.text);
  if (textBlocks.length === 0) throw new ProviderError('Research provider returned no text content.');
  return textBlocks.join('\n');
}

/**
 * @param {{country:string, language:string, limit:number, minimumFit:string}} input - already validated
 * @param {{apiKey?:string, fetchImpl?:Function}} [deps]
 * @returns {Promise<{candidates: object[]}>}
 */
async function researchAgencies(input, deps = {}) {
  const apiKey = deps.apiKey !== undefined ? deps.apiKey : process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new ConfigurationError(
      'Agency research is not configured: missing environment variable ANTHROPIC_API_KEY. ' +
      'Set it as a server-side Vercel environment variable — never in browser-reachable config.'
    );
  }
  const fetchImpl = deps.fetchImpl || fetch;

  const rawText = await fetchCandidatesFromProvider(input, { apiKey, fetchImpl });
  const rawCandidates = extractCandidateArray(rawText);
  const sanitized = rawCandidates.map(sanitizeCandidate).filter(Boolean);
  const final = filterAndCapCandidates(sanitized, input);

  return { candidates: final };
}

module.exports = {
  ConfigurationError,
  ValidationError,
  ProviderError,
  MAX_CANDIDATES,
  ALLOWED_LANGUAGES,
  ALLOWED_MINIMUM_FIT,
  ALLOWED_FIT_LEVELS,
  validateResearchInput,
  allowedFitLevelsFor,
  sanitizeCandidate,
  filterAndCapCandidates,
  extractCandidateArray,
  researchAgencies,
};
