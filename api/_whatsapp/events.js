'use strict';
/**
 * api/_whatsapp/events.js — CRM events → WhatsApp operations list.
 *
 * New Civitatis reservation, cancellation, modification and client message
 * are already written to activity_logs by the ingestion (metadata
 * auto_ingested = true). Every worker run turns the recent ones into ONE
 * operations notice per recipient; idempotency_key = event id + phone, so
 * an event is never announced twice. WhatsApp's API cannot post into an
 * existing WhatsApp group — the notice goes to each number of the
 * operations list instead.
 */
const { enqueueOperationsNotice, dateLabelTr } = require('./enqueue');

const RES_COLS = 'id,reservation_number,destination,tour_id,check_in,check_in_time,pax_adult,pax_child,tour_language,guide_id,guide_name,total_amount,currency,status,external_booking_id';

function classifyEvent(log) {
  const m = log.metadata || {};
  if (log.entity_type !== 'reservation' || m.auto_ingested !== true) return null;
  if (m.source === 'civitatis_message') return 'message';
  if (log.action === 'cancelled') return 'cancelled';
  if (m.alert_type === 'civitatis_modified') return 'modified';
  if (log.action === 'created') return 'created';
  return null;
}

const CRM_URL = 'https://crm.desetour.com/#/reservations/';
const paxOf = (x) => (Number(x.pax_adult) || 0) + (Number(x.pax_child) || 0);
function moneyLabel(amount, currency) {
  const n = Number(amount);
  if (!Number.isFinite(n) || n <= 0) return null;
  const c = String(currency || '').toUpperCase();
  const sym = c === 'TL' || c === 'TRY' ? '₺' : c === 'EUR' ? '€' : c === 'USD' ? '$' : c;
  return `${n.toLocaleString('tr-TR', { minimumFractionDigits: 0, maximumFractionDigits: 2 })} ${sym}`.trim();
}

// One line per fact (lines are joined with " | "; the Telegram sender
// puts each on its own row). `others` = the other non-cancelled
// reservations of the same day + tour.
function buildEventNotice(kind, log, r, others) {
  const m = log.metadata || {};
  const no = (r && r.reservation_number) || m.reservation_number || '';
  const pax = r ? paxOf(r) : null;
  const when = r && r.check_in ? `${dateLabelTr(r.check_in)}${r.check_in_time ? ' ' + String(r.check_in_time).slice(0, 5) : ''}` : null;
  const lines = [];
  // Civitatis shows its code as "A42635449"; the CRM stores the digits.
  const ext = String((r && r.external_booking_id) || m.external_booking_id || '').trim();
  if (ext) lines.push(`🎫 Civitatis kodu: ${/^\d+$/.test(ext) ? 'A' + ext : ext}`);
  if (kind === 'modified') {
    const ch = Array.isArray(m.changes) ? m.changes.map(c => `${c.label}: ${c.from} → ${c.to}`).join(' · ') : '';
    lines.push(`✏️ ${ch || 'Değişiklik ayrıntısı yok'}`);
  }
  if (r) {
    lines.push(`🧭 Tur: ${r.destination || m.tour_name || '—'}${r.tour_language ? ` (${r.tour_language})` : ''}`);
    if (when) lines.push(`📅 Tarih: ${when}`);
    if (pax) lines.push(`👥 Kişi: ${pax}${Number(r.pax_child) ? ` (${Number(r.pax_adult) || 0} yetişkin + ${Number(r.pax_child)} çocuk)` : ''}`);
    const money = moneyLabel(r.total_amount, r.currency);
    if (money && kind !== 'message') lines.push(`💶 Tutar: ${money}`);
    if (kind === 'created' || kind === 'modified') lines.push(r.guide_id ? `🧑‍🏫 Rehber: ${r.guide_name || 'atandı'}` : `🧑‍🏫 Rehber: atanmadı${r.id ? ` → Rehber Ata: ${CRM_URL}${r.id}/rehber-ata` : ''}`);
    if (kind === 'cancelled' && r.guide_id) lines.push(`⚠️ Rehber atanmıştı${r.guide_name ? ` (${r.guide_name})` : ''}: rehbere haber verin`);
    if (kind === 'modified' && m.guide_assigned) lines.push('⚠️ Rehbere haber verin');
    if (others && kind !== 'message') {
      const op = others.reduce((n, x) => n + paxOf(x), 0);
      if (kind === 'cancelled') lines.push(others.length ? `📊 Aynı gün bu turda kalan: ${others.length} rezervasyon, ${op} kişi` : '📊 Aynı gün bu turda başka katılım kalmadı');
      else lines.push(others.length ? `📊 Aynı gün bu turda: ${others.length} rezervasyon daha, ${op} kişi → toplam ${op + (pax || 0)} kişi` : '📊 Aynı gün bu turda başka katılım yok (ilk rezervasyon)');
    }
    if (kind === 'message') lines.push("💬 Civitatis'ten yeni mesaj var: CRM'de rezervasyonu açıp okuyun");
    if (r.id) lines.push(`🔗 ${CRM_URL}${r.id}`);
  } else lines.push(m.tour_name || '—');
  const title = kind === 'created' ? `Yeni rezervasyon ${no}` : kind === 'cancelled' ? `İPTAL ${no}` : kind === 'modified' ? `Değişiklik ${no}` : `Yeni Civitatis mesajı ${no}`;
  return { title: title.trim(), details: lines.join(' | ') };
}

