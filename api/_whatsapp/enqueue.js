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

const RES_COLS = 'id,reservation_number,check_in,check_in_time,tour_id,destination,tour_language,guide_id,guide_name,pickup_location,pickup_time,pax_adult,pax_child,status';

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
// `tour` = the tour record: only its name and duration are used. Meeting
// point and time come from the bookings (pickup), the note from the team.
const TOUR_COLS = 'name,duration_text';
function buildGuideBrief({ reservations, guideName, tourName, note, meetingPoint, tour }) {
  const list = reservations.filter(r => r.status !== 'cancelled');
  const timed = list.filter(r => r.check_in_time).sort((a, b) => String(a.check_in_time).localeCompare(String(b.check_in_time)));
  const first = timed[0] || list[0] || {};
  const guests = list.reduce((n, r) => n + pax(r), 0);
  const langs = [...new Set(list.map(r => r.tour_language).filter(Boolean))];
  // The customer's pickup point with its meeting time, e.g. "Tamara Restaurant Sultanahmed (08:45)".
  const pickups = [...new Set(list.filter(r => (r.pickup_location || '').trim())
    .map(r => `${String(r.pickup_location).trim()}${r.pickup_time ? ` (${hhmm(r.pickup_time)})` : ''}`))];
  const pickupTimes = list.map(r => hhmm(r.pickup_time)).filter(Boolean).sort();
  const duration = tour && tour.duration_text ? String(tour.duration_text).trim() : '';
  const start = hhmm(first.check_in_time);
  const out = {
    // Full name ("Merhaba Ayşe Yılmaz"), never the first name alone.
    guideName: String(guideName || '').trim().replace(/\s+/g, ' ') || 'Rehberimiz',
    dateLabel: dateLabelTr(first.check_in),
    tourName: tourName || (tour && tour.name) || first.destination || 'Tur',
    // No fixed start (Civitatis: "see the voucher") → the earliest pickup time.
    time: `${start || (pickupTimes[0] ? `${pickupTimes[0]} (buluşma)` : 'saat CRM\'de girilmemiş, operasyondan teyit edin')}${duration ? ` · Süre: ${duration}` : ''}`,
    language: langs.join(' / ') || '—',
    guests: `${guests} kişi (${list.length} rezervasyon: ${list.map(r => r.reservation_number).join(', ')})`,
    // Meeting point and times come ONLY from the bookings themselves (the
    // pickup the customer chose on Civitatis) — never the tour record.
    meetingPoint: (meetingPoint && meetingPoint.trim()) || pickups.join(' / ') || 'Operasyondan iletilecek',
    // Only a note the team wrote — no automatic tour note.
    note: (note && note.trim()) || '—',
  };
  // Not a template parameter: tells the team notice the start time is missing.
  Object.defineProperty(out, 'startKnown', { value: !!(start || pickupTimes[0]), enumerable: false });
  return out;
}

