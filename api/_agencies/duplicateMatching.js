/**
 * api/_agencies/duplicateMatching.js
 * ─────────────────────────────────────────────────────────────────────────
 * Acenteler Phase 2/3 — likely-duplicate detection between a freshly
 * researched candidate and the agencies already in the CRM. Pure, no I/O,
 * fully unit-testable: takes the candidate and the list of existing
 * agencies as plain data, returns a match or null.
 *
 * Checked in this order (first match wins): canonical website domain
 * (normalizeWebsite — the PRIMARY duplicate key whenever a reliable
 * website is present), then normalized email, then a normalized company
 * name (the safest existing fallback when no website is available).
 * Deliberately simple, deterministic string normalization throughout —
 * never fuzzy/approximate name matching, which could incorrectly suppress
 * two different businesses with similar names.
 *
 * TWO CONSUMERS, same function, same semantics:
 *   1. EARLY EXCLUSION (researchProvider.js's filterUsableCandidates) —
 *      called BEFORE a research candidate is ever shown to the user, so a
 *      company already in the CRM is silently skipped and never appears
 *      in the result list at all (not even as a "Zaten CRM'de" row).
 *   2. DEFENSE IN DEPTH at persistence (DeseTourDashboard.jsx's own
 *      frontend copy of this same normalization — a backend module can't
 *      be imported into that single-file browser script, see its own
 *      header comment) — one last deterministic check immediately before
 *      the actual INSERT, so a duplicate can never be created even if (a)
 *      the research provider ignores its context and returns an agency
 *      that should have been excluded, or (b) this endpoint is ever
 *      called directly, bypassing the research flow's own exclusion.
 * ─────────────────────────────────────────────────────────────────────────
 */
'use strict';

/** Strips scheme/www/trailing-slash/path/query-string/fragment/port so
 * "https://www.Acme.com:443/path?utm=1#x", "http://acme.com", and
 * "acme.com" all compare equal to the same canonical domain "acme.com".
 * Returns '' for anything without a usable host. This is the PRIMARY
 * duplicate key wherever a website is present (see findLikelyDuplicate) —
 * deliberately simple, deterministic string normalization, never fuzzy
 * matching, and kept in exact parity with the proposed database-level
 * canonical_agency_domain() SQL function (same step order: lowercase/trim,
 * strip scheme, strip "www.", strip path/query/fragment, strip port — see
 * the Agency canonical-domain design report for the SQL side). Only the
 * literal "www." prefix is ever collapsed — a real subdomain like
 * "booking.acme.com" is deliberately left distinct from "acme.com". */
function normalizeWebsite(url) {
  if (!url || typeof url !== 'string') return '';
  let s = url.trim().toLowerCase();
  s = s.replace(/^https?:\/\//, '').replace(/^www\./, '');
  // Split on the first path separator, query string, or fragment — not
  // just '/' — so a bare "example.com?utm=1" (no slash before the query
  // string) is still correctly reduced to "example.com".
  s = s.split(/[/?#]/)[0];
  // Strip an explicit port (e.g. "example.com:443" -> "example.com"), the
  // same way an invisible-to-the-user default/explicit port never changes
  // which real site a URL points at.
  s = s.replace(/:[0-9]+$/, '');
  return s;
}

function normalizeEmail(email) {
  if (!email || typeof email !== 'string') return '';
  return email.trim().toLowerCase();
}

/** Same plain, widely-used email shape check used elsewhere in this
 * codebase (api/_agencies/gmailSendClient.js, api/agency-send-email.js) —
 * duplicated here rather than imported, matching this codebase's existing
 * precedent for this exact small, stable regex. "Usable" means a research
 * candidate can actually be contacted — never format-perfect RFC 5322
 * validation, just enough to reject an empty string or obvious garbage. */
function isValidEmailAddress(email) {
  return typeof email === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
}

/** Lowercase, strip common legal-entity suffixes and punctuation, collapse
 * whitespace — "Acme Travel S.L." and "ACME TRAVEL" both normalize to
 * "acme travel". Deliberately simple; this is a duplicate HINT, not a
 * legal-identity match. */
function normalizeAgencyName(name) {
  if (!name || typeof name !== 'string') return '';
  return name
    .toLowerCase()
    .replace(/[.,]/g, ' ')
    .replace(/\b(s\.?l\.?|s\.?a\.?|ltd|llc|inc|gmbh|srl|sl|sa|co|corp|travel|tours|agency|tourism|turizm)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * @param {{name?:string, website?:string, email?:string}} candidate
 * @param {Array<{id:string, name?:string, website?:string, email?:string}>} existingAgencies
 * @returns {{id:string, name:string, matchedOn:'website'|'email'|'name'} | null}
 */
function findLikelyDuplicate(candidate, existingAgencies) {
  if (!candidate || !Array.isArray(existingAgencies) || existingAgencies.length === 0) return null;

  const candWebsite = normalizeWebsite(candidate.website);
  if (candWebsite) {
    const hit = existingAgencies.find(a => normalizeWebsite(a.website) === candWebsite);
    if (hit) return { id: hit.id, name: hit.name || '', matchedOn: 'website' };
  }

  const candEmail = normalizeEmail(candidate.email);
  if (candEmail) {
    const hit = existingAgencies.find(a => normalizeEmail(a.email) === candEmail);
    if (hit) return { id: hit.id, name: hit.name || '', matchedOn: 'email' };
  }

  const candName = normalizeAgencyName(candidate.name);
  if (candName) {
    const hit = existingAgencies.find(a => normalizeAgencyName(a.name) === candName);
    if (hit) return { id: hit.id, name: hit.name || '', matchedOn: 'name' };
  }

  return null;
}

module.exports = {
  normalizeWebsite,
  normalizeEmail,
  isValidEmailAddress,
  normalizeAgencyName,
  findLikelyDuplicate,
};
