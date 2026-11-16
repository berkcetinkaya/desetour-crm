'use strict';
/**
 * api/_whatsapp/templates.js — the message templates DeseTour sends.
 * Business-initiated WhatsApp messages MUST use a template approved in
 * Meta (WhatsApp Manager → Message templates). `name`, `language` and the
 * number/order of {{n}} parameters here must match the approved template
 * exactly. `preview` renders the same text locally so the CRM can show
 * what will be sent.
 *
 * Meta rejects empty parameters and parameters containing new lines,
 * tabs or more than four consecutive spaces — params() cleans them.
 */
const TEMPLATES = {
  // Rehbere tur bilgisi (Utility, tr)
  guide_tour_brief: {
    name: 'desetour_rehber_tur_bilgisi', language: 'tr', category: 'UTILITY',
    body: 'Merhaba {{1}}, {{2}} tarihindeki {{3}} turunuzun bilgileri:\n🕘 Başlangıç: {{4}}\n🗣 Dil: {{5}}\n👥 Misafir: {{6}}\n📍 Buluşma: {{7}}\n📝 Not: {{8}}\nİyi turlar! — DeseTour Operasyon',
    params: ['guideName', 'dateLabel', 'tourName', 'time', 'language', 'guests', 'meetingPoint', 'note'],
  },
  // Operasyon ekibine bildirim / hatırlatma (Utility, tr)
  operations_notice: {
    name: 'desetour_operasyon_bildirimi', language: 'tr', category: 'UTILITY',
    body: '📣 DeseTour Operasyon — {{1}}\n{{2}}',
    params: ['title', 'details'],
  },
};

function cleanParam(v) {
  const s = String(v == null ? '' : v).replace(/[\r\n\t]+/g, ' · ').replace(/ {4,}/g, '   ').trim();
  return (s || '—').slice(0, 900);
}

function templateParams(templateKey, payload) {
  const t = TEMPLATES[templateKey];
  if (!t) throw new Error(`Unknown WhatsApp template: ${templateKey}`);
  return t.params.map(k => cleanParam(payload && payload[k]));
}

function renderPreview(templateKey, payload) {
  const t = TEMPLATES[templateKey];
  const p = templateParams(templateKey, payload);
  return t.body.replace(/\{\{(\d+)\}\}/g, (_, n) => p[Number(n) - 1]);
}

module.exports = { TEMPLATES, templateParams, renderPreview, cleanParam };
