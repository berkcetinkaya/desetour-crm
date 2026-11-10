'use strict';
/**
 * tests/dashboard/dashboardFocus.test.js
 * Ana Sayfa focus layout: the revenue-goal centerpiece (100.000 ₺ steps,
 * once-per-step celebration), live new-reservation / message /
 * cancellation signals, and the open/close DashboardSection groups.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { extractTestableFn } = require('./extractTestableFn');

const SOURCE = fs.readFileSync(path.join(__dirname, '..', '..', 'DeseTourDashboard.jsx'), 'utf8');

function extractCombined(names) {
  const bodies = names.map(name => {
    const s = SOURCE.indexOf(`// TESTABLE:${name}:start`);
    const e = SOURCE.indexOf(`// TESTABLE:${name}:end`);
    if (s === -1 || e === -1 || e < s) throw new Error(`markers for ${name} not found`);
    return SOURCE.slice(s + `// TESTABLE:${name}:start`.length, e);
  });
  // eslint-disable-next-line no-new-func
  return new Function(`${bodies.join('\n')}\nreturn ${names[names.length - 1]};`)();
}

function body(name) {
  const idx = SOURCE.indexOf(`function ${name}(`);
  assert.ok(idx !== -1, `function ${name} not found`);
  return SOURCE.slice(idx, SOURCE.indexOf('\nfunction ', idx + 10));
}

const progress = extractTestableFn('_revenueMilestoneProgress');
const shouldCelebrate = extractTestableFn('_shouldCelebrateMilestone');
const classify = extractTestableFn('_classifyLiveSignal');
const group = extractCombined(['_classifyLiveSignal', '_groupLiveSignals']);

// ── Revenue milestones ──────────────────────────────────────────────────

test('revenue progress: below the first step targets 100.000 with the right percentage and remainder', () => {
  assert.deepEqual(progress(0, 100000), { value: 0, milestone: 0, next: 100000, pct: 0, remainingPct: 100, remaining: 100000 });
  assert.deepEqual(progress(62500, 100000), { value: 62500, milestone: 0, next: 100000, pct: 62, remainingPct: 38, remaining: 37500 });
});

test('revenue progress: exactly on a step counts that step as passed and starts the next at 0%', () => {
  assert.deepEqual(progress(300000, 100000), { value: 300000, milestone: 300000, next: 400000, pct: 0, remainingPct: 100, remaining: 100000 });
});

test('revenue progress: percentage floors (never rounds up to a step not yet reached)', () => {
  const p = progress(399999, 100000);
  assert.equal(p.milestone, 300000);
  assert.equal(p.pct, 99);
  assert.equal(p.remaining, 1);
  assert.equal(p.remainingPct, 1);
});

test('the spec example: ₺342.000 → passed 300K, next ₺400.000, ₺58.000 left, %42 done / %58 left', () => {
  const p = progress(342000, 100000);
  assert.equal(p.milestone, 300000);
  assert.equal(p.next, 400000);
  assert.equal(p.remaining, 58000);
  assert.equal(p.pct, 42);
  assert.equal(p.remainingPct, 58);
  assert.equal(p.pct + p.remainingPct, 100, 'done and left always add up to 100');
});

test('revenue progress: negative, missing or non-numeric input is treated as 0; a bad step falls back to 100.000', () => {
  assert.equal(progress(-500, 100000).value, 0);
  assert.equal(progress(undefined, 100000).milestone, 0);
  assert.equal(progress('abc', 100000).next, 100000);
  assert.equal(progress(250000, 0).milestone, 200000);
});

test('celebration fires only for a step above 0 that is higher than the last one celebrated this month', () => {
  assert.equal(shouldCelebrate(0, null), false, 'nothing to celebrate before the first 100.000');
  assert.equal(shouldCelebrate(100000, null), true);
  assert.equal(shouldCelebrate(100000, '100000'), false, 'never twice for the same step');
  assert.equal(shouldCelebrate(300000, '100000'), true);
  assert.equal(shouldCelebrate(200000, '300000'), false, 'a revenue drop never re-triggers a lower step');
});

test('RevenueGoalCard uses the same normalized summary as the KPI (never payments, never a fixed rate)', () => {
  const b = body('RevenueGoalCard');
  assert.match(b, /const \{ summary, loading \} = useMonthlyRevenueSummary\(\);/);
  assert.match(b, /const revenue = summary\.total;/);
  assert.doesNotMatch(b, /useRepo\(/, 'no separate data read — only the shared hook');
  assert.doesNotMatch(b, /_civitatisConvertToTry|_CIVITATIS_FIXED_EUR_TO_TRY_RATE|EUR_TO_TRY/);
  assert.match(b, /_revenueMilestoneProgress\(revenue, REVENUE_MILESTONE_STEP\)/);
  assert.match(SOURCE, /const REVENUE_MILESTONE_STEP = 100000;/);
  // The KPI card reads the exact same hook.
  assert.match(body('KpiRow'), /useMonthlyRevenueSummary\(\)/);
});

test('RevenueGoalCard copy: next target, remaining amount and remaining % in plain words', () => {
  const b = body('RevenueGoalCard');
  assert.match(b, /\{prog\.milestone > 0 \? "Sıradaki hedef" : "İlk hedef"\}/);
  assert.match(b, /`\$\{_fmtTRY\(prog\.remaining\)\} kaldı · %\$\{prog\.remainingPct\}`/);
});

test('the exclusion note appears only when some reservation could not be normalized, and names the reason as rate data', () => {
  const b = body('RevenueGoalCard');
  assert.match(b, /const otherExcludedCount = summary\.excludedCount - summary\.excludedByReason\.rate_source_error;/);
  assert.match(b, /\{!loading && otherExcludedCount > 0 && \(/);
  assert.match(b, /\{otherExcludedCount\} rezervasyon kur verisi nedeniyle bu toplama dahil değil\./);
  assert.match(b, /summary\.staleRateCurrencies\.length > 0 && <span>Son ECB kuru \{FX_MAX_RATE_AGE_DAYS\} günden eski/);
  assert.match(b, /summary\.missingRateCurrencies\.length > 0 && <span>ECB kuru bulunamadı/);
  assert.doesNotMatch(b, /Döviz cinsinden/);
});

test('converted foreign reservations get their own subtle note with the ECB rate date — never called "excluded"', () => {
  const b = body('RevenueGoalCard');
  assert.match(b, /\{!loading && summary\.convertedCount > 0 && \(/);
  assert.match(b, /\{summary\.convertedCount\} dövizli rezervasyon ECB kuru ile TL’ye çevrildi\./);
  assert.match(b, /ECB kuru · \{fxRateDates\.map\(_fmtFxRateDate\)\.join\(", "\)\}/);
  assert.match(b, /const fxRateDates = \[\.\.\.new Set\(Object\.values\(summary\.rateDatesUsed\)\)\]/, 'the date shown is the stored rate_date actually used');
  const convertedNote = b.slice(b.indexOf('summary.convertedCount > 0 && ('), b.indexOf('summary.fxUnresolved && ('));
  assert.ok(convertedNote.length > 0);
  assert.doesNotMatch(convertedNote, /dahil değil|hariç/);
});

test('rate-date disclosure formats the stored ECB date as "9 Kas 2026"', () => {
  const fmt = extractCombined(['_fmtFxRateDate']);
  assert.equal(fmt('2026-11-09'), '9 Kas 2026');
  assert.equal(fmt(''), '');
});

test('milestones and the celebration use only the normalized total shown to the user (never excluded amounts, never a fixed EUR rate)', () => {
  const b = body('RevenueGoalCard');
  assert.match(b, /const revenue = summary\.total;/);
  assert.match(b, /const prog = _revenueMilestoneProgress\(revenue, REVENUE_MILESTONE_STEP\);/);
  assert.match(b, /const shown = useCountUp\(loading \? 0 : revenue\);/, 'the displayed number is the same value');
  assert.match(b, /_shouldCelebrateMilestone\(prog\.milestone, last\)/);
  assert.match(b, /const canCelebrate = _canCelebrateRevenue\(loading, summary\);/);
  assert.match(b, /if \(!canCelebrate\) return;/);
  assert.match(b, /\}, \[canCelebrate, prog\.milestone, monthKey\]\);/);
  assert.doesNotMatch(b, /_CIVITATIS_FIXED_EUR_TO_TRY_RATE|excludedByCurrency\[[^\]]*\]\s*\*/);
});

