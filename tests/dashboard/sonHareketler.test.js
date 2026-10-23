'use strict';
/**
 * tests/dashboard/sonHareketler.test.js
 * ─────────────────────────────────────────────────────────────────────────
 * "Son Hareketler" — the meaningful operational activity experience
 * (homepage panel, dedicated full view, Admin Activity Summary, and the
 * per-Agency activity timeline). Reuses activity_logs + its actor
 * snapshot columns end to end — no new table, no parallel tracking
 * system. See DeseTourDashboard.jsx's own comments around
 * useRecentActivity/useAgencyActivity/ActivityRow for the architecture.
 *
 * As with every other test file for this single-file component, pure
 * logic is extracted via extractTestableFn and exercised directly;
 * placement/wiring/gating claims are static source-text assertions (no
 * React DOM/testing-library in this project).
 * ─────────────────────────────────────────────────────────────────────────
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { extractTestableFn } = require('./extractTestableFn');

const SOURCE_PATH = path.join(__dirname, '..', '..', 'DeseTourDashboard.jsx');
const SOURCE = fs.readFileSync(SOURCE_PATH, 'utf8');

const _isMeaningfulActivity   = extractTestableFn('_isMeaningfulActivity');
const _activityActorName      = extractTestableFn('_activityActorName');
const _activityIsSystem       = extractTestableFn('_activityIsSystem');
const _activityInitials       = extractTestableFn('_activityInitials');
const _activityCategory       = extractTestableFn('_activityCategory');
const _activityTarget         = extractTestableFn('_activityTarget');
const _activityTargetPath     = extractTestableFn('_activityTargetPath');
const _adminActivityBucket    = extractTestableFn('_adminActivityBucket');
const _reservationUpdateLogPlan    = extractTestableFn('_reservationUpdateLogPlan');

// _filterActivityByPeriod/_computeAdminActivitySummary call
// _agencyCrmPlusIsToday, which lives in a different part of the file
// (shared with computeAgencyCrmPlusSummary) — extractTestableFn only
// evaluates ONE marker's text, so these two need their dependency
// stitched in manually, in dependency order, same real implementations.
function extractCombined(names) {
  let combined = '';
  for (const name of names) {
    const s = `// TESTABLE:${name}:start`, e = `// TESTABLE:${name}:end`;
    const si = SOURCE.indexOf(s), ei = SOURCE.indexOf(e);
    if (si === -1 || ei === -1) throw new Error('extractCombined: marker not found: ' + name);
    combined += SOURCE.slice(si + s.length, ei) + '\n';
  }
  combined += `\nreturn ${names[names.length - 1]};`;
  // eslint-disable-next-line no-new-func
  return new Function(combined)();
}
const _filterActivityByPeriod = extractCombined(['_agencyCrmPlusIsToday', '_filterActivityByPeriod']);
const _computeAdminActivitySummary = extractCombined(['_agencyCrmPlusIsToday', '_adminActivityBucket', '_activityActorName', '_filterActivityByPeriod', '_computeAdminActivitySummary']);

function entry(overrides) {
  return {
    id: 'LOG-' + Math.random().toString(36).slice(2),
    entityType: 'reservation', entityId: 'RES-1', action: 'created',
    description: 'Rezervasyon: R-2026-0001', metadata: null,
    actorName: 'Berk Çetinkaya', actorRole: 'admin', source: null,
    performedBy: 'STAFF-1', createdAt: '2026-04-01T10:00:00Z',
    ...overrides,
  };
}

// ── _isMeaningfulActivity ───────────────────────────────────────────────

test('every real action this app writes is meaningful — only login/export are excluded', () => {
  for (const action of ['created','updated','status_changed','assigned','note_added','payment_received','completed','cancelled','outreach_sent','draft_created','draft_updated','reply']) {
    assert.equal(_isMeaningfulActivity(entry({ action })), true, `${action} should be meaningful`);
  }
  assert.equal(_isMeaningfulActivity(entry({ action: 'login' })), false);
  assert.equal(_isMeaningfulActivity(entry({ action: 'export' })), false);
});

// ── Actor resolution: snapshot → "Sistem", never a guessed name ────────

test('an entry with actorName set displays that name and is never flagged as system', () => {
  const e = entry({ actorName: 'Deniz' });
  assert.equal(_activityActorName(e), 'Deniz');
  assert.equal(_activityIsSystem(e), false);
});

test('an entry with no actorName (e.g. a Gmail-inbound-reply row, performed_by NULL) displays "Sistem"', () => {
  const e = entry({ actorName: null, performedBy: null });
  assert.equal(_activityActorName(e), 'Sistem');
  assert.equal(_activityIsSystem(e), true);
});

test('initials are derived from the actor name; "Sistem" (or no name) gets a plain "S"', () => {
  assert.equal(_activityInitials('Berk Çetinkaya'), 'BÇ');
  assert.equal(_activityInitials('Sistem'), 'S');
  assert.equal(_activityInitials(null), 'S');
});

// ── Category mapping (drives the icon + the Admin Summary buckets) ─────

test('category mapping covers every entity_type this app actually writes', () => {
  const cases = {
    reservation:'reservation', agency:'agency', agency_email:'agency',
    payment:'payment', civitatis_settlement:'payment', guide_payment:'payment',
    guide:'guide', tour:'tour', quote:'sales', lead:'sales',
    customer:'customer', task:'task', reservation_review:'review',
  };
  for (const [entityType, expected] of Object.entries(cases)) {
    assert.equal(_activityCategory(entry({ entityType })), expected, entityType);
  }
  assert.equal(_activityCategory(entry({ entityType: 'something_unknown' })), 'other');
});

// ── Click routing ────────────────────────────────────────────────────────

test('an agency_email row routes to the agency via metadata.agency_id, never its own entity_id (which is the email row\'s id)', () => {
  const e = entry({ entityType:'agency_email', entityId:'AEM-99', metadata:{ agency_id:'AGN-7' } });
  assert.deepEqual(_activityTarget(e), { type:'agency', id:'AGN-7' });
  assert.equal(_activityTargetPath(_activityTarget(e)), '/agencies/AGN-7');
});

test('an agency_email row with no agency_id in metadata routes to null — never a broken link', () => {
  const e = entry({ entityType:'agency_email', entityId:'AEM-99', metadata:{} });
  assert.equal(_activityTarget(e), null);
});

test('reservation/agency/guide/lead/quote/customer/tour rows route to their own entity_id', () => {
  for (const [entityType, prefix] of [['reservation','/reservations/'],['agency','/agencies/'],['guide','/guides/'],['lead','/leads/'],['quote','/quotes/'],['customer','/customers/'],['tour','/tours/']]) {
    const e = entry({ entityType, entityId: 'X-1' });
    assert.deepEqual(_activityTarget(e), { type: entityType, id: 'X-1' });
    assert.equal(_activityTargetPath(_activityTarget(e)), prefix + 'X-1');
  }
});

test('an entity type with no detail route (payment, guide_payment, task, reservation_review, civitatis_settlement) routes to null rather than a broken link', () => {
  for (const entityType of ['payment','guide_payment','task','reservation_review','civitatis_settlement']) {
    assert.equal(_activityTarget(entry({ entityType, entityId:'X-1' })), null, entityType);
  }
});

// ── Admin Activity Summary — counts and categories, never one score ────

test('the 4 admin buckets (agency/reservation/operational/email) are a clean partition with no overlap', () => {
  assert.equal(_adminActivityBucket(entry({ entityType:'agency_email' })), 'email');
  assert.equal(_adminActivityBucket(entry({ entityType:'agency' })), 'agency');
  assert.equal(_adminActivityBucket(entry({ entityType:'reservation' })), 'reservation');
  for (const entityType of ['payment','guide','tour','task','quote','lead','customer','reservation_review','civitatis_settlement','guide_payment']) {
    assert.equal(_adminActivityBucket(entry({ entityType })), 'operational', entityType);
  }
});

test('_filterActivityByPeriod "today" matches same-day entries only (reuses _agencyCrmPlusIsToday\'s date-string comparison)', () => {
  const now = '2026-09-15T18:00:00.000Z';
  const list = [
    entry({ id:'a', createdAt:'2026-09-15T02:00:00.000Z' }),
    entry({ id:'b', createdAt:'2026-09-14T23:59:00.000Z' }),
  ];
  const result = _filterActivityByPeriod(list, 'today', now);
  assert.deepEqual(result.map(e=>e.id), ['a']);
});

test('_filterActivityByPeriod "7d"/"30d" are rolling windows from now, excluding the future and anything older than the window', () => {
  const now = '2026-09-15T12:00:00.000Z';
  const list = [
    entry({ id:'within7', createdAt:'2026-09-10T12:00:00.000Z' }),
    entry({ id:'outside7', createdAt:'2026-09-01T12:00:00.000Z' }),
    entry({ id:'future', createdAt:'2026-09-20T12:00:00.000Z' }),
  ];
  const result7 = _filterActivityByPeriod(list, '7d', now).map(e=>e.id);
  assert.deepEqual(result7, ['within7']);
  const result30 = _filterActivityByPeriod(list, '30d', now).map(e=>e.id);
  assert.deepEqual(result30.sort(), ['within7','outside7'].sort());
});

test('_computeAdminActivitySummary never collapses to a single productivity score — it returns counts per bucket and per staff member', () => {
  const now = '2026-09-15T12:00:00.000Z';
  const list = [
    entry({ id:'1', entityType:'agency_email', actorName:'Berk Çetinkaya', createdAt: now }),
    entry({ id:'2', entityType:'reservation',  actorName:'Deniz',         createdAt: now }),
    entry({ id:'3', entityType:'agency_email', actorName:null, performedBy:null, createdAt: now }),
  ];
  const summary = _computeAdminActivitySummary(list, 'today', now);
  assert.equal(summary.total, 3);
  assert.equal(summary.byBucket.email, 2);
  assert.equal(summary.byBucket.reservation, 1);
  assert.equal(summary.byBucket.agency, 0);
  assert.equal(summary.byBucket.operational, 0);
  const berk = summary.staffBreakdown.find(s => s.name === 'Berk Çetinkaya');
  const sistem = summary.staffBreakdown.find(s => s.name === 'Sistem');
  assert.equal(berk.count, 1);
  assert.equal(sistem.count, 1);
  // No field anywhere in the summary resembles a single blended score.
  assert.ok(!('score' in summary));
  assert.ok(!('productivity' in summary));
});

test('_computeAdminActivitySummary with zero activity in the period returns total 0 and an empty staff breakdown, never a fabricated row', () => {
  const summary = _computeAdminActivitySummary([], 'today', '2026-09-15T12:00:00.000Z');
  assert.equal(summary.total, 0);
  assert.deepEqual(summary.staffBreakdown, []);
});

// ── mapActivityFromDB additive widening (metadata) ──────────────────────

test('mapActivityFromDB additively exposes .metadata (needed for agency_email click routing) without touching any pre-existing field', () => {
  const idx = SOURCE.indexOf('function mapActivityFromDB(r)');
  const body = SOURCE.slice(idx, SOURCE.indexOf('\n}', idx) + 2);
  assert.match(body, /metadata:r\.metadata\|\|null/);
  assert.match(body, /actorName:r\.actor_name\|\|null/, 'pre-existing actorName mapping must be untouched');
  assert.match(body, /who:r\.actor_name\|\|r\.performer\?\.full_name\|\|r\.performed_by\|\|'—'/, 'pre-existing who fallback chain must be untouched');
});

// ── getAgencyActivity: two-leg merge, bounded, reuses mapActivityFromDB ──

test('getAgencyActivity queries BOTH legs (entity_type=agency by entity_id, AND entity_type=agency_email by metadata->>agency_id), merges, sorts newest-first, and bounds the result', () => {
  const idx = SOURCE.indexOf('async getAgencyActivity(agencyId)');
  const body = SOURCE.slice(idx, SOURCE.indexOf('\n  },', idx) + 5);
  assert.match(body, /\.eq\('entity_type','agency'\)\.eq\('entity_id',agencyId\)/);
  assert.match(body, /\.eq\('entity_type','agency_email'\)\.eq\('metadata->>agency_id',agencyId\)/);
  assert.match(body, /\.sort\(\(a,b\)=>new Date\(b\.created_at\)-new Date\(a\.created_at\)\)/);
  assert.match(body, /\.slice\(0,30\)/);
  assert.match(body, /\.map\(mapActivityFromDB\)/, 'must reuse the SAME mapper every other activity read uses');
});

test('getAgencyActivity returns [] for a falsy agencyId — never queries with an undefined filter', () => {
  const idx = SOURCE.indexOf('async getAgencyActivity(agencyId)');
  const body = SOURCE.slice(idx, SOURCE.indexOf('\n  },', idx) + 5);
  assert.match(body, /if\(!agencyId\) return \[\];/);
});

// ── Homepage panel placement (desktop + mobile) ─────────────────────────

test('desktop: SonHareketlerPanel is mounted in Dashboard(), after AgencyCrmPlusSection (Son Bildirimler, Agency CRM+, Son Hareketler order)', () => {
  const dashIdx = SOURCE.indexOf('function Dashboard() {');
  const dashBody = SOURCE.slice(dashIdx, SOURCE.indexOf('\nfunction ', dashIdx + 10));
  const bildirimIdx = dashBody.indexOf('<SonBildirimlerPanel/>');
  const crmPlusIdx  = dashBody.indexOf('<AgencyCrmPlusSection/>');
  const hareketIdx  = dashBody.indexOf('<SonHareketlerPanel/>');
  assert.ok(bildirimIdx > -1 && crmPlusIdx > -1 && hareketIdx > -1);
  assert.ok(bildirimIdx < crmPlusIdx && crmPlusIdx < hareketIdx);
});

test('SonHareketlerPanel renders nothing while loading or once empty, caps at SON_HAREKETLER_HOME_MAX, and reuses the shared useRecentActivity hook', () => {
  const idx = SOURCE.indexOf('function SonHareketlerPanel() {');
  const body = SOURCE.slice(idx, SOURCE.indexOf('\n}', idx) + 2);
  assert.match(body, /useRecentActivity\(\)/);
  assert.match(body, /if \(loading \|\| activities\.length === 0\) return null;/);
  assert.match(body, /activities\.slice\(0, SON_HAREKETLER_HOME_MAX\)/);
  assert.match(SOURCE, /const SON_HAREKETLER_HOME_MAX = 8;/);
});

// The mobile-homepage redesign ("simpler operational philosophy" phase)
// removed the "Son Hareketler" MobileSection from MobileHomePage
// entirely (along with Agency CRM+, which it used to be ordered after) —
// the new homepage hierarchy (Bugünkü/Yarınki Turlar, Yaklaşan
// Rezervasyonlar, Bilet/Yemek Hazırlıkları) isn't meant to compete with
// it. useRecentActivity() and the dedicated /activity page (SonHareketlerPage)
// are completely untouched — still one tap away via Diğer.
test('MobileHomePage no longer renders a "Son Hareketler" section — removed from the mobile homepage, still reachable via the dedicated /activity page', () => {
  const mobileBody = require('./extractTestableFn').extractFunctionSource('MobileHomePage');
  assert.doesNotMatch(mobileBody, /MobileSection title="Son Hareketler"/);
  assert.doesNotMatch(mobileBody, /useRecentActivity\(\)/);
});

// ── useRecentActivity / useAgencyActivity: shared query, client-side filter only ──

test('useRecentActivity reads activity.getAll (the SAME cache entry "Son Aktiviteler" uses) and applies ONLY _isMeaningfulActivity — no server-side role filtering invented here', () => {
  const idx = SOURCE.indexOf('function useRecentActivity(opts = {}) {');
  const body = SOURCE.slice(idx, SOURCE.indexOf('\n}', idx) + 2);
  assert.match(body, /useRepo\("activity", "getAll", \{ limit: fetchLimit \}\)/);
  assert.match(body, /\.filter\(_isMeaningfulActivity\)/);
});

test('useAgencyActivity reads getAgencyActivity(agencyId) and applies the same _isMeaningfulActivity filter', () => {
  const idx = SOURCE.indexOf('function useAgencyActivity(agencyId) {');
  const body = SOURCE.slice(idx, SOURCE.indexOf('\n}', idx) + 2);
  assert.match(body, /useRepo\("activity", "getAgencyActivity", agencyId\)/);
  assert.match(body, /\.filter\(_isMeaningfulActivity\)/);
});

// ── Dedicated full view + role access + Admin Summary gating ───────────

test('every role (including the 3 non-admin ones) is granted "activity" page access — Son Hareketler is not admin-only', () => {
  const rolePermIdx = SOURCE.indexOf('const ROLE_PERMISSIONS');
  const canAccessEnd = SOURCE.indexOf('\n}', SOURCE.indexOf('function canAccess(role, page)', rolePermIdx));
  const canAccess = new Function(`${SOURCE.slice(rolePermIdx, canAccessEnd + 2)}\nreturn canAccess;`)();
  for (const role of ['Yönetici','Satış','Operasyon','Rehber']) {
    assert.equal(canAccess(role, 'activity'), true, role);
  }
});

test('the /activity route renders SonHareketlerPage on both the desktop and mobile branches of PageRouter', () => {
  const routerIdx = SOURCE.indexOf('function PageRouter({ base, param, isMobile, navigate }) {');
  const routerBody = SOURCE.slice(routerIdx, SOURCE.indexOf('\nfunction ', routerIdx + 10));
  const matches = routerBody.match(/base === "activity"\) return <SonHareketlerPage/g) || [];
  assert.equal(matches.length, 2, 'expected the activity route in both the isMobile block and the desktop fallback');
});

test('SonHareketlerPage shows AdminActivitySummaryPanel ONLY for Yönetici (admin) — every other role sees just the list, per the security requirement that cross-staff summaries are admin-only', () => {
  const idx = SOURCE.indexOf('function SonHareketlerPage() {');
  const body = SOURCE.slice(idx, SOURCE.indexOf('\n}', idx) + 2);
  assert.match(body, /const isAdmin = auth\.role === 'Yönetici';/);
  assert.match(body, /\{isAdmin && <AdminActivitySummaryPanel/);
});

test('AdminActivitySummaryPanel offers exactly the 3 named period filters (Bugün / Son 7 Gün / Son 30 Gün) and never invents a historical period beyond what is queried', () => {
  const idx = SOURCE.indexOf('function AdminActivitySummaryPanel(');
  const body = SOURCE.slice(idx, SOURCE.indexOf('\n}', idx) + 2);
  assert.match(body, /\['today','Bugün'\],\['7d','Son 7 Gün'\],\['30d','Son 30 Gün'\]/);
});

// ── Safe rendering: never the raw body, never a leaked implementation id ─

test('ActivityRow renders entry.description (the pre-written Turkish summary) — never a raw metadata.body/email body field', () => {
  const idx = SOURCE.indexOf('function ActivityRow(');
  const body = SOURCE.slice(idx, SOURCE.indexOf('\nfunction ', idx + 10));
  assert.match(body, /\{entry\.description\}/);
  assert.doesNotMatch(body, /entry\.metadata\.body|entry\.body\b/);
});

// ── Write-side logging quality fixes (reservation/agency/payment/customer) ─

test('_reservationUpdateLogPlan: a status-only patch logs status_changed, a guide-assignment patch logs assigned, a notes-only patch logs note_added, and anything else falls back to the original generic "updated"', () => {
  const row = { reservation_number: 'R-2026-0007' };
  assert.equal(_reservationUpdateLogPlan({ opStatus: 'Tamamlandı' }, row).action, 'status_changed');
  assert.equal(_reservationUpdateLogPlan({ guideId: 'G-1', guide: 'Deniz' }, row).action, 'assigned');
  assert.match(_reservationUpdateLogPlan({ guideId: 'G-1', guide: 'Deniz' }, row).description, /Deniz/);
  assert.equal(_reservationUpdateLogPlan({ guideId: null }, row).action, 'assigned');
  assert.match(_reservationUpdateLogPlan({ guideId: null }, row).description, /kaldırıldı/);
  assert.equal(_reservationUpdateLogPlan({ opNotes: 'test' }, row).action, 'note_added');
  assert.equal(_reservationUpdateLogPlan({ pickup: 'Hotel X', pickupTime: '09:00' }, row).action, 'updated');
});

test('SupabaseReservationRepo.update wires _reservationUpdateLogPlan into its single _sbLog call — never more than one log row per update', () => {
  const idx = SOURCE.indexOf("async update(id,p){const sb=getSB();if(!sb)return ReservationRepository.update(id,p);");
  const line = SOURCE.slice(idx, idx + 900);
  assert.match(line, /const logPlan=_reservationUpdateLogPlan\(p,u\);/);
  const sbLogCalls = line.match(/_sbLog\(/g) || [];
  assert.equal(sbLogCalls.length, 1);
  assert.match(line, /await _sbLog\('reservation',id,logPlan\.action,logPlan\.description\);/);
});

test('SupabaseAgencyRepo.update logs status_changed for a status-only patch, note_added for a notes-only patch, and the original generic "updated" for anything else', () => {
  const idx = SOURCE.indexOf('async update(id,p){\n    const sb=getSB(); if(!sb) return AgencyRepository.update(id,p);');
  assert.ok(idx !== -1, 'SupabaseAgencyRepo.update not found at expected shape');
  const body = SOURCE.slice(idx, SOURCE.indexOf('\n  },', idx) + 5);
  assert.match(body, /action = 'status_changed'/);
  assert.match(body, /action = 'note_added'/);
  assert.match(body, /await _sbLog\('agency', id, action, description\);/);
});

test('SupabaseAgencyRepo.create logs a distinct, honest description when the agency was imported via Pazar Araştırması (researchEvidence/researchSourceUrl present) — same single "created" action, never a second log row', () => {
  const idx = SOURCE.indexOf('async create(d){\n    const sb=getSB(); if(!sb) return AgencyRepository.create(d);');
  assert.ok(idx !== -1);
  const body = SOURCE.slice(idx, SOURCE.indexOf('\n  },', idx) + 5);
  assert.match(body, /const viaResearch = !!\(d\.researchEvidence \|\| d\.researchSourceUrl\);/);
  assert.match(body, /await _sbLog\('agency', a\.id, 'created', viaResearch \?/);
  const sbLogCalls = body.match(/_sbLog\(/g) || [];
  assert.equal(sbLogCalls.length, 1);
});

test('SupabasePaymentRepo.update now logs status_changed (a genuinely missing event before this phase) — reuses the already-allowed action, no new CHECK value', () => {
  const idx = SOURCE.indexOf("async update(id,p){const sb=getSB();if(!sb)return PaymentRepository.update(id,p);");
  const line = SOURCE.slice(idx, idx + 400);
  assert.match(line, /if\(p\.status\)await _sbLog\('payment',id,'status_changed',/);
});

test('SupabasePaymentRepo.delete (soft-cancel) now logs \'cancelled\' — also genuinely missing before this phase', () => {
  const idx = SOURCE.indexOf("async delete(id){const sb=getSB();if(!sb)return PaymentRepository.delete(id);");
  const line = SOURCE.slice(idx, idx + 400);
  assert.match(line, /await _sbLog\('payment',id,'cancelled',/);
});

test('SupabaseCustomerRepo.update logs note_added for a notes-only patch, generic updated otherwise', () => {
  const idx = SOURCE.indexOf("async update(id,p){const sb=getSB();if(!sb)return CustomerRepository.update(id,p);");
  const line = SOURCE.slice(idx, idx + 500);
  assert.match(line, /const isNoteOnly=pKeys\.length===1&&pKeys\[0\]==='notes';/);
  assert.match(line, /_sbLog\('customer',id,isNoteOnly\?'note_added':'updated',/);
});

// ── logOutreachSent reply-vs-first-contact mislabel fix ─────────────────

test('logOutreachSent (api/agency-send-email.js) now branches its description by sendMode — a reply is never mislabeled as "ilk temas" (first contact)', () => {
  const apiPath = path.join(__dirname, '..', '..', 'api', 'agency-send-email.js');
  const apiSrc = fs.readFileSync(apiPath, 'utf8');
  const idx = apiSrc.indexOf('async function logOutreachSent(');
  const body = apiSrc.slice(idx, apiSrc.indexOf('\n}', idx) + 2);
  assert.match(body, /const isReply = sendMode === 'reply';/);
  assert.match(body, /isReply[\s\S]{0,120}yanıt gönderildi/);
  assert.match(body, /ilk temas e-postası gönderildi/);
  assert.match(body, /send_mode: sendMode \|\| 'new_outreach'/);
  assert.match(body, /agency_name: agencyName \|\| null/);
});

test('the call site passes sendMode and the agency\'s own name into logOutreachSent', () => {
  const apiPath = path.join(__dirname, '..', '..', 'api', 'agency-send-email.js');
  const apiSrc = fs.readFileSync(apiPath, 'utf8');
  assert.match(apiSrc, /await logOutreachSent\(\{ adminClient, agencyId, agencyEmailId, performedBy: auth\.userId, sendMode, agencyName: agency\.name \|\| null \}\);/);
  assert.match(apiSrc, /\.from\('agencies'\)\.select\('id, email, status, name'\)/);
});
