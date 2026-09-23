'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { extractTestableFn } = require('./extractTestableFn');

const computeUnassignedGuideUpcomingCount = extractTestableFn('computeUnassignedGuideUpcomingCount');

const TODAY_ISO = '2026-09-15';

function res(overrides) {
  return {
    id: 'r-' + Math.random().toString(36).slice(2),
    checkIn: '2026-09-20',
    opStatus: 'Onaylandı',
    guideId: null,
    ...overrides,
  };
}

test('counts an upcoming, active reservation with no guide assigned', () => {
  const reservations = [res({ guideId: null })];
  assert.equal(computeUnassignedGuideUpcomingCount(reservations, TODAY_ISO), 1);
});

test('excludes reservations that already have a guide assigned', () => {
  const reservations = [
    res({ guideId: null }),
    res({ guideId: 'guide-1' }),
  ];
  assert.equal(computeUnassignedGuideUpcomingCount(reservations, TODAY_ISO), 1);
});

test('excludes cancelled reservations', () => {
  const reservations = [res({ guideId: null, opStatus: 'İptal' })];
  assert.equal(computeUnassignedGuideUpcomingCount(reservations, TODAY_ISO), 0);
});

test('excludes completed reservations', () => {
  const reservations = [res({ guideId: null, opStatus: 'Tamamlandı' })];
  assert.equal(computeUnassignedGuideUpcomingCount(reservations, TODAY_ISO), 0);
});

test('excludes past reservations (tour date before today)', () => {
  const reservations = [res({ guideId: null, checkIn: '2026-09-14' })];
  assert.equal(computeUnassignedGuideUpcomingCount(reservations, TODAY_ISO), 0);
});

test('includes a reservation whose tour date is today', () => {
  const reservations = [res({ guideId: null, checkIn: TODAY_ISO })];
  assert.equal(computeUnassignedGuideUpcomingCount(reservations, TODAY_ISO), 1);
});

test('excludes a reservation with no checkIn date rather than throwing', () => {
  const reservations = [res({ guideId: null, checkIn: null })];
  assert.equal(computeUnassignedGuideUpcomingCount(reservations, TODAY_ISO), 0);
});

test('each qualifying reservation is counted exactly once across a mixed set', () => {
  const reservations = [
    res({ id: 'A', guideId: null, checkIn: '2026-09-20', opStatus: 'Onaylandı' }),
    res({ id: 'B', guideId: null, checkIn: '2026-09-25', opStatus: 'Hazırlanıyor' }),
    res({ id: 'C', guideId: 'g-1', checkIn: '2026-09-21', opStatus: 'Onaylandı' }),
    res({ id: 'D', guideId: null, checkIn: '2026-08-01', opStatus: 'Onaylandı' }),
    res({ id: 'E', guideId: null, checkIn: '2026-09-22', opStatus: 'İptal' }),
  ];
  assert.equal(computeUnassignedGuideUpcomingCount(reservations, TODAY_ISO), 2);
});

test('returns 0 for an empty reservations array', () => {
  assert.equal(computeUnassignedGuideUpcomingCount([], TODAY_ISO), 0);
});

// --- Static source checks: KPI wiring --------------------------------------
const SOURCE = fs.readFileSync(path.join(__dirname, '..', '..', 'DeseTourDashboard.jsx'), 'utf8');

test('"Rehber Ataması Bekleyen" KPI card is wired to unassignedGuideCount with the correct subtitle', () => {
  const m = SOURCE.match(/label:"Rehber Ataması Bekleyen",\s*\n\s*value:([^,]+),\s*\n\s*sub:"([^"]+)"/);
  assert.ok(m, 'could not find the "Rehber Ataması Bekleyen" KPI card definition');
  assert.match(m[1], /m\.unassignedGuideCount/);
  assert.equal(m[2], 'Atama bekleyen rezervasyon');
});

test('the old "Bekleyen Ödemeler" dashboard KPI card is gone from KpiRow (PaymentsPage keeps its own unrelated card of the same name)', () => {
  const kpiRowStart = SOURCE.indexOf('function KpiRow()');
  const kpiRowEnd = SOURCE.indexOf('function PendingPaymentsWidget()');
  assert.ok(kpiRowStart !== -1 && kpiRowEnd !== -1 && kpiRowEnd > kpiRowStart, 'could not locate the KpiRow function body');
  const kpiRowSource = SOURCE.slice(kpiRowStart, kpiRowEnd);
  assert.doesNotMatch(kpiRowSource, /label:"Bekleyen Ödemeler"/);
  assert.match(kpiRowSource, /label:"Rehber Ataması Bekleyen"/);
});

test('calculateDashboardMetrics computes unassignedGuideCount via computeUnassignedGuideUpcomingCount', () => {
  assert.match(SOURCE, /const unassignedGuideCount = computeUnassignedGuideUpcomingCount\(_res, todayISO\);/);
});
