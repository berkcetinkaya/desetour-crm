'use strict';
/**
 * api/_whatsapp/config.js — WhatsApp Business Cloud API (Meta) settings.
 * Every value is a SERVER-SIDE Vercel environment variable; nothing here
 * ever reaches the browser. Missing credentials never break the CRM:
 * messages stay queued until Meta is configured.
 *
 *   WHATSAPP_ACCESS_TOKEN       permanent system-user token (Meta Business)
 *   WHATSAPP_PHONE_NUMBER_ID    the sending number's Phone Number ID
 *   WHATSAPP_APP_SECRET         Meta app secret (webhook signature check)
 *   WHATSAPP_VERIFY_TOKEN       any string, typed into Meta's webhook form
 *   WHATSAPP_SCHEDULER_SECRET   header secret for the scheduled worker
 *   WHATSAPP_GRAPH_VERSION      optional, default v21.0
 */
function getWhatsAppConfig(env = process.env) {
  const accessToken = env.WHATSAPP_ACCESS_TOKEN || '';
  const phoneNumberId = env.WHATSAPP_PHONE_NUMBER_ID || '';
  return {
    accessToken, phoneNumberId,
    appSecret: env.WHATSAPP_APP_SECRET || '',
    verifyToken: env.WHATSAPP_VERIFY_TOKEN || '',
    schedulerSecret: env.WHATSAPP_SCHEDULER_SECRET || '',
    graphVersion: env.WHATSAPP_GRAPH_VERSION || 'v21.0',
    sendingConfigured: !!(accessToken && phoneNumberId),
  };
}

// Phone → WhatsApp "wa_id" digits (no +). Turkish local forms are
// completed with 90; anything that cannot be a phone returns null.
function normalizePhone(raw) {
  let d = String(raw == null ? '' : raw).replace(/[^\d+]/g, '');
  if (!d) return null;
  if (d.startsWith('+')) d = d.slice(1);
  else if (d.startsWith('00')) d = d.slice(2);
  else if (/^0\d{10}$/.test(d)) d = '90' + d.slice(1);
  else if (/^5\d{9}$/.test(d)) d = '90' + d;
  d = d.replace(/\D/g, '');
  return d.length >= 8 && d.length <= 15 ? d : null;
}

module.exports = { getWhatsAppConfig, normalizePhone };
