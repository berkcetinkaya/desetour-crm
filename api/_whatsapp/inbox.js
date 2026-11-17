'use strict';
/**
 * api/_whatsapp/inbox.js — reply from the CRM WhatsApp window.
 * WhatsApp only allows a free-form message within 24 hours of the other
 * side's last message; outside that window the reply is refused with a
 * clear message (write from the phone app, or wait for their message).
 */
const { normalizePhone } = require('./config');
const { sendText } = require('./metaClient');

const WINDOW_MS = 24 * 3600 * 1000;

async function sendReply({ db, config, phone, text, requestId, fetchImpl, now = () => new Date() }) {
  const to = normalizePhone(phone);
  const body = String(text || '').trim();
  if (!to) return { ok: false, status: 422, error: 'Geçersiz telefon numarası.' };
  if (!body) return { ok: false, status: 400, error: 'Mesaj boş.' };
  if (!config.sendingConfigured) return { ok: false, status: 409, error: 'WhatsApp bağlantısı henüz kurulmadı.' };
  const { data: inbound } = await db.from('whatsapp_inbound_messages').select('received_at,profile_name').eq('from_phone', to).order('received_at', { ascending: false }).limit(1);
  const last = (inbound || []).slice().sort((a, b) => String(b.received_at).localeCompare(String(a.received_at)))[0];
  if (!last || now().getTime() - new Date(last.received_at).getTime() > WINDOW_MS) {
    return { ok: false, status: 409, error: 'Bu kişi son 24 saatte yazmadı; WhatsApp serbest mesaja izin vermiyor. Telefondaki WhatsApp\'tan yazabilir ya da karşı tarafın mesajını bekleyebilirsiniz.' };
  }
  const r = await sendText({ config, to, text: body, fetchImpl });
  const t = now().toISOString();
  await db.from('whatsapp_messages').upsert({
    event_type: 'crm_reply', audience_type: 'customer', template_key: 'free_text', language: 'und', idempotency_key: `crm_reply:${requestId}`,
    recipient_phone: to, recipient_display_name: last.profile_name || null, payload: { text: body },
    status: r.ok ? 'sent' : 'failed', provider_message_id: r.ok ? r.providerMessageId : null, sent_at: r.ok ? t : null, failed_at: r.ok ? null : t,
    last_error: r.ok ? null : r.error, attempt_count: 1, last_attempt_at: t,
  }, { onConflict: 'idempotency_key', ignoreDuplicates: true });
  return r.ok ? { ok: true } : { ok: false, status: 502, error: 'Gönderilemedi: ' + r.error };
}

module.exports = { sendReply, WINDOW_MS };
