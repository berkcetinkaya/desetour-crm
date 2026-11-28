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
const { buildGuideBrief, buildDailySummary, enqueueGuideBrief, enqueueOperationsNotice, enqueueGuideAssignments, enqueueGuideAssignmentMessage, notifyGuideAssignments, enqueueGuideReminders } = require('../../api/_whatsapp/enqueue');
const { createHandler } = require('../../api/whatsapp');
const { enqueueSurvey, enqueueReviewRequest, feedbackReminder, reviewUrlFor, parseScore, isPositive } = require('../../api/_whatsapp/survey');
const { toTurkish, toCustomer } = require('../../api/_whatsapp/translate');
const { classifyEvent, buildEventNotice, enqueueEventNotices, sendTestNotices } = require('../../api/_whatsapp/events');
const { sendReply } = require('../../api/_whatsapp/inbox');
const { extractTestableFn } = require('../dashboard/extractTestableFn');

// ── minimal in-memory stand-in for the supabase-js query builder
function fakeDb(tables, rpcImpl) {
  const t = (n) => (tables[n] = tables[n] || []);
  return {
    tables,
    rpc: async (name, args) => rpcImpl(name, args, tables),
    from(name) {
      const st = { filters: [], op: 'select', patch: null, rows: null, opts: null };
      const match = (r) => st.filters.every(([k, v, op]) => op === 'gte' ? String(r[k]) >= String(v) : r[k] === v);
      const api = {
        select() { return api; }, order() { return api; }, limit() { return api; }, gte(k, v) { st.filters.push([k, v, 'gte']); return api; },
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
  for (const k of Object.keys(TEMPLATES).filter(k => !TEMPLATES[k].languages)) {
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
  assert.equal(p.guideName, 'Ayşe Yılmaz', 'full name, not the first name alone');
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
  assert.equal(s.details, '1) 09:00 Bosforo (İtalyanca) · 2 kişi, 1 rezervasyon · ⚠️ REHBER ATANMADI  |  2) 10:00 Topkapı (İspanyolca) · 5 kişi, 2 rezervasyon · Rehber: Ayşe  |  ⚠️ 1 operasyonda rehber yok');
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
  const h = createHandler({ getConfig: () => CFG, getDb: () => db, getTelegramConfig: () => ({ token: '', configured: false }), requireStaffRole: async (req) => req.headers.authorization === 'Bearer staff' ? { ok: true } : { ok: false, status: 403, error: 'no' } });
  let r = res(); await h({ method: 'POST', query: { action: 'worker' }, headers: {} }, r); assert.equal(r.code, 401);
  r = res(); await h({ method: 'POST', query: { action: 'worker' }, headers: { authorization: 'Bearer sch' } }, r); assert.equal(r.code, 200);
  r = res(); await h({ method: 'GET', query: { action: 'status' }, headers: {} }, r); assert.equal(r.code, 403);
  r = res(); await h({ method: 'GET', query: { action: 'status' }, headers: { authorization: 'Bearer staff' } }, r); assert.deepEqual(r.body, { sendingConfigured: true, webhookConfigured: true, telegram: { botConfigured: false, group: null } });
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
  assert.match(wf, /cron: '0 15 \* \* \*'/); assert.match(wf, /secrets\.WHATSAPP_SCHEDULER_SECRET/);
  assert.ok(JSON.parse(fs.readFileSync(path.join(ROOT, 'vercel.json'), 'utf8')).functions['api/whatsapp.js']);
  const src = fs.readFileSync(path.join(ROOT, 'DeseTourDashboard.jsx'), 'utf8');
  assert.doesNotMatch(src, /WHATSAPP_ACCESS_TOKEN|graph\.facebook\.com/, 'no Meta credential or direct Meta call in the browser bundle');
});

test('feedback request: one per reservation, booking language, needs a phone; never for a cancelled booking', async () => {
  const db = fakeDb({
    reservations: [
      { id: 'R1', reservation_number: 'R-1', check_in: '2026-11-16', tour_id: 'T1', tour_language: 'Portekizce', status: 'completed', customer_id: 'C1' },
      { id: 'R2', reservation_number: 'R-2', check_in: '2026-11-16', tour_id: 'T1', tour_language: 'İspanyolca', status: 'confirmed', customer_id: 'C2' },
      { id: 'R3', reservation_number: 'R-3', check_in: '2026-11-16', tour_id: 'T1', status: 'cancelled', customer_id: 'C1' },
    ],
    customers: [{ id: 'C1', full_name: 'MARIA silva', phone: '+55 11 91234-5678' }, { id: 'C2', full_name: 'Juan', phone: null }],
    tours: [{ id: 'T1', name: 'Bosforo' }],
  });
  const r = await enqueueSurvey({ db, reservationId: 'R1' });
  assert.equal(r.ok, true);
  assert.equal(r.preview, 'Olá Maria! Obrigado por participar do nosso passeio Bosforo. Como foi o passeio? Dê uma nota de 1 (muito ruim) a 5 (excelente).');
  const m = db.tables.whatsapp_messages[0];
  assert.deepEqual([m.language, m.recipient_phone, m.audience_type], ['pt_BR', '5511912345678', 'customer']);
  assert.equal((await enqueueSurvey({ db, reservationId: 'R1' })).status, 409, 'never twice');
  assert.equal((await enqueueSurvey({ db, reservationId: 'R2' })).status, 422);
  assert.equal((await enqueueSurvey({ db, reservationId: 'R3' })).status, 409);
});

test('feedback flow: tour 1–5 → guide 1–5 → free comment → thanks; team is told; no review link is sent automatically', async () => {
  assert.deepEqual(['5', ' 4 ', 'un 3', '4/5', '6', 'hola', '2 personas más mañana por favor'].map(t => parseScore({ text: t })), [5, 4, 3, 4, null, null, null]);
  assert.equal(parseScore({ button_payload: 'svy:2', text: '2' }), 2);
  assert.deepEqual([isPositive({ tour_score: 5, guide_score: 4 }), isPositive({ tour_score: 5, guide_score: 3 }), isPositive({ tour_score: 3, guide_score: 5 }), isPositive(null)], [true, false, false, false]);
  const recent = new Date().toISOString();
  const db = fakeDb({
    whatsapp_messages: [{ id: 'S1', event_type: 'post_tour_survey', provider_message_id: 'wamid.S1', reservation_id: 'R1', customer_id: 'C1', language: 'es', recipient_phone: '34600', status: 'read', created_at: recent, sent_at: recent }],
    reservations: [{ id: 'R1', reservation_number: 'R-1', destination: 'Bosforo', tour_id: 'T1', tour_language: 'İspanyolca', source_id: 'CIV', status: 'completed' }],
    tour_channels: [{ tour_id: 'T1', source_id: 'CIV', booking_language: 'İspanyolca', review_url: 'https://example.com/review', is_active: true }],
  });
  const sent = [], notices = [];
  const fetchImpl = async (url, init) => { sent.push(JSON.parse(init.body)); return { ok: true, status: 200, json: async () => ({ messages: [{ id: 'wamid.R' + sent.length }] }) }; };
  const notify = async (a) => { notices.push(a); return { ok: true, ids: [] }; };
  const ev = (msg) => ({ entry: [{ changes: [{ value: { contacts: [{ wa_id: '34600', profile: { name: 'X' } }], messages: [{ from: '34600', ...msg }] } }] }] });
  const hook = (msg) => processWebhook(ev(msg), db, { config: CFG, fetchImpl, notify });
  await hook({ id: 'in0', type: 'text', text: { body: 'Hola, ¿a qué hora es el tour?' } });
  assert.equal(sent.length, 0, 'an ordinary message is not taken for an answer');
  await hook({ id: 'in1', type: 'button', button: { text: '5', payload: 'svy:5' }, context: { id: 'wamid.S1' } });
  const fb = () => db.tables.reservation_feedback[0];
  assert.deepEqual([fb().tour_score, fb().rating, fb().guide_score], [5, 'great', undefined]);
  assert.match(sent[0].text.body, /¿Y tu guía\?/);
  await hook({ id: 'in2', type: 'text', text: { body: '4' } });
  assert.equal(fb().guide_score, 4);
  assert.match(sent[1].text.body, /dejarnos algún comentario/);
  await hook({ id: 'in3', type: 'text', text: { body: 'Todo perfecto, el guía muy amable' } });
  assert.equal(fb().comment, 'Todo perfecto, el guía muy amable');
  assert.match(sent[2].text.body, /Muchas gracias por tu tiempo/);
  assert.equal(notices.length, 1);
  assert.match(notices[0].details, /Tur: 5\/5 · Rehber: 4\/5/); assert.match(notices[0].details, /Olumlu/);
  assert.doesNotMatch(JSON.stringify(sent), /example\.com\/review/, 'the review link is only sent by the team, the next day');
  // the same inbound delivered twice, and later messages, change nothing
  await hook({ id: 'in3', type: 'text', text: { body: 'Todo perfecto, el guía muy amable' } });
  await hook({ id: 'in4', type: 'text', text: { body: '1' } });
  assert.equal(sent.length, 3); assert.deepEqual([fb().tour_score, fb().guide_score], [5, 4]);

  const rem = await feedbackReminder({ db: fakeDb({
    reservations: [
      { id: 'A', reservation_number: 'R-10', external_booking_id: '42748941', destination: 'Bosforo', tour_language: 'İtalyanca', check_in: '2026-11-17', check_in_time: '11:00:00', pax_adult: 2, pax_child: 1, status: 'confirmed', customer_id: 'C1' },
      { id: 'B', reservation_number: 'R-11', destination: 'Topkapı', check_in: '2026-11-17', pax_adult: 2, status: 'confirmed', customer_id: 'C2' },
      { id: 'C', reservation_number: 'R-12', check_in: '2026-11-17', status: 'cancelled', customer_id: 'C1' },
      { id: 'D', reservation_number: 'R-09', external_booking_id: '42700001', destination: 'Topkapı', tour_language: 'İspanyolca', check_in: '2026-11-16', pax_adult: 4, status: 'completed', customer_id: 'C1' }],
    customers: [{ id: 'C1', full_name: 'Maria Silva', phone: '+34 600 111 222' }, { id: 'C2', full_name: 'Juan Perez', phone: null }],
    reservation_feedback: [{ reservation_id: 'D', tour_score: 5, guide_score: 5, answered_at: '2026-11-16T18:00:00Z' }],
  }), todayISO: '2026-11-17' });
  assert.deepEqual([rem.ask, rem.noPhone, rem.review], [1, 1, 1]);
  assert.deepEqual(rem.details.split(' | '), [
    '✅ Bugün turu biten, geri bildirim istenebilecek (1):',
    '• R-10 · A42748941 · Maria Silva · Bosforo (İtalyanca) · 11:00 · 3 kişi', '   🔗 https://crm.desetour.com/#/reservations/A',
    '📵 Telefonu kayıtlı değil — önce telefon ekleyin (1):',
    '• R-11 · Juan Perez · Topkapı · 2 kişi', '   🔗 https://crm.desetour.com/#/reservations/B',
    '⭐ Olumlu yanıt verdi, yorum/puan istenebilir (1):',
    '• R-09 · A42700001 · Maria Silva · Topkapı (İspanyolca) · 4 kişi · tur 5/5, rehber 5/5', '   🔗 https://crm.desetour.com/#/reservations/D']);
});

test('worker sends the feedback request in the booking language with one payload per button (5…1)', async () => {
  const db = fakeDb({ whatsapp_messages: [{ id: 'q', status: 'queued', attempt_count: 0, recipient_phone: '34600111222', template_key: 'post_tour_survey', language: 'it', payload: { customerName: 'Gio', tourName: 'Topkapı' } }] }, claimAll);
  const calls = []; await runWorker({ db, config: CFG, fetchImpl: metaOk(calls) });
  const t = calls[0].body.template;
  assert.equal(t.name, 'desetour_tur_geri_bildirim'); assert.equal(t.language.code, 'it');
  assert.deepEqual(t.components.slice(1).map(c => c.parameters[0].payload), ['svy:5', 'svy:4', 'svy:3', 'svy:2', 'svy:1']);
  const prev = extractTestableFn('_whatsappSurveyPreview');
  for (const [name, code] of [['İtalyanca', 'it'], ['İspanyolca', 'es'], ['Portekizce', 'pt_BR'], ['İngilizce', 'en'], ['Türkçe', 'tr']])
    assert.equal(prev(name, ['Gio', 'Topkapı']), renderPreview('post_tour_survey', { customerName: 'Gio', tourName: 'Topkapı' }, code));
});

test('guides: assignment message once per operation, reminder the evening before; no phone → counted, not sent', async () => {
  const now = () => new Date('2026-11-17T09:30:00Z');
  const db = fakeDb({
    reservations: [
      { id: 'R1', reservation_number: 'R-1', check_in: '2026-11-18', check_in_time: '10:00:00', tour_id: 'T1', destination: 'Topkapı', tour_language: 'İspanyolca', guide_id: 'G1', pax_adult: 2, status: 'confirmed', updated_at: '2026-11-17T08:50:00Z' },
      { id: 'R2', reservation_number: 'R-2', check_in: '2026-11-18', check_in_time: '10:00:00', tour_id: 'T1', destination: 'Topkapı', tour_language: 'İspanyolca', guide_id: 'G1', pax_adult: 3, status: 'confirmed', updated_at: '2026-11-17T08:55:00Z' },
      { id: 'R3', reservation_number: 'R-3', check_in: '2026-11-18', tour_id: 'T2', guide_id: 'G2', pax_adult: 1, status: 'confirmed', updated_at: '2026-11-17T08:55:00Z' },
      { id: 'R4', reservation_number: 'R-4', check_in: '2026-11-18', tour_id: 'T1', guide_id: null, pax_adult: 1, status: 'confirmed', updated_at: '2026-11-17T08:55:00Z' },
      { id: 'R5', reservation_number: 'R-5', check_in: '2026-11-10', tour_id: 'T1', guide_id: 'G1', pax_adult: 1, status: 'completed', updated_at: '2026-11-17T08:55:00Z' },
      { id: 'R6', reservation_number: 'R-6', check_in: '2026-11-19', tour_id: 'T1', guide_id: 'G1', pax_adult: 1, status: 'confirmed', updated_at: '2026-11-01T08:55:00Z' },
    ],
    guides: [{ id: 'G1', full_name: 'Ayşe Yılmaz', phone: '0532 123 45 67' }, { id: 'G2', full_name: 'Mehmet', phone: '' }],
    tours: [{ id: 'T1', name: 'Topkapı Sarayı' }],
  });
  const a = await enqueueGuideAssignments({ db, todayISO: '2026-11-17', now });
  assert.deepEqual([a.operations, a.queued, a.missingPhone], [2, 1, 1], 'one message for the two bookings of the same operation; past and old ones ignored');
  const m = db.tables.whatsapp_messages[0];
  assert.deepEqual([m.event_type, m.template_key, m.recipient_phone, m.payload.guests], ['guide_assigned', 'guide_tour_brief', '905321234567', '5 kişi (2 rezervasyon: R-1, R-2)']);
  assert.equal((await enqueueGuideAssignments({ db, todayISO: '2026-11-17', now })).queued, 0, 'never twice for the same operation');
  const told = []; const notify = async (a) => { const dup = told.some(x => x.key === a.key); if (!dup) told.push(a); return { ok: true, ids: [], channel: 'telegram', duplicate: dup }; };
  const t1 = await notifyGuideAssignments({ db, notify, todayISO: '2026-11-17', now });
  assert.deepEqual([t1.operations, t1.announced], [2, 2], 'the team hears about both operations, with or without a guide phone');
  assert.equal(told[0].title, 'Rehber atandı: Ayşe Yılmaz');
  assert.match(told[0].details, /🧭 Tur: Topkapı Sarayı \(İspanyolca\) \| 📅 Tarih: 18 Kasım 2026 Çarşamba 10:00 \| 📍 Buluşma: Operasyondan iletilecek \| 👥 Misafir: 5 kişi \(2 rezervasyon: R-1, R-2\) \| ⏳ Rehbere WhatsApp bilgisi sırada/);
  assert.match(told[1].details, /Rehberin telefonu kayıtlı değil/);
  assert.equal((await notifyGuideAssignments({ db, notify, todayISO: '2026-11-17', now })).announced, 0, 'once per operation');
  db.tables.whatsapp_messages[0].status = 'delivered'; told.length = 0;
  await notifyGuideAssignments({ db, notify, todayISO: '2026-11-17', now });
  assert.match(told[0].details, /📲 Rehbere WhatsApp ile tur bilgisi gönderildi/, 'once Meta approves and the message goes out, the notice says so');
  const r = await enqueueGuideReminders({ db, todayISO: '2026-11-17' });
  assert.deepEqual([r.date, r.queued, r.missingPhone], ['2026-11-18', 1, 1]);
  const rm = db.tables.whatsapp_messages[1];
  assert.deepEqual([rm.event_type, rm.template_key], ['guide_reminder', 'guide_reminder']);
  assert.match(renderPreview('guide_reminder', rm.payload), /^Merhaba Ayşe Yılmaz, hatırlatma: yarın \(18 Kasım 2026 Çarşamba\) Topkapı Sarayı turunuz var\./);
  assert.equal((await enqueueGuideReminders({ db, todayISO: '2026-11-17' })).queued, 0);
});

test('translation: customer messages → Turkish with the detected language; Turkish reply → customer language; needs the server key', async () => {
  const calls = [];
  const f = (reply) => async (url, init) => { calls.push({ url, headers: init.headers, body: JSON.parse(init.body) }); return { ok: true, status: 200, json: async () => ({ content: [{ type: 'text', text: JSON.stringify(reply) }] }) }; };
  const a = await toTurkish({ apiKey: 'k', items: [{ id: 'in-1', text: 'Hola, ¿dónde nos encontramos?' }, { id: 'x', text: '   ' }], fetchImpl: f({ language: 'es', translations: { 'in-1': 'Merhaba, nerede buluşuyoruz?', other: 'ignored' } }) });
  assert.deepEqual(a, { ok: true, translations: { 'in-1': 'Merhaba, nerede buluşuyoruz?' }, language: 'es' });
  assert.equal(calls[0].url, 'https://api.anthropic.com/v1/messages'); assert.equal(calls[0].headers['x-api-key'], 'k');
  assert.equal(JSON.parse(calls[0].body.messages[0].content).length, 1, 'empty texts are not sent');
  const b = await toCustomer({ apiKey: 'k', text: 'Sultanahmet meydanında buluşuyoruz.', language: 'es', fetchImpl: f({ language: 'es', text: 'Nos encontramos en la plaza de Sultanahmet.' }) });
  assert.deepEqual(b, { ok: true, text: 'Nos encontramos en la plaza de Sultanahmet.', language: 'es' });
  assert.match(calls[1].body.system, /Spanish/);
  assert.equal((await toCustomer({ apiKey: 'k', text: ' ', fetchImpl: f({}) })).status, 400);
  assert.equal((await toTurkish({ apiKey: 'k', items: [{ id: 'a', text: 'hi' }], fetchImpl: async () => ({ ok: false, status: 529, json: async () => ({ error: { message: 'overloaded' } }) }) })).ok, false);
  const res = () => { const r = { code: 0, body: null, status(c) { r.code = c; return r; }, json(b) { r.body = b; return r; } }; return r; };
  const h = createHandler({ getConfig: () => CFG, getDb: () => fakeDb({}), getTelegramConfig: () => ({ configured: false }), getEnv: () => ({}), requireStaffRole: async () => ({ ok: true }) });
  const r = res(); await h({ method: 'POST', query: { action: 'enqueue' }, headers: {}, rawBody: JSON.stringify({ kind: 'translate', items: [], requestId: 't1' }) }, r);
  assert.equal(r.code, 409);
  const need = extractTestableFn('_waTranslatable');
  const th = { audience: 'customer', messages: [{ id: 'a', text: 'Hola amigo' }, { id: 'b', text: '(medya)' }, { id: 'c', text: '5' }, { id: 'd', text: 'Gracias' }] };
  assert.deepEqual(need(th, (id) => id === 'd'), [{ id: 'a', text: 'Hola amigo' }]);
  assert.deepEqual(need({ ...th, audience: 'guide' }, () => false), [], 'guide threads are already Turkish');
});

test('tour page: the Civitatis page of the booking language (listing URL) is shown and sent with the survey; a review link wins for the survey', async () => {
  const tp = extractTestableFn('_reservationTourPage');
  const ch = [
    { sourceName: 'Civitatis', bookingLanguage: 'İspanyolca', listingUrl: 'https://www.civitatis.com/es/estambul/tour-gran-bazar', isActive: true },
    { sourceName: 'Civitatis', bookingLanguage: '', listingUrl: 'https://www.civitatis.com/it/istanbul/tour-grande-bazar', isActive: true },
  ];
  assert.deepEqual(tp(ch, 'İspanyolca'), { pageUrl: 'https://www.civitatis.com/es/estambul/tour-gran-bazar', channel: 'Civitatis', surveyUrl: 'https://www.civitatis.com/es/estambul/tour-gran-bazar' });
  assert.equal(tp(ch, 'İtalyanca').pageUrl, 'https://www.civitatis.com/it/istanbul/tour-grande-bazar', 'generic channel as fallback');
  assert.equal(tp([{ ...ch[0], reviewUrl: 'https://g.page/r/x' }], 'İspanyolca').surveyUrl, 'https://g.page/r/x');
  assert.equal(tp([], 'İspanyolca').pageUrl, null);
  const db = fakeDb({ tour_channels: [
    { tour_id: 'T1', source_id: 'CIV', booking_language: 'Portekizce', listing_url: 'https://www.civitatis.com/pt/istambul/visita-guiada-istambul', is_active: true },
    { tour_id: 'T1', source_id: 'CIV', booking_language: 'İtalyanca', listing_url: 'https://it', review_url: null, is_active: true }] });
  assert.equal(await reviewUrlFor(db, { tour_id: 'T1', source_id: 'CIV', tour_language: 'Portekizce' }), 'https://www.civitatis.com/pt/istambul/visita-guiada-istambul');
});

test('data SQL: fills only empty listing URLs, each guarded by its channel id + tour + language, with the desetour.com links', () => {
  const sql = fs.readFileSync(path.join(__dirname, '..', '..', 'tour_channels_civitatis_urls_from_website.sql'), 'utf8');
  assert.match(sql, /AND \(c\.listing_url IS NULL OR btrim\(c\.listing_url\) = ''\)/);
  assert.match(sql, /WHERE c\.id = v\.id AND c\.tour_id = v\.tour_id AND c\.booking_language = v\.lang/);
  for (const u of ['it/istanbul/tour-grande-bazar', 'it/istanbul/crociera-bosforo-sultanahmet', 'pt/istambul/cruzeiro-bosforo-sultanahmet', 'pt/istambul/visita-guiada-istambul', 'es/estambul/visita-palacio-topkapi-haren-santa-irene-231294']) assert.ok(sql.includes(u), u);
});

test('Graph-compatible provider (coexistence): base URL override for sending; webhook accepted by URL key when the signature is not ours', async () => {
  const cfg = getWhatsAppConfig({ WHATSAPP_ACCESS_TOKEN: 'dh_live_x', WHATSAPP_PHONE_NUMBER_ID: '42', WHATSAPP_API_BASE_URL: 'https://api.example-provider.com/v25.0/', WHATSAPP_WEBHOOK_KEY: 'k-123', WHATSAPP_VERIFY_TOKEN: 'vt' });
  assert.equal(cfg.apiBaseUrl, 'https://api.example-provider.com/v25.0');
  const db = fakeDb({ whatsapp_messages: [{ id: 'q', status: 'queued', attempt_count: 0, recipient_phone: '905321112233', template_key: 'operations_notice', payload: { title: 'T', details: 'D' } }] }, claimAll);
  const calls = []; await runWorker({ db, config: cfg, fetchImpl: metaOk(calls) });
  assert.equal(calls[0].url, 'https://api.example-provider.com/v25.0/42/messages');
  assert.equal(calls[0].auth, 'Bearer dh_live_x');
  const meta = []; await runWorker({ db: fakeDb({ whatsapp_messages: [{ id: 'q', status: 'queued', attempt_count: 0, recipient_phone: '905321112233', template_key: 'operations_notice', payload: {} }] }, claimAll), config: CFG, fetchImpl: metaOk(meta) });
  assert.equal(meta[0].url, 'https://graph.facebook.com/v21.0/123/messages', 'default stays Meta direct');
  const { verifyUrlKey } = require('../../api/_whatsapp/webhook');
  assert.equal(verifyUrlKey('k-123', 'k-123'), true);
  assert.equal(verifyUrlKey('k-124', 'k-123'), false);
  assert.equal(verifyUrlKey('k-123', ''), false, 'no key configured → never accepted');
  assert.equal(verifyUrlKey(undefined, 'k-123'), false);
  const res = () => { const r = { code: 0, body: null, status(c) { r.code = c; return r; }, json(b) { r.body = b; return r; }, send(b) { r.body = b; return r; } }; return r; };
  const h = createHandler({ getConfig: () => cfg, getDb: () => fakeDb({}) });
  let r = res(); await h({ method: 'POST', query: { key: 'wrong' }, headers: {}, rawBody: '{"entry":[]}' }, r); assert.equal(r.code, 401);
  r = res(); await h({ method: 'POST', query: { key: 'k-123' }, headers: { 'x-hub-signature-256': 'sha256=provider-signed' }, rawBody: '{"entry":[]}' }, r); assert.equal(r.code, 200);
});

test('review request: tour page link straight to the customer, once per reservation, booking language; needs phone and a link', async () => {
  const mk = () => fakeDb({
    reservations: [{ id: 'R1', reservation_number: 'R-1', check_in: '2026-11-16', tour_id: 'T1', tour_language: 'İspanyolca', status: 'completed', customer_id: 'C1', source_id: 'CIV' }],
    customers: [{ id: 'C1', full_name: 'ana lopez', phone: '+34 612 345 678' }], tours: [{ id: 'T1', name: 'Gran Bazar' }],
    tour_channels: [{ tour_id: 'T1', source_id: 'CIV', booking_language: 'İspanyolca', listing_url: 'https://www.civitatis.com/es/estambul/tour-gran-bazar', is_active: true }],
  });
  const db = mk();
  const r = await enqueueReviewRequest({ db, reservationId: 'R1' });
  assert.equal(r.ok, true);
  assert.match(r.preview, /^¡Hola Ana! Gracias por elegir DeseTour para el tour Gran Bazar\. Tu opinión es muy importante para nosotros/);
  assert.match(r.preview, /https:\/\/www\.civitatis\.com\/es\/estambul\/tour-gran-bazar ¡Muchas gracias!$/);
  const m = db.tables.whatsapp_messages[0];
  assert.deepEqual([m.event_type, m.template_key, m.language, m.recipient_phone], ['review_request', 'review_request', 'es', '34612345678']);
  assert.equal((await enqueueReviewRequest({ db, reservationId: 'R1' })).status, 409);
  const noLink = mk(); noLink.tables.tour_channels = [];
  assert.equal((await enqueueReviewRequest({ db: noLink, reservationId: 'R1' })).status, 422);
  const prev = extractTestableFn('_whatsappReviewPreview');
  for (const lang of Object.keys(TEMPLATES.review_request.languages)) {
    assert.equal(prev(lang, ['Ana', 'Gran Bazar', 'https://x']), renderPreview('review_request', { customerName: 'Ana', tourName: 'Gran Bazar', reviewUrl: 'https://x' }, lang), lang);
  }
  for (const t of Object.values(TEMPLATES)) for (const l of Object.values(t.languages || { x: { body: t.body } })) {
    assert.doesNotMatch(l.body, /\{\{\d+\}\}\s*$/, 'Meta rejects a body ending with a variable');
    for (const b of l.buttons || []) assert.match(b, /^[\p{L} ]+$/u, 'no emoji in buttons');
  }
});

test('CRM events → operations list: new booking, cancellation, change, client message; each announced once', async () => {
  const log = (id, action, metadata) => ({ id, entity_type: 'reservation', entity_id: 'R1', action, metadata: { auto_ingested: true, ...metadata }, created_at: '2026-11-17T09:00:00Z' });
  assert.equal(classifyEvent(log('a', 'created', {})), 'created');
  assert.equal(classifyEvent(log('a', 'cancelled', {})), 'cancelled');
  assert.equal(classifyEvent(log('a', 'updated', { alert_type: 'civitatis_modified' })), 'modified');
  assert.equal(classifyEvent(log('a', 'note_added', { source: 'civitatis_message' })), 'message');
  assert.equal(classifyEvent(log('a', 'note_added', { alert_type: 'civitatis_missing_passenger_names' })), null);
  assert.equal(classifyEvent({ ...log('a', 'created', {}), metadata: {} }), null, 'manual CRM activity is not announced');
  const r = { id: 'R1', reservation_number: 'R-2026-0060', destination: 'Topkapı', tour_id: 'T1', check_in: '2026-11-20', check_in_time: '10:00:00', pax_adult: 2, pax_child: 1, tour_language: 'İspanyolca', guide_id: null, total_amount: 9900, currency: 'TL', status: 'confirmed' };
  const others = [{ pax_adult: 3, pax_child: 0 }, { pax_adult: 2, pax_child: 0 }];
  assert.deepEqual(buildEventNotice('created', log('a', 'created', {}), r, others), { title: 'Yeni rezervasyon R-2026-0060', details: [
    '🧭 Tur: Topkapı (İspanyolca)', '📅 Tarih: 20 Kasım 2026 Cuma 10:00', '👥 Kişi: 3 (2 yetişkin + 1 çocuk)', '💶 Tutar: 9.900 ₺', '🧑‍🏫 Rehber: atanmadı → Rehber Ata: https://crm.desetour.com/#/reservations/R1/rehber-ata',
    '📊 Aynı gün bu turda: 2 rezervasyon daha, 5 kişi → toplam 8 kişi', '🔗 https://crm.desetour.com/#/reservations/R1'].join(' | ') });
  assert.match(buildEventNotice('created', log('a', 'created', {}), r, []).details, /başka katılım yok \(ilk rezervasyon\)/);
  assert.match(buildEventNotice('created', log('a', 'created', {}), { ...r, external_booking_id: '42748941' }, []).details, /^🎫 Civitatis kodu: A42748941 \| 🧭 Tur/);
  assert.match(buildEventNotice('cancelled', log('a', 'cancelled', { external_booking_id: '42742046' }), r, []).details, /^🎫 Civitatis kodu: A42742046 \|/, 'falls back to the code in the log');
  const mod = buildEventNotice('modified', log('a', 'updated', { changes: [{ label: 'Tarih', from: '19.11.2026', to: '20.11.2026' }], guide_assigned: true }), r, []).details;
  assert.match(mod, /^✏️ Tarih: 19\.11\.2026 → 20\.11\.2026 \| 🧭 Tur: Topkapı/); assert.match(mod, /Rehbere haber verin/);
  const can = buildEventNotice('cancelled', log('a', 'cancelled', {}), { ...r, guide_id: 'G', guide_name: 'Ayşe' }, others);
  assert.match(can.title, /^İPTAL R-2026-0060$/); assert.match(can.details, /Rehber atanmıştı \(Ayşe\): rehbere haber verin/); assert.match(can.details, /kalan: 2 rezervasyon, 5 kişi/);
  assert.doesNotMatch(buildEventNotice('message', log('a', 'note_added', {}), r, others).details, /Tutar|Aynı gün/);
  const db = fakeDb({
    activity_logs: [log('L1', 'created', {}), log('L2', 'note_added', { alert_type: 'civitatis_missing_passenger_names' }), { ...log('L3', 'cancelled', {}), created_at: '2026-11-10T00:00:00Z' }],
    reservations: [{ ...r }, { id: 'R2', tour_id: 'T1', check_in: '2026-11-20', pax_adult: 4, status: 'confirmed' }, { id: 'R3', tour_id: 'T1', check_in: '2026-11-20', pax_adult: 9, status: 'cancelled' }],
    whatsapp_destinations: [{ id: 'D', destination_key: 'operations', is_active: true }],
    whatsapp_destination_recipients: [{ destination_id: 'D', phone: '05321112233', display_name: 'Berk', is_active: true }],
  });
  const now = () => new Date('2026-11-17T09:10:00Z');
  const a = await enqueueEventNotices({ db, now });
  assert.deepEqual([a.events, a.queued], [1, 1], 'only the recent, announceable event');
  assert.equal(db.tables.whatsapp_messages[0].event_type, 'crm_event_created');
  assert.match(db.tables.whatsapp_messages[0].payload.details, /1 rezervasyon daha, 4 kişi → toplam 7 kişi/, 'cancelled bookings of the day are not counted');
  assert.equal((await enqueueEventNotices({ db, now })).queued, 0, 'second run announces nothing again');
});

test('CRM WhatsApp window: reply only inside the 24-hour window; phone-app messages (echoes) are kept; threads per number', async () => {
  const now = () => new Date('2026-11-17T12:00:00Z');
  const db = fakeDb({ whatsapp_inbound_messages: [{ from_phone: '34600111222', received_at: '2026-11-17T10:00:00Z', profile_name: 'Ana' }, { from_phone: '34999000111', received_at: '2026-11-15T10:00:00Z' }] });
  const sent = []; const fetchImpl = async (u, i) => { sent.push(JSON.parse(i.body)); return { ok: true, status: 200, json: async () => ({ messages: [{ id: 'wamid.X' }] }) }; };
  assert.equal((await sendReply({ db, config: CFG, phone: '+34 600 111 222', text: ' Hola ', requestId: 'a', fetchImpl, now })).ok, true);
  assert.deepEqual([sent[0].type, sent[0].to, sent[0].text.body], ['text', '34600111222', 'Hola']);
  assert.equal(db.tables.whatsapp_messages[0].event_type, 'crm_reply');
  assert.equal((await sendReply({ db, config: CFG, phone: '34999000111', text: 'x', requestId: 'b', fetchImpl, now })).status, 409, 'older than 24 h');
  assert.equal((await sendReply({ db, config: CFG, phone: '34000', text: 'x', requestId: 'c', fetchImpl, now })).status, 422);
  assert.equal(sent.length, 1);
  await processWebhook({ entry: [{ changes: [{ field: 'smb_message_echoes', value: { message_echoes: [{ id: 'wamid.E', to: '34600111222', timestamp: '1700000000', type: 'text', text: { body: 'Telefondan yazdım' } }] } }] }] }, db);
  const echo = db.tables.whatsapp_messages.find(m => m.event_type === 'app_echo');
  assert.equal(echo.payload.text, 'Telefondan yazdım'); assert.equal(echo.recipient_phone, '34600111222');
  const s = fs.readFileSync(path.join(__dirname, '..', '..', 'DeseTourDashboard.jsx'), 'utf8');
  const a = s.indexOf('// TESTABLE:_buildWhatsAppThreads:start'), b = s.indexOf('// TESTABLE:_buildWhatsAppThreads:end');
  // eslint-disable-next-line no-new-func
  const build = new Function(s.slice(a, b) + '\nreturn _buildWhatsAppThreads;')();
  const T = build(
    [{ id: 1, from: '34600111222', name: 'Ana', text: 'Hola', at: '2026-11-17T10:00:00Z' }, { id: 2, from: '905321112233', text: 'Tamam', at: '2026-11-10T08:00:00Z' }],
    [{ id: 9, recipientPhone: '+34 600 111 222', text: 'Gracias', sentAt: '2026-11-17T10:05:00Z', status: 'read', eventType: 'crm_reply', audience: 'customer' },
     { id: 8, recipientPhone: '905321112233', recipientName: 'Ayşe', text: 'Tur bilgisi', createdAt: '2026-11-10T07:00:00Z', status: 'delivered', eventType: 'guide_tour_brief', audience: 'guide' }],
    new Date('2026-11-17T12:00:00Z').getTime());
  assert.deepEqual(T.map(t => [t.phone, t.name, t.messages.map(m => m.dir).join(''), t.canReply, t.audience]), [['34600111222', 'Ana', 'inout', true, 'customer'], ['905321112233', 'Ayşe', 'outin', false, 'guide']]);
});

// ── Telegram group (team notifications) ──────────────────────────────────
const { listGroups, connectGroup, disconnectGroup, getTelegramDestination, sendTelegramNotice, noticeText } = require('../../api/_whatsapp/telegram');
const TG = { token: 'bot-token', configured: true };
const tgFetch = (calls, updates) => async (url, init) => {
  const method = url.split('/').pop(); const body = JSON.parse(init.body); calls.push({ method, body });
  if (method === 'getUpdates') return { status: 200, json: async () => ({ ok: true, result: updates || [] }) };
  if (body.chat_id === '-100999') return { status: 403, json: async () => ({ ok: false, description: 'Forbidden: bot was kicked' }) };
  return { status: 200, json: async () => ({ ok: true, result: { message_id: calls.length } }) };
};

test('telegram: lists only groups, connects with a test message, notice goes once, disconnect falls back', async () => {
  const calls = []; const db = fakeDb({});
  const f = tgFetch(calls, [
    { message: { chat: { id: -1001234567, type: 'supergroup', title: 'DeseTour Ekip' } } },
    { message: { chat: { id: 555, type: 'private' } } },
    { my_chat_member: { chat: { id: -4242424, type: 'group', title: 'Operasyon' } } },
    { message: { chat: { id: -1001234567, type: 'supergroup', title: 'DeseTour Ekip' } } },
  ]);
  const g = await listGroups(TG, f);
  assert.deepEqual(g.groups, [{ id: '-1001234567', title: 'DeseTour Ekip' }, { id: '-4242424', title: 'Operasyon' }]);
  assert.equal((await connectGroup({ db, tg: TG, chatId: 'abc', fetchImpl: f })).status, 400);
  assert.equal((await connectGroup({ db, tg: TG, chatId: '-100999', title: 'X', fetchImpl: f })).status, 502, 'bot cannot write → not saved');
  assert.equal(await getTelegramDestination(db), null);
  assert.equal((await connectGroup({ db, tg: TG, chatId: '-1001234567', title: 'DeseTour Ekip', fetchImpl: f })).ok, true);
  const dest = await getTelegramDestination(db);
  assert.deepEqual([dest.chatId, dest.title], ['-1001234567', 'DeseTour Ekip']);

  assert.equal(noticeText('İPTAL R-1', 'Bosforo · 18 Kas | 2 kişi'), '📣 İPTAL R-1\nBosforo · 18 Kas\n2 kişi');
  const before = calls.length;
  const a = await sendTelegramNotice({ db, tg: TG, dest, eventType: 'crm_event_cancelled', title: 'İPTAL R-1', details: 'Bosforo', key: 'event:L1', fetchImpl: f });
  assert.deepEqual([a.ok, a.channel, a.recipients], [true, 'telegram', 1]);
  const b = await sendTelegramNotice({ db, tg: TG, dest, eventType: 'crm_event_cancelled', title: 'İPTAL R-1', details: 'Bosforo', key: 'event:L1', fetchImpl: f });
  assert.equal(b.duplicate, true);
  assert.equal(calls.length - before, 1, 'one Telegram call for one event');
  const row = db.tables.whatsapp_messages[0];
  assert.deepEqual([row.template_key, row.status, row.idempotency_key, row.recipient_phone], ['telegram', 'sent', 'tg:event:L1', undefined], 'recorded as sent; the WhatsApp worker never picks it up');
  assert.doesNotMatch(JSON.stringify(db.tables), /bot-token/, 'bot token is never stored');

  await disconnectGroup({ db });
  assert.equal(await getTelegramDestination(db), null);
});

test('telegram: events and the team notice use the group when connected, the WhatsApp list otherwise', async () => {
  const res = () => { const r = { code: 0, body: null, status(c) { r.code = c; return r; }, json(b) { r.body = b; return r; }, send(b) { r.body = b; return r; } }; return r; };
  const calls = []; const f = tgFetch(calls, []);
  const db = fakeDb({
    activity_logs: [{ id: 'L1', entity_type: 'reservation', entity_id: 'R1', action: 'created', metadata: { auto_ingested: true }, created_at: new Date().toISOString() }],
    reservations: [{ id: 'R1', reservation_number: 'R-1', destination: 'Bosforo', check_in: '2026-11-20', pax_adult: 2, pax_child: 0 }],
    whatsapp_destinations: [{ id: 'D-TG', destination_key: 'telegram', display_name: 'DeseTour Ekip', provider_group_id: '-1001234567', is_active: true }],
  }, claimAll);
  const staff = async () => ({ ok: true });
  const h = createHandler({ getConfig: () => CFG, getDb: () => db, getTelegramConfig: () => TG, fetchImpl: f, requireStaffRole: staff });
  let r = res(); await h({ method: 'GET', query: { action: 'status' }, headers: {} }, r);
  assert.deepEqual(r.body.telegram, { botConfigured: true, group: 'DeseTour Ekip' });
  r = res(); await h({ method: 'POST', query: { action: 'worker' }, headers: { authorization: 'Bearer sch' } }, r);
  assert.equal(r.code, 200);
  assert.equal(calls.filter(c => c.method === 'sendMessage').length, 1);
  assert.match(calls[0].body.text, /Yeni rezervasyon R-1/);
  r = res(); await h({ method: 'POST', query: { action: 'worker' }, headers: { authorization: 'Bearer sch' } }, r);
  assert.equal(calls.filter(c => c.method === 'sendMessage').length, 1, 'second worker run does not repeat it');
  r = res(); await h({ method: 'POST', query: { action: 'enqueue' }, headers: {}, rawBody: JSON.stringify({ kind: 'operations_notice', title: 'Yarın Topkapı kapalı', details: 'Plan değişti', requestId: 'q1' }) }, r);
  assert.equal(r.code, 200); assert.equal(r.body.channel, 'telegram');
  // No bot key → Telegram kinds refuse, team notice falls back to the WhatsApp list.
  const h2 = createHandler({ getConfig: () => CFG, getDb: () => db, getTelegramConfig: () => ({ token: '', configured: false }), requireStaffRole: staff });
  r = res(); await h2({ method: 'POST', query: { action: 'enqueue' }, headers: {}, rawBody: JSON.stringify({ kind: 'telegram_groups', requestId: 'q2' }) }, r);
  assert.equal(r.code, 409);
});

test('guide profile: WhatsApp guide scores are averaged per guide; answers without a guide score are not counted', () => {
  const stats = extractTestableFn('computeGuideFeedbackStats');
  assert.deepEqual(stats([]), { count: 0, avgGuide: null, avgTour: null, low: 0 });
  const s = stats([{ guideScore: 5, tourScore: 4 }, { guideScore: 3, tourScore: 5 }, { guideScore: null, tourScore: 1 }, { guideScore: 4, tourScore: null }]);
  assert.deepEqual([s.count, s.avgGuide, s.avgTour, s.low], [3, 4, 4.5, 1]);
});

test('test button: latest new booking, guide assignment, change and cancellation are re-sent marked TEST; missing kinds are reported', async () => {
  const L = (id, at, action, metadata, rid) => ({ id, entity_type: 'reservation', entity_id: rid, action, metadata: { auto_ingested: true, ...metadata }, created_at: at });
  const db = fakeDb({
    activity_logs: [L('a', '2026-11-10T09:00:00Z', 'created', {}, 'R1'), L('b', '2026-11-12T09:00:00Z', 'created', {}, 'R2'), L('c', '2026-11-11T09:00:00Z', 'cancelled', {}, 'R1')],
    reservations: [
      { id: 'R1', reservation_number: 'R-1', destination: 'Topkapı', tour_id: 'T1', check_in: '2026-11-20', pax_adult: 2, status: 'cancelled', updated_at: '2026-11-11T09:00:00Z' },
      { id: 'R2', reservation_number: 'R-2', destination: 'Bosforo', tour_id: 'T2', check_in: '2026-11-21', pax_adult: 3, total_amount: 9900, currency: 'TL', guide_id: 'G1', guide_name: 'Ayşe Yılmaz', status: 'confirmed', updated_at: '2026-11-13T09:00:00Z' }],
    guides: [{ id: 'G1', full_name: 'Ayşe Yılmaz', phone: '0532 123 45 67' }],
  });
  const told = []; const notify = async (a) => { told.push(a); return { ok: true, ids: [], channel: 'telegram' }; };
  const out = await sendTestNotices({ db, notify, requestId: 'q' });
  assert.deepEqual([out.sent, out.missing], [['yeni rezervasyon', 'rehber ataması', 'iptal'], ['değişiklik']]);
  assert.deepEqual(told.map(t => t.title), ['TEST · Yeni rezervasyon R-2', 'TEST · Rehber atandı: Ayşe Yılmaz', 'TEST · İPTAL R-1']);
  assert.deepEqual(told.map(t => t.key), ['test:q:created', 'test:q:guide', 'test:q:cancelled']);
  assert.match(told[0].details, /💶 Tutar: 9\.900 ₺/);
});

const { buildWeeklyReport } = require('../../api/_whatsapp/weekly');
test('weekly report: last 7 full days — bookings received, guests, guide fees, top tours, languages; schedule at Istanbul noon', async () => {
  const R = (o) => ({ pax_adult: 2, pax_child: 0, status: 'confirmed', tour_id: 'T1', destination: 'Topkapı', tour_language: 'İspanyolca', guide_id: 'G1', created_at: '2026-10-01T10:00:00Z', ...o });
  const db = fakeDb({
    reservations: [
      R({ id: '1', check_in: '2026-11-16' }), R({ id: '2', check_in: '2026-11-16', pax_adult: 3, pax_child: 1 }),
      R({ id: '3', check_in: '2026-11-18', tour_id: 'T2', destination: 'Bosforo', tour_language: 'İtalyanca', guide_id: null, pax_adult: 6 }),
      R({ id: '4', check_in: '2026-11-19', status: 'cancelled', pax_adult: 9 }),
      R({ id: '5', check_in: '2026-11-22', pax_adult: 8 }),                       // today — not in the week
      R({ id: '6', check_in: '2026-11-14', pax_adult: 8 }),                       // before the week
      R({ id: '7', check_in: '2026-12-05', created_at: '2026-11-20T08:00:00Z' }), // received this week, tour later
      R({ id: '8', check_in: '2026-12-06', created_at: '2026-11-21T08:00:00Z', status: 'cancelled' }),
      R({ id: '9', check_in: '2026-12-07', created_at: '2026-11-22T08:00:00Z' }), // received today — next week's report
    ],
    guide_operation_cost_overrides: [
      { operation_key: 'fee|2026-11-16|T1|g:G1', tour_date: '2026-11-16', amount: 150, currency: 'EUR' },
      { operation_key: 'fee|2026-11-18|T2|g:G2', tour_date: '2026-11-18', amount: 150, currency: 'EUR' },
      { operation_key: 'other|x', tour_date: '2026-11-17', amount: 999, currency: 'EUR' },
      { operation_key: 'fee|2026-11-23|T1|g:G1', tour_date: '2026-11-23', amount: 150, currency: 'EUR' },
    ],
  });
  const r = await buildWeeklyReport({ db, todayISO: '2026-11-22' });
  assert.equal(r.title, 'Haftalık rapor (15 Kasım – 21 Kasım)');
  assert.deepEqual(r.details.split(' | '), [
    '🆕 Yeni gelen rezervasyon: 2 (4 kişi, 1 tanesi iptal)', '🧭 Gerçekleşen tur: 2 operasyon, 3 rezervasyon', '👥 Katılan misafir: 12 kişi',
    '💶 Rehber ücretleri: 300 € (2 operasyon)', '⚠️ Rehber kaydı olmayan rezervasyon: 1', '🏆 En çok katılım:',
    '1) Topkapı — 6 kişi, 2 rezervasyon', '2) Bosforo — 6 kişi, 1 rezervasyon', '🗣 Dile göre rezervasyon: İspanyolca 2 · İtalyanca 1']);
  const wf = fs.readFileSync(path.join(__dirname, '..', '..', '.github/workflows/whatsapp-scheduled.yml'), 'utf8');
  for (const c of ["'0 9 * * *'", "'0 9 * * 0'", "'0 15 * * *'", "'7-59/15 * * * *'"]) assert.ok(wf.includes('cron: ' + c), c);
  assert.match(wf, /"0 9 \* \* 0" \]; then ACTION="weekly-report"/);
});

test('ingestion hook: team notices run right after the Civitatis ingestion; an event from 30 hours ago is still announced, once', async () => {
  const { runTeamNotices } = require('../../api/whatsapp');
  const at = new Date(Date.now() - 30 * 3600 * 1000).toISOString();
  const db = fakeDb({
    activity_logs: [{ id: 'L1', entity_type: 'reservation', entity_id: 'R1', action: 'created', metadata: { auto_ingested: true }, created_at: at }],
    reservations: [{ id: 'R1', reservation_number: 'R-1', destination: 'Bosforo', check_in: '2030-01-05', pax_adult: 2, external_booking_id: '42748941', status: 'confirmed', updated_at: at }],
    whatsapp_destinations: [{ id: 'D-TG', destination_key: 'telegram', display_name: 'DeseTour Ekip', provider_group_id: '-1001234567', is_active: true }],
  }, claimAll);
  const calls = []; const deps = { getConfig: () => CFG, getDb: () => db, getTelegramConfig: () => TG, fetchImpl: tgFetch(calls, []) };
  const a = await runTeamNotices(deps);
  assert.deepEqual([a.channel, a.events, a.announced], ['telegram', 1, 1]);
  assert.match(calls[0].body.text, /Yeni rezervasyon R-1\n🎫 Civitatis kodu: A42748941/);
  assert.equal((await runTeamNotices(deps)).announced, 0);
  assert.equal(calls.length, 1);
  const cron = fs.readFileSync(path.join(__dirname, '..', '..', 'api/cron-ingest-civitatis-write.js'), 'utf8');
  assert.match(cron, /try \{ teamNotices = await require\('\.\/whatsapp'\)\.runTeamNotices\(\); \}\s*catch/, 'best effort: never fails the ingestion');
  assert.match(cron, /autoLinkSingleExactName: true/, 'scheduled ingestion links a single same-name customer (agency bookings)');
});

test('late scheduler: a noon/evening job that fires after midnight still works on the previous day', () => {
  const { scheduledOpsDay } = require('../../api/whatsapp');
  assert.equal(scheduledOpsDay(new Date('2026-11-20T15:00:00Z')), '2026-11-20', '18:00 Istanbul');
  assert.equal(scheduledOpsDay(new Date('2026-11-20T22:10:00Z')), '2026-11-20', '01:10 Istanbul next day → still the 20th');
  assert.equal(scheduledOpsDay(new Date('2026-11-21T03:30:00Z')), '2026-11-21', '06:30 Istanbul → the new day');
});

test('guide messages: tour meeting point and duration fill in; the earliest known start time is used; a missing time is flagged', () => {
  const tour = { name: 'Bosforo y Barrio Sultanahmet', meeting_point: 'Tamara Restaurant Sultanahmet (08:45) veya The Marmara Hotel Taksim (08:10)', duration_text: '7 Saat', guide_notes_tr: 'Alışveriş baskısı yapılmamalı.' };
  const p = buildGuideBrief({ guideName: 'Özcan Yıldız', tour, reservations: [
    { reservation_number: 'R-1', check_in: '2026-11-21', check_in_time: null, tour_language: 'İtalyanca', pax_adult: 2, status: 'confirmed' },
    { reservation_number: 'R-2', check_in: '2026-11-21', check_in_time: '11:00:00', tour_language: 'İtalyanca', pax_adult: 1, status: 'confirmed' }] });
  assert.equal(p.time, '11:00 · Süre: 7 Saat', 'a booking without a time does not hide the known start');
  assert.equal(p.meetingPoint, 'Operasyondan iletilecek', 'the tour record never supplies the meeting point');
  assert.equal(p.note, '—', 'no automatic tour note');
  assert.equal(p.tourName, 'Bosforo y Barrio Sultanahmet');
  assert.deepEqual(Object.keys(p), ['guideName', 'dateLabel', 'tourName', 'time', 'language', 'guests', 'meetingPoint', 'note'], 'payload holds only template parameters');
  assert.match(renderPreview('guide_reminder', p), /🕘 Başlangıç: 11:00 · Süre: 7 Saat\n.*\n.*\n📍 Buluşma: Operasyondan iletilecek/);
  const q = buildGuideBrief({ guideName: 'A', tour, reservations: [{ reservation_number: 'R-3', check_in: '2026-12-28', check_in_time: null, pax_adult: 2, status: 'confirmed' }] });
  assert.equal(q.time, "saat CRM'de girilmemiş, operasyondan teyit edin · Süre: 7 Saat"); assert.equal(q.startKnown, false);
  const withPickup = buildGuideBrief({ guideName: 'A', tour, reservations: [{ reservation_number: 'R-4', check_in: '2026-12-28', check_in_time: '10:00:00', pickup_location: 'Hotel X', pax_adult: 2, status: 'confirmed' }] });
  assert.equal(withPickup.meetingPoint, 'Hotel X', "the booking's own pickup wins over the tour default");
});

const { parsePickupPoint, fillMissingPickups } = require('../../api/_civitatis/pickupPoint');
test('pickup point: read from the Civitatis email, filled only when empty, used as meeting point and time in guide messages', async () => {
  assert.deepEqual(parsePickupPoint('DATE: x\n\t\t PICKUP POINT: Tamara Restaurant Sultanahmed, às 8:45 horas.\n PEOPLE'), { location: 'Tamara Restaurant Sultanahmed', time: '08:45', raw: 'Tamara Restaurant Sultanahmed, às 8:45 horas.' });
  assert.equal(parsePickupPoint(' PICKUP POINT: Tamara Restaurant Sultanahmed, alle 8:45.').location, 'Tamara Restaurant Sultanahmed');
  assert.deepEqual(parsePickupPoint('PICKUP POINT: Hotel lobby'), { location: 'Hotel lobby', time: null, raw: 'Hotel lobby' });
  assert.equal(parsePickupPoint('HOUR: 11:00 (11:00 am)'), null);
  const db = fakeDb({
    reservations: [
      { id: 'A', external_booking_id: '42330184', check_in: '2026-12-31', pickup_location: null, pickup_time: null, status: 'confirmed' },
      { id: 'B', external_booking_id: '42330185', check_in: '2026-12-31', pickup_location: 'Hotel X', pickup_time: null, status: 'confirmed' },
      { id: 'C', external_booking_id: '42330186', check_in: '2026-12-31', pickup_location: null, status: 'confirmed' },
      { id: 'D', external_booking_id: '42330187', check_in: '2026-11-01', pickup_location: null, status: 'confirmed' }],
    email_ingestions: [
      { external_booking_id: '42330184', received_at: '2026-10-01', raw_body_snapshot: 'PICKUP POINT: Old place, às 9:00 horas.' },
      { external_booking_id: '42330184', received_at: '2026-10-05', raw_body_snapshot: 'PICKUP POINT: Tamara Restaurant Sultanahmed, alle 8:45.' },
      { external_booking_id: '42330185', received_at: '2026-10-05', raw_body_snapshot: 'PICKUP POINT: Somewhere, alle 8:45.' },
      { external_booking_id: '42330186', received_at: '2026-10-05', raw_body_snapshot: 'HOUR: 10:00' },
      { external_booking_id: '42330187', received_at: '2026-10-05', raw_body_snapshot: 'PICKUP POINT: Past, alle 8:45.' }],
  });
  assert.deepEqual(await fillMissingPickups({ db, sinceISO: '2026-11-20' }), { checked: 2, filled: 1 });
  const r = db.tables.reservations;
  assert.deepEqual([r[0].pickup_location, r[0].pickup_time], ['Tamara Restaurant Sultanahmed', '08:45'], 'the latest email wins');
  assert.equal(r[1].pickup_location, 'Hotel X', 'never overwrites what the team entered');
  assert.equal(r[3].pickup_location, null, 'past tours are left alone');
  const p = buildGuideBrief({ guideName: 'Özcan', tour: { name: 'Bosforo y Barrio Sultanahmet', duration_text: '7 Saat' }, reservations: [
    { reservation_number: 'R-2026-0028', check_in: '2026-12-31', check_in_time: null, pickup_location: 'Tamara Restaurant Sultanahmed', pickup_time: '08:45:00', tour_language: 'Portekizce', pax_adult: 2, status: 'confirmed' }] });
  assert.equal(p.time, '08:45 (buluşma) · Süre: 7 Saat');
  assert.equal(p.meetingPoint, 'Tamara Restaurant Sultanahmed (08:45)');
  assert.equal(p.startKnown, true);
});

test('team notice shows the pickup point with its time', () => {
  const n = buildEventNotice('created', { id: 'L', entity_type: 'reservation', action: 'created', metadata: { auto_ingested: true } },
    { id: 'R', reservation_number: 'R-1', destination: 'Bosforo', check_in: '2026-12-31', pax_adult: 2, pickup_location: 'Tamara Restaurant Sultanahmed', pickup_time: '08:45:00' }, []);
  assert.match(n.details, /📅 Tarih: 31 Aralık 2026 Perşembe \| 📍 Buluşma: Tamara Restaurant Sultanahmed \(08:45\) \|/);
});

test('assignment dialog: send now or schedule up to 12 hours with a note; one message per operation; automatic path waits for the choice', async () => {
  const t0 = new Date('2026-11-28T09:00:00Z');
  const R = (o) => ({ reservation_number: 'R-1', check_in: '2026-11-30', check_in_time: '10:00:00', tour_id: 'T1', destination: 'Grand Bazaar', tour_language: 'İspanyolca', guide_id: 'G1', pax_adult: 2, status: 'confirmed', pickup_location: 'Hotel Sultania', pickup_time: '09:30:00', ...o });
  const db = fakeDb({
    reservations: [R({ id: 'A', updated_at: '2026-11-28T08:59:00Z' })],
    guides: [{ id: 'G1', full_name: 'Deniz Bulut', phone: '0531 898 84 32' }],
    tours: [{ id: 'T1', name: 'Grand Bazaar Experience', duration_text: '4 Saat', meeting_point: 'Çemberlitaş Tramvay İstasyonu', guide_notes_tr: 'Otomatik not' }],
  }, claimAll);
  // the automatic fallback leaves a fresh assignment alone (grace period)
  assert.equal((await enqueueGuideAssignments({ db, todayISO: '2026-11-28', now: () => t0 })).queued, 0);
  const told = []; const notify = async (a) => { told.push(a); return { ok: true, ids: [], channel: 'telegram' }; };
  await notifyGuideAssignments({ db, notify, todayISO: '2026-11-28', now: () => t0 });
  assert.equal(told.length, 0, 'the team hears about it once the choice is made');
  assert.equal((await enqueueGuideAssignmentMessage({ db, reservationId: 'A', delayMinutes: 721, now: () => t0 })).status, 400, 'at most 12 hours');
  const a = await enqueueGuideAssignmentMessage({ db, reservationId: 'A', note: 'Şemsiye alın', delayMinutes: 180, now: () => t0 });
  assert.equal(a.scheduledAt, '2026-11-28T12:00:00.000Z');
  const m = db.tables.whatsapp_messages[0];
  assert.deepEqual([m.idempotency_key, m.next_attempt_at, m.payload.guideName, m.payload.note], ['guide_assigned:2026-11-30|T1|g:G1', '2026-11-28T12:00:00.000Z', 'Deniz Bulut', 'Şemsiye alın']);
  assert.equal(m.payload.meetingPoint, 'Hotel Sultania (09:30)', 'meeting point and time from the booking, not the tour record');
  assert.match(renderPreview('guide_tour_brief', m.payload), /📝 Not: Şemsiye alın\n/);
  assert.doesNotMatch(JSON.stringify(m.payload), /Otomatik not|Çemberlitaş/);
  assert.equal((await enqueueGuideAssignmentMessage({ db, reservationId: 'A', delayMinutes: 0, now: () => t0 })).duplicate, true, 'never twice');
  const later = () => new Date('2026-11-28T10:00:00Z');
  assert.equal((await enqueueGuideAssignments({ db, todayISO: '2026-11-28', now: later })).queued, 0, 'the fallback sees the chosen message');
  await notifyGuideAssignments({ db, notify, todayISO: '2026-11-28', now: () => t0 });
  assert.equal(told.length, 1);
  assert.match(told[0].details, /⏰ Rehbere WhatsApp bilgisi/);
  const src = fs.readFileSync(path.join(__dirname, '..', '..', 'DeseTourDashboard.jsx'), 'utf8');
  const opts = src.match(/const _GUIDE_WA_DELAYS = (\[.*\]);/)[1];
  assert.deepEqual(JSON.parse(opts.replace(/\[(\d+), "([^"]+)"\]/g, '[$1,"$2"]')).map(x => x[0]), [0, 60, 120, 180, 240, 360, 480, 720]);
  assert.match(src, /if \(guideId && guideId !== r\.guideId\) \{\s*setWaStep/, 'the step opens after a new or changed guide');
});