// The notice for one activity log: loads the reservation and the other
// bookings of the same day + tour.
async function eventNoticeFor(db, kind, log) {
  const { data: r } = await db.from('reservations').select(RES_COLS).eq('id', log.entity_id).maybeSingle();
  let others = null;
  if (r && r.tour_id && r.check_in) {
    const { data: same } = await db.from('reservations').select(RES_COLS).eq('check_in', r.check_in).eq('tour_id', r.tour_id);
    others = (same || []).filter(x => x.id !== r.id && x.status !== 'cancelled');
  }
  return buildEventNotice(kind, log, r, others);
}

// Test button (Ayarlar → Telegram): the latest new booking, change and
// cancellation, plus the latest guide assignment, sent again marked TEST.
async function sendTestNotices({ db, notify, requestId }) {
  const { latestGuideAssignmentNotice } = require('./enqueue');
  const { data: logs, error } = await db.from('activity_logs').select('id,entity_type,entity_id,action,metadata,created_at')
    .eq('entity_type', 'reservation').order('created_at', { ascending: false }).limit(1000);
  if (error) throw new Error(error.message);
  const sorted = (logs || []).slice().sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
  const out = { sent: [], missing: [] };
  const LABEL = { created: 'yeni rezervasyon', guide: 'rehber ataması', modified: 'değişiklik', cancelled: 'iptal' };
  for (const kind of ['created', 'guide', 'modified', 'cancelled']) {
    let n = null;
    if (kind === 'guide') n = await latestGuideAssignmentNotice(db);
    else { const log = sorted.find(l => classifyEvent(l) === kind); if (log) n = await eventNoticeFor(db, kind, log); }
    if (!n) { out.missing.push(LABEL[kind]); continue; }
    const res = await notify({ eventType: 'test_notice', title: 'TEST · ' + n.title, details: n.details, key: `test:${requestId}:${kind}` });
    if (!res.ok) return { ok: false, status: res.status || 502, error: res.error };
    out.sent.push(LABEL[kind]);
  }
  return { ok: true, ...out };
}

// notify(args) defaults to the WhatsApp operations list; the endpoint
// passes the Telegram group sender when a group is connected.
async function enqueueEventNotices({ db, sinceMinutes = 120, now = () => new Date(), notify = (a) => enqueueOperationsNotice({ db, ...a }) }) {
  const since = new Date(now().getTime() - sinceMinutes * 60000).toISOString();
  const { data: logs, error } = await db.from('activity_logs').select('id,entity_type,entity_id,action,metadata,created_at')
    .eq('entity_type', 'reservation').gte('created_at', since).order('created_at');
  if (error) throw new Error(error.message);
  const out = { events: 0, queued: 0, ids: [], skipped: null };
  for (const log of logs || []) {
    const kind = classifyEvent(log);
    if (!kind) continue;
    out.events += 1;
    const n = await eventNoticeFor(db, kind, log);
    const res = await notify({ eventType: 'crm_event_' + kind, title: n.title, details: n.details, key: `event:${log.id}` });
    if (!res.ok) { out.skipped = res.error; break; } // no recipients / group unreachable → retried on the next run
    if (!res.duplicate) out.queued += Math.max(res.ids.length, res.channel === 'telegram' ? 1 : 0);
    out.ids.push(...res.ids);
  }
  return out;
}

module.exports = { classifyEvent, buildEventNotice, enqueueEventNotices, eventNoticeFor, sendTestNotices };
