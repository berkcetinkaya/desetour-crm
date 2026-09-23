'use strict';
/**
 * build-version.js
 * ─────────────────────────────────────────────────────────────────────────
 * The CRM's single canonical version source. The number itself
 * (major.minor) lives in crm-version.json — NEVER hand-edited in the
 * middle of a feature change — and this file is the only code that reads
 * it, formats it, and (via bumpCrmVersion, used only by the separate
 * bump-crm-version.js release script) advances it. build.js embeds the
 * result into build-meta.js at build time; nothing else — app.js least of
 * all — owns or duplicates the version number.
 *
 * VERSION FORMAT: "{major}.{minor}", minor always 2 digits, e.g. "12.24",
 * "13.01". This is DeseTour's own internal release counter, not semver:
 *   - minor increments by exactly 1 per intentional release.
 *   - when minor would exceed 50, the release instead bumps major by 1
 *     and resets minor to 01 (…12.50 -> 13.01 -> … -> 13.50 -> 14.01).
 * See incrementCrmVersion below for the exact rule, and
 * bump-crm-version.js for the one place that ever calls it for real.
 *
 * INCREMENTING IS NEVER AUTOMATIC: node build.js (what `npm run build`,
 * Vercel's own buildCommand, and every local verification build during
 * development all run) only READS crm-version.json — it never writes it.
 * Running the test suite never touches this file either. The ONLY way
 * the version advances is running `node bump-crm-version.js` (wired to
 * `npm run release`) as a deliberate, one-time step before committing a
 * real release — see that file's header for the full contract.
 *
 * The build TIMESTAMP is a separate concern from the version number: it
 * is `new Date()` read exactly ONCE, at build time, by
 * buildVersionMetadata() — never re-read at runtime/page-load, so
 * refreshing the CRM tomorrow cannot make "Son güncelleme" show
 * tomorrow's date.
 */
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const CRM_VERSION_FILE = 'crm-version.json';

// The release counter never lets minor exceed this — see
// incrementCrmVersion.
const MAX_MINOR = 50;

function run(cmd, cwd) {
  return execSync(cmd, { cwd, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
}

// Reads the canonical {major, minor} — never guessed, never defaulted:
// a missing or malformed crm-version.json fails the build loudly rather
// than silently inventing a version number.
function readCrmVersion(cwd = process.cwd()) {
  const filePath = path.join(cwd, CRM_VERSION_FILE);
  const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  if (!Number.isInteger(raw.major) || !Number.isInteger(raw.minor)) {
    throw new Error(`${CRM_VERSION_FILE} must contain integer "major" and "minor" fields, got: ${JSON.stringify(raw)}`);
  }
  return { major: raw.major, minor: raw.minor };
}

function writeCrmVersion(cwd, { major, minor }) {
  const filePath = path.join(cwd, CRM_VERSION_FILE);
  fs.writeFileSync(filePath, JSON.stringify({ major, minor }, null, 2) + '\n');
}

// "{major}.{minor}" with minor always zero-padded to 2 digits, e.g.
// (12, 24) -> "12.24", (13, 1) -> "13.01", (12, 50) -> "12.50".
function formatCrmVersion(major, minor) {
  return `${major}.${String(minor).padStart(2, '0')}`;
}

// The one place the DeseTour release-counter rule is implemented:
// minor+1 normally; once minor would exceed MAX_MINOR (50), major+1 and
// minor resets to 1 instead. Never produces a minor of 0 or 51+, and
// never produces "13.00" — the reset target is always 1 ("01").
function incrementCrmVersion({ major, minor }) {
  if (minor >= MAX_MINOR) {
    return { major: major + 1, minor: 1 };
  }
  return { major, minor: minor + 1 };
}

// Reads, increments, and persists crm-version.json in one step — the
// only function that actually advances the release counter. Called
// exclusively by bump-crm-version.js (the deliberate, manual release
// step), never by build.js or any test.
function bumpCrmVersion(cwd = process.cwd()) {
  const previous = readCrmVersion(cwd);
  const next = incrementCrmVersion(previous);
  writeCrmVersion(cwd, next);
  return { previous, next };
}

// Git traceability: full SHA, short SHA, and branch (best-effort — a
// detached-HEAD CI checkout may not have a symbolic branch name at all,
// which is reported as null rather than a misleading guess). Informational
// only — no longer any part of the version number itself.
function getGitCommitInfo(cwd) {
  let sha = null, shaShort = null, branch = null;
  try { sha = run('git rev-parse HEAD', cwd); } catch (_) {}
  try { shaShort = run('git rev-parse --short HEAD', cwd); } catch (_) {}
  try {
    const ref = run('git rev-parse --abbrev-ref HEAD', cwd);
    branch = ref && ref !== 'HEAD' ? ref : null;
  } catch (_) {}
  return { sha, shaShort, branch };
}

// The full metadata object embedded into the build output. `now` and `cwd`
// are injectable purely so this is deterministically testable — production
// callers just use the defaults (build.js calls this with no arguments).
function buildVersionMetadata({ cwd = process.cwd(), now = new Date() } = {}) {
  const { major, minor } = readCrmVersion(cwd);
  const commit = getGitCommitInfo(cwd);
  return {
    version: formatCrmVersion(major, minor),
    major,
    minor,
    buildTimestamp: now.toISOString(),
    commitSha: commit.sha,
    commitShaShort: commit.shaShort,
    branch: commit.branch,
  };
}

module.exports = {
  CRM_VERSION_FILE,
  MAX_MINOR,
  readCrmVersion,
  writeCrmVersion,
  formatCrmVersion,
  incrementCrmVersion,
  bumpCrmVersion,
  getGitCommitInfo,
  buildVersionMetadata,
};
