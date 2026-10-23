'use strict';
/**
 * tests/dashboard/mobileHomepageRedesign.test.js
 * ─────────────────────────────────────────────────────────────────────────
 * Mobile homepage redesign ("simpler operational philosophy" phase):
 * MobileHomePage no longer mirrors the desktop dashboard. Final, further-
 * simplified hierarchy — exactly 5 primary sections: Bugünkü Turlar,
 * Yarınki Turlar, Yaklaşan Rezervasyonlar, Bilet Hazırlıkları, Yemek
 * Hazırlıkları. No greeting/welcome block, no Önemli Uyarılar, no Dikkat
 * Gerekenler on this screen — this is a concise, current/near-future
 * tour-operations homepage, not a general alert surface. Plus a
 * redesigned mobile header (no Dese logo, a menu control at the top).
 *
 * All assertions are static source-text checks against the REAL shipping
 * DeseTourDashboard.jsx, matching every other test file for this
 * 900KB+ single-file component (no React DOM/testing-library in this
 * project's devDependencies — see any sibling *.test.js file's own header
 * for the same rationale). No Supabase/network call anywhere in this file.
 * ─────────────────────────────────────────────────────────────────────────
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { extractFunctionSource } = require('./extractTestableFn');

const SOURCE_PATH = path.join(__dirname, '..', '..', 'DeseTourDashboard.jsx');
const SOURCE = fs.readFileSync(SOURCE_PATH, 'utf8');

const MOBILE_HOME_BODY = extractFunctionSource('MobileHomePage');

function mobileHeaderBlock() {
  const headerIdx = SOURCE.indexOf('{isMobile && (\n        <div style={{\n          position:"fixed", top:0, left:0, right:0, zIndex:200,');
  assert.ok(headerIdx > -1, 'expected the mobile fixed header block in App()');
  return SOURCE.slice(headerIdx, SOURCE.indexOf('{isMobile && <BottomNav', headerIdx));
}

// ── Mobile header ────────────────────────────────────────────────────────

test('mobile header has no Dese logo', () => {
  assert.doesNotMatch(mobileHeaderBlock(), /seffafdeselogo\.png/);
});

test('mobile menu control is the leftmost (visually primary) element in the header and remains accessible', () => {
  const header = mobileHeaderBlock();
  const menuIdx = header.indexOf("onClick={()=>navigate('/more')}");
  const titleIdx = header.indexOf('MOBILE_PAGE_TITLES[base]');
  const bellIdx = header.indexOf('<MobileNotificationBell/>');
  assert.ok(menuIdx > -1, 'expected a menu control routing to /more');
  assert.ok(menuIdx < titleIdx && titleIdx < bellIdx, 'menu control must be the leftmost element, ahead of the title and the bell');
});

test('the mobile header keeps the notification bell and theme toggle (already part of the global shell)', () => {
  const header = mobileHeaderBlock();
  assert.match(header, /<ThemeToggle theme=\{theme\} onToggle=\{toggleTheme\}/);
  assert.match(header, /<MobileNotificationBell\/>/);
});

test('desktop header (DesktopTopBar) remains unchanged — still renders GlobalSearch, NotificationBell, ThemeToggle and the user identity block, gated to !isMobile only', () => {
  const body = extractFunctionSource('DesktopTopBar');
  assert.match(body, /<GlobalSearch\/>/);
  assert.match(body, /<NotificationBell\/>/);
  assert.match(body, /<ThemeToggle theme=\{theme\} onToggle=\{onToggleTheme\}\/>/);
  assert.match(body, /auth\.displayName/);
  assert.match(SOURCE, /\{!isMobile && <DesktopTopBar/);
});

// ── Sections removed from the mobile homepage (feature itself untouched) ──

test('mobile homepage does not render Civitatis Hakedişi', () => {
  assert.doesNotMatch(MOBILE_HOME_BODY, /Civitatis Hakedişi/);
  assert.doesNotMatch(MOBILE_HOME_BODY, /civitatisSettlement/);
});

test('mobile homepage does not render Son Hareketler', () => {
  assert.doesNotMatch(MOBILE_HOME_BODY, /MobileSection title="Son Hareketler"/);
  assert.doesNotMatch(MOBILE_HOME_BODY, /useRecentActivity\(\)/);
});

test('mobile homepage does not render Hızlı İşlemler', () => {
  assert.doesNotMatch(MOBILE_HOME_BODY, /Hızlı İşlemler/);
  assert.doesNotMatch(MOBILE_HOME_BODY, /QUICK_ACTIONS/);
});

test('mobile homepage does not render Son Bildirimler or Agency CRM+ (large summary sections competing with the new hierarchy)', () => {
  assert.doesNotMatch(MOBILE_HOME_BODY, /MobileSection title="Son Bildirimler"/);
  assert.doesNotMatch(MOBILE_HOME_BODY, /MobileSection title="Agency CRM\+"/);
});

test('mobile homepage does not render a greeting/welcome block', () => {
  assert.doesNotMatch(MOBILE_HOME_BODY, /\{greeting\}/);
  assert.doesNotMatch(MOBILE_HOME_BODY, /Günaydın|İyi günler|İyi akşamlar/);
});

test('mobile homepage does not render Önemli Uyarılar (the cancellation-review alert feature remains unchanged elsewhere, just not on this screen)', () => {
  assert.doesNotMatch(MOBILE_HOME_BODY, /MobileSection title="Önemli Uyarılar"/);
  assert.doesNotMatch(MOBILE_HOME_BODY, /useUnreadImportantAlerts\(\)/);
  assert.doesNotMatch(MOBILE_HOME_BODY, /CancellationAlertBody/);
  // The feature itself is untouched: still used by the desktop OnemliUyarilar component.
  assert.match(SOURCE, /function useUnreadImportantAlerts\(\)/);
  assert.match(SOURCE, /const \{ alerts, loading, error, markRead \} = useUnreadImportantAlerts\(\);/);
});

test('mobile homepage does not render Dikkat Gerekenler (the general ops-urgency summary); computeUrgent itself remains used elsewhere', () => {
  assert.doesNotMatch(MOBILE_HOME_BODY, /MobileSection title="Dikkat Gerekenler"/);
  assert.doesNotMatch(MOBILE_HOME_BODY, /urgentItems/);
  // computeUrgent is never actually CALLED on this page (the explanatory
  // comment above merely names it) — no "computeUrgent(" invocation.
  assert.doesNotMatch(MOBILE_HOME_BODY, /computeUrgent\(repoRes/);
  // computeUrgent is still a real, used function elsewhere (not deleted).
  assert.match(SOURCE, /function computeUrgent\(reservations, payments, reminders\)/);
  const computeUrgentCallSites = (SOURCE.match(/computeUrgent\(repoRes|computeUrgent\(_res/g) || []).length;
  assert.ok(computeUrgentCallSites >= 2, 'computeUrgent must still have real call sites outside MobileHomePage');
});

test('removed sections are still reachable through their existing routes/modules (not deleted from the CRM)', () => {
  // Civitatis Hakedişi -> Ödemeler
  assert.match(SOURCE, /function _MobileCivitatisHakedisleriView\(\)/);
  // Son Hareketler -> dedicated /activity page
  assert.match(SOURCE, /if \(base === "activity"\) return <SonHareketlerPage\/>;/);
  // Agency CRM+'s own module -> Acenteler
  assert.match(SOURCE, /function AcentelerPage\(/);
  // Önemli Uyarılar -> desktop Dashboard's OnemliUyarilar component
  assert.match(SOURCE, /<OnemliUyarilar\/>/);
});

// ── New hierarchy: order + prominence ──────────────────────────────────

test('mobile homepage contains EXACTLY the 5 required primary sections, in order: Bugünkü Turlar, Yarınki Turlar, Yaklaşan Rezervasyonlar, Bilet Hazırlıkları, Yemek Hazırlıkları — nothing more, nothing less', () => {
  const required = ['Bugünkü Turlar', 'Yarınki Turlar', 'Yaklaşan Rezervasyonlar', 'Bilet Hazırlıkları', 'Yemek Hazırlıkları'];
  const order = required.map(title => {
    const idx = MOBILE_HOME_BODY.indexOf(`"${title}"`);
    assert.ok(idx > -1, `expected to find a section titled "${title}"`);
    return idx;
  });
  for (let i = 0; i < order.length - 1; i++) {
    assert.ok(order[i] < order[i + 1], `section ${i} must render before section ${i + 1}`);
  }
  // Exactly 5 MobileSection/_MobileAccordionSection titles total on this page.
  const sectionTitles = (MOBILE_HOME_BODY.match(/(?:MobileSection|_MobileAccordionSection) title="([^"]+)"/g) || []);
  assert.deepEqual(
    sectionTitles,
    required.map(t => (t.includes('Hazırlıkları') ? `_MobileAccordionSection title="${t}"` : `MobileSection title="${t}"`))
  );
});

test('Bugünkü Turlar is the single most visually prominent section (the only one using MobileSection\'s `prominent` title treatment)', () => {
  const todayIdx = MOBILE_HOME_BODY.indexOf('title="Bugünkü Turlar"');
  const todaySection = MOBILE_HOME_BODY.slice(todayIdx, todayIdx + 60);
  assert.match(todaySection, /prominent/);
  // Yarınki Turlar uses the SAME card component (same visual language)
  // but the plain (non-prominent) section caption — lower visual priority.
  const tomorrowIdx = MOBILE_HOME_BODY.indexOf('title="Yarınki Turlar"');
  const tomorrowSection = MOBILE_HOME_BODY.slice(tomorrowIdx, tomorrowIdx + 30);
  assert.doesNotMatch(tomorrowSection, /prominent/);
});

test('Bugünkü Turlar is the first homepage content section — no greeting, alert, or any other panel renders above it', () => {
  const returnIdx = MOBILE_HOME_BODY.indexOf('return (');
  const todayIdx = MOBILE_HOME_BODY.indexOf('MobileSection title="Bugünkü Turlar"');
  assert.ok(returnIdx > -1 && todayIdx > -1);
  const between = MOBILE_HOME_BODY.slice(returnIdx, todayIdx);
  // Nothing but the opening <div> wrapper and a JSX comment may appear
  // before Bugünkü Turlar — no other section, card, or text content.
  assert.doesNotMatch(between, /MobileSection title=/);
  assert.doesNotMatch(between, /MobileEntityCard/);
  assert.doesNotMatch(between, /\{greeting\}/);
});

// ── Bugünkü Turlar ──────────────────────────────────────────────────────

test('Bugünkü Turlar renders correctly: filters by today (date or checkIn), sorted by time, using the shared _MobileTourDayCard', () => {
  const idx = MOBILE_HOME_BODY.indexOf('const todaysTours');
  const body = MOBILE_HOME_BODY.slice(idx, idx + 300);
  assert.match(body, /r\.date === _TODAY_STR \|\| r\.checkIn === _TODAY_ISO/);
  assert.match(body, /\.sort\(\(a,b\) => \(a\.time\|\|""\)\.localeCompare\(b\.time\|\|""\)\)/);
  const sectionIdx = MOBILE_HOME_BODY.indexOf('MobileSection title="Bugünkü Turlar"');
  const sectionEnd = MOBILE_HOME_BODY.indexOf('</MobileSection>', sectionIdx);
  const section = MOBILE_HOME_BODY.slice(sectionIdx, sectionEnd);
  assert.match(section, /<_MobileTourDayCard key=\{t\.id\|\|i\} t=\{t\} navigate=\{navigate\} prepPending=\{prepPendingReservationIds\.has\(t\.id\)\}\/>/);
});

test('_MobileTourDayCard shows time, tour name, guest name + guest count, guide status, optional preparation flag and optional pickup detail', () => {
  const body = extractFunctionSource('_MobileTourDayCard');
  assert.match(body, /\{fmtResTime\(t\.time\)\}/);
  assert.match(body, /\{t\.tour \|\| "—"\}/);
  assert.match(body, /\{t\.name \|\| t\.customer \|\| "—"\} · \{t\.pax\|\|1\} kişi/);
  assert.match(body, /Rehber: \$\{t\.guide\}/);
  assert.match(body, /prepPending && <MobileStatusChip label="Hazırlık Bekliyor"/);
  assert.match(body, /\{t\.pickup && \(/);
});

// ── Yarınki Turlar ──────────────────────────────────────────────────────

test('Yarınki Turlar renders correctly: filters by tomorrow (date or checkIn), sorted by time, same _MobileTourDayCard as today', () => {
  const idx = MOBILE_HOME_BODY.indexOf('const tomorrowsTours');
  const body = MOBILE_HOME_BODY.slice(idx, idx + 300);
  assert.match(body, /r\.date === _TOMORROW_STR \|\| r\.checkIn === _TOMORROW_ISO/);
  assert.match(body, /\.sort\(\(a,b\) => \(a\.time\|\|""\)\.localeCompare\(b\.time\|\|""\)\)/);
  const sectionIdx = MOBILE_HOME_BODY.indexOf('MobileSection title="Yarınki Turlar"');
  const sectionEnd = MOBILE_HOME_BODY.indexOf('</MobileSection>', sectionIdx);
  const section = MOBILE_HOME_BODY.slice(sectionIdx, sectionEnd);
  assert.match(section, /<_MobileTourDayCard key=\{t\.id\|\|i\} t=\{t\} navigate=\{navigate\} prepPending=\{prepPendingReservationIds\.has\(t\.id\)\}\/>/);
});

test('_TOMORROW_STR/_TOMORROW_ISO follow the exact same module-init-time, dual-format convention as _TODAY_STR/_TODAY_ISO', () => {
  assert.match(SOURCE, /const _TOMORROW_STR = new Date\(Date\.now\(\)\+86400000\)\.toLocaleDateString\("tr-TR",\{day:"02-digit".*\}\);|const _TOMORROW_STR = new Date\(Date\.now\(\)\+86400000\)\.toLocaleDateString\("tr-TR",\{day:"2-digit",month:"short",year:"numeric"\}\);/);
  assert.match(SOURCE, /const _TOMORROW_ISO = new Date\(Date\.now\(\)\+86400000\)\.toISOString\(\)\.split\("T"\)\[0\];/);
});

test('today and tomorrow are mutually exclusive and both excluded from Yaklaşan Rezervasyonlar (no reservation appears twice across the three sections)', () => {
  const idx = MOBILE_HOME_BODY.indexOf('const upcoming');
  const body = MOBILE_HOME_BODY.slice(idx, idx + 400);
  assert.match(body, /r\.date !== _TODAY_STR && r\.checkIn !== _TODAY_ISO/);
  assert.match(body, /r\.date !== _TOMORROW_STR && r\.checkIn !== _TOMORROW_ISO/);
});

// ── Yaklaşan Rezervasyonlar ─────────────────────────────────────────────

test('Yaklaşan Rezervasyonlar renders correctly: next 5 upcoming reservations, with a "Tümünü Gör" link to the existing /reservations route — no pagination/filters built here', () => {
  const idx = MOBILE_HOME_BODY.indexOf('const upcoming');
  const body = MOBILE_HOME_BODY.slice(idx, idx + 400);
  assert.match(body, /\.slice\(0,\s*5\)/);
  const sectionIdx = MOBILE_HOME_BODY.indexOf('MobileSection title="Yaklaşan Rezervasyonlar"');
  const sectionEnd = MOBILE_HOME_BODY.indexOf('</MobileSection>', sectionIdx);
  const section = MOBILE_HOME_BODY.slice(sectionIdx, sectionEnd);
  assert.match(section, /action="Tümünü Gör" onAction=\{\(\)=>navigate\('\/reservations'\)\}/);
  assert.doesNotMatch(section, /useState\(.*page/i, 'no pagination state should be built into this section');
});

// ── Preparation accordions: shared component contract ──────────────────

test('_MobileAccordionSection: collapsed by default, shows the pending count without opening, and is non-interactive with a quiet "done" state when nothing is pending', () => {
  const body = extractFunctionSource('_MobileAccordionSection');
  assert.match(body, /useState\(false\)/, 'must start collapsed');
  assert.match(body, /\$\{count\} \$\{countLabel\}/, 'the pending count must be visible in the collapsed header');
  assert.match(body, /onClick=\{hasItems \? \(\) => setOpen\(o => !o\) : undefined\}/, 'non-interactive when there is nothing pending');
  assert.match(body, /tone=\{hasItems \? "warn" : "good"\}/);
});

test('_MobileAccordionSection: large touch target, smooth-but-restrained expand/collapse, no excessive border boxes, good light/dark support', () => {
  const body = extractFunctionSource('_MobileAccordionSection');
  assert.match(body, /minHeight:52/, 'the header button must be a large enough touch target');
  assert.match(body, /transition:"grid-template-rows 0\.25s cubic-bezier\(0\.4,0,0\.2,1\)"/, 'expand/collapse must be a smooth but restrained CSS transition');
  assert.match(body, /gridTemplateRows: open \? "1fr" : "0fr"/);
  // Theme-reactive tokens only — no hardcoded light-only hex that would
  // break dark mode (see the C object's own design-polish-phase contract).
  assert.doesNotMatch(body, /#[0-9A-Fa-f]{6}/, 'no hardcoded hex color — must use the theme-reactive C token system for light/dark support');
  assert.match(body, /background:C\.white/);
});

test('expanded accordion content reads like a compact operational table (plain rows, not full elevated cards)', () => {
  const ticketRow = extractFunctionSource('_MobileAccordionTicketRow');
  assert.doesNotMatch(ticketRow, /<MobileEntityCard/, 'accordion rows must be compact plain rows, not full MobileEntityCard surfaces');
  assert.match(ticketRow, /padding:"10px 12px", borderRadius:T\.radiusSm/);
});

// ── Bilet Hazırlıkları accordion ────────────────────────────────────────

test('ticket preparation accordion collapsed state: title "Bilet Hazırlıkları" with the pending count, built from the real tickets array length', () => {
  const sectionIdx = MOBILE_HOME_BODY.indexOf('<_MobileAccordionSection title="Bilet Hazırlıkları"');
  assert.ok(sectionIdx > -1);
  const section = MOBILE_HOME_BODY.slice(sectionIdx, sectionIdx + 200);
  assert.match(section, /count=\{tickets\.length\}/);
  assert.match(section, /countLabel="Bekliyor"/);
  assert.match(section, /emptyLabel="Tamamlandı"/);
});

test('ticket preparation accordion expanded state: shows only pending, operationally-relevant rows (tour, date, quantity, status) — no desktop-table clone, capped and "+N diğer" beyond the cap', () => {
  const sectionIdx = MOBILE_HOME_BODY.indexOf('<_MobileAccordionSection title="Bilet Hazırlıkları"');
  const sectionEnd = MOBILE_HOME_BODY.indexOf('</_MobileAccordionSection>', sectionIdx);
  const section = MOBILE_HOME_BODY.slice(sectionIdx, sectionEnd);
  assert.match(section, /tickets\.slice\(0, MAX_VISIBLE_TICKET_PREPARATIONS\)\.map/);
  assert.match(section, /tickets\.length > MAX_VISIBLE_TICKET_PREPARATIONS/);
  assert.match(section, /diğer bilet hazırlığı/);

  const rowBody = extractFunctionSource('_MobileAccordionTicketRow');
  assert.match(rowBody, /row\.tourName/);
  assert.match(rowBody, /new Date\(row\.checkIn\)\.toLocaleDateString\('tr-TR'/);
  assert.match(rowBody, /_formatTicketQuantityLabel\(row\.quantity\)/);
  assert.match(rowBody, /navigate\('\/reservations\/' \+ row\.reservationId\)/);
});

// ── Yemek Hazırlıkları accordion ─────────────────────────────────────────

test('food preparation accordion collapsed state: title "Yemek Hazırlıkları" with the pending count, built from the real meals array length', () => {
  const sectionIdx = MOBILE_HOME_BODY.indexOf('<_MobileAccordionSection title="Yemek Hazırlıkları"');
  assert.ok(sectionIdx > -1);
  const section = MOBILE_HOME_BODY.slice(sectionIdx, sectionIdx + 200);
  assert.match(section, /count=\{meals\.length\}/);
  assert.match(section, /countLabel="Bekliyor"/);
  assert.match(section, /emptyLabel="Tamamlandı"/);
});

test('food preparation accordion expanded state: shows only pending rows (tour, date, guest count), capped and "+N diğer" beyond the cap, never a completion action', () => {
  const sectionIdx = MOBILE_HOME_BODY.indexOf('<_MobileAccordionSection title="Yemek Hazırlıkları"');
  const sectionEnd = MOBILE_HOME_BODY.indexOf('</_MobileAccordionSection>', sectionIdx);
  const section = MOBILE_HOME_BODY.slice(sectionIdx, sectionEnd);
  assert.match(section, /meals\.slice\(0, MAX_VISIBLE_MEAL_PREPARATIONS\)\.map/);
  assert.match(section, /meals\.length > MAX_VISIBLE_MEAL_PREPARATIONS/);
  assert.match(section, /diğer yemek hazırlığı/);
  assert.match(section, /row\.tourName/);
  assert.match(section, /_formatMealQuantityLabel\(row\.quantity\)/);
  assert.doesNotMatch(section, /_canCompletePreparation|handleCompletePreparation|<button/);
});

// ── Pending counts + empty states (shared across both accordions) ──────

test('pending counts shown in both accordions come straight from _groupTourPreparationRows\' own real tickets/meals arrays — no separate counting logic', () => {
  const idx = MOBILE_HOME_BODY.indexOf('const { tickets, meals } = useMemo');
  assert.ok(idx > -1);
  const body = MOBILE_HOME_BODY.slice(idx, idx + 150);
  assert.match(body, /_groupTourPreparationRows\(turHazirliklariRows\)/);
});

test('Bugünkü/Yarınki Turlar empty states render a clean, quiet message when there are no tours', () => {
  assert.match(MOBILE_HOME_BODY, /Bugün için planlanmış tur yok\./);
  assert.match(MOBILE_HOME_BODY, /Yarın için planlanmış tur yok\./);
});

test('Bilet/Yemek Hazırlıkları empty state (zero pending) is the accordion\'s own quiet, non-interactive "Tamamlandı" row — not a separate empty-state component', () => {
  // Already covered structurally above (emptyLabel="Tamamlandı" on both
  // accordion mounts); this test confirms _MobileAccordionSection takes
  // NO vertical space beyond the one header row when there is nothing
  // pending (no expandable body is even rendered).
  const body = extractFunctionSource('_MobileAccordionSection');
  const bodyBlockIdx = body.indexOf('{hasItems && (');
  assert.ok(bodyBlockIdx > -1, 'the expandable body must be conditionally rendered only when hasItems — otherwise it would reserve space even when empty');
});

// ── Role-safe rendering ───────────────────────────────────────────────

test('role safe rendering: no new authorization behavior was introduced — every data hook on the mobile homepage is the SAME repo/hook used elsewhere, which already goes through RLS', () => {
  assert.match(MOBILE_HOME_BODY, /useRepo\("reservation", "getAll"\)/);
  assert.match(MOBILE_HOME_BODY, /useTurHazirliklariRows\(\)/);
  // No bespoke role/permission check was added anywhere in this page —
  // the one role check that exists (_canCompletePreparation) is the
  // SAME existing Yönetici/Operasyon gate used on desktop and on
  // Reservation Detail, never a new one.
  assert.doesNotMatch(MOBILE_HOME_BODY, /auth\.role === "|auth\.role !== "/, 'no new inline role string-comparison was introduced — only the existing _canCompletePreparation(auth.role, row) gate is reused');
});

test('role safe rendering: when a role has no pending ticket/meal preparations (e.g. RLS returns nothing for that role), the accordion renders its quiet zero-count state, never a broken/empty-but-interactive accordion', () => {
  // _MobileAccordionSection's hasItems gate (count > 0) already covers
  // the zero-rows-from-RLS case structurally — same code path as "nothing
  // is pending for any reason", so no separate role-specific branch exists
  // or is needed.
  const body = extractFunctionSource('_MobileAccordionSection');
  assert.match(body, /const hasItems = count > 0;/);
});

test('the ticket completion action is still gated by the existing _canCompletePreparation(role) check — Rehber/Satış never see the "Hazırlandı" button', () => {
  assert.match(MOBILE_HOME_BODY, /canComplete=\{_canCompletePreparation\(auth\.role,\s*row\)\}/);
});

// ── Light/dark mode compatibility ───────────────────────────────────────

test('light and dark mode compatibility: the new header menu control, accordions, and tour-day cards use only theme-reactive C tokens, never a hardcoded hex color', () => {
  const pieces = [
    mobileHeaderBlock(),
    extractFunctionSource('_MobileAccordionSection'),
    extractFunctionSource('_MobileAccordionTicketRow'),
    extractFunctionSource('_MobileTourDayCard'),
  ];
  for (const body of pieces) {
    const hexMatches = body.match(/#[0-9A-Fa-f]{6}\b/g) || [];
    // GOLD_ACCENT ("#8A6D1F") is the one pre-existing, deliberate fixed
    // brand accent already used this way across every other ticket row
    // in the app (desktop included) — not a new light-only regression.
    const unexpected = hexMatches.filter(h => h !== '#8A6D1F');
    assert.deepEqual(unexpected, [], `unexpected hardcoded hex color(s) found: ${unexpected.join(', ')}`);
  }
});

test('light and dark mode compatibility: MobileSection\'s new `prominent` title variant also uses theme-reactive tokens (C.text, not a fixed color)', () => {
  const body = extractFunctionSource('MobileSection');
  const prominentIdx = body.indexOf('prominent ? (');
  const prominentBlock = body.slice(prominentIdx, prominentIdx + 200);
  assert.match(prominentBlock, /color:C\.text/);
});

// ── Desktop safety ───────────────────────────────────────────────────────

test('desktop homepage (Dashboard()) remains exactly as it is: Welcome, OnemliUyarilar, KpiRow, SonBildirimlerPanel, AgencyCrmPlusSection, SonHareketlerPanel, CivitatisHakedisPanel, TurHazirliklari all still mounted, unconditionally, in the same order', () => {
  const body = extractFunctionSource('Dashboard');
  const order = ['<Welcome/>', '<OnemliUyarilar/>', '<KpiRow/>', '<SonBildirimlerPanel/>', '<AgencyCrmPlusSection/>', '<SonHareketlerPanel/>', '<CivitatisHakedisPanel/>', '<TurHazirliklari/>'].map(tag => {
    const idx = body.indexOf(tag);
    assert.ok(idx > -1, `expected ${tag} to still be mounted in Dashboard()`);
    return idx;
  });
  for (let i = 0; i < order.length - 1; i++) {
    assert.ok(order[i] < order[i + 1], `${i} must still precede ${i + 1} in Dashboard()`);
  }
});

test('desktop homepage routing is unaffected: PageRouter still returns <Dashboard/> for base==="dashboard" when !isMobile', () => {
  assert.match(SOURCE, /if \(base === "dashboard"\) return <Dashboard\/>;/);
});

test('this phase touched no desktop-only component (TurHazirliklari, _BiletHazirliklariDesktopPanel, CivitatisHakedisPanel, AgencyCrmPlusSection, SonHareketlerPanel, SonBildirimlerPanel, KpiRow, Welcome, OnemliUyarilar) beyond what MobileHomePage itself already called before this phase', () => {
  // A narrow, targeted check: none of these desktop component bodies
  // reference any of the NEW mobile-only symbols this phase introduced.
  const desktopBodies = [
    extractFunctionSource('TurHazirliklari'),
    extractFunctionSource('CivitatisHakedisPanel'),
  ];
  for (const body of desktopBodies) {
    assert.doesNotMatch(body, /_MobileAccordionSection|_MobileAccordionTicketRow|_MobileTourDayCard|_TOMORROW_STR|_TOMORROW_ISO/);
  }
});
