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
 *
 * ACTIONABLE-PROSPECTS-ONLY GATE (outreach-quality follow-up): a sanitized
 * candidate still has to pass filterUsableCandidates before it is ever
 * returned — mechanically enforced here, never left to the prompt alone:
 *   - no usable contact email → dropped (an agency research can't yet
 *     contact is not an actionable prospect for this workflow).
 *   - matches an agency already in the CRM, by canonical website domain
 *     first, then email, then normalized name (see duplicateMatching.js)
 *     → dropped (early exclusion, before the candidate is ever shown,
 *     counted, or offered for import — not a late "already in CRM" badge).
 * Existing agencies created before this change with no email are NOT
 * affected — they are never touched by this module at all; see
 * AcenteDetailPage's own manual contact-editing capability instead.
 * ─────────────────────────────────────────────────────────────────────────
 */
'use strict';

const { findLikelyDuplicate, isValidEmailAddress, normalizeWebsite } = require('./duplicateMatching');

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_MODEL = 'claude-opus-5-5';

const MAX_CANDIDATES = 20;

// PART 1 (prompt-side exclusion) — bounded so the exclusion context never
// grows unbounded as the CRM's agency list grows; 200 canonical domains is
// generous for this B2B tool's realistic scale while keeping the prompt
// small. If the CRM ever has more agencies with a website than this, the
// LEAST useful ones to exclude at the prompt level are simply left off —
// the deterministic post-provider filter (filterCandidatesWithCounts)
// still catches every one of them regardless of this cap, since it
// checks against the FULL existingAgencies list, not the capped prompt
// list. This cap only affects how many domains the model is TOLD about
// up front, never what gets silently excluded afterward.
const MAX_EXCLUSION_DOMAINS = 200;

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
 * PART 2/3/4 — the deterministic acceptance gate a research candidate must
 * pass BEFORE it is ever shown to the user, let alone capped to `limit` or
 * offered for import. Two independent, non-AI-reliant rules, both pure:
 *
 *   1. USABLE EMAIL REQUIRED — a candidate with no usable contact email is
 *      not an actionable outreach prospect for this CRM's current
 *      workflow. Dropped here means: never returned to the browser, never
 *      shown as a successful new prospect, never counted toward the
 *      requested `limit`, never a row anyone can accidentally import.
 *
 *   2. EARLY EXCLUSION OF EXISTING AGENCIES — matched via the SAME
 *      findLikelyDuplicate used for the (now-removed) post-hoc "Zaten
 *      CRM'de" annotation, canonical-domain-first (see
 *      duplicateMatching.js's own header). A match means this candidate
 *      is silently dropped — never shown, never counted, never an extra
 *      "already in CRM" row the user has to notice and skip past.
 *      existingAgencies starts as whatever is already in public.agencies
 *      (fetched once by the caller) and GROWS by one entry each time a
 *      candidate passes both checks — so if the research provider's own
 *      result happens to list the same company twice (different URL
 *      formatting, two sources), the second occurrence is excluded by
 *      the exact same mechanism, not a second one.
 *
 * Order relative to filterAndCapCandidates below matters: this runs
 * FIRST, so `limit` and the fit-level filter apply only to the pool of
 * genuinely actionable, non-duplicate candidates — a candidate dropped
 * here never consumes one of the user's requested slots.
 */
/**
 * Same gate as filterUsableCandidates, but ALSO returns the two rejection
 * counts (excludedNoEmail, excludedDuplicate) — needed for the research
 * result summary (PART 5: "25 şirket incelendi / 11 mevcut CRM kaydı
 * elendi / 6 e-posta bulunamadığı için elendi / 8 yeni uygun acente").
 * filterUsableCandidates (below) is kept as a thin wrapper over this, so
 * its existing bare-array contract and every caller/test of it is
 * completely unchanged — this is purely additive.
 */
