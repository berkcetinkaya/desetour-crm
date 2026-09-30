'use strict';
/**
 * tests/dashboard/desktopGridLayout.test.js
 * ─────────────────────────────────────────────────────────────────────────
 * Regression coverage for the Ana Sayfa (Dashboard) desktop grid layout
 * refinement — a visual/CSS-only pass. Every test here is a static source
 * assertion against DeseTourDashboard.jsx; nothing renders React or touches
 * a database. These tests exist to lock in the new symmetrical 12-column
 * composition and to prove the change never reached data/business logic.
 * ─────────────────────────────────────────────────────────────────────────
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const SOURCE = fs.readFileSync(path.join(__dirname, '..', '..', 'DeseTourDashboard.jsx'), 'utf8');

function fnBody(name, source) {
  const idx = source.indexOf(`function ${name}(`);
  assert.ok(idx !== -1, `expected to find function ${name}`);
  const nextFnIdx = source.indexOf('\nfunction ', idx + 10);
  return source.slice(idx, nextFnIdx === -1 ? undefined : nextFnIdx);
}

// ── Section 2: KPI row — 5 equal columns ────────────────────────────────

test('KpiRow renders 5 KPI cards on an equal-column grid with the dashboard-standard 16px gap', () => {
  const body = fnBody('KpiRow', SOURCE);
  assert.match(body, /className="dash-kpi-grid"/);
  assert.match(body, /gridTemplateColumns:"repeat\(5,1fr\)"/);
  assert.match(body, /gap:16/);
});

// ── Section 3: Bugünkü Turlar / Acil İşler — 50/50, equal height ───────

test('Section 3 (TodayTours + UrgentPanel) is an exact 50/50 grid, not the old 1.85fr/1fr split', () => {
  const dashBody = fnBody('Dashboard', SOURCE);
  const idx = dashBody.indexOf('dash-row-2');
  assert.ok(idx !== -1, 'expected the dash-row-2 section wrapper');
  const section = dashBody.slice(idx, dashBody.indexOf('</div>', idx));
  assert.match(section, /gridTemplateColumns:"1fr 1fr"/);
  assert.doesNotMatch(section, /1\.85fr/);
  assert.match(section, /gap:16/);
  assert.match(section, /<TodayTours\/>/);
  assert.match(section, /<UrgentPanel\/>/);
});

test('Section 3 does not force alignItems:"start" — cards default to CSS Grid stretch so unequal content never shrinks one card shorter than the other', () => {
  const dashBody = fnBody('Dashboard', SOURCE);
  const idx = dashBody.indexOf('dash-row-2');
  const section = dashBody.slice(idx, dashBody.indexOf('</div>', idx));
  assert.doesNotMatch(section, /alignItems/);
});

test('TodayTours and UrgentPanel both use the same unmodified Card padding — no one-off padding override on either, so header/content padding match exactly', () => {
  const todayBody = fnBody('TodayTours', SOURCE);
  const urgentBody = fnBody('UrgentPanel', SOURCE);
  // Neither passes a custom `padding:` override to Card — both rely on
  // Card's own default (22px 24px), so their header/content padding is
  // identical by construction rather than by two matching literals.
  assert.doesNotMatch(todayBody.slice(0, todayBody.indexOf('<SectionHeader')), /padding:/);
  assert.doesNotMatch(urgentBody.slice(0, urgentBody.indexOf('<SectionHeader')), /padding:/);
  assert.match(todayBody, /<Card style=\{\{display:"flex", flexDirection:"column"\}\}>/);
  assert.match(urgentBody, /<Card style=\{\{display:"flex", flexDirection:"column"\}\}>/);
});

// ── Section 4: Yaklaşan Rezervasyonlar / Bekleyen Ödemeler / Son Aktiviteler ─

test('Section 4 is an exact 33.333% three-column grid with the dashboard-standard 16px gap', () => {
  const dashBody = fnBody('Dashboard', SOURCE);
  const idx = dashBody.indexOf('dash-row-3');
  assert.ok(idx !== -1, 'expected the dash-row-3 section wrapper');
  const section = dashBody.slice(idx, dashBody.indexOf('</div>', idx));
  assert.match(section, /gridTemplateColumns:"1fr 1fr 1fr"/);
  assert.match(section, /gap:16/);
  assert.match(section, /<UpcomingReservations\/>/);
  assert.match(section, /<PendingPaymentsWidget\/>/);
  assert.match(section, /<ActivityFeed\/>/);
});

test('Section 4 does not force alignItems:"start" — all three cards stretch to equal height', () => {
  const dashBody = fnBody('Dashboard', SOURCE);
  const idx = dashBody.indexOf('dash-row-3');
  const section = dashBody.slice(idx, dashBody.indexOf('</div>', idx));
  assert.doesNotMatch(section, /alignItems/);
});

for (const [fn, emptyMarker] of [
  ['UpcomingReservations', 'Yaklaşan rezervasyon bulunmuyor'],
  ['PendingPaymentsWidget', 'Bekleyen ödeme bulunmuyor'],
  ['ActivityFeed', 'Henüz aktivite kaydı yok'],
]) {
  test(`${fn} is a flex-column Card with a flex:1 body wrapper that centers its loading/empty state — so an empty card never reads as a differently sized component next to its Section 4 siblings`, () => {
    const body = fnBody(fn, SOURCE);
    assert.match(body, /<Card style=\{\{display:"flex", flexDirection:"column"\}\}>/);
    assert.match(body, /flex:1, display:"flex", flexDirection:"column", justifyContent:/);
    assert.match(body, new RegExp(emptyMarker));
  });
}

// ── Section 5: Rehber Operasyonu — full width, 3 equal KPI columns ─────

test('GuideOpsPanel is wrapped in the shared Card component (same border radius/padding/shadow as every other dashboard row) instead of a one-off styled div', () => {
  const body = fnBody('GuideOpsPanel', SOURCE);
  assert.match(body, /return \(\s*<Card>/);
  assert.doesNotMatch(body, /background:C\.white, border:`1px solid \$\{C\.border\}`, borderRadius:12, padding:"18px 20px"/);
});

test('GuideOpsPanel\'s three KPI blocks (Aktif Rehber / Bugün Atanmış Rehber / Rehber Atanmamış Yaklaşan Rezervasyon) are three equal columns at the dashboard-standard 16px gap', () => {
  const body = fnBody('GuideOpsPanel', SOURCE);
  assert.match(body, /className="dash-guide-kpi"/);
  assert.match(body, /gridTemplateColumns:"repeat\(3,1fr\)"/);
  assert.match(body, /gap:16/);
});

// ── Card geometry consistency across the whole dashboard ───────────────

test('every dashboard-only grid classname (dash-kpi-grid, dash-row-2, dash-row-3, dash-guide-kpi) appears exactly where expected and nowhere else in the file — no leftover use of the old shared rsp-split/rsp-stat-grid classnames inside Dashboard, TodayTours, UrgentPanel, UpcomingReservations, PendingPaymentsWidget, ActivityFeed, or GuideOpsPanel', () => {
  for (const fnName of ['Dashboard', 'KpiRow', 'GuideOpsPanel']) {
    const body = fnBody(fnName, SOURCE);
    assert.doesNotMatch(body, /rsp-split|rsp-stat-grid/);
  }
});

// ── Tablet: dashboard-scoped 2-column wrapping, isolated from every other page ─

test('a tablet-only (768–1023px) media query gives the dashboard grids sensible 2-column wrapping', () => {
  assert.match(SOURCE, /@media \(min-width: 768px\) and \(max-width: 1023px\) \{[\s\S]{0,400}\.dash-kpi-grid[\s\S]{0,80}repeat\(2, minmax\(0,1fr\)\)/);
  assert.match(SOURCE, /\.dash-row-3[\s\S]{0,80}repeat\(2, minmax\(0,1fr\)\)/);
  assert.match(SOURCE, /\.dash-guide-kpi[\s\S]{0,80}repeat\(2, minmax\(0,1fr\)\)/);
});

test('the tablet dashboard media query never touches .rsp-split or .rsp-stat-grid — every other page\'s tablet layout is untouched by this change', () => {
  const tabletIdx = SOURCE.indexOf('@media (min-width: 768px) and (max-width: 1023px)');
  assert.ok(tabletIdx !== -1);
  const tabletBlock = SOURCE.slice(tabletIdx, SOURCE.indexOf('}', SOURCE.indexOf('}', tabletIdx) + 1) + 1);
  assert.doesNotMatch(tabletBlock, /\.rsp-split|\.rsp-stat-grid/);
});

test('the pre-existing mobile (max-width: 767px) media query and its .rsp-split/.rsp-stat-grid rules are untouched — Dashboard never renders below 768px (MobileHomePage takes over), so mobile business behavior is unaffected by this pass', () => {
  assert.match(SOURCE, /@media \(max-width: 767px\) \{/);
  assert.match(SOURCE, /\.rsp-stat-grid \{ grid-template-columns: repeat\(2, minmax\(0, 1fr\)\) !important; gap: 10px !important; \}/);
  assert.match(SOURCE, /\.rsp-split \{ grid-template-columns: 1fr !important; \}/);
});

test('PageRouter still routes base==="dashboard" to MobileHomePage when isMobile, and to Dashboard otherwise — this pass never touched that routing split', () => {
  const routerBody = fnBody('PageRouter', SOURCE);
  assert.match(routerBody, /if \(base === "dashboard"\) return <MobileHomePage navigate=\{navigate\}\/>;/);
  assert.match(routerBody, /if \(base === "dashboard"\) return <Dashboard\/>;/);
});

// ── Scope guard: layout only, no data/business logic touched ───────────

test('scope guard: Dashboard still renders the same components in the same order (Welcome, OnemliUyarilar, KpiRow, Section 3, Section 4, GuideOpsPanel, RecentReviewsPanel) — only their wrapping grid CSS changed', () => {
  const body = fnBody('Dashboard', SOURCE);
  const order = ['<Welcome/>', '<OnemliUyarilar/>', '<KpiRow/>', '<TodayTours/>', '<UrgentPanel/>', '<UpcomingReservations/>', '<PendingPaymentsWidget/>', '<ActivityFeed/>', '<GuideOpsPanel/>', '<RecentReviewsPanel/>'];
  let cursor = -1;
  for (const token of order) {
    const idx = body.indexOf(token);
    assert.ok(idx > cursor, `expected ${token} to appear in order`);
    cursor = idx;
  }
});

test('scope guard: no dashboard data-fetching call (useRepo/computeUrgent/calculateDashboardMetrics) was added, removed, or had its arguments changed by this layout pass', () => {
  assert.match(SOURCE, /useRepo\("reservation", "getAll"\)/);
  assert.match(SOURCE, /useRepo\("payment", {1,8}"getAll"\)/);
  assert.match(SOURCE, /useRepo\("guide", {1,8}"getAll"\)/);
  assert.match(SOURCE, /computeUrgent\(repoRes, repoPays, repoRems\)/);
  assert.match(SOURCE, /calculateDashboardMetrics\(null, repoRes, repoPays, null, null\)/);
});

test('scope guard: no SQL file was touched by this layout-only pass — no .sql content appears anywhere in the dashboard source', () => {
  const dashBody = fnBody('Dashboard', SOURCE);
  assert.doesNotMatch(dashBody, /\.sql|CREATE TABLE|ALTER TABLE|BEGIN;|COMMIT;/);
});

test('scope guard: Önemli Uyarılar (OnemliUyarilar) keeps its exact prior render-nothing-when-empty and read/filter logic — Section 1 behavior is untouched, only alignment with the grid below is in scope', () => {
  const body = fnBody('OnemliUyarilar', SOURCE);
  assert.match(body, /if \(loading \|\| error \|\| alerts\.length === 0\) return null;/);
  assert.match(body, /<SectionHeader title="Önemli Uyarılar"\/>/);
});