async function enqueueGuideBrief({ db, reservationId, note, meetingPoint, requestId }) {
  const { data: r, error } = await db.from('reservations').select(RES_COLS).eq('id', reservationId).maybeSingle();
  if (error) throw new Error(error.message);
  if (!r) return { ok: false, status: 404, error: 'Rezervasyon bulunamadı.' };
  if (!r.guide_id) return { ok: false, status: 409, error: 'Bu rezervasyona rehber atanmamış.' };
  const [{ data: guide }, { data: sibs }, { data: tour }] = await Promise.all([
    db.from('guides').select('id,full_name,phone').eq('id', r.guide_id).maybeSingle(),
    db.from('reservations').select(RES_COLS).eq('check_in', r.check_in).eq('tour_id', r.tour_id).eq('guide_id', r.guide_id),
    r.tour_id ? db.from('tours').select(TOUR_COLS).eq('id', r.tour_id).maybeSingle() : Promise.resolve({ data: null }),
  ]);
  if (!guide) return { ok: false, status: 404, error: 'Rehber bulunamadı.' };
  const phone = normalizePhone(guide.phone);
  if (!phone) return { ok: false, status: 422, error: `${guide.full_name} için geçerli bir telefon numarası kayıtlı değil.` };
  const payload = buildGuideBrief({ reservations: sibs && sibs.length ? sibs : [r], guideName: guide.full_name, tour, tourName: (tour && tour.name) || r.destination, note, meetingPoint });
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
      r.tour_id ? db.from('tours').select(TOUR_COLS).eq('id', r.tour_id).maybeSingle() : Promise.resolve({ data: null }),
    ]);
    const phone = guide ? normalizePhone(guide.phone) : null;
    if (!phone) { missingPhone += 1; continue; }
    const payload = buildGuideBrief({ reservations: sibs && sibs.length ? sibs : seed, guideName: guide.full_name, tour, tourName: (tour && tour.name) || r.destination });
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
// The CRM asks, right after the assignment, when the guide's message
// should go and whether to add a note (enqueueGuideAssignmentMessage).
// This automatic path is only the fallback for an assignment whose dialog
// was closed without a choice: it waits GRACE_MINUTES so it never races
// the team's choice, then sends right away.
const GRACE_MINUTES = 20;
async function enqueueGuideAssignments({ db, sinceMinutes = 2880, todayISO = istanbulISODate(), now = () => new Date() }) {
  const since = new Date(now().getTime() - sinceMinutes * 60000).toISOString();
  const graceEnd = new Date(now().getTime() - GRACE_MINUTES * 60000).toISOString();
  const { data, error } = await db.from('reservations').select(RES_COLS + ',updated_at').gte('updated_at', since).gte('check_in', todayISO);
  if (error) throw new Error(error.message);
  return guideOperationRows(db, settledOps(data || [], graceEnd), 'guide_assigned');
}
// Bookings of operations whose latest change is older than the grace period.
function settledOps(rows, graceEnd) {
  const latest = new Map();
  for (const r of rows) {
    const k = `${String(r.check_in).slice(0, 10)}|${r.tour_id}|g:${r.guide_id}`;
    if (!latest.has(k) || String(r.updated_at) > latest.get(k)) latest.set(k, String(r.updated_at));
  }
  return rows.filter(r => latest.get(`${String(r.check_in).slice(0, 10)}|${r.tour_id}|g:${r.guide_id}`) <= graceEnd);
}

