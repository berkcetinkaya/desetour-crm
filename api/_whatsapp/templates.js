'use strict';
/**
 * api/_whatsapp/templates.js — the message templates DeseTour sends.
 * Business-initiated WhatsApp messages MUST use a template approved in
 * Meta (WhatsApp Manager → Message templates). `name`, language and the
 * number/order of {{n}} parameters here must match the approved template
 * exactly (see WHATSAPP_SETUP.md). `renderPreview` renders the same text
 * locally so the CRM can show what will be sent.
 *
 * Meta rejects empty parameters and parameters containing new lines,
 * tabs or more than four consecutive spaces — cleanParam() handles that.
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
  // Tur sonrası anket: one template name approved in several languages,
  // three quick-reply buttons whose payload the server sets (svy:<rating>).
  post_tour_survey: {
    name: 'desetour_tur_sonrasi_anket', category: 'UTILITY', params: ['customerName', 'tourName'],
    ratings: ['great', 'good', 'poor'],
    languages: {
      es: { body: '¡Hola {{1}}! Gracias por hacer el tour {{2}} con DeseTour. ¿Qué te ha parecido?', buttons: ['😍 Excelente', '🙂 Bien', '😕 Mejorable'] },
      pt_BR: { body: 'Olá {{1}}! Obrigado por fazer o passeio {{2}} com a DeseTour. O que você achou?', buttons: ['😍 Excelente', '🙂 Bom', '😕 Pode melhorar'] },
      it: { body: "Ciao {{1}}! Grazie per aver fatto il tour {{2}} con DeseTour. Com'è andata?", buttons: ['😍 Ottimo', '🙂 Bene', '😕 Migliorabile'] },
      en: { body: 'Hi {{1}}! Thank you for joining the {{2}} tour with DeseTour. How was your experience?', buttons: ['😍 Excellent', '🙂 Good', '😕 Could be better'] },
      tr: { body: 'Merhaba {{1}}! {{2}} turunu DeseTour ile yaptığınız için teşekkürler. Nasıldı?', buttons: ['😍 Harika', '🙂 İyi', '😕 Geliştirilebilir'] },
    },
  },
};

// Free-form replies, sent inside the 24-hour window the customer's
// button tap / message opens.
const SURVEY_REPLIES = {
  es: { link: (u) => `¡Muchas gracias! 🙏 Nos ayudaría muchísimo tu reseña: ${u}`, thanks: '¡Muchas gracias por tu respuesta! 🙏', ask: 'Sentimos que no haya sido perfecto. ¿Qué podríamos mejorar? Puedes responder a este mensaje.', got: '¡Gracias por contárnoslo! Lo tendremos en cuenta. 🙏' },
  pt_BR: { link: (u) => `Muito obrigado! 🙏 Sua avaliação nos ajudaria muito: ${u}`, thanks: 'Muito obrigado pela sua resposta! 🙏', ask: 'Sentimos muito que não tenha sido perfeito. O que poderíamos melhorar? Você pode responder a esta mensagem.', got: 'Obrigado por nos contar! Vamos levar isso em conta. 🙏' },
  it: { link: (u) => `Grazie mille! 🙏 La tua recensione ci aiuterebbe tantissimo: ${u}`, thanks: 'Grazie mille per la risposta! 🙏', ask: 'Ci dispiace che non sia stato perfetto. Cosa potremmo migliorare? Puoi rispondere a questo messaggio.', got: 'Grazie per avercelo detto! Ne terremo conto. 🙏' },
  en: { link: (u) => `Thank you so much! 🙏 A review would help us a lot: ${u}`, thanks: 'Thank you so much for your answer! 🙏', ask: "We're sorry it wasn't perfect. What could we improve? You can simply reply to this message.", got: 'Thank you for telling us! We will take it into account. 🙏' },
  tr: { link: (u) => `Çok teşekkürler! 🙏 Bir değerlendirme yazarsanız bize çok yardımcı olur: ${u}`, thanks: 'Yanıtınız için çok teşekkürler! 🙏', ask: 'Mükemmel olmadığı için üzgünüz. Neyi geliştirebiliriz? Bu mesaja yanıt yazabilirsiniz.', got: 'Bize anlattığınız için teşekkürler! Dikkate alacağız. 🙏' },
};

// CRM booking language (Turkish name) → template language code.
const LANGUAGE_CODE = { 'İspanyolca': 'es', 'Portekizce': 'pt_BR', 'İtalyanca': 'it', 'İngilizce': 'en', 'Türkçe': 'tr' };
function surveyLanguage(tourLanguage) { return LANGUAGE_CODE[String(tourLanguage || '').trim()] || 'en'; }

function cleanParam(v) {
  const s = String(v == null ? '' : v).replace(/[\r\n\t]+/g, ' · ').replace(/ {4,}/g, '   ').trim();
  return (s || '—').slice(0, 900);
}

function templateParams(templateKey, payload) {
  const t = TEMPLATES[templateKey];
  if (!t) throw new Error(`Unknown WhatsApp template: ${templateKey}`);
  return t.params.map(k => cleanParam(payload && payload[k]));
}
function templateLanguage(templateKey, lang) {
  const t = TEMPLATES[templateKey];
  return t.languages ? (t.languages[lang] ? lang : 'en') : t.language;
}
function templateBody(templateKey, lang) {
  const t = TEMPLATES[templateKey];
  return t.languages ? t.languages[templateLanguage(templateKey, lang)].body : t.body;
}
function renderPreview(templateKey, payload, lang) {
  const p = templateParams(templateKey, payload);
  return templateBody(templateKey, lang).replace(/\{\{(\d+)\}\}/g, (_, n) => p[Number(n) - 1]);
}

module.exports = { TEMPLATES, SURVEY_REPLIES, LANGUAGE_CODE, surveyLanguage, templateParams, templateLanguage, templateBody, renderPreview, cleanParam };
