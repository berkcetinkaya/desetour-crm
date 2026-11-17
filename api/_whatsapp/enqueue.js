'use strict';
/**
 * api/_whatsapp/enqueue.js — turns CRM events into queued WhatsApp
 * messages (public.whatsapp_messages). Every message is a snapshot: the
 * phone, name and template parameters are captured now, so what is sent
 * matches what the CRM showed. idempotency_key (UNIQUE) makes a repeated
 * request or a repeated cron run a no-op.
 */
const { normalizePhone } = require('./config');
const { renderPreview } = require('./templates');

const RES_COLS = 'id,reservation_number,check_in,check_in_time,tour_id,destination,tour_language,guide_id,guide_name,pickup_location,pax_adult,pax_child,status';

function dateLabelTr(iso) {
  return new Date(String(iso).slice(0, 10) + 'T12:00:00Z').toLocaleDateString('tr-TR', { day: 'numeric', month: 'long', year: 'numeric', weekday: 'long', timeZone: 'UTC' });
}
function hhmm(t) { return t ? String(t).slice(0, 5) : null; }
function istanbulISODate(d = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Istanbul', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}
function addDays(iso, n) { const d = new Date(iso + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
const pax = (r) => (Number(r.pax_adult) || 0) + (Number(r.pax_child) || 0);

// One guide operation = same date + tour + guide (CRM rule since 13.18).
function buildGuideBrief({ reservations, guideName, tourName, note, meetingPoint }) {
  const list = reservations.filter(r => r.status !== 'cancelled');
  const first = list.slice().sort((a, b) => String(a.check_in_time || '').localeCompare(String(b.check_in_time || '')))[0] || {};
  const guests = list.reduce((n, r) => n + pax(r), 0);
  const langs = [...new Set(list.map(r => r.tour_language).filter(Boolean))];
  const pickups = [...new Set(list.map(r => (r.pickup_location || '').trim()).filter(Boolean))];
  return {
    guideName: String(guideName || '').trim().split(/\s+/)[0] || 'Merhaba',
    dateLabel: dateLabelTr(first.check_in),
    tourName: tourName || first.destination || 'Tur',
    time: hhmm(first.check_in_time) || 'saat bilgisi yok',
    language: langs.join(' / ') || '—',
    guests: `${guests} kişi (${list.length} rezervasyon: ${list.map(r => r.reservation_number).join(', ')})`,
    meetingPoint: (meetingPoint && meetingPoint.trim()) || pickups.join(' / ') || 'Operasyondan iletilecek',
    note: (note && note.trim()) || '—',
  };
}

async function enqueueGuideBrief({ db, reservationId, note, meetingPoint, requestId }) {
  const { data: r, error } = await db.from('reservations').select(RES_COLS).eq('id', reservationId).maybeSingle();
  if (error) throw new Error(error.message);
  if (!r) return { ok: false, status: 404, error: 'Rezervasyon bulunamadı.' };
  if (!r.guide_id) return { ok: false, status: 409, error: 'Bu rezervasyona rehber atanmamış.' };
  const [{ data: guide }, { data: sibs }, { data: tour }] = await Promise.all([
    db.from('guides').select('id,full_name,phone').eq('id', r.guide_id).maybeSingle(),
    db.from('reservations').select(RES_COLS).eq('check_in', r.check_in).eq('tour_id', r.tour_id).eq('guide_id', r.guide_id),
    r.tour_id ? db.from('tours').select('name').eq('id', r.tour_id).maybeSingle() : Promise.resolve({ data: null }),
  ]);
  if (!guide) return { ok: false, status: 404, error: 'Rehber bulunamadı.' };
  const phone = normalizePhone(guide.phone);
  if (!phone) return { ok: false, status: 422, error: `${guide.full_name} için geçerli bir telefon numarası kayıtlı değil.` };
  const payload = buildGuideBrief({ reservations: sibs && sibs.length ? sibs : [r], guideName: guide.full_name, tourName: (tour && tour.name) || r.destination, note, meetingPoint });
  const row = {
    event_type: 'guide_tour_brief', audience_type: 'guide', template_key: 'guide_tour_brief', language: 'tr',
    idempotency_key: `guide_tour_brief:${r.check_in}|${r.tour_id}|g:${r.guide_id}:${requestId}`,
    reservation_id: r.id, guide_id: r.guide_id, tour_id: r.tour_id, recipient_phone: phone, recipient_display_name: guide.full_name, payload,
  };
  const { data, error: insErr } = await db.from('whatsapp_messages').upsert(row, { onConflict: 'idempotency_key', ignoreDuplicates: true }).select('id');
  if (insErr) throw new Error(insErr.message);
  return { ok: true, ids: (data || []).map(x => x.id), preview: renderPreview('guide_tour_brief', payload), recipient: guide.full_name };
}

// One row per guide operation (date + tour + guide), built from all its
// reservations. kind: 'guide_assigned' (right after the assignment) or
// 'guide_reminder' (the evening before). Once per operation and kind.
async function guideOperationRows(db, reservations, kind) {
  const ops = new Map();
  for (const r of reservations.filter(x => x.guide_id && x.status !== 'cancelled')) {
    const k = `${String(r.check_in).slice(0, 10)}|${r.tour_id}|g:${r.guide_id}`;
    if (!ops.has(k)) ops.set(k, []);
    ops.get(k).push(r);
  }
  const rows = []; let missingPhone = 0;
  for (const [k, seed] of ops) {
    const idem = `${kind}:${k}`;
    const { data: prior } = await db.from('whatsapp_messages').select('id').eq('idempotency_key', idem).maybeSingle();
    if (prior) continue;
    const r = seed[0];
    const [{ data: guide }, { data: sibs }, { data: tour }] = await Promise.all([
      db.from('guides').select('id,full_name,phone').eq('id', r.guide_id).maybeSingle(),
      db.from('reservations').select(RES_COLS).eq('check_in', r.check_in).eq('tour_id', r.tour_id).eq('guide_id', r.guide_id),
      r.tour_id ? db.from('tours').select('name').eq('id', r.tour_id).maybeSingle() : Promise.resolve({ data: null }),
    ]);
    const phone = guide ? normalizePhone(guide.phone) : null;
    if (!phone) { missingPhone += 1; continue; }
    const payload = buildGuideBrief({ reservations: sibs && sibs.length ? sibs : seed, guideName: guide.full_name, tourName: (tour && tour.name) || r.destination });
    rows.push({ event_type: kind, audience_type: 'guide', template_key: kind === 'guide_reminder' ? 'guide_reminder' : 'guide_tour_brief', language: 'tr',
      idempotency_key: idem, reservation_id: r.id, guide_id: r.guide_id, tour_id: r.tour_id, recipient_phone: phone, recipient_display_name: guide.full_name, payload });
  }
  let ids = [];
  if (rows.length) {
    const { data, error } = await db.from('whatsapp_messages').upsert(rows, { onConflict: 'idempotency_key', ignoreDuplicates: true }).select('id');
    if (error) throw new Error(error.message);
    ids = (data || []).map(x => x.id);
  }
  return { operations: ops.size, queued: ids.length, missingPhone, ids };
}

// Guide assigned (or changed) on an upcoming reservation in the last
// sinceMinutes → the guide gets the assignment + tour details.
async function enqueueGuideAssignments({ db, sinceMinutes = 120, todayISO = istanbulISODate(), now = () => new Date() }) {
  const since = new Date(now().getTime() - sinceMinutes * 60000).toISOString();
  const { data, error } = await db.from('reservations').select(RES_COLS + ',updated_at').gte('updated_at', since).gte('check_in', todayISO);
  if (error) throw new Error(error.message);
  return guideOperationRows(db, data || [], 'guide_assigned');
}

// The evening before: every guide with a tour tomorrow gets a reminder.
async function enqueueGuideReminders({ db, todayISO = istanbulISODate() }) {
  const date = addDays(todayISO, 1);
  const { data, error } = await db.from('reservations').select(RES_COLS).eq('check_in', date);
  if (error) throw new Error(error.message);
  return { date, ...(await guideOperationRows(db, data || [], 'guide_reminder')) };
}

async function operationsRecipients(db) {
  const { data: dest } = await db.from('whatsapp_destinations').select('id,is_active').eq('destination_key', 'operations').maybeSingle();
  if (!dest || !dest.is_active) return { dest: null, recipients: [] };
  const { data } = await db.from('whatsapp_destination_recipients').select('phone,display_name,is_active').eq('destination_id', dest.id).eq('is_active', true).order('sort_order');
  return { dest, recipients: (data || []).map(x => ({ ...x, wa: normalizePhone(x.phone) })).filter(x => x.wa) };
}

async function enqueueOperationsNotice({ db, eventType, title, details, key }) {
  const { dest, recipients } = await operationsRecipients(db);
  if (!dest || !recipients.length) return { ok: false, status: 409, error: 'WhatsApp operasyon listesine kayıtlı alıcı yok (Ayarlar → WhatsApp).' };
  const payload = { title, details };
  const rows = recipients.map(x => ({
    event_type: eventType, audience_type: 'operations', template_key: 'operations_notice', language: 'tr',
    idempotency_key: `${key}:${x.wa}`, destination_id: dest.id, recipient_phone: x.wa, recipient_display_name: x.display_name || null, payload,
  }));
  const { data, error } = await db.from('whatsapp_messages').upsert(rows, { onConflict: 'idempotency_key', ignoreDuplicates: true }).select('id');
  if (error) throw new Error(error.message);
  return { ok: true, ids: (data || []).map(x => x.id), recipients: recipients.length, preview: renderPreview('operations_notice', payload) };
}

// Tomorrow's operations in one line per operation (template parameters
// cannot contain line breaks): "10:00 Topkapı (İspanyolca) 4 kişi · Rehber: Ayşe".
function buildDailySummary(reservations, dateISO) {
  const ops = new Map();
  for (const r of reservations.filter(x => x.status !== 'cancelled' && String(x.check_in).slice(0, 10) === dateISO)) {
    const k = `${r.tour_id}|${r.guide_id || 'none'}`;
    if (!ops.has(k)) ops.set(k, { time: hhmm(r.check_in_time), tour: r.destination || 'Tur', langs: new Set(), pax: 0, guide: (r.guide_name || '').trim(), hasGuide: !!r.guide_id, res: 0 });
    const o = ops.get(k); o.pax += pax(r); o.res += 1; if (r.tour_language) o.langs.add(r.tour_language);
    if (!o.time || (hhmm(r.check_in_time) && hhmm(r.check_in_time) < o.time)) o.time = hhmm(r.check_in_time);
  }
  const list = [...ops.values()].sort((a, b) => String(a.time || '99').localeCompare(String(b.time || '99')));
  const unassigned = list.filter(o => !o.hasGuide).length;
  const title = `Yarın (${dateLabelTr(dateISO)}): ${list.length} operasyon, ${list.reduce((n, o) => n + o.pax, 0)} misafir`;
  const details = list.length
    ? list.map((o, i) => `${i + 1}) ${o.time || '--:--'} ${o.tour}${o.langs.size ? ` (${[...o.langs].join('/')})` : ''} ${o.pax} kişi · ${o.hasGuide ? 'Rehber: ' + (o.guide || 'atandı') : '⚠️ REHBER ATANMADI'}`).join('  |  ')
      + (unassigned ? `  |  ⚠️ ${unassigned} operasyonda rehber yok` : '')
    : 'Yarın tur yok.';
  return { title, details, operations: list.length, unassigned };
}

async function enqueueDailySummary({ db, todayISO = istanbulISODate(), notify }) {
  const date = addDays(todayISO, 1);
  const { data, error } = await db.from('reservations').select(RES_COLS).eq('check_in', date);
  if (error) throw new Error(error.message);
  const s = buildDailySummary(data || [], date);
  const r = await (notify || ((a) => enqueueOperationsNotice({ db, ...a })))({ eventType: 'daily_operations_summary', title: s.title, details: s.details, key: `daily_summary:${date}` });
  return { ...r, date, operations: s.operations, unassigned: s.unassigned };
}

module.exports = { buildGuideBrief, enqueueGuideBrief, enqueueGuideAssignments, enqueueGuideReminders, enqueueOperationsNotice, buildDailySummary, enqueueDailySummary, istanbulISODate, addDays, dateLabelTr };
