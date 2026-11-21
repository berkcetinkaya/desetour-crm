'use strict';
/**
 * api/_civitatis/pickupPoint.js — the customer's chosen pickup point.
 *
 * Civitatis booking emails for products without a fixed "Hour" (e.g.
 * Bosforo y Barrio Sultanahmet, Estambul Histórica) state the meeting
 * point and its time instead:
 *     PICKUP POINT: Tamara Restaurant Sultanahmed, às 8:45 horas.
 *     PICKUP POINT: Tamara Restaurant Sultanahmed, alle 8:45.
 * The ingestion RPC does not store it, so this fills the reservation's
 * own pickup_location / pickup_time (the same fields the CRM's "Pickup
 * Bilgisi" edits) from the stored email — only when they are still empty,
 * never overwriting what the team entered. check_in_time is NOT touched:
 * the pickup time is the meeting time, not the tour's start.
 */
function parsePickupPoint(body) {
  const m = String(body || '').match(/PICKUP POINT:[ \t]*([^\n\r]+)/i);
  if (!m) return null;
  const raw = m[1].replace(/\s+/g, ' ').trim();
  const t = raw.match(/(\d{1,2})[:.h](\d{2})/);
  const time = t && Number(t[1]) < 24 ? `${String(t[1]).padStart(2, '0')}:${t[2]}` : null;
  // "Place, às 8:45 horas." → "Place"; keep the text as is when no time is found.
  let location = t ? raw.slice(0, t.index).replace(/[,\s]*(às|as|at|a las|alle|à|ore|um|vers)?\s*$/i, '').trim() : raw.replace(/[.\s]+$/, '');
  if (!location) location = raw;
  return { location: location.slice(0, 300), time, raw };
}

// Reservations from yesterday on whose pickup is still empty get it from
// their latest stored Civitatis email that has a PICKUP POINT line.
async function fillMissingPickups({ db, sinceISO }) {
  const { data: res, error } = await db.from('reservations').select('id,external_booking_id,pickup_location,pickup_time,check_in,status')
    .gte('check_in', sinceISO).limit(2000);
  if (error) throw new Error(error.message);
  const out = { checked: 0, filled: 0 };
  for (const r of (res || []).filter(x => x.external_booking_id && !String(x.pickup_location || '').trim() && x.status !== 'cancelled')) {
    out.checked += 1;
    const { data: mails } = await db.from('email_ingestions').select('raw_body_snapshot,received_at').eq('external_booking_id', r.external_booking_id).limit(20);
    const p = (mails || []).slice().sort((a, b) => String(b.received_at || '').localeCompare(String(a.received_at || '')))
      .map(m => parsePickupPoint(m.raw_body_snapshot)).find(Boolean);
    if (!p) continue;
    const patch = { pickup_location: p.location };
    if (p.time && !r.pickup_time) patch.pickup_time = p.time;
    const { error: upErr } = await db.from('reservations').update(patch).eq('id', r.id);
    if (upErr) throw new Error(upErr.message);
    out.filled += 1;
  }
  return out;
}

module.exports = { parsePickupPoint, fillMissingPickups };
