'use strict';
/**
 * api/_whatsapp/weekly.js — the team's weekly report (Sunday noon).
 * Covers the last 7 full days (last Sunday … yesterday):
 *   • new bookings received (and how many of them were cancelled)
 *   • tours that took place: operations, reservations, guests
 *   • guide fees recorded for those operations
 *   • tours with the most guests, reservations per language
 * Read-only; amounts are the guide fee rows already recorded in the CRM
 * (guide_operation_cost_overrides, "fee|…"), never recomputed here.
 */
const { istanbulISODate, addDays, dateLabelTr } = require('./enqueue');

const paxOf = (r) => (Number(r.pax_adult) || 0) + (Number(r.pax_child) || 0);
const shortDate = (iso) => dateLabelTr(iso).split(' ').slice(0, 2).join(' ');
function money(n, c) {
  const cur = String(c || '').toUpperCase();
  const sym = cur === 'TL' || cur === 'TRY' ? '₺' : cur === 'EUR' ? '€' : cur === 'USD' ? '$' : cur;
  return `${Number(n).toLocaleString('tr-TR', { maximumFractionDigits: 2 })} ${sym}`.trim();
}

async function buildWeeklyReport({ db, todayISO = istanbulISODate() }) {
  const from = addDays(todayISO, -7), to = addDays(todayISO, -1);
  const COLS = 'id,reservation_number,destination,tour_id,check_in,pax_adult,pax_child,tour_language,guide_id,status,created_at';
  const [{ data: byTour, error: e1 }, { data: byCreated, error: e2 }, { data: fees }] = await Promise.all([
    db.from('reservations').select(COLS).gte('check_in', from).limit(5000),
    db.from('reservations').select(COLS).gte('created_at', `${from}T00:00:00+03:00`).limit(5000),
    db.from('guide_operation_cost_overrides').select('operation_key,tour_date,amount,currency').gte('tour_date', from).limit(5000),
  ]);
  if (e1 || e2) throw new Error((e1 || e2).message);
  const end = new Date(`${todayISO}T00:00:00+03:00`).getTime();
  const received = (byCreated || []).filter(r => new Date(r.created_at).getTime() < end);
  const done = (byTour || []).filter(r => String(r.check_in).slice(0, 10) <= to && r.status !== 'cancelled');
  const guests = done.reduce((n, r) => n + paxOf(r), 0);
  const operations = new Set(done.map(r => `${String(r.check_in).slice(0, 10)}|${r.tour_id || r.destination}`)).size;
  const noGuide = done.filter(r => !r.guide_id).length;

  const tours = new Map(), langs = new Map();
  for (const r of done) {
    const t = tours.get(r.destination || 'Tur') || { pax: 0, res: 0 }; t.pax += paxOf(r); t.res += 1; tours.set(r.destination || 'Tur', t);
    const l = r.tour_language || 'Belirtilmemiş'; langs.set(l, (langs.get(l) || 0) + 1);
  }
  const topTours = [...tours.entries()].sort((a, b) => b[1].pax - a[1].pax).slice(0, 5);
  const langList = [...langs.entries()].sort((a, b) => b[1] - a[1]);

  const feeRows = (fees || []).filter(f => String(f.operation_key || '').startsWith('fee|') && String(f.tour_date).slice(0, 10) <= to);
  const feeBy = new Map();
  for (const f of feeRows) feeBy.set(f.currency || 'EUR', (feeBy.get(f.currency || 'EUR') || 0) + (Number(f.amount) || 0));

  const lines = [
    `🆕 Yeni gelen rezervasyon: ${received.length}${received.length ? ` (${received.reduce((n, r) => n + paxOf(r), 0)} kişi${received.some(r => r.status === 'cancelled') ? `, ${received.filter(r => r.status === 'cancelled').length} tanesi iptal` : ''})` : ''}`,
    `🧭 Gerçekleşen tur: ${operations} operasyon, ${done.length} rezervasyon`,
    `👥 Katılan misafir: ${guests} kişi`,
    `💶 Rehber ücretleri: ${feeBy.size ? [...feeBy.entries()].map(([c, n]) => money(n, c)).join(' + ') + ` (${feeRows.length} operasyon)` : 'kayıt yok'}`,
  ];
  if (noGuide) lines.push(`⚠️ Rehber kaydı olmayan rezervasyon: ${noGuide}`);
  if (topTours.length) { lines.push('🏆 En çok katılım:'); topTours.forEach(([name, t], i) => lines.push(`${i + 1}) ${name} — ${t.pax} kişi, ${t.res} rezervasyon`)); }
  if (langList.length) lines.push(`🗣 Dile göre rezervasyon: ${langList.map(([l, n]) => `${l} ${n}`).join(' · ')}`);
  return { title: `Haftalık rapor (${shortDate(from)} – ${shortDate(to)})`, details: lines.join(' | '), from, to,
    received: received.length, reservations: done.length, guests, operations };
}

async function sendWeeklyReport({ db, notify, todayISO = istanbulISODate() }) {
  const r = await buildWeeklyReport({ db, todayISO });
  const res = await notify({ eventType: 'weekly_report', title: r.title, details: r.details, key: `weekly_report:${r.to}` });
  return { ok: res.ok, error: res.error, from: r.from, to: r.to, received: r.received, reservations: r.reservations, guests: r.guests };
}

module.exports = { buildWeeklyReport, sendWeeklyReport };