function filterCandidatesWithCounts(sanitizedCandidates, existingAgencies) {
  let excludedNoEmail = 0;
  let excludedDuplicate = 0;
  const usable = [];
  for (const c of sanitizedCandidates) {
    if (isValidEmailAddress(c.email)) usable.push(c);
    else excludedNoEmail++;
  }
  const exclusionPool = Array.isArray(existingAgencies) ? existingAgencies.slice() : [];
  const accepted = [];
  for (const candidate of usable) {
    if (findLikelyDuplicate(candidate, exclusionPool)) { excludedDuplicate++; continue; } // silently skip
    accepted.push(candidate);
    exclusionPool.push({ id: null, name: candidate.name, website: candidate.website, email: candidate.email });
  }
  return { accepted, excludedNoEmail, excludedDuplicate };
}

function filterUsableCandidates(sanitizedCandidates, existingAgencies) {
  return filterCandidatesWithCounts(sanitizedCandidates, existingAgencies).accepted;
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

/**
 * PARSER ROBUSTNESS (production-incident follow-up, see researchAgencies'
 * diagnostic logging below for how this was found): the original
 * implementation ran ONE greedy regex (/\[[\s\S]*\]/) across the ENTIRE
 * joined text. Greedy means it matches from the FIRST '[' anywhere in the
 * text to the LAST ']' anywhere in the text — a single stray bracket
 * character in surrounding prose, a citation, a markdown link, or (the
 * most likely real-world trigger) a truncated/incomplete JSON array with
 * no closing ']' at all, could each make that match either grab the wrong
 * span or fail to match anything, with no way to tell the two failure
 * modes apart. Rewritten below as three independent strategies, tried in
 * order, each using nothing but JSON.parse (never eval, never a
 * hand-rolled JSON grammar):
 *   1. The whole text, parsed as-is — the common case when the model
 *      followed the system prompt's "respond with ONLY a JSON array" instruction literally.
 *   2. The whole text with a ```json ... ``` / ``` ... ``` markdown fence
 *      stripped away, then parsed the same way.
 *   3. A SELF-CONTAINED bracket span found by walking the text character
 *      by character (findBalancedJsonSpan below) — not a greedy regex —
 *      stopping at the first position where open/close brackets balance
 *      back to zero, and skipping everything inside quoted strings so a
 *      bracket character inside a Turkish sentence or a URL can never be
 *      mistaken for structural JSON. This is what correctly isolates a
 *      JSON array that has explanatory prose before/after it, or that is
 *      one of several text blocks already joined together upstream (see
 *      fetchCandidatesFromProvider) — as long as the array itself is
 *      complete. A genuinely truncated array (cut off mid-stream, e.g. by
 *      hitting max_tokens before the closing ']') has no balanced closing
 *      bracket to find, so this strategy correctly returns nothing for it
 *      too, rather than silently accepting a corrupt partial array.
 * Accepts both a bare JSON array and an object with a `candidates` array
 * property (`{"candidates": [...]}`) — some structured-output shapes wrap
 * the list rather than returning it bare; either way the result must
 * still be a real array, never invented, never coerced from anything
 * else. If NOTHING above produces a valid array, this still throws
 * ProviderError exactly as before — fail-closed, never an empty/fake
 * result.
 */
function stripMarkdownFence(text) {
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  return fenceMatch ? fenceMatch[1] : text;
}

/**
 * Parses `jsonText` and, if it is valid JSON, returns an array either
 * directly (bare array) or from its `.candidates` property (wrapped
 * object form) — otherwise returns `null` (valid JSON, wrong shape).
 * Returns `undefined` if `jsonText` is not valid JSON at all. The two
 * "no array" outcomes are kept distinct so callers can tell "this text
 * wasn't JSON" apart from "this was JSON but not a candidate list".
 */
function parseCandidateJson(jsonText) {
  let parsed;
  try {
    parsed = JSON.parse(jsonText);
  } catch (err) {
    return undefined;
  }
  if (Array.isArray(parsed)) return parsed;
  if (parsed && typeof parsed === 'object' && Array.isArray(parsed.candidates)) return parsed.candidates;
  return null;
}

/**
 * Walks `text` from the first occurrence of `openChar`, tracking
 * bracket-depth (and skipping the contents of quoted strings, so a
 * bracket character inside a string literal is never counted), and
 * returns the substring up to and including the matching `closeChar`
 * once depth returns to zero — or `null` if the brackets never balance
 * (e.g. the text was cut off mid-structure). Pure string scanning, no
 * eval, no regex backtracking over the whole text.
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

function extractCandidateArray(text) {
  if (typeof text !== 'string') throw new ProviderError('Research provider returned no text content.');

  for (const candidateText of [text, stripMarkdownFence(text)]) {
    const result = parseCandidateJson(candidateText.trim());
    if (Array.isArray(result)) return result;
  }

  // Scan every '[' in order (not just the first) — a numeric citation
  // marker like "[1]" or a markdown link's "[label]" elsewhere in the
  // text is itself a perfectly balanced, validly-parsing bracket span,
  // so stopping at the FIRST '[' could lock onto one of those instead of
  // the real candidate array. Every real candidate is a JSON OBJECT
  // (the prompt asks for an array of objects, never primitives), so the
  // first balanced span that parses into an array actually containing
  // objects wins; a balanced-but-not-object-shaped span (like "[1]") is
  // skipped in favor of the next '[' rather than accepted outright.
  let firstValidArray = null;
  let searchFrom = 0;
  while (true) {
    const idx = text.indexOf('[', searchFrom);
    if (idx === -1) break;
    const span = findBalancedJsonSpan(text.slice(idx), '[', ']');
    if (span) {
      const result = parseCandidateJson(span);
      if (Array.isArray(result)) {
        if (firstValidArray === null) firstValidArray = result;
        if (result.some(el => el && typeof el === 'object')) return result;
      }
    }
    searchFrom = idx + 1;
  }
  if (firstValidArray !== null) return firstValidArray;

  const objectSpan = findBalancedJsonSpan(text, '{', '}');
  if (objectSpan) {
    const result = parseCandidateJson(objectSpan);
    if (Array.isArray(result)) return result;
  }

  if (!/[[{]/.test(text)) {
    throw new ProviderError('Research provider response did not contain a parseable candidate list.');
  }
  throw new ProviderError('Research provider response contained malformed JSON.');
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
    '- A usable, real contact email is MANDATORY for a company to be worth including in your results — this',
    '  CRM only acts on candidates it can actually email. If you cannot find a public business email for a',
    "  company you were about to include, DO NOT include it with an empty email field — skip that company",
    '  entirely and look for a different one instead, so you do not waste a result slot on a company nobody',
    '  can contact. Never guess, infer, or fabricate an email address pattern under any circumstances (e.g.',
    '  never invent info@domain.com unless you actually saw that exact address published).',
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

/**
 * PART 1 (prompt-side exclusion) — derives the bounded, canonical-domain-
 * only exclusion context sent to the provider. ONLY a website's canonical
 * domain is ever extracted here — never the agency's name, email, status,
 * internal notes, or any other CRM field; those never leave this CRM for
 * this purpose. An existing agency with no website simply contributes
 * nothing to this list (there is no reliable domain to exclude it by at
 * the prompt level — the deterministic post-provider filter still catches
 * it by email/name if the provider happens to return it anyway).
 */
function buildExclusionDomains(existingAgencies) {
  if (!Array.isArray(existingAgencies)) return [];
  const domains = new Set();
  for (const a of existingAgencies) {
    const d = normalizeWebsite(a && a.website);
    if (d) domains.add(d);
  }
  return Array.from(domains).sort().slice(0, MAX_EXCLUSION_DOMAINS);
}

/**
 * excludedDomains: see buildExclusionDomains — a bounded array of
 * canonical domains already in the CRM, or [] when none apply. This is a
 * PROMPT-LEVEL HINT only, to stop the provider from spending result slots
 * on companies we already have — it is NOT relied upon for correctness.
 * The deterministic filterCandidatesWithCounts below re-checks every
 * candidate against the FULL existing-agencies list regardless of
 * whether the provider honored this instruction, so provider
 * non-compliance can never let a duplicate through.
 */
function buildUserPrompt({ country, language, limit, minimumFit, excludedDomains }) {
  let prompt = `Research up to ${limit} tourism agencies / tour operators based in ${country}, operating primarily ` +
    `in ${language}, that meet at least the "${minimumFit}" fit bar. Return the JSON array described in your ` +
    `instructions, ranked strongest fit first.`;

  if (Array.isArray(excludedDomains) && excludedDomains.length > 0) {
    prompt += `\n\nEXCLUSION LIST — these canonical domains are already DeseTour CRM contacts; do NOT return any ` +
      `company whose own official website's canonical domain (ignoring protocol, "www.", path, and query string) ` +
      `exactly matches one of these: ${excludedDomains.join(', ')}. If a company you were about to include turns ` +
      `out to be on this list, skip it and research a different company instead — do not spend a result slot on it.`;
  }

  return prompt;
}

/**
 * The one live network call in this module. Deliberately separated from
 * researchAgencies() below so tests can inject a fake fetchImpl/apiKey and
 * never touch the network, mirroring gmailClient.js's own DI pattern.
 *
 * max_tokens raised from 4096 — proven, from the current output contract,
 * to be a real truncation risk, not a guess: this turn's budget covers
 * the model's own web-search tool-use reasoning AND the final candidate
 * JSON together, and each candidate now serializes five Turkish
 * analytical sentences (travel_focus, turkiye_signal, fit_reason,
 * evidence_summary, cooperation_angle) plus every factual field — for a
 * full 20-candidate request that can plausibly exceed 4096 tokens before
 * the array's closing ']' is ever written, which presents EXACTLY as
 * "Research provider response did not contain a parseable candidate
 * list." (an unclosed '[' with no matching ']', nothing else to find).
 * 8192 gives meaningful headroom without changing the model, the tool, or
 * any field this module asks for.
 *
 * Returns { rawText, diagnostics } rather than a bare string — diagnostics
 * carries ONLY structural metadata (content-block count/types and each
 * text block's length) for researchAgencies to log if parsing later
 * fails. It is never the response content itself, so logging it can never
 * leak contact/research data, let alone a secret.
 */
async function fetchCandidatesFromProvider({ country, language, limit, minimumFit, excludedDomains }, { apiKey, fetchImpl }) {
  const response = await fetchImpl(ANTHROPIC_API_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: ANTHROPIC_MODEL,
      max_tokens: 8192,
      system: buildSystemPrompt(),
      tools: [{ type: 'web_search_20250305', name: 'web_search' }],
      messages: [{ role: 'user', content: buildUserPrompt({ country, language, limit, minimumFit, excludedDomains }) }],
    }),
  });

  if (!response.ok) {
    const bodyText = await response.text().catch(() => '');
    throw new ProviderError(`Research provider request failed (${response.status}): ${bodyText.slice(0, 300)}`);
  }

  const data = await response.json();
  const blocks = data.content || [];
  // Only `type === 'text'` blocks ever carry model-authored output — a
  // server_tool_use (the model's own web_search tool call) or a
  // web_search_tool_result (the raw search results the model read) are
  // the model's WORKING material, never its answer, so they are
  // correctly excluded here exactly as before this change — confirmed
  // from the Anthropic Messages API's documented content-block types,
  // not assumed.
  const textBlocks = blocks.filter(b => b && b.type === 'text').map(b => b.text);
  if (textBlocks.length === 0) throw new ProviderError('Research provider returned no text content.');
  return {
    rawText: textBlocks.join('\n'),
    diagnostics: {
      blockCount: blocks.length,
      blockTypes: blocks.map(b => (b && b.type) || 'unknown'),
      textBlockLengths: textBlocks.map(t => t.length),
    },
  };
}

