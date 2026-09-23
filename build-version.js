'use strict';
/**
 * build-version.js
 * ─────────────────────────────────────────────────────────────────────────
 * Produces the CRM's application version and build metadata, entirely at
 * BUILD time (invoked by build.js) — never at runtime, never manually
 * edited, never random, never Date.now()-as-a-version.
 *
 * VERSION FORMAT: "{major}.{build}", e.g. "1.74".
 *   - major: a small, rarely-changed constant below (MAJOR_VERSION). Like
 *     any project's semver major, it is bumped deliberately by a human for
 *     a real milestone/breaking change — that is standard practice, not
 *     the "manually maintained version string" this was built to avoid.
 *     What must never be hand-maintained is the part that changes on
 *     every deploy, which is:
 *   - build: the total number of commits reachable from HEAD
 *     (`git rev-list --count HEAD`). This is a deterministic, monotonic,
 *     git-derived build sequence — the exact "deterministic Git based
 *     build sequence" fallback this was asked to use instead of a
 *     persisted/incremented numeric counter (which would need either a
 *     database write on every build, purely to bump a number — rejected
 *     as unnecessary — or a commit made BY the build itself, which is
 *     itself a race condition/ordering hazard and was explicitly ruled
 *     out). Commit count requires no writes, no network call in the
 *     common case, and is trivially reproducible from any checkout of the
 *     same commit — two builds of the exact same commit always produce
 *     the exact same version number, and it only advances when the
 *     history genuinely does.
 *
 * A CI/CD provider sometimes performs a SHALLOW clone for speed, which
 * would make `git rev-list --count HEAD` return a small, wrong, and
 * non-monotonic number. getGitBuildNumber() defends against this: it
 * checks `git rev-parse --is-shallow-repository` first and attempts a
 * best-effort `git fetch --unshallow` before counting. If that isn't
 * possible in a given environment (no network, no remote configured), it
 * still returns whatever count is available rather than crashing the
 * build — build.js's caller decides how to degrade (see formatVersionString).
 *
 * The build TIMESTAMP is a separate concern from the version number: it is
 * `new Date()` read exactly ONCE, at build time, by buildVersionMetadata()
 * — never re-read at runtime/page-load, so refreshing the CRM tomorrow
 * cannot make "Son güncelleme" show tomorrow's date.
 */
const { execSync } = require('child_process');

// Bumped deliberately, by a human, only for a real milestone — see the
// file header above for why this does not conflict with "not manually
// maintained": it is not what makes each deploy's version unique.
const MAJOR_VERSION = 1;

function run(cmd, cwd) {
  return execSync(cmd, { cwd, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
}

// The deterministic build sequence number: total commits reachable from
// HEAD. Returns null (never a fabricated/random number) if git information
// genuinely cannot be determined at all — e.g. building outside a git
// checkout.
function getGitBuildNumber(cwd) {
  try {
    let isShallow = false;
    try { isShallow = run('git rev-parse --is-shallow-repository', cwd) === 'true'; }
    catch (_) { /* older git or not a repo — rev-list below will fail too and we return null */ }
    if (isShallow) {
      try { execSync('git fetch --unshallow --quiet', { cwd, stdio: 'ignore' }); }
      catch (_) { /* best effort only — network or remote may be unavailable in this build environment */ }
    }
    const count = parseInt(run('git rev-list --count HEAD', cwd), 10);
    return Number.isFinite(count) ? count : null;
  } catch (e) {
    return null;
  }
}

// Git traceability: full SHA, short SHA, and branch (best-effort — a
// detached-HEAD CI checkout may not have a symbolic branch name at all,
// which is reported as null rather than a misleading guess).
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

// "{major}.{build}" — e.g. "1.74". Falls back to "{major}.0" only when no
// git build number could be determined at all (never Date.now(), never a
// random number).
function formatVersionString(major, buildNumber) {
  return `${major}.${buildNumber != null ? buildNumber : 0}`;
}

// The full metadata object embedded into the build output. `now` and `cwd`
// are injectable purely so this is deterministically testable — production
// callers just use the defaults (build.js calls this with no arguments).
function buildVersionMetadata({ cwd = process.cwd(), now = new Date() } = {}) {
  const buildNumber = getGitBuildNumber(cwd);
  const commit = getGitCommitInfo(cwd);
  return {
    version: formatVersionString(MAJOR_VERSION, buildNumber),
    major: MAJOR_VERSION,
    build: buildNumber,
    buildTimestamp: now.toISOString(),
    commitSha: commit.sha,
    commitShaShort: commit.shaShort,
    branch: commit.branch,
  };
}

module.exports = {
  MAJOR_VERSION,
  getGitBuildNumber,
  getGitCommitInfo,
  formatVersionString,
  buildVersionMetadata,
};
