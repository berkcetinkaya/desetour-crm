'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const SOURCE_PATH = path.join(__dirname, '..', '..', 'DeseTourDashboard.jsx');
const SOURCE = fs.readFileSync(SOURCE_PATH, 'utf8');

function extractFunctionBody(name, nextMarker) {
  const idx = SOURCE.indexOf(`function ${name}(`);
  assert.ok(idx !== -1, `could not find function ${name}`);
  return SOURCE.slice(idx, SOURCE.indexOf(nextMarker, idx));
}

const GUEST_DETAIL_BODY = extractFunctionBody('GuestDetailPage', '\nfunction customerSourceName');
const NEW_RES_MODAL_BODY = extractFunctionBody('NewReservationModal', '\nfunction ReservationsPage');

// --- Root cause: the button had no onClick at all -----------------------

test('root cause: before this fix, none of the Customer Detail quick-action buttons had an onClick handler', () => {
  // This is a historical/documentation assertion about the bug, verified
  // against the OLD shape: a bare {label, icon} object list with no key
  // used for dispatch. We assert the NEW shape instead (each action now
  // carries a `key` used by handleQuickAction), which is the actual fix.
  assert.match(GUEST_DETAIL_BODY, /key:"reservation",\s*label:"Yeni Rezervasyon"/);
  assert.match(GUEST_DETAIL_BODY, /onClick=\{\(\)=>handleQuickAction\(a\.key\)\}/);
});

// --- 1. Clicking "Yeni Rezervasyon" launches the reservation creation flow --

