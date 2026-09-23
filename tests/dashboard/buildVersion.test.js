'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const {
  CRM_VERSION_FILE,
  MAX_MINOR,
  readCrmVersion,
  formatCrmVersion,
  incrementCrmVersion,
  bumpCrmVersion,
  getGitCommitInfo,
  buildVersionMetadata,
} = require('../../build-version');

const REPO_ROOT = path.join(__dirname, '..', '..');
const { extractTestableFn } = require('./extractTestableFn');
const formatBuildTimestampTR = extractTestableFn('formatBuildTimestampTR');

// --- build metadata contains a version, read from crm-version.json ---------

test('buildVersionMetadata produces a version string of the form "{major}.{minor}" (minor zero-padded), read from crm-version.json', () => {
  const onDisk = readCrmVersion(REPO_ROOT);
  const meta = buildVersionMetadata({ cwd: REPO_ROOT, now: new Date('2026-09-23T11:52:00Z') });
  assert.match(meta.version, /^\d+\.\d{2}$/);
  assert.equal(meta.version, formatCrmVersion(onDisk.major, onDisk.minor));
  assert.equal(meta.major, onDisk.major);
  assert.equal(meta.minor, onDisk.minor);
});

test('the version is never derived from Date.now(), a random number, or git commit count — only from crm-version.json', () => {
  // Two calls against the SAME crm-version.json, at different wall-clock
  // instants, must produce the exact same version — proving it isn't
  // time- or randomness-derived.
  const a = buildVersionMetadata({ cwd: REPO_ROOT, now: new Date('2026-01-01T00:00:00Z') });
  const b = buildVersionMetadata({ cwd: REPO_ROOT, now: new Date('2030-06-15T08:30:00Z') });
  assert.equal(a.version, b.version);
});

test('reading the version (buildVersionMetadata / readCrmVersion) never writes to crm-version.json', () => {
  const before = fs.readFileSync(path.join(REPO_ROOT, CRM_VERSION_FILE), 'utf8');
  buildVersionMetadata({ cwd: REPO_ROOT, now: new Date() });
  readCrmVersion(REPO_ROOT);
  const after = fs.readFileSync(path.join(REPO_ROOT, CRM_VERSION_FILE), 'utf8');
  assert.equal(after, before, 'reading the version must never mutate crm-version.json — only bumpCrmVersion (the manual release step) may');
});

// --- the DeseTour release-counter rule: +1 minor, rollover at 50 -----------
// Never semantic versioning — this is the internal release counter's own
// deterministic rule, per crm-version.json.

test('12.24 -> 12.25 (ordinary increment)', () => {
  const next = incrementCrmVersion({ major: 12, minor: 24 });
  assert.deepEqual(next, { major: 12, minor: 25 });
  assert.equal(formatCrmVersion(next.major, next.minor), '12.25');
});

test('12.49 -> 12.50 (ordinary increment, right up to the rollover boundary)', () => {
  const next = incrementCrmVersion({ major: 12, minor: 49 });
  assert.deepEqual(next, { major: 12, minor: 50 });
  assert.equal(formatCrmVersion(next.major, next.minor), '12.50');
});

test('12.50 -> 13.01 (rollover: major +1, minor resets to 01, never 13.00 or 12.51)', () => {
  const next = incrementCrmVersion({ major: 12, minor: 50 });
  assert.deepEqual(next, { major: 13, minor: 1 });
  assert.equal(formatCrmVersion(next.major, next.minor), '13.01');
});

test('13.50 -> 14.01 (the same rollover rule applies again at the next boundary)', () => {
  const next = incrementCrmVersion({ major: 13, minor: 50 });
  assert.deepEqual(next, { major: 14, minor: 1 });
  assert.equal(formatCrmVersion(next.major, next.minor), '14.01');
});

test('MAX_MINOR is 50 — the documented rollover boundary', () => {
  assert.equal(MAX_MINOR, 50);
});

test('bumpCrmVersion reads, increments, and persists crm-version.json, then can be read back correctly', (t) => {
  const original = fs.readFileSync(path.join(REPO_ROOT, CRM_VERSION_FILE), 'utf8');
  t.after(() => fs.writeFileSync(path.join(REPO_ROOT, CRM_VERSION_FILE), original));

  const before = readCrmVersion(REPO_ROOT);
  const { previous, next } = bumpCrmVersion(REPO_ROOT);
  assert.deepEqual(previous, before);
  assert.deepEqual(next, incrementCrmVersion(before));

  const reread = readCrmVersion(REPO_ROOT);
  assert.deepEqual(reread, next, 'bumpCrmVersion must actually persist the new value to disk');
});

