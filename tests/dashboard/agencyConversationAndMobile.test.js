'use strict';
/**
 * tests/dashboard/agencyConversationAndMobile.test.js
 * ─────────────────────────────────────────────────────────────────────────
 * Agency Mailbox Phase 6 (AcenteDetailPage's real conversation timeline)
 * and Phase 10 (the mobile Agency CRM+ section in MobileHomePage).
 *
 * agencyConversationBadgeLabel is a pure function, extracted and exercised
 * directly via its TESTABLE markers (extractTestableFn), so it runs the
 * real shipping implementation. Everything else here is a static
 * source-text match against DeseTourDashboard.jsx — no live Supabase/
 * network call, no React rendering, matching every other test file in
 * this project.
 * ─────────────────────────────────────────────────────────────────────────
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { extractTestableFn } = require('./extractTestableFn');

const REPO_ROOT = path.join(__dirname, '..', '..');
const SOURCE = fs.readFileSync(path.join(REPO_ROOT, 'DeseTourDashboard.jsx'), 'utf8');

function sliceFunction(name, fromIdx = 0) {
  const idx = SOURCE.indexOf(`function ${name}(`, fromIdx);
  if (idx === -1) throw new Error(`function ${name} not found`);
  const end = SOURCE.indexOf('\nfunction ', idx + 20);
  return SOURCE.slice(idx, end);
}

// ═══════════════ Phase 6 — agencyConversationBadgeLabel (pure) ═══════════

test('agencyConversationBadgeLabel: an inbound row is always "Yanıt Geldi", regardless of its stored status', () => {
  const fn = extractTestableFn('agencyConversationBadgeLabel');
  assert.equal(fn({ direction: 'inbound', status: 'received' }), 'Yanıt Geldi');
  assert.equal(fn({ direction: 'inbound', status: 'sent' }), 'Yanıt Geldi');
});

test('agencyConversationBadgeLabel: an outbound sent row is "Gönderildi"', () => {
  const fn = extractTestableFn('agencyConversationBadgeLabel');
  assert.equal(fn({ direction: 'outbound', status: 'sent' }), 'Gönderildi');
});

test('agencyConversationBadgeLabel: an outbound failed row is "Başarısız"', () => {
  const fn = extractTestableFn('agencyConversationBadgeLabel');
  assert.equal(fn({ direction: 'outbound', status: 'failed' }), 'Başarısız');
});

test('agencyConversationBadgeLabel: anything else (draft, missing fields, null) falls back to "Taslak"', () => {
  const fn = extractTestableFn('agencyConversationBadgeLabel');
  assert.equal(fn({ direction: 'outbound', status: 'draft' }), 'Taslak');
  assert.equal(fn(null), 'Taslak');
  assert.equal(fn({}), 'Taslak');
});

test('AGENCY_CONVERSATION_BADGE_CFG defines a color/bg entry for every label agencyConversationBadgeLabel can return', () => {
  const idx = SOURCE.indexOf('const AGENCY_CONVERSATION_BADGE_CFG');
  const end = SOURCE.indexOf('};', idx) + 2;
  const cfgSrc = SOURCE.slice(idx, end);
  for (const label of ['Taslak', 'Gönderildi', 'Başarısız', 'Yanıt Geldi']) {
    assert.match(cfgSrc, new RegExp(`'${label}':`));
  }
});

// ═══════════════ Phase 6 — AcenteDetailPage conversation timeline JSX ═════

function acenteDetailPageBody() {
  const idx = SOURCE.indexOf('function AcenteDetailPage(');
  const end = SOURCE.indexOf('\nfunction ', idx + 20);
  return SOURCE.slice(idx, end);
}

function emailHistorySectionBody() {
  const body = acenteDetailPageBody();
  const idx = body.indexOf('"E-posta Geçmişi"');
  const end = body.indexOf('</RCard>', idx);
  return body.slice(idx, end);
}

test('the email history timeline renders emailHistory reversed (oldest first) for display, without mutating/reordering the underlying emailHistory itself', () => {
  const section = emailHistorySectionBody();
  assert.match(section, /emailHistory\.slice\(\)\.reverse\(\)\.map\(/);
});

test('an inbound row is visually distinguished with the blue background tint', () => {
  const section = emailHistorySectionBody();
  assert.match(section, /background:\s*isInbound\s*\?\s*C\.blueBg/);
});

test('an inbound row shows the sender email and the received time (falling back to createdAt), not the outbound createdAt alone', () => {
  const section = emailHistorySectionBody();
  assert.match(section, /isInbound\s*&&\s*\(email\.fromEmail/);
  assert.match(section, /email\.receivedAt\s*\|\|\s*email\.createdAt/);
});

test('an inbound row renders its normalized body as a safe, scroll-bounded preview (never unbounded height)', () => {
  const section = emailHistorySectionBody();
  const bodyPreviewIdx = section.indexOf('isInbound && email.body');
  assert.ok(bodyPreviewIdx !== -1);
  const nearby = section.slice(bodyPreviewIdx, bodyPreviewIdx + 400);
  assert.match(nearby, /whiteSpace:\s*"pre-wrap"/);
  assert.match(nearby, /maxHeight:\s*120/);
  assert.match(nearby, /overflow:\s*"auto"/);
});

test('the "Aç" (open-in-editor) button is rendered ONLY for outbound rows — an inbound reply is read-only, never opened into the draft editor', () => {
  const section = emailHistorySectionBody();
  const btnIdx = section.indexOf('>Aç</button>');
  assert.ok(btnIdx !== -1);
  const guard = section.slice(section.lastIndexOf('{!isInbound', btnIdx), btnIdx);
  assert.match(guard, /!isInbound/);
  assert.doesNotMatch(section, /isInbound[^}]*>Aç<\/button>/);
});

test('the "Aç" button, when rendered, still calls handleOpenHistoryItem exactly as before Phase 6 — outbound behavior is unchanged', () => {
  const section = emailHistorySectionBody();
  const btnIdx = section.indexOf('>Aç</button>');
  const onClickSlice = section.slice(section.lastIndexOf('onClick=', btnIdx), btnIdx);
  assert.match(onClickSlice, /handleOpenHistoryItem\(email\)/);
});

test('the badge for every row (inbound or outbound) uses AGENCY_CONVERSATION_BADGE_CFG and agencyConversationBadgeLabel, not the old flat per-status config', () => {
  const section = emailHistorySectionBody();
  assert.match(section, /agencyConversationBadgeLabel\(email\)/);
  assert.match(section, /map=\{AGENCY_CONVERSATION_BADGE_CFG\}/);
});

// ═══════════════ Phase 7 (hardened) — the explicit "Yanıtla" Reply action ═

test('a "Yanıtla" button is rendered for every INBOUND row, and only for inbound rows', () => {
  const section = emailHistorySectionBody();
  const btnIdx = section.indexOf('>Yanıtla</button>');
  assert.ok(btnIdx !== -1, 'expected a Yanıtla button in the conversation timeline');
  const guard = section.slice(section.lastIndexOf('{isInbound', btnIdx), btnIdx);
  assert.match(guard, /\{isInbound\s*&&/);
  assert.doesNotMatch(section, /\{!isInbound[^{]*>Yanıtla<\/button>/);
});

test('the "Yanıtla" button calls handleReplyToEmail(email) — never handleOpenHistoryItem, never a silent send', () => {
  const section = emailHistorySectionBody();
  const btnIdx = section.indexOf('>Yanıtla</button>');
  const onClickSlice = section.slice(section.lastIndexOf('onClick=', btnIdx), btnIdx);
  assert.match(onClickSlice, /handleReplyToEmail\(email\)/);
});

function handleReplyToEmailBody() {
  const body = acenteDetailPageBody();
  const idx = body.indexOf('async function handleReplyToEmail(');
  const end = body.indexOf('\n  }', idx);
  return body.slice(idx, end);
}

test('handleReplyToEmail creates a real draft row (never sends freshly-typed text directly) and marks the session as replying to the SPECIFIC selected inbound row', () => {
  const fnBody = handleReplyToEmailBody();
  assert.match(fnBody, /mutAgencyEmail\(\s*["']create["']/);
  assert.match(fnBody, /setReplyTargetEmail\(inboundEmail\)/);
  assert.match(fnBody, /setEditingEmailId\(createdRow\.id\)/);
});

test('handleReplyToEmail never infers reply intent from agency history — it only ever acts on the specific inboundEmail argument it was called with', () => {
  const fnBody = handleReplyToEmailBody();
  assert.doesNotMatch(fnBody, /emailHistory\[0\]/);
  assert.doesNotMatch(fnBody, /\.sort\(/);
});

test('handleGenerateDraft clears replyTargetEmail — generating a fresh draft is explicitly new outreach, never a reply', () => {
  const body = acenteDetailPageBody();
  const idx = body.indexOf('async function handleGenerateDraft(');
  const end = body.indexOf('\n  }', idx);
  const fnBody = body.slice(idx, end);
  assert.match(fnBody, /setReplyTargetEmail\(null\)/);
});

test('handleOpenHistoryItem clears replyTargetEmail — opening a different draft row is never a reply session', () => {
  const body = acenteDetailPageBody();
  const idx = body.indexOf('function handleOpenHistoryItem(');
  const end = body.indexOf('\n  }', idx);
  const fnBody = body.slice(idx, end);
  assert.match(fnBody, /setReplyTargetEmail\(null\)/);
});

test('handleSendEmail sends send_mode:"reply" and reply_to_agency_email_id:replyTargetEmail.id ONLY when replyTargetEmail is set — otherwise send_mode:"new_outreach" exactly as before', () => {
  const body = acenteDetailPageBody();
  const idx = body.indexOf('async function handleSendEmail(');
  const end = body.indexOf('\n  }', idx);
  const fnBody = body.slice(idx, end);
  assert.match(fnBody, /send_mode:\s*['"]reply['"]/);
  assert.match(fnBody, /reply_to_agency_email_id:\s*replyTargetEmail\.id/);
  assert.match(fnBody, /send_mode:\s*['"]new_outreach['"]/);
  assert.match(fnBody, /replyTargetEmail\s*\?/);
});

test('handleSendEmail clears replyTargetEmail after a successful send', () => {
  const body = acenteDetailPageBody();
  const idx = body.indexOf('async function handleSendEmail(');
  const end = body.indexOf('\n  }', idx);
  const fnBody = body.slice(idx, end);
  const okIdx = fnBody.indexOf('if (!resp.ok)');
  const afterOk = fnBody.slice(okIdx);
  assert.match(afterOk, /setReplyTargetEmail\(null\)/);
});

test('the composer never exposes a Gmail implementation identifier (provider_message_id/provider_thread_id/gmailMessageId/gmailThreadId) anywhere in its visible text', () => {
  const body = acenteDetailPageBody();
  const idx = body.indexOf('"İlk Temas Taslağı"');
  const end = body.indexOf('</RCard>', idx);
  const composerSection = body.slice(Math.max(0, idx - 400), end);
  assert.doesNotMatch(composerSection, />\s*\{[^}]*provider_thread_id/);
  assert.doesNotMatch(composerSection, />\s*\{[^}]*provider_message_id/);
});

test('the composer shows a clear, visible indication of reply mode (replyTargetEmail), with its own subject/sender, and an explicit way to exit reply mode', () => {
  const body = acenteDetailPageBody();
  const idx = body.indexOf('"İlk Temas Taslağı"');
  const end = body.indexOf('</RCard>', idx);
  const composerSection = body.slice(Math.max(0, idx - 400), end);
  assert.match(composerSection, /replyTargetEmail\s*\?/);
  assert.match(composerSection, /Yanıt veriliyor/);
  assert.match(composerSection, /replyTargetEmail\.subject/);
  assert.match(composerSection, /setReplyTargetEmail\(null\)/);
});

test('the card title switches to a reply-specific label while replyTargetEmail is set', () => {
  const body = acenteDetailPageBody();
  const idx = body.indexOf('RCardHead title={replyTargetEmail');
  assert.ok(idx !== -1, 'expected the card header to branch on replyTargetEmail');
});

test('the selected inbound message stays identifiable (highlighted) in the timeline while it is being replied to', () => {
  const section = emailHistorySectionBody();
  assert.match(section, /isReplyTarget\s*=\s*!!\(replyTargetEmail\s*&&\s*replyTargetEmail\.id\s*===\s*email\.id\)/);
  assert.match(section, /isReplyTarget/);
});

test('the review/confirm panel also shows a reply indication before the final send confirmation', () => {
  const body = acenteDetailPageBody();
  const idx = body.indexOf('Gönderimden Önce Son Kontrol');
  const end = body.indexOf('</div>', body.indexOf('</div>', idx) + 1);
  const reviewSection = body.slice(idx, idx + 800);
  assert.match(reviewSection, /replyTargetEmail\s*&&/);
});

// ═══════════════ Phase 10 — MobileHomePage Agency CRM+ section ═══════════

function mobileHomePageBody() {
  return sliceFunction('MobileHomePage');
}

function mobileAgencySectionBody() {
  const body = mobileHomePageBody();
  const idx = body.indexOf('"Agency CRM+"');
  // The section is self-closing JSX ended by the matching "</MobileSection>"
  // right before the next Civitatis Settlement comment block.
  const end = body.indexOf('</MobileSection>', idx) + '</MobileSection>'.length;
  return body.slice(idx - 400, end);
}

test('the mobile Agency CRM+ section is gated by the same canAccess(auth.role, "agencies") check as the desktop section', () => {
  const body = mobileHomePageBody();
  const sectionIdx = body.indexOf('"Agency CRM+"');
  const guardSlice = body.slice(Math.max(0, sectionIdx - 200), sectionIdx);
  assert.match(guardSlice, /canAccess\(auth\.role,\s*["']agencies["']\)/);
});

test('the mobile section reuses the exact same computeAgencyCrmPlusSummary selector and the same bounded sinceDays:14 query as the desktop section', () => {
  const body = mobileHomePageBody();
  assert.match(body, /computeAgencyCrmPlusSummary\(/);
  assert.match(body, /useRepo\(\s*["']agencyEmail["'],\s*["']getAll["'],\s*\{\s*sinceDays:\s*14\s*\}\s*\)/);
});

test('the mobile section renders all 4 KPI numbers from the shared summary object, in a 2x2 grid', () => {
  const section = mobileAgencySectionBody();
  assert.match(section, /gridTemplateColumns:\s*"1fr 1fr"/);
  for (const field of ['newAgenciesTodayCount', 'sentTodayCount', 'repliesTodayCount', 'followUpCount']) {
    assert.match(section, new RegExp(`agencyCrmPlusSummary\\.${field}`));
  }
});

test('the mobile section lists up to 3 recent replies, each navigating to that agency\'s detail page on tap', () => {
  const section = mobileAgencySectionBody();
  assert.match(section, /agencyCrmPlusSummary\.recentReplies\.slice\(0,\s*3\)\.map\(/);
  assert.match(section, /onClick=\{\(\)\s*=>\s*navigate\('\/agencies\/'\+reply\.agencyId\)\}/);
  assert.match(section, /<MobileStatusChip label="Yanıt Geldi" tone="info"\/>/);
});

test('the mobile section lists up to 3 follow-up agencies, each navigating to that agency\'s detail page on tap', () => {
  const section = mobileAgencySectionBody();
  assert.match(section, /agencyCrmPlusSummary\.followUpItems\.slice\(0,\s*3\)\.map\(/);
  assert.match(section, /onClick=\{\(\)\s*=>\s*navigate\('\/agencies\/'\+agency\.id\)\}/);
  assert.match(section, /<MobileStatusChip label="Takip" tone="warn"\/>/);
});

test('the mobile Agency CRM+ section is placed before the Civitatis Hakedişi/Settlement mobile section, mirroring the desktop order', () => {
  const body = mobileHomePageBody();
  const agencyIdx = body.indexOf('"Agency CRM+"');
  // The JSX render block's own Civitatis comment, not the earlier
  // useRepo("civitatisSettlement", ...) hook-declaration comment near the
  // top of the function (which always precedes Agency CRM+ positionally).
  const civitatisIdx = body.indexOf('Civitatis Settlement Engine', agencyIdx);
  assert.ok(agencyIdx !== -1 && civitatisIdx !== -1);
  assert.ok(agencyIdx < civitatisIdx, 'Agency CRM+ must render above the Civitatis Hakedişi/Settlement mobile section');
});
