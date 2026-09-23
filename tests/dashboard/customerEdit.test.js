'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { extractTestableFn } = require('./extractTestableFn');

const mapCustomerToDB = extractTestableFn('mapCustomerToDB');

// --- mapCustomerToDB: the payload sent to Supabase's customers table -------

test('maps the editable fields to their real column names', () => {
  const row = mapCustomerToDB({ name: 'Sarah Johnson', phone: '+90 555 000 0000', email: 'sarah@example.com', country: 'Türkiye', language: 'Türkçe' });
  assert.deepEqual(row, {
    full_name: 'Sarah Johnson',
    phone: '+90 555 000 0000',
    email: 'sarah@example.com',
    nationality: 'Türkiye',
    language: 'Türkçe',
  });
});

test('"Durum" = Aktif maps to is_active: true', () => {
  const row = mapCustomerToDB({ status: 'Aktif' });
  assert.equal(row.is_active, true);
});

test('"Durum" = Arşiv maps to is_active: false', () => {
  const row = mapCustomerToDB({ status: 'Arşiv' });
  assert.equal(row.is_active, false);
});

test('an empty phone is saved as null, not omitted or an empty string — imported customers may genuinely have none', () => {
  const row = mapCustomerToDB({ phone: '' });
  assert.equal(row.phone, null);
});

test('an empty email is saved as null, not omitted or an empty string', () => {
  const row = mapCustomerToDB({ email: '' });
  assert.equal(row.email, null);
});

test('fields not included in the edit payload are left out of the update row entirely, so unrelated columns are never overwritten', () => {
  const row = mapCustomerToDB({ name: 'Only Name Changed' });
  assert.deepEqual(Object.keys(row), ['full_name']);
});

test('omitting status entirely leaves is_active untouched (no accidental archive/reactivate)', () => {
  const row = mapCustomerToDB({ name: 'X' });
  assert.equal('is_active' in row, false);
});

// --- Static source checks: the edit flow is wired the way the task asked ---
const SOURCE = fs.readFileSync(path.join(__dirname, '..', '..', 'DeseTourDashboard.jsx'), 'utf8');

test('GSection renders an optional action slot, used by "Misafir Profili" for its "Düzenle" button', () => {
  assert.match(SOURCE, /function GSection\(\{ title, icon, children, noPad, action \}\)/);
  assert.match(SOURCE, /\{action && <div style=\{\{marginLeft:"auto"\}\}>\{action\}<\/div>\}/);
});

test('the "Misafir Profili" section has a "Düzenle" action that opens the edit modal', () => {
  const idx = SOURCE.indexOf('GSection title="Misafir Profili"');
  assert.ok(idx !== -1, 'could not find the Misafir Profili GSection');
  const nearby = SOURCE.slice(idx, idx + 600);
  assert.match(nearby, /onClick=\{\(\)=>setShowEditGuest\(true\)\}/);
  assert.match(nearby, />Düzenle</);
});

test('EditGuestModal updates the EXISTING customer record (repo "update" with guest.id), never "create"', () => {
  const idx = SOURCE.indexOf('function EditGuestModal(');
  assert.ok(idx !== -1, 'could not find EditGuestModal');
  const body = SOURCE.slice(idx, SOURCE.indexOf('\nfunction NewReminderModal', idx));
  assert.match(body, /mutCustG\("update", guest\.id, \{/);
  assert.doesNotMatch(body, /mutCustG\("create"/);
});

test('EditGuestModal is only rendered when showEditGuest is true, prefilled from the real loaded guest', () => {
  assert.match(SOURCE, /\{showEditGuest && <EditGuestModal guest=\{g\} onClose=\{\(\)=>setShowEditGuest\(false\)\}\/>\}/);
});

test('the customer edit form exposes exactly the requested editable fields', () => {
  const idx = SOURCE.indexOf('function EditGuestModal(');
  const body = SOURCE.slice(idx, SOURCE.indexOf('\nfunction NewReminderModal', idx));
  for (const label of ['Ad Soyad', 'Telefon', 'E-posta', 'Ülke', 'Dil', 'Durum']) {
    assert.match(body, new RegExp(`FRow label="${label}"`), `missing field: ${label}`);
  }
});

test('"Durum" in the edit form is restricted to the two values the schema actually supports', () => {
  const idx = SOURCE.indexOf('function EditGuestModal(');
  const body = SOURCE.slice(idx, SOURCE.indexOf('\nfunction NewReminderModal', idx));
  assert.match(body, /FRow label="Durum"><FSelect value=\{status\} onChange=\{setStatus\} options=\{\["Aktif","Arşiv"\]\}\/>/);
});

test('SupabaseCustomerRepo.update records the edit in the activity log system', () => {
  const idx = SOURCE.indexOf("async update(id,p){const sb=getSB();if(!sb)return CustomerRepository.update(id,p);");
  assert.ok(idx !== -1, 'could not find SupabaseCustomerRepo.update');
  const line = SOURCE.slice(idx, idx + 400);
  assert.match(line, /_sbLog\('customer',id,'updated',/);
});

test('SupabaseCustomerRepo.update never touches reservation_guests — customers and reservation_guests are separate concepts', () => {
  const idx = SOURCE.indexOf("async update(id,p){const sb=getSB();if(!sb)return CustomerRepository.update(id,p);");
  const line = SOURCE.slice(idx, idx + 400);
  assert.doesNotMatch(line, /reservation_guests/);
});
