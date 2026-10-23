'use strict';
/**
 * tests/dashboard/agencyRedesign.test.js
 * ─────────────────────────────────────────────────────────────────────────
 * Agencies module visual/UX redesign (AcentelerPage list + AcenteDetailPage
 * detail) — every existing capability preserved, only the presentation
 * layer and the new list/detail enrichment are new. Pure logic is
 * extracted via extractTestableFn and exercised directly; placement/
 * structure claims are static source-text assertions, matching every
 * other test file for this single-file component.
 * ─────────────────────────────────────────────────────────────────────────
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { extractTestableFn } = require('./extractTestableFn');

const SOURCE_PATH = path.join(__dirname, '..', '..', 'DeseTourDashboard.jsx');
const SOURCE = fs.readFileSync(SOURCE_PATH, 'utf8');

// _agencyActivityState/_latestInboundReplyAt/_computeAgencyListEnrichment
// all call _agencyCrmPlusIsToday/_agencyCrmPlusDaysSince/
// AGENCY_FOLLOWUP_STALE_DAYS, which live elsewhere in the file (shared
// with computeAgencyCrmPlusSummary) — extractTestableFn only evaluates
// ONE marker's text, so these are stitched together manually, in
// dependency order, using the exact same real implementations.
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
const DEPS = ['_agencyCrmPlusIsToday', '_agencyCrmPlusDaysSince', 'AGENCY_FOLLOWUP_STALE_DAYS'];
const _agencyActivityState         = extractCombined([...DEPS, '_agencyActivityState']);
const _latestInboundReplyAt        = extractTestableFn('_latestInboundReplyAt');
const _computeAgencyListEnrichment = extractCombined([...DEPS, '_agencyActivityState', '_latestInboundReplyAt', '_computeAgencyListEnrichment']);

function agency(overrides) {
  return {
    id: 'AGN-' + Math.random().toString(36).slice(2),
    name: 'Test Agency', country: 'Spain', languages: ['İspanyolca'],
    status: 'Aday', createdAt: '2026-09-01', lastContactAt: null,
    ...overrides,
  };
}
function email(overrides) {
  return {
    id: 'AEM-' + Math.random().toString(36).slice(2), agencyId: 'AGN-x',
    direction: 'outbound', status: 'draft', sentAt: null, receivedAt: null,
    createdAt: '2026-09-01T10:00:00.000Z', ...overrides,
  };
}

const NOW = '2026-09-15T12:00:00.000Z';
const TODAY = '2026-09-15';

// ── _latestInboundReplyAt ────────────────────────────────────────────────

test('_latestInboundReplyAt finds the most recent INBOUND email, ignoring outbound ones entirely', () => {
  const emails = [
    email({ direction:'outbound', createdAt:'2026-09-14T10:00:00.000Z' }),
    email({ direction:'inbound', receivedAt:'2026-09-10T08:00:00.000Z' }),
    email({ direction:'inbound', receivedAt:'2026-09-13T08:00:00.000Z' }),
  ];
  assert.equal(_latestInboundReplyAt(emails), '2026-09-13T08:00:00.000Z');
});

test('_latestInboundReplyAt falls back to createdAt when receivedAt is missing, and returns null for no inbound mail', () => {
  assert.equal(_latestInboundReplyAt([email({ direction:'inbound', receivedAt:null, createdAt:'2026-09-01T00:00:00.000Z' })]), '2026-09-01T00:00:00.000Z');
  assert.equal(_latestInboundReplyAt([email({ direction:'outbound' })]), null);
  assert.equal(_latestInboundReplyAt([]), null);
  assert.equal(_latestInboundReplyAt(undefined), null);
});

// ── _agencyActivityState ─────────────────────────────────────────────────

test('hasNewReply is true only when the latest inbound reply is from today', () => {
  assert.equal(_agencyActivityState(agency(), TODAY + 'T08:00:00.000Z', NOW).hasNewReply, true);
  assert.equal(_agencyActivityState(agency(), '2026-09-10T08:00:00.000Z', NOW).hasNewReply, false);
  assert.equal(_agencyActivityState(agency(), null, NOW).hasNewReply, false);
});

test('needsFollowUp is true only for an ACTIVE conversation (İletişime Geçildi/Görüşülüyor) that is stale or never contacted', () => {
  const stale = agency({ status:'İletişime Geçildi', lastContactAt:'2026-09-01T00:00:00.000Z' });
  assert.equal(_agencyActivityState(stale, null, NOW).needsFollowUp, true);
  const neverContacted = agency({ status:'Görüşülüyor', lastContactAt:null });
  assert.equal(_agencyActivityState(neverContacted, null, NOW).needsFollowUp, true);
  const freshlyContacted = agency({ status:'İletişime Geçildi', lastContactAt:'2026-09-14T00:00:00.000Z' });
  assert.equal(_agencyActivityState(freshlyContacted, null, NOW).needsFollowUp, false);
});

test('needsFollowUp is always false for a non-active-conversation status (Aday/Partner/Uygun Değil), regardless of staleness', () => {
  for (const status of ['Aday','Partner','Uygun Değil']) {
    const a = agency({ status, lastContactAt: '2026-01-01T00:00:00.000Z' });
    assert.equal(_agencyActivityState(a, null, NOW).needsFollowUp, false, status);
  }
});

test('recentlyContacted is true within 7 days of lastContactAt, false beyond it or when never contacted', () => {
  assert.equal(_agencyActivityState(agency({ lastContactAt:'2026-09-10T00:00:00.000Z' }), null, NOW).recentlyContacted, true);
  assert.equal(_agencyActivityState(agency({ lastContactAt:'2026-08-01T00:00:00.000Z' }), null, NOW).recentlyContacted, false);
  assert.equal(_agencyActivityState(agency({ lastContactAt:null }), null, NOW).recentlyContacted, false);
});

// ── _computeAgencyListEnrichment: per-agency flags + overview counts ────

test('enrichment correctly indexes inbound replies PER agency — an agency never sees another agency\'s reply', () => {
  const agencies = [agency({ id:'A1' }), agency({ id:'A2' })];
  const emails = [email({ agencyId:'A1', direction:'inbound', receivedAt: TODAY + 'T08:00:00.000Z' })];
  const result = _computeAgencyListEnrichment(agencies, emails, NOW);
  const a1 = result.agencies.find(a=>a.id==='A1');
  const a2 = result.agencies.find(a=>a.id==='A2');
  assert.equal(a1.hasNewReply, true);
  assert.equal(a2.hasNewReply, false);
});

test('overview counts: Toplam/Aktif Görüşmeler/Bugün Yeni/Takip Bekleyen/Yanıt Gelen/Partner are all independently correct', () => {
  const agencies = [
    agency({ id:'A1', status:'Partner' }),
    agency({ id:'A2', status:'İletişime Geçildi', lastContactAt:'2026-08-01T00:00:00.000Z' }), // needs follow-up
    agency({ id:'A3', createdAt: TODAY }), // new today
  ];
  const emails = [email({ agencyId:'A3', direction:'inbound', receivedAt: TODAY + 'T09:00:00.000Z' })]; // reply today
  const result = _computeAgencyListEnrichment(agencies, emails, NOW);
  assert.equal(result.totalCount, 3);
  assert.equal(result.activeConversationCount, 1);
  assert.equal(result.newTodayCount, 1);
  assert.equal(result.needsFollowUpCount, 1);
  assert.equal(result.hasNewReplyCount, 1);
  assert.equal(result.partnerCount, 1);
});

test('enrichment never fabricates data for an empty agencies/emails input', () => {
  const result = _computeAgencyListEnrichment([], [], NOW);
  assert.deepEqual(result.agencies, []);
  assert.equal(result.totalCount, 0);
  assert.equal(result.hasNewReplyCount, 0);
});

// ── AcentelerPage: overview strip + filters + bounded email fetch ──────

test('AcentelerPage renders all 6 named overview metrics, never a meaningless filler metric', () => {
  const idx = SOURCE.indexOf('function AcentelerPage({ onSelect }) {');
  const body = SOURCE.slice(idx, SOURCE.indexOf('\n// Fields match', idx));
  for (const label of ['Toplam Acente','Aktif Görüşmeler','Bugün Yeni','Takip Bekleyen','Yanıt Gelen','Partner']) {
    assert.match(body, new RegExp(`label:"${label}"`), label);
  }
  // Exactly 6 — no stray extra metric slipped in.
  const metricBlockIdx = body.indexOf('const OVERVIEW_METRICS = [');
  const metricBlock = body.slice(metricBlockIdx, body.indexOf('];', metricBlockIdx));
  const count = (metricBlock.match(/label:"/g) || []).length;
  assert.equal(count, 6);
});

test('AcentelerPage fetches agencyEmail with the SAME bounded sinceDays:14 window AgencyCrmPlusSection uses — one convention, not a second one', () => {
  const idx = SOURCE.indexOf('function AcentelerPage({ onSelect }) {');
  const body = SOURCE.slice(idx, SOURCE.indexOf('\n// Fields match', idx));
  assert.match(body, /useRepo\("agencyEmail", "getAll", \{ sinceDays: 14 \}\)/);
});

test('AcentelerPage offers exactly the 4 new boolean filters (Takip Gerekiyor/Yeni Yanıt/Partner/Son 7 Günde İletişim), independently toggleable and AND-combined with status/country/search', () => {
  const idx = SOURCE.indexOf('function AcentelerPage({ onSelect }) {');
  const body = SOURCE.slice(idx, SOURCE.indexOf('\n// Fields match', idx));
  assert.match(body, /AgencyFilterChip active=\{needsFollowUpOnly\}[\s\S]{0,80}Takip Gerekiyor/);
  assert.match(body, /AgencyFilterChip active=\{hasNewReplyOnly\}[\s\S]{0,80}Yeni Yanıt/);
  assert.match(body, /AgencyFilterChip active=\{partnerOnly\}[\s\S]{0,80}Partner/);
  assert.match(body, /AgencyFilterChip active=\{recentlyContactedOnly\}[\s\S]{0,80}Son 7 Günde İletişim/);
  assert.match(body, /if \(needsFollowUpOnly && !a\.needsFollowUp\) return false;/);
  assert.match(body, /if \(hasNewReplyOnly && !a\.hasNewReply\) return false;/);
  assert.match(body, /if \(partnerOnly && a\.status !== "Partner"\) return false;/);
  assert.match(body, /if \(recentlyContactedOnly && !a\.recentlyContacted\) return false;/);
});

test('every new filter toggle is backed by data the existing model actually supports (status, lastContactAt, inbound agency_emails) — none is a fabricated/unsupported facet', () => {
  const enrichIdx = SOURCE.indexOf('function _computeAgencyListEnrichment(');
  const enrichBody = SOURCE.slice(enrichIdx, SOURCE.indexOf('\n}', enrichIdx) + 2);
  assert.match(enrichBody, /a\.status/);
  assert.match(enrichBody, /_latestInboundReplyAt/);
  const stateIdx = SOURCE.indexOf('function _agencyActivityState(');
  const stateBody = SOURCE.slice(stateIdx, SOURCE.indexOf('\n}', stateIdx) + 2);
  assert.match(stateBody, /agency\.lastContactAt/);
  const replyIdx = SOURCE.indexOf('function _latestInboundReplyAt(');
  const replyBody = SOURCE.slice(replyIdx, SOURCE.indexOf('\n}', replyIdx) + 2);
  assert.match(replyBody, /direction !== 'inbound'/);
});

test('the list row gives visual emphasis to a new reply, a needed follow-up, and a Partner — never identical weight for every row', () => {
  const idx = SOURCE.indexOf('function AcentelerPage({ onSelect }) {');
  const body = SOURCE.slice(idx, SOURCE.indexOf('\n// Fields match', idx));
  assert.match(body, /const accentColor = a\.hasNewReply \? C\.gold : a\.needsFollowUp \? C\.amber : a\.status === "Partner" \? C\.green : "transparent";/);
  assert.match(body, /borderLeft:`3px solid \$\{accentColor\}`/);
});

test('the mobile card rendering also carries the reply/follow-up accent and labels — not merely a shrunk desktop table', () => {
  const idx = SOURCE.indexOf('function AcentelerPage({ onSelect }) {');
  const body = SOURCE.slice(idx, SOURCE.indexOf('\n// Fields match', idx));
  const mobileIdx = body.indexOf('className="rsp-cards"');
  const mobileBody = body.slice(mobileIdx);
  assert.match(mobileBody, /Yanıt geldi/);
  assert.match(mobileBody, /Takip gerekiyor/);
  assert.match(mobileBody, /borderLeft:`3px solid \$\{accentColor\}`/);
});

// ── AcenteDetailPage: header + modular 2-column layout ──────────────────

const ACENTE_DETAIL_IDX = SOURCE.indexOf('function AcenteDetailPage({ agencyId, onBack }) {');
const ACENTE_DETAIL_BODY = SOURCE.slice(ACENTE_DETAIL_IDX, SOURCE.indexOf('\nfunction GuidesPage', ACENTE_DETAIL_IDX));

test('the detail page computes its own activityState via the SHARED _agencyActivityState helper, scoped to this agency\'s own full emailHistory (not the list page\'s bounded cross-agency window)', () => {
  assert.match(ACENTE_DETAIL_BODY, /const activityState = _agencyActivityState\(agency, _latestInboundReplyAt\(emailHistory\), new Date\(\)\.toISOString\(\)\);/);
});

test('the header summary shows name, website, status, country/city, primary contact, last contact, and next action', () => {
  const headerIdx = ACENTE_DETAIL_BODY.indexOf('linear-gradient');
  const headerBody = ACENTE_DETAIL_BODY.slice(headerIdx, ACENTE_DETAIL_BODY.indexOf('</div>\n\n      <div style={{display:"grid"', headerIdx));
  assert.match(headerBody, /\{agency\.name\}/);
  assert.match(headerBody, /agency\.website/);
  assert.match(headerBody, /RBadge label=\{agency\.status\}/);
  assert.match(headerBody, /Ülke \/ Şehir/);
  assert.match(headerBody, /Birincil İletişim/);
  assert.match(headerBody, /Son Temas/);
  assert.match(headerBody, /Sonraki Adım/);
});

test('a new reply shows a distinct "Yeni Yanıt" badge in the header', () => {
  assert.match(ACENTE_DETAIL_BODY, /activityState\.hasNewReply && \([\s\S]{0,200}Yeni Yanıt/);
});

test('the page uses a responsive 2-column grid on desktop (2fr main / 1fr side) that collapses to 1 column on mobile via useBreakpoint — no separate mobile component', () => {
  assert.match(ACENTE_DETAIL_BODY, /const \{ isMobile \} = useBreakpoint\(\);/);
  assert.match(ACENTE_DETAIL_BODY, /gridTemplateColumns: isMobile \? "1fr" : "2fr 1fr"/);
});

test('all 6 recommended sections are present: Genel Bakış, İletişim, Araştırma Bulguları, Konuşmalar (İlk Temas Taslağı/Yanıt Yaz + E-posta Geçmişi), Notlar, Son Hareketler', () => {
  for (const title of ['Genel Bakış','İletişim','Araştırma Bulguları','Notlar','Son Hareketler']) {
    assert.match(ACENTE_DETAIL_BODY, new RegExp(`RCardHead title="${title}"`), title);
  }
  assert.match(ACENTE_DETAIL_BODY, /RCardHead title=\{replyTargetEmail \? "Yanıt Yaz" : "İlk Temas Taslağı"\}/);
  assert.match(ACENTE_DETAIL_BODY, /RCardHead title="E-posta Geçmişi"/);
});

test('Genel Bakış holds the actual interactive status control (not just a read-only label) plus next action and last contact', () => {
  const idx = ACENTE_DETAIL_BODY.indexOf('RCardHead title="Genel Bakış"');
  const body = ACENTE_DETAIL_BODY.slice(idx, ACENTE_DETAIL_BODY.indexOf('</RCard>', idx));
  assert.match(body, /SSelect value=\{agency\.status\} onChange=\{handleStatusChange\}/);
  assert.match(body, /RInfoRow label="Sonraki Adım" value=\{nextActionLabel\}/);
});

test('İletişim shows country/city/website/contact/email/phone, read-only — the exact Phase 1 fields, just relocated out of the header', () => {
  const idx = ACENTE_DETAIL_BODY.indexOf('RCardHead title="İletişim"');
  const body = ACENTE_DETAIL_BODY.slice(idx, ACENTE_DETAIL_BODY.indexOf('</RCard>', idx));
  for (const label of ['Ülke','Şehir','Website','İletişim Kişisi','E-posta','Telefon']) {
    assert.match(body, new RegExp(`RInfoRow label="${label}"`), label);
  }
});

test('Araştırma Bulguları separates fit reason, languages, evidence, and source into their own labeled fields — never one dumped block of text', () => {
  const idx = ACENTE_DETAIL_BODY.indexOf('RCardHead title="Araştırma Bulguları"');
  const body = ACENTE_DETAIL_BODY.slice(idx, ACENTE_DETAIL_BODY.indexOf('</RCard>', idx));
  assert.match(body, /Neden Uygun/);
  assert.match(body, /Diller/);
  assert.match(body, /Kaynak Kanıt/);
  assert.match(body, />Kaynak</);
  assert.match(body, /agency\.fitNote/);
  assert.match(body, /agency\.languages/);
  assert.match(body, /agency\.researchEvidence/);
  assert.match(body, /agency\.researchSourceUrl/);
});

test('Son Hareketler on the detail page uses useAgencyActivity(agencyId) and the shared ActivityRow renderer, capped at 10, loading/empty states handled', () => {
  const idx = ACENTE_DETAIL_BODY.indexOf('RCardHead title="Son Hareketler"');
  const body = ACENTE_DETAIL_BODY.slice(idx, ACENTE_DETAIL_BODY.indexOf('</RCard>', idx));
  assert.match(body, /agencyActivitiesLoading/);
  assert.match(body, /agencyActivities\.length === 0/);
  assert.match(body, /agencyActivities\.slice\(0, 10\)\.map\(entry => <ActivityRow key=\{entry\.id\} entry=\{entry\} compact\/>\)/);
  assert.match(ACENTE_DETAIL_BODY, /const \{ activities:agencyActivities, loading:agencyActivitiesLoading \} = useAgencyActivity\(agencyId\);/);
});

// ── No existing capability lost ──────────────────────────────────────────

test('every Phase 1-7 interaction handler is still defined and wired: status change, save notes, generate draft, save draft, open history item, reply to email, send email', () => {
  assert.match(ACENTE_DETAIL_BODY, /function handleStatusChange\(/);
  // Status change is wired via the SSelect's onChange, not a button click.
  assert.match(ACENTE_DETAIL_BODY, /onChange=\{handleStatusChange\}/);
  for (const handler of ['handleSaveNotes','handleGenerateDraft','handleSaveDraft','handleOpenHistoryItem','handleReplyToEmail','handleSendEmail']) {
    assert.match(ACENTE_DETAIL_BODY, new RegExp(`function ${handler}\\(`), handler);
    assert.match(ACENTE_DETAIL_BODY, new RegExp(`onClick=\\{\\(?\\)?\\s*=>?\\s*\\{?\\s*${handler}|onClick=\\{${handler}\\}`), `${handler} must still be wired to a click handler`);
  }
});

test('the conversation timeline (E-posta Geçmişi) still distinguishes inbound/outbound, shows subject/sender/timestamp/body, and keeps the explicit Yanıtla/Aç actions', () => {
  const idx = ACENTE_DETAIL_BODY.indexOf('RCardHead title="E-posta Geçmişi"');
  const body = ACENTE_DETAIL_BODY.slice(idx, ACENTE_DETAIL_BODY.indexOf('</RCard>', idx));
  assert.match(body, /isInbound = email\.direction === 'inbound'/);
  assert.match(body, /email\.subject/);
  assert.match(body, /email\.fromEmail/);
  assert.match(body, />Yanıtla</);
  assert.match(body, />Aç</);
  // Never a Gmail implementation id anywhere in the visible text of this block.
  assert.doesNotMatch(body, /gmailMessageId|gmailThreadId|provider_message_id|provider_thread_id/);
});

// ── Typography ─────────────────────────────────────────────────────────
// A later design-polish phase explicitly, deliberately retypefaced the
// app onto Geist (operational UI) + Instrument Serif (major headings
// only) + DM Mono (unchanged). Playfair Display and DM Sans stay loaded
// too, but only for ProposalTemplate/ProposalPreviewModal and the Resend
// HTML email template, which were deliberately left on the old pairing
// as a self-contained branded document — not because Agencies itself
// still uses them.

test('exactly one Google Fonts stylesheet request loads the app\'s full type system (Geist, Instrument Serif, DM Mono, plus Playfair Display/DM Sans kept only for the print-proposal template)', () => {
  const indexHtml = fs.readFileSync(path.join(__dirname, '..', '..', 'index.html'), 'utf8');
  const fontLinkMatch = indexHtml.match(/fonts\.googleapis\.com\/css2\?family=[^"]+/);
  assert.ok(fontLinkMatch);
  assert.match(fontLinkMatch[0], /Geist/);
  assert.match(fontLinkMatch[0], /Instrument\+Serif/);
  assert.match(fontLinkMatch[0], /Playfair\+Display/);
  assert.match(fontLinkMatch[0], /DM\+Sans/);
  assert.match(fontLinkMatch[0], /DM\+Mono/);
  // Exactly one Google Fonts request in the whole document.
  const allFontLinks = indexHtml.match(/fonts\.googleapis\.com\/css2[^"]*/g) || [];
  assert.equal(allFontLinks.length, 1);
});

test('AcenteDetailPage\'s header uses Instrument Serif for the agency name (a major heading) while the rest of its operational text uses Geist — the current type system, not the retired Playfair/DM Sans pairing', () => {
  const headerIdx = ACENTE_DETAIL_BODY.indexOf('linear-gradient');
  const headerBody = ACENTE_DETAIL_BODY.slice(headerIdx, headerIdx + 800);
  assert.match(headerBody, /fontFamily:"'Instrument Serif',serif"/);
  assert.match(headerBody, /fontFamily:"'Geist',sans-serif"/);
  assert.doesNotMatch(headerBody, /'Playfair Display'|'DM Sans'/);
});