// The team's choice after assigning a guide: send now or in up to 12 hours,
// with an optional note. One message per operation (same key as the
// automatic path, so the guide never gets it twice).
const MAX_DELAY_MINUTES = 12 * 60;
async function enqueueGuideAssignmentMessage({ db, reservationId, note, delayMinutes = 0, now = () => new Date() }) {
  const delay = Math.round(Number(delayMinutes) || 0);
  if (delay < 0 || delay > MAX_DELAY_MINUTES) return { ok: false, status: 400, error: 'Gönderim zamanı en fazla 12 saat sonrası olabilir.' };
  const { data: r, error } = await db.from('reservations').select(RES_COLS).eq('id', reservationId).maybeSingle();
  if (error) throw new Error(error.message);
  if (!r) return { ok: false, status: 404, error: 'Rezervasyon bulunamadı.' };
  if (!r.guide_id) return { ok: false, status: 409, error: 'Bu rezervasyona rehber atanmamış.' };
  const opKey = `${String(r.check_in).slice(0, 10)}|${r.tour_id}|g:${r.guide_id}`;
  const idem = `guide_assigned:${opKey}`;
  const { data: prior } = await db.from('whatsapp_messages').select('id,status,next_attempt_at').eq('idempotency_key', idem).maybeSingle();
  if (prior) return { ok: true, ids: [], duplicate: true, status: prior.status, scheduledAt: prior.next_attempt_at || null };
  const [{ data: guide }, { data: sibs }, { data: tour }] = await Promise.all([
    db.from('guides').select('id,full_name,phone').eq('id', r.guide_id).maybeSingle(),
    db.from('reservations').select(RES_COLS).eq('check_in', r.check_in).eq('tour_id', r.tour_id).eq('guide_id', r.guide_id),
    r.tour_id ? db.from('tours').select(TOUR_COLS).eq('id', r.tour_id).maybeSingle() : Promise.resolve({ data: null }),
  ]);
  if (!guide) return { ok: false, status: 404, error: 'Rehber bulunamadı.' };
  const phone = normalizePhone(guide.phone);
  if (!phone) return { ok: false, status: 422, error: `${guide.full_name} için geçerli bir telefon numarası kayıtlı değil.` };
  const payload = buildGuideBrief({ reservations: sibs && sibs.length ? sibs : [r], guideName: guide.full_name, tour, tourName: (tour && tour.name) || r.destination, note: String(note || '').slice(0, 600) });
  const scheduledAt = delay > 0 ? new Date(now().getTime() + delay * 60000).toISOString() : null;
  const row = { event_type: 'guide_assigned', audience_type: 'guide', template_key: 'guide_tour_brief', language: 'tr', idempotency_key: idem,
    reservation_id: r.id, guide_id: r.guide_id, tour_id: r.tour_id, recipient_phone: phone, recipient_display_name: guide.full_name, payload, next_attempt_at: scheduledAt };
  const { data, error: e2 } = await db.from('whatsapp_messages').upsert(row, { onConflict: 'idempotency_key', ignoreDuplicates: true }).select('id');
  if (e2) throw new Error(e2.message);
  return { ok: true, ids: (data || []).map(x => x.id), scheduledAt, sendNow: !scheduledAt, recipient: guide.full_name, preview: renderPreview('guide_tour_brief', payload) };
}

// What really happened to the guide's own WhatsApp message (the worker
// has already run): sent, or not — and why. Until Meta approves the
// templates every guide message fails, so the team is told to call.
async function guideMessageLine(db, opKey, guide) {
  if (!guide || !normalizePhone(guide.phone)) return '⚠️ Rehberin telefonu kayıtlı değil: WhatsApp bilgisi gönderilemedi, rehbere siz haber verin';
  const { data: msg } = await db.from('whatsapp_messages').select('status,last_error,next_attempt_at').eq('idempotency_key', `guide_assigned:${opKey}`).maybeSingle();
  if (msg && ['sent', 'delivered', 'read'].includes(msg.status)) return '📲 Rehbere WhatsApp ile tur bilgisi gönderildi';
  if (msg && msg.status === 'queued' && msg.next_attempt_at && new Date(msg.next_attempt_at).getTime() > Date.now()) {
    const at = new Date(msg.next_attempt_at).toLocaleString('tr-TR', { timeZone: 'Europe/Istanbul', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' });
    return `⏰ Rehbere WhatsApp bilgisi ${at}'da gönderilecek`;
  }
  if (msg && msg.status === 'failed') return '⚠️ Rehbere WhatsApp bilgisi gönderilemedi, rehbere siz haber verin';
  return '⏳ Rehbere WhatsApp bilgisi sırada, birkaç dakika içinde gider';
}

async function guideAssignmentNotice(db, r, k) {
  const [{ data: guide }, { data: sibs }, { data: tour }] = await Promise.all([
    db.from('guides').select('id,full_name,phone').eq('id', r.guide_id).maybeSingle(),
    db.from('reservations').select(RES_COLS).eq('check_in', r.check_in).eq('tour_id', r.tour_id).eq('guide_id', r.guide_id),
    r.tour_id ? db.from('tours').select(TOUR_COLS).eq('id', r.tour_id).maybeSingle() : Promise.resolve({ data: null }),
  ]);
  const name = (guide && guide.full_name) || r.guide_name || 'Rehber';
  const b = buildGuideBrief({ reservations: sibs && sibs.length ? sibs : [r], guideName: name, tour, tourName: (tour && tour.name) || r.destination });
  const lines = [`🧑‍🏫 Rehber: ${name}`, `🧭 Tur: ${b.tourName}${b.language !== '—' ? ` (${b.language})` : ''}`, `📅 Tarih: ${b.dateLabel} ${b.time}`, `📍 Buluşma: ${b.meetingPoint}`, ...(b.startKnown ? [] : ['⚠️ Rezervasyonda saat girilmemiş: rehbere saati siz iletin']), `👥 Misafir: ${b.guests}`,
    await guideMessageLine(db, k, guide), `🔗 https://crm.desetour.com/#/reservations/${r.id}`];
  return { title: `Rehber atandı: ${name}`, details: lines.join(' | ') };
}

// For the test button: the most recently updated reservation that has a guide.
async function latestGuideAssignmentNotice(db) {
  const { data } = await db.from('reservations').select(RES_COLS + ',updated_at').order('updated_at', { ascending: false }).limit(300);
  const r = (data || []).filter(x => x.guide_id && x.status !== 'cancelled').sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)))[0];
  return r ? guideAssignmentNotice(db, r, `${String(r.check_in).slice(0, 10)}|${r.tour_id}|g:${r.guide_id}`) : null;
}