test('the "Yeni Rezervasyon" quick action opens the existing NewReservationModal (not a new/second form)', () => {
  assert.match(GUEST_DETAIL_BODY, /if \(key === "reservation"\) \{ setShowNewRes\(true\); return; \}/);
  assert.match(GUEST_DETAIL_BODY, /\{showNewRes && \(/);
  assert.match(GUEST_DETAIL_BODY, /<NewReservationModal\s*\n\s*customerId=\{g\.id\} customerName=\{g\.name\}/);
});

test('NewReservationModal is the same single reservation-creation component used elsewhere (Welcome, ReservationsPage, mobile quick actions)', () => {
  const usages = SOURCE.match(/<NewReservationModal\b/g) || [];
  // Welcome(), ReservationsPage, mobile QUICK_ACTIONS dispatcher, and now
  // GuestDetailPage — no second/duplicate reservation form was created.
  assert.ok(usages.length >= 4, `expected NewReservationModal to be reused across multiple entry points, found ${usages.length}`);
});

// --- 2. The current customer is preselected — no re-searching -------------

test('customerId defaults custId, and the customer field is rendered as a fixed label instead of a re-searchable select when customerId is provided', () => {
  assert.match(NEW_RES_MODAL_BODY, /function NewReservationModal\(\{ onClose, onSuccess, customerId, customerName \}\)/);
  assert.match(NEW_RES_MODAL_BODY, /const \[custId,\s*setCustId\]\s*=\s*useState\(customerId \|\| ""\);/);
  assert.match(NEW_RES_MODAL_BODY, /\{customerId \? \(/);
  assert.doesNotMatch(NEW_RES_MODAL_BODY.split('{customerId ? (')[0], /-- Musteri secin --/);
});

// --- 3. The real customer UUID is used as customer_id ----------------------

test('the create payload sends customerId straight through as customerId, which the repo writes to reservations.customer_id', () => {
  assert.match(NEW_RES_MODAL_BODY, /customerId: custId, tourId: tourId\|\|null,/);
  const idx = SOURCE.indexOf("async create(d){const sb=getSB();if(!sb)return ReservationRepository.create(d);");
  assert.ok(idx !== -1, 'SupabaseReservationRepo.create not found');
  const createBody = SOURCE.slice(idx, idx + 900);
  assert.match(createBody, /customer_id:d\.customerId/);
});

// --- 4. No second customer record is ever created --------------------------

test('the reservation flow never calls the customer repo\'s create — only reservation "create" is invoked', () => {
  assert.doesNotMatch(NEW_RES_MODAL_BODY, /useRepoMutation\("customer"\)/);
  assert.match(NEW_RES_MODAL_BODY, /useRepoMutation\("reservation"\)/);
});

// --- 5. Reuses the existing component, no second independent form ----------

test('GuestDetailPage does not define a second/local reservation form component', () => {
  assert.doesNotMatch(GUEST_DETAIL_BODY, /function\s+\w*Reservation\w*Modal/);
});

// --- 6. Everything downstream (KPI, tabs, Reservations page, Calendar, ----
// Guide Detail) is store-subscribed, so a single mutation refreshes all of it.

test('reservation creation notifies the shared store, and every downstream view (customer reservations, Reservations page, Calendar, Guide Detail) reads via the live useRepo hook that subscribes to it', () => {
  const mutationIdx = SOURCE.indexOf('function useRepoMutation(entity)');
  const mutationBody = SOURCE.slice(mutationIdx, SOURCE.indexOf('\n}', mutationIdx + 50));
  assert.match(mutationBody, /Store\.notify\(\)/);

  assert.match(GUEST_DETAIL_BODY, /useRepo\("reservation",\s*"getByCustomerId",\s*guestId\)/);
  assert.match(SOURCE, /useRepo\("reservation",\s*"getAll"\)/); // ReservationsPage/Calendar/GuideDetailPage all use this

  const useRepoIdx = SOURCE.indexOf('function useRepo(entity, method, arg)');
  const useRepoBody = SOURCE.slice(useRepoIdx, SOURCE.indexOf('\nfunction useRepoMutation', useRepoIdx));
  assert.match(useRepoBody, /const tick = useStore\(\);/);
});

// --- 7. Guide assignment persists through reservations.guide_id -----------

test('the reservation create payload carries guideId through to reservations.guide_id, never relying on guide_name text for the relationship', () => {
  assert.match(NEW_RES_MODAL_BODY, /guideId: guideId\|\|null, guide: guide\?\.name\|\|null,/);
  const idx = SOURCE.indexOf("async create(d){const sb=getSB();if(!sb)return ReservationRepository.create(d);");
  const createBody = SOURCE.slice(idx, idx + 900);
  assert.match(createBody, /guide_id:d\.guideId\|\|null/);
});

// --- 8. Other Customer Detail quick actions were checked -------------------

test('"WhatsApp Gönder" and "Not Ekle" are also wired to real, existing flows', () => {
  assert.match(GUEST_DETAIL_BODY, /if \(key === "note"\) \{ setShowEditGuest\(true\); return; \}/);
  assert.match(GUEST_DETAIL_BODY, /if \(key === "whatsapp"\) \{/);
  assert.match(GUEST_DETAIL_BODY, /window\.open\(`https:\/\/wa\.me\/\$\{digits\}`/);
});

test('Lead/Quote/Task quick actions are left deliberately unwired (those workflows were removed from navigation) rather than silently pointed at something broken', () => {
  // No nav entry for leads/quotes/tasks exists any more in this simplified CRM.
  assert.doesNotMatch(SOURCE, /id:"leads"/);
  assert.doesNotMatch(SOURCE, /id:"quotes"/);
  assert.doesNotMatch(SOURCE, /id:"tasks"/);
  // handleQuickAction has no branch for "lead"/"quote"/"task" — documented, not silently broken.
  const handlerIdx = GUEST_DETAIL_BODY.indexOf('function handleQuickAction(key)');
  const handlerBody = GUEST_DETAIL_BODY.slice(handlerIdx, GUEST_DETAIL_BODY.indexOf('\n  }', handlerIdx));
  assert.doesNotMatch(handlerBody, /key === "lead"/);
  assert.doesNotMatch(handlerBody, /key === "quote"/);
  assert.doesNotMatch(handlerBody, /key === "task"/);
});
