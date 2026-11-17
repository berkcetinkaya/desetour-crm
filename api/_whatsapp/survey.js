'use strict';
/**
 * api/_whatsapp/survey.js — post-tour feedback and review request.
 *
 *  1. enqueueSurvey (reservation page → "Geri bildirim iste"): ONE feedback
 *     template per reservation, in the booking's language: thanks + "how
 *     was the tour, 1 to 5?" (five buttons).
 *  2. handleSurveyInbound (from the webhook) walks the customer through:
 *       tour score (button or a typed 1–5) → "and your guide, 1–5?"
 *       guide score (typed 1–5)            → "any feedback for us?"
 *       free text                          → saved as the comment, thanks.
 *     Answers are saved in reservation_feedback (tour_score, guide_score,
 *     comment). Follow-up questions are free-form texts (allowed: the
 *     customer just wrote to us). The team is told when feedback arrives.
 *  3. enqueueReviewRequest (reservation page → "Yorum ve puan iste"): the
 *     tour's Civitatis page, sent by the team the next day when the
 *     answers are positive. Never sent automatically.
 *  4. feedbackReminder: the evening list for the team — today's finished
 *     tours still without a feedback request, and positive answers still
 *     without a review request.
 */
const { normalizePhone } = require('./config');
const { FEEDBACK_REPLIES, surveyLanguage, renderPreview } = require('./templates');
const { sendText } = require('./metaClient');
const { istanbulISODate, addDays } = require('./enqueue');

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
  if (r.status === 'cancelled') return { ok: false, status: 409, error: 'İptal edilmiş rezervasyona geri bildirim mesajı gönderilmez.' };
  const built = await surveyRowFor(db, r);
  if (!built.ok) return built;
  const { data, error: e2 } = await db.from('whatsapp_messages').upsert(built.row, { onConflict: 'idempotency_key', ignoreDuplicates: true }).select('id');
  if (e2) throw new Error(e2.message);
  if (!(data || []).length) return { ok: false, status: 409, error: 'Bu rezervasyona geri bildirim mesajı zaten gönderildi.' };
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

const isPositive = (fb) => !!fb && Number(fb.tour_score) >= 4 && (fb.guide_score == null || Number(fb.guide_score) >= 4);