test('premium card: no decorative disc and no gradients in the revenue card', () => {
  const b = body('RevenueGoalCard');
  assert.doesNotMatch(b, /gradient/i);
  assert.doesNotMatch(b, /borderRadius:"50%"[^}]*position:"absolute"|position:"absolute"[^}]*borderRadius:"50%"/, 'no absolutely positioned decorative circle');
});

test('celebrated step is remembered per month (YYYY-MM) and every localStorage access is guarded', () => {
  const b = body('RevenueGoalCard');
  assert.match(b, /const monthKey = _TODAY_ISO\.slice\(0, 7\);/);
  assert.match(b, /try \{ last = Number\(localStorage\.getItem\(REVENUE_MILESTONE_STORAGE_PREFIX \+ monthKey\)\) \|\| 0; \} catch \(_\) \{\}/);
  assert.match(b, /try \{ localStorage\.setItem\(REVENUE_MILESTONE_STORAGE_PREFIX \+ monthKey, String\(prog\.milestone\)\); \} catch \(_\) \{\}/);
  assert.match(b, /role="status"/, 'the congratulation is announced to screen readers');
});

// ── Live signals ────────────────────────────────────────────────────────

test('live signal classification uses the app\'s existing markers', () => {
  assert.equal(classify({ entityType: 'reservation', action: 'created' }), 'reservation');
  assert.equal(classify({ entityType: 'reservation', action: 'cancelled' }), 'cancellation');
  assert.equal(classify({ entityType: 'reservation', action: 'note_added', source: 'civitatis_message' }), 'message');
  assert.equal(classify({ entityType: 'agency_email', action: 'reply' }), 'message');
  assert.equal(classify({ entityType: 'reservation', action: 'note_added' }), null, 'e.g. the missing-passenger-names note is not a live signal');
  assert.equal(classify(null), null);
});

