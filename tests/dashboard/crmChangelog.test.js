'use strict';
/**
 * tests/dashboard/crmChangelog.test.js
 * ─────────────────────────────────────────────────────────────────────────
 * Regression coverage for the "CRM Güncellemeleri" product changelog
 * feature: crmChangelog.js's data contract, the sidebar nav entry + new-
 * update indicator, the dedicated ChangelogPage, and the localStorage-only
 * "last seen version" tracking. No Supabase, no SQL, no Auth changes —
 * this feature is entirely frontend-owned and version-controlled.
 * ─────────────────────────────────────────────────────────────────────────
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { CRM_CHANGELOG, CRM_CHANGELOG_CATEGORIES } = require('../../crmChangelog');
const { readCrmVersion, formatCrmVersion } = require('../../build-version');
const { extractTestableFn } = require('./extractTestableFn');

const REPO_ROOT = path.join(__dirname, '..', '..');
const SOURCE = fs.readFileSync(path.join(REPO_ROOT, 'DeseTourDashboard.jsx'), 'utf8');
const INDEX_HTML = fs.readFileSync(path.join(REPO_ROOT, 'index.html'), 'utf8');
const BUILD_JS = fs.readFileSync(path.join(REPO_ROOT, 'build.js'), 'utf8');

// ── 1. Current version matches the newest changelog entry ──────────────

test('the newest changelog entry (index 0) version equals the CRM\'s current product version (crm-version.json, the sole authoritative source)', () => {
  const { major, minor } = readCrmVersion(REPO_ROOT);
  const currentVersion = formatCrmVersion(major, minor);
  assert.ok(CRM_CHANGELOG.length > 0, 'changelog must not be empty');
  assert.equal(CRM_CHANGELOG[0].version, currentVersion);
});

// ── 2. Entries are ordered newest first ─────────────────────────────────

test('CRM_CHANGELOG is ordered strictly newest-first by date', () => {
  for (let i = 0; i < CRM_CHANGELOG.length - 1; i++) {
    const a = new Date(CRM_CHANGELOG[i].date);
    const b = new Date(CRM_CHANGELOG[i + 1].date);
    assert.ok(a >= b, `entry ${i} (${CRM_CHANGELOG[i].version}, ${CRM_CHANGELOG[i].date}) must not be older than entry ${i + 1} (${CRM_CHANGELOG[i + 1].version}, ${CRM_CHANGELOG[i + 1].date})`);
  }
});

test('CRM_CHANGELOG is ordered strictly newest-first by version (major.minor descending, matching the DeseTour release counter)', () => {
  function versionKey(v) {
    const [major, minor] = String(v).split('.').map(Number);
    return major * 1000 + minor;
  }
  for (let i = 0; i < CRM_CHANGELOG.length - 1; i++) {
    assert.ok(
      versionKey(CRM_CHANGELOG[i].version) > versionKey(CRM_CHANGELOG[i + 1].version),
      `version must strictly decrease: entry ${i} (${CRM_CHANGELOG[i].version}) vs entry ${i + 1} (${CRM_CHANGELOG[i + 1].version})`
    );
  }
});

// ── 3. Required changelog fields exist ──────────────────────────────────

test('every changelog entry has all required fields, correctly typed', () => {
  for (const entry of CRM_CHANGELOG) {
    assert.equal(typeof entry.version, 'string');
    assert.match(entry.version, /^\d+\.\d{2}$/, `version "${entry.version}" must be "{major}.{minor}" (2-digit minor)`);
    assert.equal(typeof entry.date, 'string');
    assert.match(entry.date, /^\d{4}-\d{2}-\d{2}$/, `date "${entry.date}" must be YYYY-MM-DD`);
    assert.ok(!isNaN(new Date(entry.date).getTime()), `date "${entry.date}" must be a real calendar date`);
    assert.equal(typeof entry.title, 'string');
    assert.ok(entry.title.length > 0);
    assert.equal(typeof entry.summary, 'string');
    assert.ok(entry.summary.length > 0);
    assert.ok(Array.isArray(entry.categories) && entry.categories.length > 0, `entry ${entry.version} must have at least one category`);
    assert.ok(Array.isArray(entry.highlights), `entry ${entry.version} must have a highlights array`);
    assert.equal(typeof entry.author, 'string');
    assert.ok(entry.author.length > 0);
    if (entry.technicalNote !== undefined) {
      assert.equal(typeof entry.technicalNote, 'string');
    }
  }
});

test('every entry has between 3 and 5 highlights, per the release-card design contract', () => {
  for (const entry of CRM_CHANGELOG) {
    assert.ok(
      entry.highlights.length >= 3 && entry.highlights.length <= 5,
      `entry ${entry.version} ("${entry.title}") has ${entry.highlights.length} highlights — expected 3-5`
    );
  }
});

test('every category used by an entry is a member of the controlled CRM_CHANGELOG_CATEGORIES vocabulary', () => {
  for (const entry of CRM_CHANGELOG) {
    for (const cat of entry.categories) {
      assert.ok(CRM_CHANGELOG_CATEGORIES.includes(cat), `category "${cat}" on entry ${entry.version} is not in the controlled vocabulary`);
    }
  }
});

test('the controlled category vocabulary is the small, specific set the product spec calls for — no sprawl', () => {
  assert.deepEqual(CRM_CHANGELOG_CATEGORIES, ['Yeni Özellik', 'Otomasyon', 'Operasyon', 'İyileştirme', 'Arayüz', 'Altyapı']);
});

test('no two entries share the same version', () => {
  const versions = CRM_CHANGELOG.map(e => e.version);
  assert.equal(new Set(versions).size, versions.length);
});

test('has a plausible number of historical releases (8-12, per the product spec — not a single giant entry, not dozens of tiny ones)', () => {
  assert.ok(CRM_CHANGELOG.length >= 8 && CRM_CHANGELOG.length <= 12, `expected 8-12 entries, found ${CRM_CHANGELOG.length}`);
});

// ── Do not claim unreleased functionality ───────────────────────────────

test('no entry claims Civitatis cancellation automation — that is explicitly a future, not-yet-shipped release', () => {
  for (const entry of CRM_CHANGELOG) {
    const text = JSON.stringify(entry).toLowerCase();
    assert.doesNotMatch(text, /iptal.?y[oö]netimi|cancellation/, `entry ${entry.version} must not describe cancellation handling as already released`);
  }
});

// ── No internal implementation detail leaks into user-facing copy ──────

test('no entry exposes commit hashes, migration file names, RPC/table names, or raw stack-trace-style detail', () => {
  const forbidden = /\bV[0-9]+\b|migration|RPC|supabase_migration|\.sql\b|commit [0-9a-f]{7}|stack trace|exception|ingest_civitatis_booking/i;
  for (const entry of CRM_CHANGELOG) {
    const text = [entry.title, entry.summary, ...(entry.highlights || []), entry.technicalNote || ''].join(' ');
    assert.doesNotMatch(text, forbidden, `entry ${entry.version} leaks internal implementation detail: "${text}"`);
  }
});

// ── 4. Sidebar opens "CRM Güncellemeleri" ───────────────────────────────

test('the desktop sidebar renders a "CRM Güncellemeleri" nav row that navigates to /changelog', () => {
  const idx = SOURCE.indexOf('function ChangelogNavRow(');
  assert.ok(idx !== -1, 'ChangelogNavRow component not found');
  const body = SOURCE.slice(idx, SOURCE.indexOf('\nfunction SidebarInner(', idx));
  assert.match(body, /CRM Güncellemeleri/);
  assert.match(body, /markChangelogViewed\(\)/);
});

test('ChangelogNavRow is wired into both the desktop sidebar and the mobile drawer', () => {
  const occurrences = SOURCE.match(/<ChangelogNavRow\b/g) || [];
  assert.equal(occurrences.length, 2, `expected ChangelogNavRow used exactly twice (desktop Sidebar + mobile SidebarInner), found ${occurrences.length}`);
});

test('the mobile "More" page also links to CRM Güncellemeleri (the actually-reachable mobile navigation surface)', () => {
  const idx = SOURCE.indexOf('function MobileMorePage(');
  const body = SOURCE.slice(idx, SOURCE.indexOf('\nfunction ', idx + 10));
  assert.match(body, /id:"changelog"/);
  assert.match(body, /CRM Güncellemeleri/);
});

test('PageRouter routes base==="changelog" to <ChangelogPage/>', () => {
  assert.match(SOURCE, /if \(base === "changelog"\) return <ChangelogPage\/>;/);
});

test('changelog is accessible to every staff role (not restricted like Ayarlar)', () => {
  const idx = SOURCE.indexOf('const ROLE_PERMISSIONS = {');
  const body = SOURCE.slice(idx, SOURCE.indexOf('\n};', idx));
  for (const role of ['Satış', 'Operasyon', 'Rehber']) {
    const lineMatch = body.match(new RegExp(`"${role}":\\s*\\[([^\\]]*)\\]`));
    assert.ok(lineMatch, `role ${role} not found in ROLE_PERMISSIONS`);
    assert.match(lineMatch[1], /"changelog"/, `role ${role} must be able to access "changelog"`);
  }
});

// ── 5. Current version renders in the sidebar (near the nav item) ─────

test('ChangelogNavRow renders the current build version as a subtitle, sourced from window.__DESETOUR_BUILD__ (the single authoritative version source), never a hardcoded string', () => {
  const idx = SOURCE.indexOf('function ChangelogNavRow(');
  const body = SOURCE.slice(idx, SOURCE.indexOf('\nfunction SidebarInner(', idx));
  assert.match(body, /window\.__DESETOUR_BUILD__ && window\.__DESETOUR_BUILD__\.version/);
  assert.match(body, /v\{buildVersion\}/);
});

test('no hardcoded, stale version string ("v1.0") remains anywhere in DeseTourDashboard.jsx', () => {
  assert.doesNotMatch(SOURCE, /v1\.0\b/);
});

// ── 6. New-update indicator logic (pure function) ───────────────────────

const hasUnseenChangelogUpdate = extractTestableFn('hasUnseenChangelogUpdate');

test('hasUnseenChangelogUpdate: true when the last-seen version differs from the latest', () => {
  assert.equal(hasUnseenChangelogUpdate('12.36', '12.35'), true);
  assert.equal(hasUnseenChangelogUpdate('12.36', null), true, 'never having seen anything counts as unseen');
  assert.equal(hasUnseenChangelogUpdate('12.36', undefined), true);
});

test('hasUnseenChangelogUpdate: false once the last-seen version equals the latest', () => {
  assert.equal(hasUnseenChangelogUpdate('12.36', '12.36'), false);
});

test('hasUnseenChangelogUpdate: false (never throws) when there is no latest version at all', () => {
  assert.equal(hasUnseenChangelogUpdate(null, null), false);
  assert.equal(hasUnseenChangelogUpdate(undefined, '12.36'), false);
});

test('the indicator uses the stable localStorage key "desetour_crm_last_seen_version"', () => {
  assert.match(SOURCE, /CRM_CHANGELOG_LAST_SEEN_KEY = 'desetour_crm_last_seen_version'/);
});

test('the indicator is informational-only: no Supabase table/column is read or written for it', () => {
  const idx = SOURCE.indexOf("const CRM_CHANGELOG_LAST_SEEN_KEY");
  const body = SOURCE.slice(idx, SOURCE.indexOf('\nfunction ChangelogNavRow(', idx));
  assert.doesNotMatch(body, /getSB\(\)|\.from\(|supabase/i);
});

test('the gold "Yeni" indicator only renders when there is an unseen update, on both the nav row and the mobile More page', () => {
  const navIdx = SOURCE.indexOf('function ChangelogNavRow(');
  const navBody = SOURCE.slice(navIdx, SOURCE.indexOf('\nfunction SidebarInner(', navIdx));
  assert.match(navBody, /hasNewUpdate && \(/);
  assert.match(navBody, />Yeni</);

  const moreIdx = SOURCE.indexOf('function MobileMorePage(');
  const moreBody = SOURCE.slice(moreIdx, SOURCE.indexOf('\nfunction ', moreIdx + 10));
  assert.match(moreBody, /hasNewChangelogUpdate && \(/);
  assert.match(moreBody, />Yeni</);
});

// ── 7. Opening the changelog marks the current version as viewed ───────

test('ChangelogPage calls markChangelogViewed() on mount (deep-link safe — works regardless of how the user arrived)', () => {
  const idx = SOURCE.indexOf('function ChangelogPage()');
  assert.ok(idx !== -1, 'ChangelogPage component not found');
  const body = SOURCE.slice(idx, SOURCE.indexOf('\nfunction calculateReportMetrics', idx));
  assert.match(body, /useEffect\(\(\) => \{ markChangelogViewed\(\); \}, \[\]\)/);
});

test('markChangelogViewed writes the LATEST changelog version (CRM_CHANGELOG[0]) to localStorage under the stable key, then notifies listeners', () => {
  const idx = SOURCE.indexOf('function markChangelogViewed()');
  const body = SOURCE.slice(idx, SOURCE.indexOf('\n}', idx) + 2);
  assert.match(body, /CRM_CHANGELOG\[0\]/);
  assert.match(body, /localStorage\.setItem\(CRM_CHANGELOG_LAST_SEEN_KEY, latest\.version\)/);
  assert.match(body, /ChangelogViewedStore\.notify\(\)/);
});

test('localStorage access is guarded (try/catch) so a private-browsing/quota failure never crashes the app', () => {
  const getIdx = SOURCE.indexOf('function getLastSeenChangelogVersion()');
  const getBody = SOURCE.slice(getIdx, SOURCE.indexOf('\n}', getIdx) + 2);
  assert.match(getBody, /try \{ return localStorage\.getItem/);
  assert.match(getBody, /catch \(_\) \{ return null; \}/);

  const markIdx = SOURCE.indexOf('function markChangelogViewed()');
  const markBody = SOURCE.slice(markIdx, SOURCE.indexOf('\n}', markIdx) + 2);
  assert.match(markBody, /try \{ localStorage\.setItem/);
});

// ── 8. Mobile-safe rendering (static checks, matching this suite's existing architecture) ──

test('ChangelogPage is a single shared component (desktop + mobile), responsive via isMobile — not a separate unrelated mobile screen', () => {
  const idx = SOURCE.indexOf('function ChangelogPage()');
  const body = SOURCE.slice(idx, SOURCE.indexOf('\nfunction calculateReportMetrics', idx));
  assert.match(body, /const \{ isMobile \} = useBreakpoint\(\);/);
  assert.match(body, /isMobile\s*\?/);
});

test('ChangelogReleaseCard adapts padding/type scale for isMobile — no fixed desktop-only layout', () => {
  const idx = SOURCE.indexOf('function ChangelogReleaseCard(');
  const body = SOURCE.slice(idx, SOURCE.indexOf('\nfunction ChangelogPage(', idx));
  assert.match(body, /isMobile \? "20px" : "26px 30px"/);
});

// ── 9. Existing navigation remains unchanged ────────────────────────────

test('existing NAV_TOP/NAV_BOT/NAV_SETTINGS entries are untouched (no id removed, "changelog" not injected into the shared arrays)', () => {
  const navTopIdx = SOURCE.indexOf('const NAV_TOP = [');
  const navTopBody = SOURCE.slice(navTopIdx, SOURCE.indexOf('\n];', navTopIdx));
  for (const id of ['dashboard', 'customers', 'reservations', 'calendar', 'tours', 'guides']) {
    assert.match(navTopBody, new RegExp(`id:"${id}"`));
  }
  assert.doesNotMatch(navTopBody, /id:"changelog"/, 'changelog must not be added to NAV_TOP');

  const navBotIdx = SOURCE.indexOf('const NAV_BOT = [');
  const navBotBody = SOURCE.slice(navBotIdx, SOURCE.indexOf('\n];', navBotIdx));
  assert.doesNotMatch(navBotBody, /id:"changelog"/, 'changelog must not be added to NAV_BOT');

  const navSettingsIdx = SOURCE.indexOf('const NAV_SETTINGS = [');
  const navSettingsBody = SOURCE.slice(navSettingsIdx, SOURCE.indexOf('\n];', navSettingsIdx));
  assert.match(navSettingsBody, /id:"settings"/);
  assert.doesNotMatch(navSettingsBody, /id:"changelog"/, 'changelog is rendered via its own ChangelogNavRow, not injected into NAV_SETTINGS');
});

test('MOBILE_PAGE_TITLES gains a "changelog" entry without removing any existing title', () => {
  const idx = SOURCE.indexOf('const MOBILE_PAGE_TITLES = {');
  const body = SOURCE.slice(idx, SOURCE.indexOf('\n};', idx));
  for (const [id, label] of [['dashboard', 'Bugün'], ['reservations', 'Rezervasyonlar'], ['settings', 'Ayarlar'], ['more', 'Diğer']]) {
    assert.match(body, new RegExp(`${id}:"${label}"`));
  }
  assert.match(body, /changelog:"CRM Güncellemeleri"/);
});

test('this feature adds no new Supabase table/query — crmChangelog.js is pure static data', () => {
  const changelogSrc = fs.readFileSync(path.join(REPO_ROOT, 'crmChangelog.js'), 'utf8');
  assert.doesNotMatch(changelogSrc, /supabase|getSB\(|\.from\(/i);
});

test('crmChangelog.js is loaded before app.js in index.html, exactly like build-meta.js', () => {
  const changelogIdx = INDEX_HTML.indexOf('crmChangelog.js');
  const appIdx = INDEX_HTML.indexOf('src="app.js');
  assert.ok(changelogIdx !== -1 && appIdx !== -1 && changelogIdx < appIdx);
});

test('build.js cache-busts crmChangelog.js on every build, same as app.js/build-meta.js', () => {
  assert.match(BUILD_JS, /cacheBustScriptTag\(html, 'crmChangelog\.js'/);
});

// ── 10. No cancellation support implemented yet (explicit safety check) ─
// (The data-level check — no CRM_CHANGELOG entry claims cancellation
// automation as released — already runs above, under "Do not claim
// unreleased functionality". This section additionally confirms
// ChangelogPage renders no cancellation-specific UI of its own.)

test('ChangelogPage renders no cancellation-specific UI (status pill, button, badge) — only the generic release-card layout', () => {
  const idx = SOURCE.indexOf('function ChangelogPage()');
  const pageBody = SOURCE.slice(idx, SOURCE.indexOf('\nfunction calculateReportMetrics', idx));
  assert.doesNotMatch(pageBody, /[İi]ptal/);
});

// ── 11. Auth remains untouched by this feature (defensive check specific to this diff) ──

test('none of the new changelog code references Auth internals (useAuth, onAuthStateChange, staff lookup, auth cache/timeouts/diagnostics)', () => {
  const changelogSrc = fs.readFileSync(path.join(REPO_ROOT, 'crmChangelog.js'), 'utf8');
  const navIdx = SOURCE.indexOf('function ChangelogNavRow(');
  const navBody = SOURCE.slice(navIdx, SOURCE.indexOf('\nfunction SidebarInner(', navIdx));
  const pageIdx = SOURCE.indexOf('function ChangelogPage()');
  const pageBody = SOURCE.slice(pageIdx, SOURCE.indexOf('\nfunction calculateReportMetrics', pageIdx));
  const combined = changelogSrc + navBody + pageBody;
  assert.doesNotMatch(combined, /onAuthStateChange|staff_users|useAuth\(|AUTH-DIAG/);
});