// Evening reminder for the team (goes with the daily summary): who can be
// asked for feedback today, and whose positive answer is waiting for a
// review request. Returns null when there is nothing to do.
async function feedbackReminder({ db, todayISO = istanbulISODate() }) {
  const { data: today, error } = await db.from('reservations').select(RES_COLS).eq('check_in', todayISO);
  if (error) throw new Error(error.message);
  const ask = [], noPhone = [];
  for (const r of (today || []).filter(x => x.status !== 'cancelled')) {
    const { data: sent } = await db.from('whatsapp_messages').select('id').eq('idempotency_key', `post_tour_survey:${r.id}`).maybeSingle();
    if (sent) continue;
    const { data: cust } = r.customer_id ? await db.from('customers').select('phone').eq('id', r.customer_id).maybeSingle() : { data: null };
    (cust && normalizePhone(cust.phone) ? ask : noPhone).push(r.reservation_number);
  }
  const { data: fbs } = await db.from('reservation_feedback').select('reservation_id,tour_score,guide_score,answered_at').gte('answered_at', addDays(todayISO, -7));
  const review = [];
  for (const fb of (fbs || []).filter(isPositive)) {
    const { data: sent } = await db.from('whatsapp_messages').select('id').eq('idempotency_key', `review_request:${fb.reservation_id}`).maybeSingle();
    if (sent) continue;
    const { data: r } = await db.from('reservations').select('reservation_number').eq('id', fb.reservation_id).maybeSingle();
    if (r) review.push(`${r.reservation_number} (tur ${fb.tour_score}/5${fb.guide_score != null ? `, rehber ${fb.guide_score}/5` : ''})`);
  }
  if (!ask.length && !noPhone.length && !review.length) return null;
  const parts = [];
  if (ask.length) parts.push(`Bugün turu biten, geri bildirim istenebilecek: ${ask.join(', ')}`);
  if (noPhone.length) parts.push(`Telefonu kayıtlı olmayan: ${noPhone.join(', ')}`);
  if (review.length) parts.push(`Olumlu yanıt verdi, yorum/puan istenebilir: ${review.join(', ')}`);
  return { title: 'Geri bildirim hatırlatması', details: parts.join(' | '), ask: ask.length, noPhone: noPhone.length, review: review.length };
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

// "5", "5 ⭐", "un 4", "4/5" → 1…5; anything else → null.
function parseScore(inbound) {
  const p = /^svy:([1-5])$/.exec(inbound.button_payload || '');
  if (p) return Number(p[1]);
  const t = String(inbound.text || '').trim();
  const m = /^\D{0,12}([1-5])(?:\s*\/\s*5)?\D{0,12}$/.exec(t);
  return m && t.length <= 20 ? Number(m[1]) : null;
}
const ratingOf = (score) => (score >= 5 ? 'great' : score === 4 ? 'good' : 'poor');

async function handleSurveyInbound({ db, config, fetchImpl, inbound, notify, now = () => new Date() }) {
  // The latest feedback request to this phone (last 3 days).
  const since = new Date(now().getTime() - 3 * 86400000).toISOString();
  const { data: surveys } = await db.from('whatsapp_messages').select('*').eq('event_type', 'post_tour_survey').eq('recipient_phone', inbound.from_phone);
  const s = (surveys || []).filter(x => x.reservation_id && x.status !== 'failed' && String(x.sent_at || x.created_at || since) >= since)
    .sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')))[0];
  if (!s) return { handled: false };
  const L = FEEDBACK_REPLIES[FEEDBACK_REPLIES[s.language] ? s.language : 'en'];
  const say = (text) => reply({ db, config, fetchImpl, to: inbound.from_phone, text, original: s, inboundId: inbound.provider_message_id });
  const { data: fb } = await db.from('reservation_feedback').select('*').eq('reservation_id', s.reservation_id).maybeSingle();
  const score = parseScore(inbound);
  const t = now().toISOString();
  if (!fb) {
    if (score == null) return { handled: false };
    await db.from('reservation_feedback').upsert({ reservation_id: s.reservation_id, customer_id: s.customer_id, rating: ratingOf(score), tour_score: score,
      source: 'whatsapp', whatsapp_message_id: s.id, answered_at: t }, { onConflict: 'reservation_id' });
    await say(L.guide);
    return { handled: true, step: 'tour', score };
  }
  if (fb.guide_score == null && fb.comment == null) {
    if (score == null) return { handled: false };
    await db.from('reservation_feedback').update({ guide_score: score }).eq('reservation_id', s.reservation_id);
    await say(L.comment);
    return { handled: true, step: 'guide', score };
  }
  if (fb.comment == null && inbound.message_type === 'text' && inbound.text) {
    const comment = String(inbound.text).slice(0, 2000);
    await db.from('reservation_feedback').update({ comment, comment_at: t }).eq('reservation_id', s.reservation_id);
    await say(L.thanks);
    if (notify) {
      const { data: r } = await db.from('reservations').select('reservation_number,destination').eq('id', s.reservation_id).maybeSingle();
      const done = { ...fb, comment };
      await notify({ eventType: 'crm_event_feedback', title: `Geri bildirim geldi ${(r && r.reservation_number) || ''}`.trim(),
        details: `${(r && r.destination) || 'Tur'} | Tur: ${fb.tour_score}/5 · Rehber: ${fb.guide_score}/5 | Yorum: ${comment.slice(0, 600)}${isPositive(done) ? ' | Olumlu — yarın yorum/puan isteyebilirsiniz' : ''}`,
        key: `feedback:${s.reservation_id}` }).catch(() => null);
    }
    return { handled: true, step: 'comment' };
  }
  return { handled: false };
}

module.exports = { enqueueSurvey, enqueueReviewRequest, feedbackReminder, handleSurveyInbound, reviewUrlFor, parseScore, isPositive };
