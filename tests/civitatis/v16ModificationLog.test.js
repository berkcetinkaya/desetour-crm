'use strict';
/**
 * tests/civitatis/v16ModificationLog.test.js
 * Civitatis "Booking modified" emails were applied silently (A42711975 /
 * R-2026-0058 moved 19 → 20 November with no trace in the reservation's
 * history). V16 writes one activity row listing what changed; the CRM
 * shows it on the reservation page, in the bell and on the home page.
 * Static text checks only; the runtime behaviour was exercised on a local
 * PostgreSQL 16 with the full V6–V15 chain (create → modify → identical
 * modify → stale modify → rollback to V15).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { extractTestableFn } = require('../dashboard/extractTestableFn');

const ROOT = path.join(__dirname, '..', '..');
const V15 = fs.readFileSync(path.join(ROOT, 'supabase_migration_civitatis_write_v15_zero_passenger_names.sql'), 'utf8');
const V16 = fs.readFileSync(path.join(ROOT, 'supabase_migration_civitatis_write_v16_modification_log.sql'), 'utf8');
const RB = fs.readFileSync(path.join(ROOT, 'supabase_migration_civitatis_write_v16_ROLLBACK_to_v15.sql'), 'utf8');
const SRC = fs.readFileSync(path.join(ROOT, 'DeseTourDashboard.jsx'), 'utf8');
const fnBody = (sql) => sql.slice(sql.indexOf('CREATE OR REPLACE FUNCTION public.ingest_civitatis_booking('), sql.indexOf('COMMENT ON FUNCTION public.ingest_civitatis_booking'));

test('V16 reads the previous values before the update and logs only fields that really changed', () => {
  const b = fnBody(V16);
  const read = b.indexOf("v_stage := 'modification_read_previous'"), upd = b.indexOf("v_stage := 'reservation_update'");
  assert.ok(read > 0 && read < upd, 'previous values are read BEFORE the update');
  for (const [f, cond] of [['check_in', 'v_old_check_in IS DISTINCT FROM p_check_in'], ['check_in_time', 'v_old_check_in_time IS DISTINCT FROM p_check_in_time'],
    ['pax_adult', 'v_old_pax_adult IS DISTINCT FROM p_pax_adult'], ['pax_child', 'v_old_pax_child IS DISTINCT FROM COALESCE(p_pax_child, 0)'],
    ['tour_language', 'v_old_tour_language IS DISTINCT FROM p_tour_language']]) {
    assert.ok(b.includes(cond), f);
  }
  assert.match(b, /IF jsonb_array_length\(v_changes\) > 0 THEN/);
  assert.match(b, /'reservation', v_reservation_id, 'updated',\s*'Civitatis değişikliği: '/);
  assert.match(b, /'auto_ingested', true,\s*'source', 'civitatis',\s*'alert_type', 'civitatis_modified'/);
  assert.match(b, /'changes', v_changes,/);
  assert.doesNotMatch(b.slice(b.indexOf("v_stage := 'modification_change_log'"), b.indexOf("v_stage := 'unexpected_branch'")), /customer|full_name|email|phone/i, 'no customer PII in the change log');
});

test('V16 leaves everything else of V15 untouched: only the modification branch, declarations and the COMMENT differ', () => {
  const strip = (b) => b
    .replace(/  -- V16: modification change log[\s\S]*?v_change_text\s+TEXT;\n/, '')
    .replace(/      -- V16: the values BEFORE[\s\S]*?WHERE r\.id = v_reservation_id;\n\n/, '')
    .replace(/      -- V16: record WHAT Civitatis changed[\s\S]*?\n      END IF;\n\n(?=    ELSE)/, '');
  assert.equal(strip(fnBody(V16)), fnBody(V15));
});

test('V16 preflight requires V15 live; postflight checks the new insert; rollback restores V15 verbatim', () => {
  assert.match(V16, /V16 PREFLIGHT FAILED: the live ingest_civitatis_booking is not V15/);
  assert.match(V16, /v_src !~ 'alert_type\.\*civitatis_modified'/);
  assert.match(V16, /^BEGIN;/m); assert.match(V16, /^COMMIT;/m);
  assert.ok(RB.endsWith(V15), 'rollback = V15 file verbatim');
});

test('CRM: notifications carry the changes; home shows a "Değişiklik" signal and an important alert; reservation page lists the changes', () => {
  assert.match(SRC, /alertType:l\.metadata\?\.alert_type\|\|null,changes:Array\.isArray\(l\.metadata\?\.changes\)/);
  assert.match(SRC, /if \(n\.alertType === 'civitatis_modified'\) return 'modification';/);
  assert.match(SRC, /\{ kind:"modification", label:"Değişiklik"/);
  assert.match(SRC, /n\.action === 'cancelled' \|\| n\.alertType === 'civitatis_modified'/);
  assert.match(SRC, /<_ResCivitatisChanges activity=\{resActivity\} r=\{r\}\/>/);
  const vm = extractTestableFn('_cancellationAlertViewModel');
  const m = vm({ alertType: 'civitatis_modified', reservationNumber: 'R-2026-0058', tourName: 'Topkapı', externalBookingId: '42711975',
    changes: [{ field: 'check_in', label: 'Tarih', from: '19.11.2026', to: '20.11.2026' }], guideAssigned: true, guideName: 'Ayşe' });
  assert.equal(m.title, 'Rezervasyon Değişikliği');
  assert.deepEqual(m.rows.map(r => r.label + ': ' + r.value), ['Tur: Topkapı', 'Tarih: 19.11.2026 → 20.11.2026', 'Civitatis: 42711975', 'Rehber: Ayşe — değişikliği rehbere iletin']);
  assert.equal(vm({ reservationNumber: 'R1' }).title, 'Rezervasyon İptali');
  const changes = extractTestableFn('_civitatisChangesFromActivity');
  const out = changes([
    { id: 'a', createdAt: '2026-11-15T10:00:00Z', metadata: { alert_type: 'civitatis_modified', changes: [{ label: 'Tarih', from: '1', to: '2' }] } },
    { id: 'b', createdAt: '2026-11-16T10:00:00Z', metadata: { alert_type: 'civitatis_modified', changes: [{ label: 'Yetişkin', from: '2', to: '3' }], guide_assigned: true } },
    { id: 'c', metadata: { alert_type: 'civitatis_missing_passenger_names' } }, null,
  ]);
  assert.deepEqual(out.map(x => x.id), ['b', 'a']);
  assert.equal(out[0].guideAssigned, true);
});
