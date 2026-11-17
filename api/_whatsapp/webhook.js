'use strict';
/**
 * api/_whatsapp/webhook.js — Meta webhook: verification handshake,
 * X-Hub-Signature-256 check, delivery statuses (sent → delivered → read,
 * or failed) and inbound messages (stored for the post-tour survey).
 */
const crypto = require('crypto');

function verifyHandshake(query, config) {
  if (query['hub.mode'] === 'subscribe' && config.verifyToken && query['hub.verify_token'] === config.verifyToken) {
    return { ok: true, challenge: String(query['hub.challenge'] || '') };
  }
  return { ok: false };
}

function verifySignature(rawBody, header, appSecret) {
  if (!appSecret || typeof header !== 'string' || !header.startsWith('sha256=')) return false;
  const expected = Buffer.from('sha256=' + crypto.createHmac('sha256', appSecret).update(rawBody).digest('hex'));
  const got = Buffer.from(header);
  return got.length === expected.length && crypto.timingSafeEqual(got, expected);
}

// Webhook URL secret (?key=…), compared in constant time. Used when the
// payload is signed with a provider's app secret (e.g. Dualhook's Webhook
// Override: Meta calls us directly, but the signature is not ours to check).
function verifyUrlKey(key, expected) {
  if (!expected || typeof key !== 'string') return false;
  const a = Buffer.from(key), b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

const RANK = { queued: 0, processing: 0, sent: 1, delivered: 2, read: 3, failed: 4 };

async function processWebhook(payload, db, opts = {}) {
  const { handleSurveyInbound } = require('./survey');
  const out = { statuses: 0, inbound: 0 };
  for (const entry of (payload && payload.entry) || []) {
    for (const change of entry.changes || []) {
      const v = change.value || {};
      for (const st of v.statuses || []) {
        const status = st.status === 'failed' ? 'failed' : ['sent', 'delivered', 'read'].includes(st.status) ? st.status : null;
        if (!status || !st.id) continue;
        const { data: row } = await db.from('whatsapp_messages').select('id,status').eq('provider_message_id', st.id).maybeSingle();
        if (!row || RANK[status] < RANK[row.status] || (row.status === 'failed' && status !== 'failed')) continue;
        const ts = st.timestamp ? new Date(Number(st.timestamp) * 1000).toISOString() : new Date().toISOString();
        const patch = { status };
        if (status === 'delivered') patch.delivered_at = ts;
        if (status === 'read') patch.read_at = ts;
        if (status === 'sent') patch.sent_at = ts;
        if (status === 'failed') { patch.failed_at = ts; patch.last_error = ((st.errors || [])[0] || {}).title || 'Meta: delivery failed'; }
        await db.from('whatsapp_messages').update(patch).eq('id', row.id);
        out.statuses += 1;
      }
      // Messages the team sent from the WhatsApp Business app on the phone
      // (coexistence): kept so the CRM thread shows both sides.
      for (const e of v.message_echoes || []) {
        const body = e.text ? e.text.body : e.type ? `(${e.type})` : null;
        if (!e.id || !e.to || !body) continue;
        const ts = e.timestamp ? new Date(Number(e.timestamp) * 1000).toISOString() : new Date().toISOString();
        await db.from('whatsapp_messages').upsert({
          event_type: 'app_echo', audience_type: 'customer', template_key: 'free_text', language: 'und', idempotency_key: `app_echo:${e.id}`,
          recipient_phone: String(e.to), payload: { text: String(body).slice(0, 4000) }, status: 'sent', provider_message_id: e.id, sent_at: ts, attempt_count: 0,
        }, { onConflict: 'idempotency_key', ignoreDuplicates: true });
        out.echoes = (out.echoes || 0) + 1;
      }
      const names = new Map((v.contacts || []).map(c => [c.wa_id, c.profile && c.profile.name]));
      for (const m of v.messages || []) {
        const text = m.text ? m.text.body : m.button ? m.button.text : m.interactive ? ((m.interactive.button_reply || m.interactive.list_reply || {}).title || null) : null;
        const buttonPayload = m.button ? m.button.payload : m.interactive ? ((m.interactive.button_reply || m.interactive.list_reply || {}).id || null) : null;
        const contextId = m.context ? m.context.id : null;
        let related = null;
        if (contextId) { const { data } = await db.from('whatsapp_messages').select('id').eq('provider_message_id', contextId).maybeSingle(); related = data ? data.id : null; }
        const inbound = {
          provider_message_id: m.id, from_phone: m.from, profile_name: names.get(m.from) || null, message_type: m.type || null,
          text: text ? String(text).slice(0, 4000) : null, button_payload: buttonPayload, context_message_id: contextId, related_message_id: related,
          received_at: m.timestamp ? new Date(Number(m.timestamp) * 1000).toISOString() : new Date().toISOString(),
        };
        const { data: fresh } = await db.from('whatsapp_inbound_messages').upsert(inbound, { onConflict: 'provider_message_id', ignoreDuplicates: true }).select('id');
        out.inbound += 1;
        // Meta may deliver the same message twice: act only on the first.
        if ((fresh || []).length && opts.config) {
          const r = await handleSurveyInbound({ db, config: opts.config, fetchImpl: opts.fetchImpl, inbound });
          if (r.handled) out.survey = (out.survey || 0) + 1;
        }
      }
    }
  }
  return out;
}

module.exports = { verifyHandshake, verifySignature, verifyUrlKey, processWebhook };
