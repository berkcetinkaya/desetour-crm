'use strict';
/**
 * api/_whatsapp/survey.js — post-tour survey.
 *
 *  1. enqueueSurvey / enqueueDailySurveys: on the tour day (evening) every
 *     non-cancelled reservation whose customer has a phone gets ONE survey
 *     template in the booking's language (idempotency: one per reservation).
 *  2. handleSurveyInbound (from the webhook):
 *     • a tap on a survey button (payload svy:great|good|poor, context = the
 *       survey message) → saved in reservation_feedback; great/good get the
 *       tour's review link (tour_channels.review_url), poor gets "what could
 *       we improve?";
 *     • a text from the same phone within 3 days of a "poor" answer without
 *       a comment yet → saved as the comment, thanked.
 *     Replies are free-form texts (allowed: the customer just wrote to us).
 */
const { normalizePhone } = require('./config');
const { SURVEY_REPLIES, surveyLanguage, renderPreview } = require('./templates');
const { sendText } = require('./metaClient');
const { istanbulISODate } = require('./enqueue');

const RES_COLS = 'id,reservation_number,check_in,tour_id,destination,tour_language,status,customer_id,source_id';

async function surveyRowFor(db, r) {
  const [{ data: cust }, { data: tour }] = await Promise.all([
    r.customer_id ? db.from('customers').select('id,full_name,phone').eq('id', r.customer_id).maybeSingle() : Promise.resolve({ data: null }),
    r.tour_id ? db.from('tours').select('name').eq('id', r.tour_id).maybeSingle() : Promise.resolve({ data: null }),
  ]);
  const phone = cust ? normalizePhone(cust.phone) : null;
  if (!phone) return { ok: false, status: 422, error: 'Müşterinin telefon numarası kayıtlı değil.' };
  const lang = surveyLanguage(r.tour_language);
  const firstName = String((cust && cust.full_name) || '').trim().split(/\s+/)[0] || '';
  const payload = { customerName: firstName ? firstName.charAt(0).toUpperCase() + firstName.slice(1).toLowerCase() : '', tourName: (tour && tour.name) || r.destination || '' };
  return { ok: true, row: {
    event_type: 'post_tour_survey', audience_type: 'customer', template_key: 'post_tour_survey', language: lang,
    idempotency_key: `post_tour_survey:${r.id}`, reservation_id: r.id, customer_id: r.customer_id, tour_id: r.tour_id,
    recipient_phone: phone, recipient_display_name: (cust && cust.full_name) || null, payload,
  }, preview: renderPreview('post_tour_survey', payload, lang) };
}

async function enqueueSurvey({ db, reservationId }) {
  const { data: r, error } = await db.from('reservations').select(RES_COLS).eq('id', reservationId).maybeSingle();
  if (error) throw new Error(error.message);
  if (!r) return { ok: false, status: 404, error: 'Rezervasyon bulunamadı.' };
  if (r.status === 'cancelled') return { ok: false, status: 409, error: 'İptal edilmiş rezervasyona anket gönderilmez.' };
  const built = await surveyRowFor(db, r);
  if (!built.ok) return built;
  const { data, error: e2 } = await db.from('whatsapp_messages').upsert(built.row, { onConflict: 'idempotency_key', ignoreDuplicates: true }).select('id');
  if (e2) throw new Error(e2.message);
  if (!(data || []).length) return { ok: false, status: 409, error: 'Bu rezervasyona anket zaten gönderildi.' };
  return { ok: true, ids: data.map(x => x.id), preview: built.preview };
}

// "Yorum ve puan iste": the tour page / review link straight to the
// customer, once per reservation, in the booking language.
async function enqueueReviewRequest({ db, reservationId }) {
  const { data: r, error } = await db.from('reservations').select(RES_COLS).eq('id', reservationId).maybeSingle();
  if (error) throw new Error(error.message);
  if (!r) return { ok: false, status: 404, error: 'Rezervasyon bulunamadı.' };
  if (r.status === 'cancelled') return { ok: false, status: 409, error: 'İptal edilmiş rezervasyona yorum isteği gönderilmez.' };
  const built = await surveyRowFor(db, r);
  if (!built.ok) return built;
  const url = await reviewUrlFor(db, r);
  if (!url) return { ok: false, status: 422, error: 'Bu turun sayfa / puanlama linki girilmemiş (Turlar → kanal ayarları → Listing URL).' };
  const payload = { ...built.row.payload, reviewUrl: url };
  const row = { ...built.row, event_type: 'review_request', template_key: 'review_request', idempotency_key: `review_request:${r.id}`, payload };
  const { data, error: e2 } = await db.from('whatsapp_messages').upsert(row, { onConflict: 'idempotency_key', ignoreDuplicates: true }).select('id');
  if (e2) throw new Error(e2.message);
  if (!(data || []).length) return { ok: false, status: 409, error: 'Bu rezervasyona yorum isteği zaten gönderildi.' };
  return { ok: true, ids: data.map(x => x.id), preview: renderPreview('review_request', payload, row.language) };
}

