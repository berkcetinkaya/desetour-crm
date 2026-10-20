/**
 * api/_agencies/duplicateMatching.js
 * ─────────────────────────────────────────────────────────────────────────
 * Acenteler Phase 2 — likely-duplicate detection between a freshly
 * researched candidate and the agencies already in the CRM. Pure, no I/O,
 * fully unit-testable: takes the candidate and the list of existing
 * agencies as plain data, returns a match or null.
 *
 * Checked in this order (first match wins): website, then email, then a
 * normalized company name. "Likely duplicate" is deliberately loose (a
 * false positive just means the UI shows "Zaten CRM'de" and a link —
 * nothing destructive) but never silently creates a second row for an
 * agency that already exists.
 * ─────────────────────────────────────────────────────────────────────────
 */
'use strict';

/** Strips scheme/www/trailing slash/path so "https://www.Acme.com/" and
 * "acme.com" compare equal. Returns '' for anything without a usable host. */
function normalizeWebsite(url) {
  if (!url || typeof url !== 'string') return '';
  let s = url.trim().toLowerCase();
  s = s.replace(/^https?:\/\//, '').replace(/^www\./, '');
  s = s.split('/')[0];
  return s;
}

function normalizeEmail(email) {
  if (!email || typeof email !== 'string') return '';
  return email.trim().toLowerCase();
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
  normalizeAgencyName,
  findLikelyDuplicate,
};
