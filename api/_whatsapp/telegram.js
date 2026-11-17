'use strict';
/**
 * api/_whatsapp/telegram.js — team notifications to a Telegram group.
 *
 * WhatsApp's API cannot post into an existing WhatsApp group, so the
 * internal team feed (new booking, cancellation, Civitatis change, client
 * message, tomorrow's summary, manual team notice) goes to a Telegram
 * group through a bot. Guides and customers stay on WhatsApp.
 *
 *   TELEGRAM_BOT_TOKEN   server-side Vercel env var (from @BotFather)
 *   the group            chosen in CRM → Ayarlar → WhatsApp, stored as the
 *                        "telegram" row of whatsapp_destinations
 *                        (provider_group_id = Telegram chat id — an
 *                        identifier, not a credential)
 *
 * Every notice is recorded in whatsapp_messages (template_key 'telegram',
 * already sent — the WhatsApp worker never touches it) with a unique
 * idempotency_key, so one event is announced once.
 */
function telegramConfig(env = process.env) {
  const token = env.TELEGRAM_BOT_TOKEN || '';
  return { token, configured: !!token };
}

async function tgCall(tg, method, body, fetchImpl) {
  let res, json;
  try {
    res = await (fetchImpl || fetch)(`https://api.telegram.org/bot${tg.token}/${method}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
    json = await res.json().catch(() => ({}));
  } catch (e) { return { ok: false, error: 'network: ' + e.message }; }
  return json && json.ok ? { ok: true, result: json.result } : { ok: false, error: `${res.status} ${(json && json.description) || 'unknown error'}`.slice(0, 300) };
}

// Groups the bot can see right now (it was added to them or saw a message).
async function listGroups(tg, fetchImpl) {
  const r = await tgCall(tg, 'getUpdates', { limit: 100, allowed_updates: ['message', 'my_chat_member'] }, fetchImpl);
  if (!r.ok) return r;
  const seen = new Map();
  for (const u of r.result || []) {
    const chat = (u.message && u.message.chat) || (u.my_chat_member && u.my_chat_member.chat);
    if (chat && (chat.type === 'group' || chat.type === 'supergroup')) seen.set(String(chat.id), { id: String(chat.id), title: chat.title || 'Grup' });
  }
  return { ok: true, groups: [...seen.values()] };
}

async function getTelegramDestination(db) {
  const { data } = await db.from('whatsapp_destinations').select('id,display_name,provider_group_id,is_active').eq('destination_key', 'telegram').maybeSingle();
  return data && data.is_active && data.provider_group_id ? { id: data.id, chatId: data.provider_group_id, title: data.display_name } : null;
}

async function connectGroup({ db, tg, chatId, title, fetchImpl }) {
  const id = String(chatId || '').trim();
  if (!/^-?\d{5,20}$/.test(id)) return { ok: false, status: 400, error: 'Geçersiz grup.' };
  const test = await tgCall(tg, 'sendMessage', { chat_id: id, text: '✅ DeseTour CRM bu gruba bağlandı. Yeni rezervasyon, iptal, değişiklik, müşteri mesajı ve yarının tur özeti buraya düşecek.' }, fetchImpl);
  if (!test.ok) return { ok: false, status: 502, error: 'Telegram gruba yazamadı: ' + test.error };
  const row = { destination_key: 'telegram', display_name: String(title || 'Telegram grubu').slice(0, 120), transport_mode: 'meta_group', provider_group_id: id, is_active: true };
  const { error } = await db.from('whatsapp_destinations').upsert(row, { onConflict: 'destination_key' });
  if (error) throw new Error(error.message);
  return { ok: true, title: row.display_name };
}

async function disconnectGroup({ db }) {
  const { error } = await db.from('whatsapp_destinations').update({ is_active: false }).eq('destination_key', 'telegram');
  if (error) throw new Error(error.message);
  return { ok: true };
}

function noticeText(title, details) {
  const lines = String(details || '').split(/\s+\|\s+/).map(x => x.trim()).filter(Boolean);
  return `📣 ${String(title || '').trim()}\n${lines.join('\n')}`.slice(0, 3900);
}

// One notice → the group, once per key. Returns the same shape as
// enqueueOperationsNotice so callers can use either.
async function sendTelegramNotice({ db, tg, dest, eventType, title, details, key, fetchImpl }) {
  const idem = `tg:${key}`;
  const { data: prior } = await db.from('whatsapp_messages').select('id').eq('idempotency_key', idem).maybeSingle();
  if (prior) return { ok: true, ids: [], recipients: 1, channel: 'telegram', duplicate: true };
  const text = noticeText(title, details);
  const r = await tgCall(tg, 'sendMessage', { chat_id: dest.chatId, text, disable_web_page_preview: true }, fetchImpl);
  if (!r.ok) return { ok: false, status: 502, error: 'Telegram: ' + r.error };
  const t = new Date().toISOString();
  await db.from('whatsapp_messages').upsert({
    event_type: eventType, audience_type: 'operations', template_key: 'telegram', language: 'tr', idempotency_key: idem, destination_id: dest.id,
    recipient_display_name: 'Telegram · ' + dest.title, payload: { title, details, text }, status: 'sent', sent_at: t, attempt_count: 1, last_attempt_at: t,
  }, { onConflict: 'idempotency_key', ignoreDuplicates: true });
  return { ok: true, ids: [], recipients: 1, channel: 'telegram', preview: text };
}

module.exports = { telegramConfig, tgCall, listGroups, getTelegramDestination, connectGroup, disconnectGroup, sendTelegramNotice, noticeText };