test('only UNREAD notifications become live signals, grouped by kind in the order received', () => {
  const g = group([
    { id: 1, entityType: 'reservation', action: 'created', isRead: false },
    { id: 2, entityType: 'reservation', action: 'created', isRead: true },
    { id: 3, entityType: 'reservation', action: 'cancelled', isRead: false },
    { id: 4, entityType: 'agency_email', action: 'reply', isRead: false },
    { id: 5, entityType: 'reservation', action: 'note_added', source: 'civitatis_message', isRead: false },
    { id: 6, entityType: 'reservation', action: 'note_added', isRead: false },
    { id: 7, entityType: 'reservation', action: 'created', isRead: false },
  ]);
  assert.deepEqual(g.reservation.map(n => n.id), [1, 7]);
  assert.deepEqual(g.message.map(n => n.id), [4, 5]);
  assert.deepEqual(g.cancellation.map(n => n.id), [3]);
  assert.deepEqual(group(null), { reservation: [], message: [], cancellation: [] });
});

test('LiveSignalsPanel reuses the shared notification hook (same role filter + read/navigate as the bell) and is hidden for Rehber', () => {
  const b = body('LiveSignalsPanel');
  assert.match(b, /useOperationalNotifications\(\)/);
  assert.match(b, /const eligible = !!auth\.role && auth\.role !== "Rehber";/);
  assert.match(b, /async function handleOpen\(n\) \{ hideLocally\(n\.id\); await select\(n\); \}/, 'open = the bell\'s select (marks read + navigates)');
  assert.match(b, /async function handleMarkRead\(n\) \{ hideLocally\(n\.id\); await markRead\(n\.id\); \}/, 'mark read = the bell\'s markRead');
  assert.doesNotMatch(b, /localStorage/, 'no second, browser-side read-state system');
});

test('the İptal drawer carries the old alert card\'s details and both of its actions', () => {
  const b = body('LiveSignalTile');
  assert.match(b, /def\.kind === "cancellation"/);
  assert.match(b, /<CancellationAlertBody alert=\{n\} compact\/>/);
  assert.match(b, /onClick=\{\(\) => onOpenItem\(n\)\}[^>]*>Rezervasyonu Gör</);
  assert.match(b, /onClick=\{\(\) => onMarkRead\(n\)\}[^>]*>Okundu Olarak İşaretle</);
});