// The same assignments, announced to the team (Telegram group or the
// WhatsApp operations list) — once per operation and guide, whether or
// not the guide has a phone on file.
async function notifyGuideAssignments({ db, notify, sinceMinutes = 2880, todayISO = istanbulISODate(), now = () => new Date() }) {
  const since = new Date(now().getTime() - sinceMinutes * 60000).toISOString();
  const { data, error } = await db.from('reservations').select(RES_COLS + ',updated_at').gte('updated_at', since).gte('check_in', todayISO);
  if (error) throw new Error(error.message);
  const ops = new Map();
  for (const r of (data || []).filter(x => x.guide_id && x.status !== 'cancelled')) {
    const k = `${String(r.check_in).slice(0, 10)}|${r.tour_id}|g:${r.guide_id}`;
    if (!ops.has(k)) ops.set(k, r);
  }
  const out = { operations: ops.size, announced: 0, skipped: null };
  const graceEnd = new Date(now().getTime() - GRACE_MINUTES * 60000).toISOString();
  const settled = new Set(settledOps(data || [], graceEnd).map(r => `${String(r.check_in).slice(0, 10)}|${r.tour_id}|g:${r.guide_id}`));
  for (const [k, r] of ops) {
    // Wait for the team's send-time choice (or the grace period) first.
    if (!settled.has(k)) {
      const { data: chosen } = await db.from('whatsapp_messages').select('id').eq('idempotency_key', `guide_assigned:${k}`).maybeSingle();
      if (!chosen) continue;
    }
    const n = await guideAssignmentNotice(db, r, k);
    const res = await notify({ eventType: 'crm_event_guide_assigned', title: n.title, details: n.details, key: `guide_assigned_team:${k}` });
    if (!res.ok) { out.skipped = res.error; break; }
    if (!res.duplicate && (res.ids.length || res.channel === 'telegram')) out.announced += 1;
  }
  return out;
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
    ? list.map((o, i) => `${i + 1}) ${o.time || '⚠️ saat yok'} ${o.tour}${o.langs.size ? ` (${[...o.langs].join('/')})` : ''} · ${o.pax} kişi, ${o.res} rezervasyon · ${o.hasGuide ? 'Rehber: ' + (o.guide || 'atandı') : '⚠️ REHBER ATANMADI'}`).join('  |  ')
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

module.exports = { buildGuideBrief, enqueueGuideBrief, enqueueGuideAssignments, enqueueGuideAssignmentMessage, notifyGuideAssignments, latestGuideAssignmentNotice, enqueueGuideReminders, enqueueOperationsNotice, buildDailySummary, enqueueDailySummary, istanbulISODate, addDays, dateLabelTr };