/**
 * @param {{country:string, language:string, limit:number, minimumFit:string}} input - already validated
 * @param {{apiKey?:string, fetchImpl?:Function, existingAgencies?:Array<{id:string,name?:string,website?:string,email?:string}>}} [deps]
 *   existingAgencies: the agencies already in the CRM — used BOTH to build
 *   the bounded canonical-domain exclusion context sent to the provider
 *   (buildExclusionDomains) AND for the deterministic post-provider
 *   re-check (filterCandidatesWithCounts) that never trusts provider
 *   compliance. Defaults to [] — an empty exclusion set, never a reason to
 *   fail the whole request if the caller's own DB read came back empty
 *   (same "best-effort, never blocks results" philosophy
 *   api/agency-research.js already documents for this data).
 * @returns {Promise<{candidates: object[], summary: {examined:number, excludedExistingInCrm:number, excludedNoEmail:number, actionable:number}}>}
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
  const existingAgencies = Array.isArray(deps.existingAgencies) ? deps.existingAgencies : [];

  // PART 1 — bounded, canonical-domain-only exclusion context sent to the
  // provider itself, so it does not spend result slots on companies
  // already in the CRM. Prompt-level hint only; see
  // filterCandidatesWithCounts below for the deterministic re-check that
  // never trusts provider compliance.
  const excludedDomains = buildExclusionDomains(existingAgencies);
  const { rawText, diagnostics } = await fetchCandidatesFromProvider({ ...input, excludedDomains }, { apiKey, fetchImpl });

  let rawCandidates;
  try {
    rawCandidates = extractCandidateArray(rawText);
  } catch (err) {
    // Safe structural diagnostics only — counts, types, lengths. Never the
    // raw response text itself (may contain contact/research data), never
    // ANTHROPIC_API_KEY, never any header. See fetchCandidatesFromProvider.
    console.error('[agency-research] candidate extraction failed:', {
      reason: err.message,
      blockCount: diagnostics.blockCount,
      blockTypes: diagnostics.blockTypes,
      textBlockLengths: diagnostics.textBlockLengths,
    });
    throw err;
  }

  const sanitized = rawCandidates.map(sanitizeCandidate).filter(Boolean);
  const { accepted, excludedNoEmail, excludedDuplicate } = filterCandidatesWithCounts(sanitized, existingAgencies);
  const final = filterAndCapCandidates(accepted, input);

  // PART 5 — research result summary counts. "examined" is the number of
  // raw candidate objects the provider's own response actually contained
  // (before any sanitization/filtering) — genuinely known, not invented.
  // excludedExistingInCrm/excludedNoEmail are the real counts from the
  // deterministic filter above. "actionable" is the final, already-
  // fit-level-filtered-and-capped list this function returns. HONEST
  // LIMITATION: these four numbers will not always sum exactly to
  // `examined` — a raw candidate sanitizeCandidate rejects outright (e.g.
  // missing a name, or an invalid fit_level) or one filterAndCapCandidates
  // drops for too-low fit level is not separately counted here; adding a
  // 5th/6th bucket for those was judged not worth the added complexity
  // for what is, in practice, a rare occurrence — never silently invented
  // to make the numbers appear to add up.
  const summary = {
    examined: rawCandidates.length,
    excludedExistingInCrm: excludedDuplicate,
    excludedNoEmail,
    actionable: final.length,
  };

  return { candidates: final, summary };
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
  filterUsableCandidates,
  filterCandidatesWithCounts,
  filterAndCapCandidates,
  buildExclusionDomains,
  MAX_EXCLUSION_DOMAINS,
  extractCandidateArray,
  stripMarkdownFence,
  parseCandidateJson,
  findBalancedJsonSpan,
  researchAgencies,
};
