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

function classifyEvent(log) {
  const m = log.metadata || {};
  if (log.entity_type !== 'reservation' || m.auto_ingested !== true) return null;
  if (m.source === 'civitatis_message') return 'message';
  if (log.action === 'cancelled') return 'cancelled';
  if (m.alert_type === 'civitatis_modified') return 'modified';
  if (log.action === 'created') return 'created';
  return null;
}

function buildEventNotice(kind, log, r) {
  const m = log.metadata || {};
  const no = (r && r.reservation_number) || m.reservation_number || '';
  const pax = r ? (Number(r.pax_adult) || 0) + (Number(r.pax_child) || 0) : null;
  const when = r && r.check_in ? `${dateLabelTr(r.check_in)}${r.check_in_time ? ' ' + String(r.check_in_time).slice(0, 5) : ''}` : null;
  const base = [r && r.destination, when, pax ? `${pax} kişi` : null, r && r.tour_language].filter(Boolean).join(' · ');
  if (kind === 'created') return { title: `Yeni rezervasyon ${no}`.trim(), details: `${base || '—'}${r && !r.guide_id ? ' · Rehber atanmadı' : ''}` };
  if (kind === 'cancelled') return { title: `İPTAL ${no}`.trim(), details: `${base || m.tour_name || '—'}${r && r.guide_id ? ' · Rehber atanmıştı: rehbere haber verin' : ''}` };
  if (kind === 'modified') {
    const ch = Array.isArray(m.changes) ? m.changes.map(c => `${c.label} ${c.from} → ${c.to}`).join(' · ') : '';
    return { title: `Değişiklik ${no}`.trim(), details: `${ch || '—'}${base ? ' | ' + base : ''}${m.guide_assigned ? ' · Rehbere haber verin' : ''}` };
  }
  return { title: `Yeni Civitatis mesajı ${no}`.trim(), details: `${base || '—'} · CRM'de rezervasyonu açıp okuyun` };
}

async function enqueueEventNotices({ db, sinceMinutes = 120, now = () => new Date() }) {
  const since = new Date(now().getTime() - sinceMinutes * 60000).toISOString();
  const { data: logs, error } = await db.from('activity_logs').select('id,entity_type,entity_id,action,metadata,created_at')
    .eq('entity_type', 'reservation').gte('created_at', since).order('created_at');
  if (error) throw new Error(error.message);
  const out = { events: 0, queued: 0, ids: [], skipped: null };
  for (const log of logs || []) {
    const kind = classifyEvent(log);
    if (!kind) continue;
    out.events += 1;
    const { data: r } = await db.from('reservations').select('id,reservation_number,destination,check_in,check_in_time,pax_adult,pax_child,tour_language,guide_id').eq('id', log.entity_id).maybeSingle();
    const n = buildEventNotice(kind, log, r);
    const res = await enqueueOperationsNotice({ db, eventType: 'crm_event_' + kind, title: n.title, details: n.details, key: `event:${log.id}` });
    if (!res.ok) { out.skipped = res.error; break; } // no recipients configured → nothing to do
    out.queued += res.ids.length; out.ids.push(...res.ids);
  }
  return out;
}

module.exports = { classifyEvent, buildEventNotice, enqueueEventNotices };