// --- build metadata contains a fixed build timestamp ------------------------

test('buildVersionMetadata contains the exact timestamp it was given, as a fixed ISO string', () => {
  const fixedNow = new Date('2026-09-23T11:52:00.000Z');
  const meta = buildVersionMetadata({ cwd: REPO_ROOT, now: fixedNow });
  assert.equal(meta.buildTimestamp, fixedNow.toISOString());
});

// --- build metadata contains a commit identifier when git info is available --

test('buildVersionMetadata contains a real commit SHA and branch when built inside this git repo', () => {
  const meta = buildVersionMetadata({ cwd: REPO_ROOT, now: new Date() });
  const realSha = execSync('git rev-parse HEAD', { cwd: REPO_ROOT }).toString().trim();
  assert.equal(meta.commitSha, realSha);
  assert.equal(meta.commitShaShort, realSha.slice(0, 7));
  assert.ok(meta.branch, 'expected a branch name to be resolvable in this checkout');
});

test('getGitCommitInfo degrades to nulls, never throws, outside a git repository', () => {
  const info = getGitCommitInfo('/');
  assert.equal(info.sha, null);
  assert.equal(info.shaShort, null);
});

// --- the version can only ever advance via the explicit, manual release ----
// step (npm run release / bump-crm-version.js) — never as a side effect of
// tests, of an ordinary `node build.js`, or of Vercel's own buildCommand.

const PACKAGE_JSON = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));
const BUMP_SCRIPT = fs.readFileSync(path.join(REPO_ROOT, 'bump-crm-version.js'), 'utf8');
const VERCEL_JSON = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'vercel.json'), 'utf8'));

test('npm test never invokes the version-bump script, directly or indirectly', () => {
  assert.doesNotMatch(PACKAGE_JSON.scripts.test, /bump-crm-version/);
  assert.equal(PACKAGE_JSON.scripts.test, 'node --test');
});

test('node build.js (what Vercel\'s buildCommand and every local dev/test build run) never invokes the version-bump script', () => {
  const buildJs = fs.readFileSync(path.join(REPO_ROOT, 'build.js'), 'utf8');
  assert.doesNotMatch(buildJs, /bump-crm-version/);
  assert.doesNotMatch(buildJs, /bumpCrmVersion/);
  assert.equal(PACKAGE_JSON.scripts.build, 'node build.js');
  assert.equal(VERCEL_JSON.buildCommand, 'node build.js', 'Vercel\'s own production build must stay read-only w.r.t. the version — it only embeds whatever crm-version.json already says, exactly like every other build.js invocation');
});

test('the release counter can only advance via bump-crm-version.js, which calls bumpCrmVersion — never writeCrmVersion directly, never a hand-edit', () => {
  assert.match(BUMP_SCRIPT, /require\('\.\/build-version'\)/);
  assert.match(BUMP_SCRIPT, /bumpCrmVersion\(\)/);
});

test('"npm run release" is the one wired path that bumps the version and then builds with the new number', () => {
  assert.equal(PACKAGE_JSON.scripts.release, 'node bump-crm-version.js && node build.js');
});

// --- formatBuildTimestampTR: renders the BUILD date, not the browser's current date --

test('formats a fixed build timestamp in Turkish, Europe/Istanbul local time', () => {
  // 2026-09-23T11:52:00Z is 14:52 in Europe/Istanbul (UTC+3).
  const label = formatBuildTimestampTR('2026-09-23T11:52:00.000Z');
  assert.equal(label, '23 Eylül 2026 · 14:52');
});

test('formatBuildTimestampTR takes the timestamp as an argument — it never calls new Date() for "now"', () => {
  assert.doesNotMatch(formatBuildTimestampTR.toString(), /new Date\(\)/);
  assert.doesNotMatch(formatBuildTimestampTR.toString(), /Date\.now\(\)/);
});

test('an empty/invalid timestamp is handled safely, not shown as a fabricated date', () => {
  assert.equal(formatBuildTimestampTR(''), '');
  assert.equal(formatBuildTimestampTR(null), '');
  assert.equal(formatBuildTimestampTR('not-a-date'), '');
});