test('cancellations are not shown twice: Önemli Uyarılar skips whatever a live signal already shows', () => {
  const b = body('OnemliUyarilar');
  // pinned lines stay intact
  assert.match(b, /const \{ alerts, loading, error, markRead \} = useUnreadImportantAlerts\(\);/);
  assert.match(b, /if \(loading \|\| error \|\| alerts\.length === 0\) return null;/);
  // dedupe
  assert.match(b, /const unsignaled = alerts\.filter\(a => !_classifyLiveSignal\(a\)\);/);
  assert.match(b, /if \(unsignaled\.length === 0\) return null;/);
  assert.match(b, /_paginateImportantAlerts\(unsignaled, MAX_VISIBLE_IMPORTANT_ALERTS\)/);
  // every alert the panel would get today is a cancellation → all represented by the İptal tile
  const alerts = [
    { id: 'a', entityType: 'reservation', action: 'cancelled', isRead: false },
    { id: 'b', entityType: 'reservation', action: 'cancelled', isRead: false },
  ];
  assert.deepEqual(alerts.filter(a => !classify(a)), []);
  assert.deepEqual(group(alerts).cancellation.map(a => a.id), ['a', 'b']);
});

// ── Layout / open-close groups ──────────────────────────────────────────

test('Dashboard() keeps the always-visible essentials first and has no conditional of its own', () => {
  const b = body('Dashboard');
  assert.doesNotMatch(b, /if\s*\(/);
  const order = ['<Welcome/>', '<DashboardPulse/>', '<OnemliUyarilar/>', '<TodayTours/>', '<UrgentPanel/>'];
  const idx = order.map(m => b.indexOf(m));
  idx.forEach((v, i) => assert.ok(v !== -1, `${order[i]} missing`));
  for (let i = 1; i < idx.length; i++) assert.ok(idx[i] > idx[i - 1], `${order[i]} must come after ${order[i - 1]}`);
});

test('secondary content lives in open/close groups: operations open by default, general status and other modules collapsed', () => {
  const b = body('Dashboard');
  // The opening tag is one line; summary={<…/>} contains its own ">" so
  // anchor on the line rather than on [^>]*.
  const openTag = id => (b.match(new RegExp(`<DashboardSection id="${id}"[^\\n]*`)) || [''])[0];
  assert.match(openTag('operations'), /defaultOpen=\{true\}>$/);
  assert.doesNotMatch(openTag('general'), /defaultOpen/);
  assert.doesNotMatch(openTag('modules'), /defaultOpen/);
  assert.match(b, /<DashboardSection id="general"[^\n]*\n\s*<KpiRow\/>/);
  assert.match(b, /<DashboardSection id="modules"[^\n]*\n\s*<SonBildirimlerPanel\/>/);
});

test('DashboardSection is an accessible disclosure that remembers its state and keeps a closed body out of keyboard focus', () => {
  const b = body('DashboardSection');
  assert.match(b, /aria-expanded=\{open\}/);
  assert.match(b, /aria-controls=\{bodyId\}/);
  assert.match(b, /bodyRef\.current\.inert = !open/);
  assert.match(b, /try \{\s*const v = localStorage\.getItem\(storageKey\);/);
  assert.match(b, /try \{ localStorage\.setItem\(storageKey, next \? '1' : '0'\); \} catch \(_\) \{\}/);
});

test('every new dashboard animation is switched off under prefers-reduced-motion', () => {
  const css = SOURCE.slice(SOURCE.indexOf('Ana Sayfa focus layout: staggered entrance'));
  const reduced = css.slice(css.indexOf('@media (prefers-reduced-motion: reduce)'));
  const block = reduced.slice(0, reduced.indexOf('\n        }\n'));
  assert.match(block, /\.dash-stack > \*, \.dash-ring-progress, \.dash-signal\.is-live, \.dash-ping::after, \.dash-celebrate \{ animation: none !important; \}/);
  assert.match(block, /\.dash-ping::after \{ display: none; \}/);
  assert.match(block, /\.dash-section__body, \.dash-section__chev, \.dash-ring-progress, \.dash-signal, \.dash-signal__head, \.dash-icon-btn \{ transition: none !important; \}/);
  assert.match(block, /\.dash-confetti \{ display: none; \}/);
  assert.match(body('useCountUp'), /if \(_prefersReducedMotion\(\)\)/);
});

test('live signal motion is calm: no opacity flashing of the card, slow breathe, 180–240ms transitions', () => {
  const css = SOURCE.slice(SOURCE.indexOf('Ana Sayfa focus layout: staggered entrance'));
  const kf = css.match(/@keyframes dashSignalBreathe \{([^\n]*)\}/);
  assert.ok(kf, 'dashSignalBreathe keyframes missing');
  assert.doesNotMatch(kf[1], /opacity/, 'the card itself never fades in and out');
  assert.match(css, /\.dash-signal\.is-live \{ animation: dashSignalBreathe 3\.6s ease-in-out infinite; \}/);
  assert.match(css, /\.dash-signal \{ transition: border-color 200ms ease, box-shadow 200ms ease; \}/);
  assert.match(css, /\.dash-section__chev \{ display: inline-flex; transition: transform 220ms ease; \}/);
  assert.match(css, /\.dash-section__body \{ display: grid; transition: grid-template-rows 240ms cubic-bezier\(\.2,\.7,\.2,1\), opacity 200ms ease; \}/);
  // the unread state is not motion-only: the tile keeps its tone border, the
  // static dot and the count under reduced motion (only ::after is hidden).
  assert.match(body('LiveSignalTile'), /border:`1px solid \$\{live \? tone\.border : C\.border\}`/);
  assert.match(body('LiveSignalTile'), /\{live && <span className="dash-ping" aria-hidden="true"\/>\}/);
});

test('collapsed group headers keep urgent/unread counts visible', () => {
  const ops = body('_OperationsSectionSummary');
  assert.match(ops, /\{pendingPrep > 0 && <_SectionChip tone="alert">\{pendingPrep\} hazırlık bekliyor<\/_SectionChip>\}/);
  assert.match(ops, /\{m\.unassignedGuideCount > 0 && <_SectionChip tone="alert">/);
  const mods = body('_ModulesSectionSummary');
  assert.match(mods, /<_SectionChip tone="unread">\{unread\.length\} okunmamış bildirim<\/_SectionChip>/);
  assert.match(mods, /useOperationalNotifications\(\)/, 'same role-filtered unread list as the bell');
  // summaries render in the header button, outside the collapsible body
  const sec = body('DashboardSection');
  assert.ok(sec.indexOf('dash-section__summary') < sec.indexOf('dash-section__body'));
});

test('critical warnings are never inside a collapsed group: Önemli Uyarılar, Bugün and Acil stay above the groups', () => {
  const b = body('Dashboard');
  const firstSection = b.indexOf('<DashboardSection');
  for (const m of ['<OnemliUyarilar/>', '<DashboardPulse/>', '<TodayTours/>', '<UrgentPanel/>']) {
    assert.ok(b.indexOf(m) !== -1 && b.indexOf(m) < firstSection, `${m} must be outside every DashboardSection`);
  }
});

test('section open/closed state: stored value wins, otherwise the default; "0" keeps a default-open group closed', () => {
  const b = body('DashboardSection');
  assert.match(b, /if \(v === '1'\) return true;/);
  assert.match(b, /if \(v === '0'\) return false;/);
  assert.match(b, /return defaultOpen;/);
  assert.match(SOURCE, /const DASH_SECTION_STORAGE_PREFIX = 'desetour_dash_section_';/);
});

test('MobileHomePage is untouched by the focus layout (no new dashboard pieces inside it)', () => {
  const b = body('MobileHomePage');
  for (const m of ['DashboardPulse', 'RevenueGoalCard', 'LiveSignalsPanel', 'DashboardSection']) {
    assert.ok(!b.includes(m), `${m} leaked into MobileHomePage`);
  }
});

test('the Bugün row stacks below 1400px so Acil İşler is never pushed out of view by the Bugünkü Turlar table', () => {
  assert.match(body('Dashboard'), /<div className="dash-row-2 dash-row-today"[^\n]*\n\s*<TodayTours\/>\n\s*<UrgentPanel\/>/);
  assert.match(SOURCE, /@media \(max-width: 1399px\) \{ \.dash-row-today \{ grid-template-columns: minmax\(0, 1fr\) !important; \} \}/);
});

test('cancellations stay in the chronological Son Bildirimler feed (history), unfiltered by the live-signal dedupe', () => {
  const b = body('SonBildirimlerPanel');
  assert.match(b, /const \{ notifications, loading, select \} = useOperationalNotifications\(\);/);
  assert.match(b, /const visible = notifications\.slice\(0, SON_BILDIRIMLER_MAX\);/);
  assert.doesNotMatch(b, /_classifyLiveSignal|cancelled/, 'the feed never drops cancellation events');
  assert.match(body('Dashboard'), /<DashboardSection id="modules"[^\n]*\n\s*<SonBildirimlerPanel\/>/);
});

test('Tur Hazırlıkları segmented tabs: dark-mode readable via tokens, light mode keeps its exact original colors', () => {
  const b = body('_TicketTabButton');
  assert.match(b, /background: active \? C\.segActiveBg : "transparent"/);
  assert.match(b, /color: active \? C\.segActiveText : C\.textMuted/);
  assert.match(b, /aria-pressed=\{active\}/);
  assert.match(b, /type="button"/);
  assert.doesNotMatch(b, /boxShadow/, 'no inline shadow, so the global :focus-visible ring still shows');
  assert.match(SOURCE, /segActiveBg:"var\(--c-seg-active-bg\)", segActiveText:"var\(--c-seg-active-text\)"/);
  // light = previous literal values (C.navy #1B2D4F on light --c-ivory #FAF9F6)
  const root = SOURCE.slice(SOURCE.indexOf('        :root {'), SOURCE.indexOf('        html[data-theme="dark"] {'));
  assert.match(root, /--c-seg-active-bg: #1B2D4F;/);
  assert.match(root, /--c-seg-active-text: #FAF9F6;/);
  assert.match(SOURCE, /navy:"#1B2D4F"/);
  const dark = SOURCE.slice(SOURCE.indexOf('        html[data-theme="dark"] {'));
  assert.match(dark.slice(0, 3000), /--c-seg-active-bg: rgba\(201,168,76,0\.18\);/);
  assert.match(dark.slice(0, 3000), /--c-seg-active-text: #D9BC67;/);
  // hover feedback is dark-only
  assert.match(SOURCE, /html\[data-theme="dark"\] \.dt-seg-tab\[aria-pressed="false"\]:hover \{/);
  assert.doesNotMatch(SOURCE, /\n\s*\.dt-seg-tab[:\[]/, 'no unscoped (light-affecting) .dt-seg-tab rule');
});

// ── FX rate-source failure is its own, visible state ─────────────────────

test('a failed rate read shows its own warning — never "ECB kuru bulunamadı" — and no technical error text', () => {
  const b = body('RevenueGoalCard');
  const i = b.indexOf('{!loading && summary.fxUnresolved && (');
  assert.ok(i !== -1, 'warning is gated on fxUnresolved');
  const warning = b.slice(i, b.indexOf('{!loading && otherExcludedCount > 0', i));
  assert.match(warning, /Kur verisine erişilemiyor\. Dövizli rezervasyonlar geçici olarak toplam dışında\./);
  assert.match(warning, /role="status"/);
  assert.doesNotMatch(warning, /ECB kuru bulunamadı|error|message/i);
});

test('an incomplete total is visibly marked, and the ring is not shown as authoritative during an FX source failure', () => {
  const b = body('RevenueGoalCard');
  assert.match(b, /\{!loading && !summary\.isComplete && \(/);
  assert.match(b, />\s*Eksik toplam\s*</);
  assert.match(b, /stroke=\{summary\.fxUnresolved \? C\.textMuted : C\.gold\}/);
  assert.match(b, /\{summary\.fxUnresolved \? "kesinleşmedi" : "tamamlandı"\}/);
});

test('the shared hook passes a failed exchange_rates read on as rateSourceError (distinct from "no rates")', () => {
  const h = body('useMonthlyRevenueSummary');
  assert.match(h, /const \{ data:fxRows, loading:fxLoading, error:fxError \} = useRepo\("exchangeRate", "getLatestToTry"\);/);
  assert.match(h, /const rateSourceError = !!fxError;/);
  assert.match(h, /summarizeMonthlyExpectedRevenue\(repoRes \|\| \[\], _TODAY_ISO, fxRows \|\| \[\], \{ rateSourceError \}\)/);
  assert.match(h, /return \{ summary, loading: resLoading \|\| fxLoading \};/);
  assert.match(body('KpiRow'), /rev\.fxUnresolved \? "Bu ay · kur verisine erişilemiyor"/);
});

test('an unexpected (non-array) exchange_rates response is a source error, not an empty rate list', () => {
  const a = SOURCE.indexOf('const SupabaseExchangeRateRepo = {');
  const repo = SOURCE.slice(a, SOURCE.indexOf('\n};', a));
  assert.match(repo, /if \(error\) throw new Error\(error\.message\);/);
  assert.match(repo, /if \(!Array\.isArray\(data\)\) throw new Error\('exchange_rates: unexpected response'\);/);
  assert.doesNotMatch(repo, /data \|\| \[\]/);
});
