'use strict';
/**
 * api/_whatsapp/metaClient.js — one call: send an approved template to one
 * phone through the WhatsApp Business Cloud API. Returns a normalized
 * result; never throws for an API error (the worker decides on retry).
 */
const { TEMPLATES, templateParams, templateLanguage } = require('./templates');

function graphUrl(config) { return `https://graph.facebook.com/${config.graphVersion}/${config.phoneNumberId}/messages`; }

// lang: language for multi-language templates (survey); buttonPayloads:
// quick-reply payload per button index.
async function sendTemplate({ config, to, templateKey, payload, lang, buttonPayloads, fetchImpl }) {
  const t = TEMPLATES[templateKey];
  const components = [{ type: 'body', parameters: templateParams(templateKey, payload).map(text => ({ type: 'text', text })) }];
  (buttonPayloads || []).forEach((p, i) => components.push({ type: 'button', sub_type: 'quick_reply', index: String(i), parameters: [{ type: 'payload', payload: p }] }));
  return post(config, { messaging_product: 'whatsapp', recipient_type: 'individual', to, type: 'template',
    template: { name: t.name, language: { code: templateLanguage(templateKey, lang) }, components } }, fetchImpl);
}

// Free-form text — only allowed within 24 h of the recipient's last message.
async function sendText({ config, to, text, fetchImpl }) {
  return post(config, { messaging_product: 'whatsapp', recipient_type: 'individual', to, type: 'text', text: { preview_url: true, body: String(text).slice(0, 4000) } }, fetchImpl);
}

async function post(config, body, fetchImpl) {
  const url = graphUrl(config);
  let res, json;
  try {
    res = await (fetchImpl || fetch)(url, { method: 'POST', headers: { Authorization: `Bearer ${config.accessToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    json = await res.json().catch(() => ({}));
  } catch (e) {
    return { ok: false, retryable: true, error: `network: ${e.message}` };
  }
  if (res.ok && json && Array.isArray(json.messages) && json.messages[0] && json.messages[0].id) {
    return { ok: true, providerMessageId: json.messages[0].id };
  }
  const err = (json && json.error) || {};
  // 429 / 5xx / Meta throttling codes are worth retrying; template,
  // recipient and permission errors are not.
  const retryable = res.status === 429 || res.status >= 500 || [4, 80007, 130429, 131016, 131048, 131056].includes(err.code);
  return { ok: false, retryable, error: `${res.status} ${err.code || ''} ${err.message || 'unknown error'}`.trim().slice(0, 500) };
}

module.exports = { sendTemplate, sendText };