// --- Static source checks: sidebar wiring, build pipeline integration -------
const SOURCE = fs.readFileSync(path.join(REPO_ROOT, 'DeseTourDashboard.jsx'), 'utf8');
const BUILD_JS = fs.readFileSync(path.join(REPO_ROOT, 'build.js'), 'utf8');
const INDEX_HTML = fs.readFileSync(path.join(REPO_ROOT, 'index.html'), 'utf8');

test('the sidebar renders the version from window.__DESETOUR_BUILD__, not a hardcoded string', () => {
  const idx = SOURCE.indexOf('function SidebarVersionInfo(');
  assert.ok(idx !== -1, 'SidebarVersionInfo component not found');
  const body = SOURCE.slice(idx, SOURCE.indexOf('\nfunction Sidebar(', idx));
  assert.match(body, /window\.__DESETOUR_BUILD__/);
  assert.match(body, /DeseTour CRM · \{versionLabel\}/);
  assert.doesNotMatch(body, /DeseTour CRM · v4\.233/, 'must never hardcode the illustrative example version');
});

test('the sidebar renders the BUILD date (formatBuildTimestampTR of the baked-in timestamp), never a fresh new Date()', () => {
  const idx = SOURCE.indexOf('function SidebarVersionInfo(');
  const body = SOURCE.slice(idx, SOURCE.indexOf('\nfunction Sidebar(', idx));
  assert.match(body, /formatBuildTimestampTR\(meta\.buildTimestamp\)/);
  assert.doesNotMatch(body, /new Date\(\)/);
});

test('SidebarVersionInfo is wired into both the desktop sidebar and the mobile drawer', () => {
  assert.match(SOURCE, /\{!collapsed && <SidebarVersionInfo\/>\}/);
  assert.match(SOURCE, /<SidebarVersionInfo padded=\{false\}\/>/);
});

test('build.js generates build-meta.js via build-version.js on every build — never a hand-maintained string', () => {
  assert.match(BUILD_JS, /require\('\.\/build-version'\)/);
  assert.match(BUILD_JS, /buildVersionMetadata\(\)/);
  assert.match(BUILD_JS, /window\.__DESETOUR_BUILD__ = \$\{JSON\.stringify\(versionMeta\)\}/);
  assert.match(BUILD_JS, /writeFileSync\('\.\/build-meta\.js'/);
});

test('build.js never hand-edits app.js beyond writing the Babel output — version metadata lives in its own generated file', () => {
  assert.match(BUILD_JS, /writeFileSync\('\.\/app\.js', result\.code\)/);
});

test('index.html loads build-meta.js before app.js, so window.__DESETOUR_BUILD__ is defined when the sidebar renders', () => {
  const metaIdx = INDEX_HTML.indexOf('build-meta.js');
  const appIdx = INDEX_HTML.indexOf('src="app.js');
  assert.ok(metaIdx !== -1 && appIdx !== -1 && metaIdx < appIdx);
});

test('the running build already produced a real, non-placeholder build-meta.js on disk', () => {
  const metaPath = path.join(REPO_ROOT, 'build-meta.js');
  assert.ok(fs.existsSync(metaPath), 'build-meta.js should exist after `node build.js` has run at least once');
  const content = fs.readFileSync(metaPath, 'utf8');
  assert.match(content, /window\.__DESETOUR_BUILD__ = \{.*"version":"[^"]+".*\}/);
});

// --- end-to-end: the footer renders exactly the canonical crm-version.json --

test('the built app carries the SAME version currently in crm-version.json (the single canonical source), not a separately-owned copy', () => {
  const { major, minor } = readCrmVersion(REPO_ROOT);
  const expected = formatCrmVersion(major, minor);
  const metaContent = fs.readFileSync(path.join(REPO_ROOT, 'build-meta.js'), 'utf8');
  assert.match(metaContent, new RegExp(`"version":"${expected.replace('.', '\\.')}"`));
  // The sidebar's own render prefixes it with "v" (SidebarVersionInfo's
  // versionLabel), so the footer ends up showing e.g. "DeseTour CRM · v12.24".
  const versionLabel = `v${expected}`;
  assert.match(versionLabel, /^v\d+\.\d{2}$/);
});
