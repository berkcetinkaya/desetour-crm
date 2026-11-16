'use strict';
/**
 * tests/whatsapp/whatsappSending.test.js — WhatsApp sending pipeline with a
 * fake database and a fake Meta Graph API (no network, no real numbers).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { normalizePhone, getWhatsAppConfig } = require('../../api/_whatsapp/config');
const { TEMPLATES, renderPreview, templateParams } = require('../../api/_whatsapp/templates');
const { runWorker } = require('../../api/_whatsapp/worker');
const { verifySignature, verifyHandshake, processWebhook } = require('../../api/_whatsapp/webhook');
const { buildGuideBrief, buildDailySummary, enqueueGuideBrief, enqueueOperationsNotice } = require('../../api/_whatsapp/enqueue');
const { createHandler } = require('../../api/whatsapp');
const { extractTestableFn } = require('../dashboard/extractTestableFn');

// ── minimal in-memory stand-in for the supabase-js query builder
function fakeDb(tables, rpcImpl) {
  const t = (n) => (tables[n] = tables[n] || []);
  return {
    tables,
    rpc: async (name, args) => rpcImpl(name, args, tables),
    from(name) {
      const st = { filters: [], op: 'select', patch: null, rows: null, opts: null };
      const match = (r) => st.filters.every(([k, v]) => r[k] === v);
      const api = {
        select() { return api; }, order() { return api; }, limit() { return api; },
        eq(k, v) { st.filters.push([k, v]); return api; },
        update(p) { st.op = 'update'; st.patch = p; return api; },
        upsert(rows, opts) { st.op = 'upsert'; st.rows = [].concat(rows); st.opts = opts; return api; },
        async maybeSingle() { const r = await api.then(); return { data: (r.data || [])[0] || null, error: null }; },
        then(res, rej) {
          let out;
          if (st.op === 'update') { t(name).filter(match).forEach(r => Object.assign(r, st.patch)); out = { data: null, error: null }; }
          else if (st.op === 'upsert') {
            const key = (st.opts && st.opts.onConflict) || 'id'; const ins = [];
            for (const r of st.rows) { if (t(name).some(x => x[key] === r[key])) continue; const row = { id: name + '-' + (t(name).length + 1), status: 'queued', attempt_count: 0, ...r }; t(name).push(row); ins.push(row); }
            out = { data: ins, error: null };
          } else out = { data: t(name).filter(match), error: null };
          return Promise.resolve(out).then(res, rej);
        },
      };
      return api;
    },
  };
}
const claimAll = (name, args, tables) => {
  const rows = (tables.whatsapp_messages || []).filter(r => r.status === 'queued' && (!args.p_ids || args.p_ids.includes(r.id)));
  rows.forEach(r => { r.status = 'processing'; r.attempt_count += 1; });
  return { data: rows.map(r => ({ ...r })), error: null };
};
const CFG = { accessToken: 'tok', phoneNumberId: '123', graphVersion: 'v21.0', appSecret: 'shh', verifyToken: 'vt', schedulerSecret: 'sch', sendingConfigured: true };
const metaOk = (calls) => async (url, init) => { calls.push({ url, body: JSON.parse(init.body), auth: init.headers.Authorization }); return { ok: true, status: 200, json: async () => ({ messages: [{ id: 'wamid.' + calls.length }] }) }; };

test('phone normalization: Turkish local forms, +, 00; junk → null', () => {
  assert.equal(normalizePhone('0532 123 45 67'), '905321234567');
  assert.equal(normalizePhone('532-123-4567'), '905321234567');
  assert.equal(normalizePhone('+34 612 345 678'), '34612345678');
  assert.equal(normalizePhone('0034612345678'), '34612345678');
  assert.equal(normalizePhone(''), null);
  assert.equal(normalizePhone('abc'), null);
  assert.equal(getWhatsAppConfig({}).sendingConfigured, false);
});

test('templates: parameters cleaned (no empty, no line breaks); CRM preview text equals the server template', () => {
  assert.deepEqual(templateParams('operations_notice', { title: 'A\nB', details: '' }), ['A · B', '—']);
  const bodies = extractTestableFn('_whatsappTemplatePreview');
  for (const k of Object.keys(TEMPLATES)) {
    const params = TEMPLATES[k].params.map((_, i) => 'p' + (i + 1));
    assert.equal(bodies(k, params), renderPreview(k, Object.fromEntries(TEMPLATES[k].params.map((p, i) => [p, 'p' + (i + 1)]))), k);
  }
});

test('guide brief: one operation = all bookings of the same date + tour + guide; cancelled ones excluded', () => {
  const p = buildGuideBrief({ guideName: 'Ayşe Yılmaz', tourName: 'Topkapı', note: '', meetingPoint: '',
    reservations: [
      { reservation_number: 'R-1', check_in: '2026-11-20', check_in_time: '10:00:00', tour_language: 'İspanyolca', pax_adult: 2, pax_child: 0, pickup_location: 'Sultanahmet', status: 'confirmed' },
      { reservation_number: 'R-2', check_in: '2026-11-20', check_in_time: '09:30:00', tour_language: 'Portekizce', pax_adult: 3, pax_child: 1, pickup_location: 'Sultanahmet', status: 'pending_confirmation' },
      { reservation_number: 'R-3', check_in: '2026-11-20', check_in_time: '10:00:00', pax_adult: 9, status: 'cancelled' },
    ] });
  assert.equal(p.guideName, 'Ayşe');
  assert.equal(p.time, '09:30');
  assert.equal(p.language, 'İspanyolca / Portekizce');
  assert.equal(p.guests, '6 kişi (2 rezervasyon: R-1, R-2)');
  assert.equal(p.meetingPoint, 'Sultanahmet');
  assert.equal(p.note, '—');
  assert.match(p.dateLabel, /20 Kasım 2026/);
});

test('daily summary: tomorrow only, one line per operation, unassigned guide flagged', () => {
  const s = buildDailySummary([
    { check_in: '2026-11-21', check_in_time: '10:00:00', tour_id: 'T1', destination: 'Topkapı', tour_language: 'İspanyolca', guide_id: 'G1', guide_name: 'Ayşe', pax_adult: 2, status: 'confirmed' },
    { check_in: '2026-11-21', check_in_time: '10:00:00', tour_id: 'T1', destination: 'Topkapı', tour_language: 'İspanyolca', guide_id: 'G1', guide_name: 'Ayşe', pax_adult: 3, status: 'confirmed' },
    { check_in: '2026-11-21', check_in_time: '09:00:00', tour_id: 'T2', destination: 'Bosforo', tour_language: 'İtalyanca', guide_id: null, pax_adult: 2, status: 'confirmed' },
    { check_in: '2026-11-22', tour_id: 'T3', destination: 'X', pax_adult: 2, status: 'confirmed' },
  ], '2026-11-21');
  assert.equal(s.operations, 2); assert.equal(s.unassigned, 1);
  assert.match(s.title, /2 operasyon, 7 misafir/);
  assert.equal(s.details, '1) 09:00 Bosforo (İtalyanca) 2 kişi · ⚠️ REHBER ATANMADI  |  2) 10:00 Topkapı (İspanyolca) 5 kişi · Rehber: Ayşe  |  ⚠️ 1 operasyonda rehber yok');
  assert.ok(!/\n/.test(s.details), 'no line breaks (Meta rejects them in parameters)');
});

test('enqueue guide brief: snapshot of phone + payload, idempotent per request; refuses without guide / phone', async () => {
  const db = fakeDb({
    reservations: [{ id: 'RA', reservation_number: 'R-1', check_in: '2026-11-20', check_in_time: '10:00:00', tour_id: 'T1', destination: 'Topkapı', tour_language: 'İspanyolca', guide_id: 'G1', pax_adult: 2, pax_child: 0, status: 'confirmed' },
      { id: 'RB', reservation_number: 'R-2', check_in: '2026-11-20', tour_id: 'T1', guide_id: null, pax_adult: 1, status: 'confirmed' }],
    guides: [{ id: 'G1', full_name: 'Ayşe Yılmaz', phone: '0532 111 22 33' }], tours: [{ id: 'T1', name: 'Topkapı Sarayı' }],
  });
  const r = await enqueueGuideBrief({ db, reservationId: 'RA', note: 'Şemsiye alın', requestId: 'q1' });
  assert.equal(r.ok, true); assert.equal(r.ids.length, 1);
  const m = db.tables.whatsapp_messages[0];
  assert.equal(m.recipient_phone, '905321112233'); assert.equal(m.audience_type, 'guide'); assert.equal(m.template_key, 'guide_tour_brief');
  assert.equal(m.payload.tourName, 'Topkapı Sarayı'); assert.equal(m.payload.note, 'Şemsiye alın');
  assert.equal((await enqueueGuideBrief({ db, reservationId: 'RA', requestId: 'q1' })).ids.length, 0, 'same request → no duplicate');
  assert.equal((await enqueueGuideBrief({ db, reservationId: 'RB', requestId: 'q2' })).status, 409);
  db.tables.guides[0].phone = '';
  assert.equal((await enqueueGuideBrief({ db, reservationId: 'RA', requestId: 'q3' })).status, 422);
});

test('operations notice fans out to active recipients only; none configured → clear error', async () => {
  const db = fakeDb({ whatsapp_destinations: [{ id: 'D', destination_key: 'operations', is_active: true }],
    whatsapp_destination_recipients: [{ destination_id: 'D', phone: '05321112233', display_name: 'Berk', is_active: true }, { destination_id: 'D', phone: '05329998877', display_name: 'X', is_active: false }] });
  const r = await enqueueOperationsNotice({ db, eventType: 'operations_notice', title: 'T', details: 'D', key: 'k' });
  assert.equal(r.recipients, 1); assert.equal(db.tables.whatsapp_messages.length, 1);
  const empty = fakeDb({ whatsapp_destinations: [{ id: 'D', destination_key: 'operations', is_active: true }] });
  assert.equal((await enqueueOperationsNotice({ db: empty, eventType: 'x', title: 'T', details: 'D', key: 'k' })).status, 409);
});

test('worker: sends the approved template; retries transient errors with backoff; fails permanent ones; idle without Meta', async () => {
  const mk = (id, phone) => ({ id, status: 'queued', attempt_count: 0, recipient_phone: phone, template_key: 'operations_notice', payload: { title: 'T', details: 'D' } });
  const db = fakeDb({ whatsapp_messages: [mk('m1', '905321112233'), mk('m2', '905321112234'), mk('m3', '')] }, claimAll);
  let n = 0; const calls = [];
  const fetchImpl = async (url, init) => { n += 1; calls.push(JSON.parse(init.body));
    return n === 1 ? { ok: true, status: 200, json: async () => ({ messages: [{ id: 'wamid.A' }] }) } : { ok: false, status: 503, json: async () => ({ error: { code: 2, message: 'busy' } }) }; };
  const out = await runWorker({ db, config: CFG, fetchImpl, now: () => new Date('2026-11-16T10:00:00Z') });
  assert.deepEqual([out.sent, out.retried, out.failed], [1, 1, 1]);
  const [a, b, c] = db.tables.whatsapp_messages;
  assert.equal(a.status, 'sent'); assert.equal(a.provider_message_id, 'wamid.A');
  assert.equal(b.status, 'queued'); assert.equal(b.next_attempt_at, '2026-11-16T10:02:00.000Z');
  assert.equal(c.status, 'failed'); assert.match(c.last_error, /telefon/);
  assert.equal(calls[0].template.name, 'desetour_operasyon_bildirimi');
  assert.deepEqual(calls[0].template.components[0].parameters.map(p => p.text), ['T', 'D']);
  assert.equal((await runWorker({ db, config: { ...CFG, sendingConfigured: false } })).configured, false);
});

test('webhook: handshake, signature, status progression never goes backwards, inbound stored', async () => {
  assert.deepEqual(verifyHandshake({ 'hub.mode': 'subscribe', 'hub.verify_token': 'vt', 'hub.challenge': '42' }, CFG), { ok: true, challenge: '42' });
  assert.equal(verifyHandshake({ 'hub.mode': 'subscribe', 'hub.verify_token': 'no' }, CFG).ok, false);
  const raw = Buffer.from('{"a":1}');
  const sig = 'sha256=' + crypto.createHmac('sha256', 'shh').update(raw).digest('hex');
  assert.equal(verifySignature(raw, sig, 'shh'), true);
  assert.equal(verifySignature(raw, sig, 'other'), false);
  assert.equal(verifySignature(raw, undefined, 'shh'), false);
  const db = fakeDb({ whatsapp_messages: [{ id: 'm1', provider_message_id: 'wamid.A', status: 'sent' }] });
  const v = (statuses, messages) => ({ entry: [{ changes: [{ value: { statuses, messages, contacts: [{ wa_id: '34600', profile: { name: 'Ana' } }] } }] }] });
  await processWebhook(v([{ id: 'wamid.A', status: 'read', timestamp: '1700000000' }]), db);
  await processWebhook(v([{ id: 'wamid.A', status: 'delivered', timestamp: '1700000001' }]), db);
  assert.equal(db.tables.whatsapp_messages[0].status, 'read');
  await processWebhook(v([], [{ id: 'wamid.IN', from: '34600', type: 'text', text: { body: 'Gracias!' }, context: { id: 'wamid.A' }, timestamp: '1700000002' }]), db);
  const inb = db.tables.whatsapp_inbound_messages[0];
  assert.equal(inb.text, 'Gracias!'); assert.equal(inb.profile_name, 'Ana'); assert.equal(inb.related_message_id, 'm1');
});

test('endpoint: scheduler secret, staff role and Meta signature are all enforced', async () => {
  const res = () => { const r = { code: 0, body: null, status(c) { r.code = c; return r; }, json(b) { r.body = b; return r; }, send(b) { r.body = b; return r; } }; return r; };
  const db = fakeDb({}, claimAll);
  const h = createHandler({ getConfig: () => CFG, getDb: () => db, requireStaffRole: async (req) => req.headers.authorization === 'Bearer staff' ? { ok: true } : { ok: false, status: 403, error: 'no' } });
  let r = res(); await h({ method: 'POST', query: { action: 'worker' }, headers: {} }, r); assert.equal(r.code, 401);
  r = res(); await h({ method: 'POST', query: { action: 'worker' }, headers: { authorization: 'Bearer sch' } }, r); assert.equal(r.code, 200);
  r = res(); await h({ method: 'GET', query: { action: 'status' }, headers: {} }, r); assert.equal(r.code, 403);
  r = res(); await h({ method: 'GET', query: { action: 'status' }, headers: { authorization: 'Bearer staff' } }, r); assert.deepEqual(r.body, { sendingConfigured: true, webhookConfigured: true });
  r = res(); await h({ method: 'POST', query: {}, headers: { 'x-hub-signature-256': 'sha256=bad' }, rawBody: '{}' }, r); assert.equal(r.code, 401);
  r = res(); await h({ method: 'GET', query: { 'hub.mode': 'subscribe', 'hub.verify_token': 'vt', 'hub.challenge': 'c1' }, headers: {} }, r); assert.equal(r.body, 'c1');
});

test('migration: claim function is service_role only and uses SKIP LOCKED; inbound table read-only for staff; workflow + vercel config', () => {
  const ROOT = path.join(__dirname, '..', '..');
  const MIG = fs.readFileSync(path.join(ROOT, 'supabase_migration_whatsapp_phase2_sending.sql'), 'utf8');
  assert.match(MIG, /FOR UPDATE SKIP LOCKED/);
  assert.match(MIG, /GRANT EXECUTE ON FUNCTION public\.whatsapp_claim_due_messages\(INTEGER, UUID\[\]\) TO service_role;/);
  assert.match(MIG, /REVOKE ALL ON FUNCTION public\.whatsapp_claim_due_messages\(INTEGER, UUID\[\]\) FROM authenticated;/);
  assert.equal((MIG.match(/ON public\.whatsapp_inbound_messages FOR SELECT/g) || []).length, 2);
  assert.doesNotMatch(MIG, /whatsapp_inbound_messages FOR (INSERT|UPDATE|DELETE|ALL)/);
  const wf = fs.readFileSync(path.join(ROOT, '.github/workflows/whatsapp-scheduled.yml'), 'utf8');
  assert.match(wf, /cron: '5 15 \* \* \*'/); assert.match(wf, /secrets\.WHATSAPP_SCHEDULER_SECRET/);
  assert.ok(JSON.parse(fs.readFileSync(path.join(ROOT, 'vercel.json'), 'utf8')).functions['api/whatsapp.js']);
  const src = fs.readFileSync(path.join(ROOT, 'DeseTourDashboard.jsx'), 'utf8');
  assert.doesNotMatch(src, /WHATSAPP_ACCESS_TOKEN|graph\.facebook\.com/, 'no Meta credential or direct Meta call in the browser bundle');
});
