'use strict';
/**
 * api/_whatsapp/worker.js — sends due messages from public.whatsapp_messages.
 * Rows are claimed atomically by public.whatsapp_claim_due_messages (FOR
 * UPDATE SKIP LOCKED), so two runs never send the same row. A retryable
 * Meta error puts the row back in the queue with exponential backoff
 * (2, 4, 8, 16 min); after MAX_ATTEMPTS, or on a permanent error, the row
 * is 'failed' with the reason. Without Meta credentials nothing is
 * claimed — messages simply wait.
 */
const { sendTemplate } = require('./metaClient');
const { normalizePhone } = require('./config');
const { TEMPLATES } = require('./templates');

const MAX_ATTEMPTS = 5;

async function runWorker({ db, config, limit = 25, ids = null, fetchImpl, now = () => new Date() }) {
  if (!config.sendingConfigured) return { configured: false, claimed: 0, sent: 0, failed: 0, retried: 0 };
  const { data: rows, error } = await db.rpc('whatsapp_claim_due_messages', { p_limit: limit, p_ids: ids && ids.length ? ids : null });
  if (error) throw new Error(`claim failed: ${error.message}`);
  const out = { configured: true, claimed: (rows || []).length, sent: 0, failed: 0, retried: 0, results: [] };
  for (const row of rows || []) {
    const to = normalizePhone(row.recipient_phone);
    let r;
    if (!to) r = { ok: false, retryable: false, error: 'Geçersiz veya boş telefon numarası' };
    else if (!TEMPLATES[row.template_key]) r = { ok: false, retryable: false, error: `Bilinmeyen şablon: ${row.template_key}` };
    else r = await sendTemplate({ config, to, templateKey: row.template_key, payload: row.payload || {}, lang: row.language, fetchImpl,
      buttonPayloads: row.template_key === 'post_tour_survey' ? TEMPLATES.post_tour_survey.buttons.map(x => 'svy:' + x) : null });
    const t = now();
    let patch;
    if (r.ok) { patch = { status: 'sent', provider_message_id: r.providerMessageId, sent_at: t.toISOString(), last_error: null, next_attempt_at: null }; out.sent += 1; }
    else if (r.retryable && row.attempt_count < MAX_ATTEMPTS) {
      patch = { status: 'queued', last_error: r.error, next_attempt_at: new Date(t.getTime() + Math.pow(2, row.attempt_count) * 60000).toISOString() }; out.retried += 1;
    } else { patch = { status: 'failed', last_error: r.error, failed_at: t.toISOString(), next_attempt_at: null }; out.failed += 1; }
    const { error: upErr } = await db.from('whatsapp_messages').update(patch).eq('id', row.id);
    if (upErr) throw new Error(`update failed: ${upErr.message}`);
    out.results.push({ id: row.id, status: patch.status, error: patch.last_error || null });
  }
  return out;
}

module.exports = { runWorker, MAX_ATTEMPTS };
