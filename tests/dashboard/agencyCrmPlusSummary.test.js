'use strict';
/**
 * tests/dashboard/agencyCrmPlusSummary.test.js
 * ─────────────────────────────────────────────────────────────────────────
 * Homepage "Agency CRM+" section — unit tests for the two pure, dependency-
 * free selectors it's built on: computeAgencyCrmPlusSummary (the 4 KPI
 * counts + the two panels' rows) and formatAgencyRelativeTime (the "2 saat
 * önce" style copy). Both are extracted straight from DeseTourDashboard.jsx
 * via extractTestableFn, so these tests exercise the REAL, currently
 * shipping implementation — never a hand-copied duplicate.
 *
 * IMPORTANT, deliberately covered below: 'inbound' agency_emails rows
 * (replies) are a real, schema-supported value, but no code path in this
 * repository writes one yet (see the function's own header comment in
 * DeseTourDashboard.jsx) — "Bugün Yanıt Geldi" and "Gelen Yanıtlar" are
 * therefore correctly wired to data that is honestly empty in production
 * today. The tests below prove the LOGIC is correct for when such rows
 * exist (so a future reply-ingestion phase needs zero changes here), not
 * that replies exist today.
 * ─────────────────────────────────────────────────────────────────────────
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { extractTestableFn } = require('./extractTestableFn');

const computeAgencyCrmPlusSummary = extractTestableFn('computeAgencyCrmPlusSummary');
const formatAgencyRelativeTime = extractTestableFn('formatAgencyRelativeTime');

const NOW_ISO = '2026-09-15T12:00:00.000Z';
const TODAY = '2026-09-15';

function agency(overrides) {
  return {
    id: 'AGN-' + Math.random().toString(36).slice(2),
    name: 'Test Agency',
    country: 'Spain',
    languages: ['İspanyolca'],
    status: 'Aday',
    createdAt: '2026-09-01',
    lastContactAt: null,
    ...overrides,
  };
}

function email(overrides) {
  return {
    id: 'AEM-' + Math.random().toString(36).slice(2),
    agencyId: 'AGN-x',
    direction: 'outbound',
    status: 'draft',
    sentAt: null,
    receivedAt: null,
    createdAt: '2026-09-01T10:00:00.000Z',
    subject: '', body: '', fromEmail: '', agencyName: '',
    ...overrides,
  };
}

// ═══════════════ Bugün Yeni Acente ════════════════════════════════════════

test('counts an agency created today', () => {
  const agencies = [agency({ createdAt: TODAY })];
  const result = computeAgencyCrmPlusSummary(agencies, [], NOW_ISO);
  assert.equal(result.newAgenciesTodayCount, 1);
});

test('excludes an agency created on a different day', () => {
  const agencies = [agency({ createdAt: '2026-09-10' })];
  const result = computeAgencyCrmPlusSummary(agencies, [], NOW_ISO);
  assert.equal(result.newAgenciesTodayCount, 0);
});

test('an agency with no createdAt at all is never counted as "today" (never a false positive)', () => {
  const agencies = [agency({ createdAt: null })];
  const result = computeAgencyCrmPlusSummary(agencies, [], NOW_ISO);
  assert.equal(result.newAgenciesTodayCount, 0);
});

// ═══════════════ Bugün Mail Gönderildi ═════════════════════════════════════

test('counts an outbound email actually sent today', () => {
  const emails = [email({ direction: 'outbound', status: 'sent', sentAt: TODAY + 'T09:00:00.000Z' })];
  const result = computeAgencyCrmPlusSummary([], emails, NOW_ISO);
  assert.equal(result.sentTodayCount, 1);
});

test('a draft (never sent) today does not count toward Bugün Mail Gönderildi', () => {
  const emails = [email({ direction: 'outbound', status: 'draft', sentAt: null, createdAt: TODAY + 'T09:00:00.000Z' })];
  const result = computeAgencyCrmPlusSummary([], emails, NOW_ISO);
  assert.equal(result.sentTodayCount, 0);
});

test('a sent email from a previous day does not count today', () => {
  const emails = [email({ direction: 'outbound', status: 'sent', sentAt: '2026-09-10T09:00:00.000Z' })];
  const result = computeAgencyCrmPlusSummary([], emails, NOW_ISO);
  assert.equal(result.sentTodayCount, 0);
});

// ═══════════════ Bugün Yanıt Geldi / Gelen Yanıtlar ════════════════════════

test('counts an inbound reply received today, and lists it in recentReplies', () => {
  const emails = [email({ direction: 'inbound', receivedAt: TODAY + 'T08:00:00.000Z', agencyName: 'Acme Travel' })];
  const result = computeAgencyCrmPlusSummary([], emails, NOW_ISO);
  assert.equal(result.repliesTodayCount, 1);
  assert.equal(result.recentReplies.length, 1);
  assert.equal(result.recentReplies[0].agencyName, 'Acme Travel');
});

test('an outbound email is never counted as a reply, regardless of its own timestamps', () => {
  const emails = [email({ direction: 'outbound', status: 'sent', sentAt: TODAY + 'T08:00:00.000Z' })];
  const result = computeAgencyCrmPlusSummary([], emails, NOW_ISO);
  assert.equal(result.repliesTodayCount, 0);
  assert.equal(result.recentReplies.length, 0);
});

test('an inbound reply with no receivedAt falls back to createdAt for the "today" check', () => {
  const emails = [email({ direction: 'inbound', receivedAt: null, createdAt: TODAY + 'T08:00:00.000Z' })];
  const result = computeAgencyCrmPlusSummary([], emails, NOW_ISO);
  assert.equal(result.repliesTodayCount, 1);
});

test('recentReplies is sorted newest first and capped at 5', () => {
  const emails = [
    email({ direction: 'inbound', receivedAt: '2026-09-10T08:00:00.000Z', agencyName: 'Oldest' }),
    email({ direction: 'inbound', receivedAt: '2026-09-14T08:00:00.000Z', agencyName: 'Newest' }),
    email({ direction: 'inbound', receivedAt: '2026-09-12T08:00:00.000Z', agencyName: 'Middle' }),
    ...Array.from({ length: 5 }, (_, i) => email({ direction: 'inbound', receivedAt: `2026-09-0${i+1}T08:00:00.000Z`, agencyName: 'Filler' + i })),
  ];
  const result = computeAgencyCrmPlusSummary([], emails, NOW_ISO);
  assert.equal(result.recentReplies.length, 5);
  assert.equal(result.recentReplies[0].agencyName, 'Newest');
});

test('no replies exist today returns an honest zero/empty, never a fabricated placeholder reply', () => {
  const result = computeAgencyCrmPlusSummary([agency()], [email({ direction: 'outbound' })], NOW_ISO);
  assert.equal(result.repliesTodayCount, 0);
  assert.deepEqual(result.recentReplies, []);
});

// ═══════════════ Takip Bekleyen / Takip Edilmesi Gereken Acenteler ═════════

test('an agency İletişime Geçildi with no contact in 3+ days needs follow-up', () => {
  const agencies = [agency({ status: 'İletişime Geçildi', lastContactAt: '2026-09-10T00:00:00.000Z' })];
  const result = computeAgencyCrmPlusSummary(agencies, [], NOW_ISO);
  assert.equal(result.followUpCount, 1);
  assert.equal(result.followUpItems[0].daysSinceContact, 5);
});

test('an agency contacted within the last 3 days does NOT need follow-up yet', () => {
  const agencies = [agency({ status: 'Görüşülüyor', lastContactAt: '2026-09-14T06:00:00.000Z' })];
  const result = computeAgencyCrmPlusSummary(agencies, [], NOW_ISO);
  assert.equal(result.followUpCount, 0);
});

test('a brand-new Aday agency (never contacted) is NOT counted as needing follow-up — it needs a first contact, not a follow-up', () => {
  const agencies = [agency({ status: 'Aday', lastContactAt: null })];
  const result = computeAgencyCrmPlusSummary(agencies, [], NOW_ISO);
  assert.equal(result.followUpCount, 0);
});

test('Partner and Uygun Değil agencies are never counted as needing follow-up, regardless of last_contact_at', () => {
  const agencies = [
    agency({ status: 'Partner', lastContactAt: '2026-01-01T00:00:00.000Z' }),
    agency({ status: 'Uygun Değil', lastContactAt: null }),
  ];
  const result = computeAgencyCrmPlusSummary(agencies, [], NOW_ISO);
  assert.equal(result.followUpCount, 0);
});

test('İletişime Geçildi/Görüşülüyor with NO last_contact_at at all (marked contacted but no timestamp) still needs follow-up — a data-quality edge case, never silently dropped', () => {
  const agencies = [agency({ status: 'İletişime Geçildi', lastContactAt: null })];
  const result = computeAgencyCrmPlusSummary(agencies, [], NOW_ISO);
  assert.equal(result.followUpCount, 1);
  assert.equal(result.followUpItems[0].daysSinceContact, null);
});

test('followUpItems is sorted most-overdue first and capped at 5', () => {
  const agencies = [
    agency({ id: 'A1', status: 'Görüşülüyor', lastContactAt: '2026-09-11T00:00:00.000Z' }), // 4 days
    agency({ id: 'A2', status: 'İletişime Geçildi', lastContactAt: '2026-09-05T00:00:00.000Z' }), // 10 days
    agency({ id: 'A3', status: 'Görüşülüyor', lastContactAt: null }), // unknown -> sorts first (Infinity)
    // Each less overdue (exactly at the 3-day threshold) than A1/A2, so
    // they fill out the remaining slots AFTER A3 and A2, never ahead.
    ...Array.from({ length: 5 }, (_, i) => agency({ id: 'FILL' + i, status: 'Görüşülüyor', lastContactAt: '2026-09-12T00:00:00.000Z' })),
  ];
  const result = computeAgencyCrmPlusSummary(agencies, [], NOW_ISO);
  assert.equal(result.followUpItems.length, 5);
  assert.equal(result.followUpItems[0].agency.id, 'A3');
  assert.equal(result.followUpItems[1].agency.id, 'A2');
});

test('no agency needs follow-up returns an honest zero/empty', () => {
  const result = computeAgencyCrmPlusSummary([agency({ status: 'Aday' })], [], NOW_ISO);
  assert.equal(result.followUpCount, 0);
  assert.deepEqual(result.followUpItems, []);
});

// ═══════════════ Robustness — null/undefined inputs never throw ══════════

test('null/undefined agencies and agencyEmails are treated as empty, never thrown', () => {
  assert.doesNotThrow(() => computeAgencyCrmPlusSummary(null, null, NOW_ISO));
  assert.doesNotThrow(() => computeAgencyCrmPlusSummary(undefined, undefined, NOW_ISO));
  const result = computeAgencyCrmPlusSummary(null, null, NOW_ISO);
  assert.deepEqual(result, {
    newAgenciesTodayCount: 0, sentTodayCount: 0, repliesTodayCount: 0,
    followUpCount: 0, followUpItems: [], recentReplies: [],
  });
});

// ═══════════════ formatAgencyRelativeTime ═════════════════════════════════

test('formats a 2-hour-old timestamp as "2 saat önce"', () => {
  assert.equal(formatAgencyRelativeTime('2026-09-15T10:00:00.000Z', NOW_ISO), '2 saat önce');
});

test('formats a 45-minute-old timestamp as "45 dakika önce"', () => {
  assert.equal(formatAgencyRelativeTime('2026-09-15T11:15:00.000Z', NOW_ISO), '45 dakika önce');
});

test('formats a 3-day-old timestamp as "3 gün önce"', () => {
  assert.equal(formatAgencyRelativeTime('2026-09-12T12:00:00.000Z', NOW_ISO), '3 gün önce');
});

test('formats a sub-minute-old timestamp as "az önce"', () => {
  assert.equal(formatAgencyRelativeTime('2026-09-15T11:59:45.000Z', NOW_ISO), 'az önce');
});

test('a missing or invalid timestamp returns the safe placeholder, never "NaN saat önce" or a throw', () => {
  assert.equal(formatAgencyRelativeTime(null, NOW_ISO), '—');
  assert.equal(formatAgencyRelativeTime(undefined, NOW_ISO), '—');
  assert.equal(formatAgencyRelativeTime('not-a-date', NOW_ISO), '—');
});

test('a timestamp in the future (clock skew) returns the safe placeholder, never a negative duration', () => {
  assert.equal(formatAgencyRelativeTime('2026-09-16T00:00:00.000Z', NOW_ISO), '—');
});