async function enqueueDailySurveys({ db, todayISO = istanbulISODate() }) {
  const { data, error } = await db.from('reservations').select(RES_COLS).eq('check_in', todayISO);
  if (error) throw new Error(error.message);
  const out = { date: todayISO, reservations: 0, queued: 0, missingPhone: 0, ids: [] };
  for (const r of (data || []).filter(x => x.status !== 'cancelled')) {
    out.reservations += 1;
    const built = await surveyRowFor(db, r);
    if (!built.ok) { out.missingPhone += 1; continue; }
    const { data: ins } = await db.from('whatsapp_messages').upsert(built.row, { onConflict: 'idempotency_key', ignoreDuplicates: true }).select('id');
    (ins || []).forEach(x => { out.ids.push(x.id); out.queued += 1; });
  }
  return out;
}

async function reviewUrlFor(db, reservation) {
  if (!reservation || !reservation.tour_id) return null;
  // The channel's own review link, otherwise its tour page (listing_url —
  // the Civitatis page desetour.com links to), same language first.
  const { data } = await db.from('tour_channels').select('review_url,listing_url,booking_language,source_id,is_active').eq('tour_id', reservation.tour_id);
  const rows = (data || []).filter(c => (c.review_url || c.listing_url) && c.is_active !== false);
  const pick = rows.find(c => c.source_id === reservation.source_id && c.booking_language === reservation.tour_language)
    || rows.find(c => c.booking_language === reservation.tour_language)
    || rows.find(c => c.source_id === reservation.source_id && !c.booking_language)
    || rows.find(c => !c.booking_language) || rows[0];
  return pick ? (pick.review_url || pick.listing_url) : null;
}

async function reply({ db, config, fetchImpl, to, text, original, inboundId }) {
  const row = { event_type: 'survey_reply', audience_type: 'customer', template_key: 'free_text', language: original.language || 'en',
    idempotency_key: `survey_reply:${inboundId}`, reservation_id: original.reservation_id, customer_id: original.customer_id,
    recipient_phone: to, recipient_display_name: original.recipient_display_name, payload: { text } };
  if (!config.sendingConfigured) return null;
  const r = await sendText({ config, to, text, fetchImpl });
  const t = new Date().toISOString();
  await db.from('whatsapp_messages').upsert({ ...row, status: r.ok ? 'sent' : 'failed', provider_message_id: r.ok ? r.providerMessageId : null,
    sent_at: r.ok ? t : null, failed_at: r.ok ? null : t, last_error: r.ok ? null : r.error, attempt_count: 1, last_attempt_at: t }, { onConflict: 'idempotency_key', ignoreDuplicates: true });
  return r;
}

const RATING = { 'svy:great': 'great', 'svy:good': 'good', 'svy:poor': 'poor' };

async function handleSurveyInbound({ db, config, fetchImpl, inbound }) {
  const lang = (o) => (SURVEY_REPLIES[o.language] ? o.language : 'en');
  const rating = RATING[inbound.button_payload || ''];
  if (rating && inbound.context_message_id) {
    const { data: original } = await db.from('whatsapp_messages').select('*').eq('provider_message_id', inbound.context_message_id).maybeSingle();
    if (!original || original.event_type !== 'post_tour_survey' || !original.reservation_id) return { handled: false };
    const now = new Date().toISOString();
    await db.from('reservation_feedback').upsert({ reservation_id: original.reservation_id, customer_id: original.customer_id, rating,
      source: 'whatsapp', whatsapp_message_id: original.id, answered_at: now }, { onConflict: 'reservation_id' });
    const L = SURVEY_REPLIES[lang(original)];
    let text = L.ask;
    if (rating !== 'poor') {
      const { data: res } = await db.from('reservations').select(RES_COLS).eq('id', original.reservation_id).maybeSingle();
      const url = await reviewUrlFor(db, res);
      text = url ? L.link(url) : L.thanks;
    }
    await reply({ db, config, fetchImpl, to: inbound.from_phone, text, original, inboundId: inbound.provider_message_id });
    return { handled: true, rating };
  }
  if (inbound.message_type === 'text' && inbound.text) {
    // A comment after a "poor" answer from the same phone (last 3 days).
    const since = new Date(Date.now() - 3 * 86400000).toISOString();
    const { data: surveys } = await db.from('whatsapp_messages').select('*').eq('event_type', 'post_tour_survey').eq('recipient_phone', inbound.from_phone);
    for (const s of (surveys || []).sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')))) {
      const { data: fb } = await db.from('reservation_feedback').select('*').eq('reservation_id', s.reservation_id).maybeSingle();
      if (fb && fb.rating === 'poor' && !fb.comment && String(fb.answered_at || '') >= since) {
        await db.from('reservation_feedback').update({ comment: String(inbound.text).slice(0, 2000), comment_at: new Date().toISOString() }).eq('reservation_id', s.reservation_id);
        await reply({ db, config, fetchImpl, to: inbound.from_phone, text: SURVEY_REPLIES[lang(s)].got, original: s, inboundId: inbound.provider_message_id });
        return { handled: true, comment: true };
      }
    }
  }
  return { handled: false };
}

module.exports = { enqueueSurvey, enqueueReviewRequest, enqueueDailySurveys, handleSurveyInbound, reviewUrlFor };
