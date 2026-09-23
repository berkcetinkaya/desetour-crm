'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const {
  MAJOR_VERSION,
  getGitBuildNumber,
  getGitCommitInfo,
  formatVersionString,
  buildVersionMetadata,
} = require('../../build-version');

const REPO_ROOT = path.join(__dirname, '..', '..');
const { extractTestableFn } = require('./extractTestableFn');
const formatBuildTimestampTR = extractTestableFn('formatBuildTimestampTR');

// --- build metadata contains a version -------------------------------------

test('buildVersionMetadata produces a version string of the form "{major}.{build}"', () => {
  const meta = buildVersionMetadata({ cwd: REPO_ROOT, now: new Date('2026-09-23T11:52:00Z') });
  assert.match(meta.version, /^\d+\.\d+$/);
  assert.equal(meta.major, MAJOR_VERSION);
});

test('the version is never derived from Date.now() or a random number', () => {
  // Two calls against the SAME commit, at different wall-clock instants,
  // must produce the exact same version — proving it isn't time- or
  // randomness-derived.
  const a = buildVersionMetadata({ cwd: REPO_ROOT, now: new Date('2026-01-01T00:00:00Z') });
  const b = buildVersionMetadata({ cwd: REPO_ROOT, now: new Date('2030-06-15T08:30:00Z') });
  assert.equal(a.version, b.version);
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

test('getGitBuildNumber degrades to null, never throws, outside a git repository', () => {
  assert.equal(getGitBuildNumber('/'), null);
});

// --- version metadata changes when the underlying build/revision changes ----

test('formatVersionString changes when the build number changes', () => {
  const a = formatVersionString(1, 74);
  const b = formatVersionString(1, 75);
  assert.notEqual(a, b);
  assert.equal(a, '1.74');
  assert.equal(b, '1.75');
});

test('a missing build number falls back to "{major}.0", never a random or time-based value', () => {
  assert.equal(formatVersionString(1, null), '1.0');
});

test('getGitBuildNumber reflects the real commit count of this repository (a deterministic, monotonic, git-derived sequence)', () => {
  const build = getGitBuildNumber(REPO_ROOT);
  const realCount = parseInt(execSync('git rev-list --count HEAD', { cwd: REPO_ROOT }).toString().trim(), 10);
  assert.equal(build, realCount);
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
