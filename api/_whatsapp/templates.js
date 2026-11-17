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
    body: '📣 DeseTour Operasyon — {{1}}\n{{2}}\nDeseTour CRM otomatik bildirimi.',
    params: ['title', 'details'],
  },
  // Rehbere tur hatırlatması, turdan bir gün önce (Utility, tr)
  guide_reminder: {
    name: 'desetour_rehber_hatirlatma', language: 'tr', category: 'UTILITY',
    body: 'Merhaba {{1}}, hatırlatma: yarın ({{2}}) {{3}} turunuz var.\n🕘 Başlangıç: {{4}}\n🗣 Dil: {{5}}\n👥 Misafir: {{6}}\n📍 Buluşma: {{7}}\nİyi turlar! — DeseTour Operasyon',
    params: ['guideName', 'dateLabel', 'tourName', 'time', 'language', 'guests', 'meetingPoint'],
  },
  // Tur sonrası geri bildirim: thanks + "how was the tour, 1 to 5?" with
  // five quick-reply buttons (1…5). The guide score and the open comment
  // are then asked as free-form messages (FEEDBACK_REPLIES) inside the
  // 24-hour window the customer's answer opens.
  post_tour_survey: {
    name: 'desetour_tur_geri_bildirim', category: 'UTILITY', params: ['customerName', 'tourName'],
    buttons: ['1', '2', '3', '4', '5'],
    languages: {
      es: { body: '¡Hola {{1}}! Gracias por participar en nuestro tour {{2}}. ¿Qué tal fue el tour? Puntúalo del 1 (muy mal) al 5 (excelente).' },
      pt_BR: { body: 'Olá {{1}}! Obrigado por participar do nosso passeio {{2}}. Como foi o passeio? Dê uma nota de 1 (muito ruim) a 5 (excelente).' },
      it: { body: "Ciao {{1}}! Grazie per aver partecipato al nostro tour {{2}}. Com'è andato il tour? Dai un voto da 1 (molto male) a 5 (eccellente)." },
      en: { body: 'Hi {{1}}! Thank you for joining our {{2}} tour. How was the tour? Please rate it from 1 (very bad) to 5 (excellent).' },
      tr: { body: 'Merhaba {{1}}! {{2}} turumuza katıldığınız için teşekkürler. Tur nasıl geçti? 1 (çok kötü) ile 5 (mükemmel) arasında puan verir misiniz?' },
    },
  },
  // Yorum ve puan isteği: the tour's own page (Civitatis) sent straight to
  // the customer after the tour, from the reservation page.
  review_request: {
    name: 'desetour_yorum_istegi', category: 'UTILITY', params: ['customerName', 'tourName', 'reviewUrl'],
    languages: {
      es: { body: '¡Hola {{1}}! Gracias por elegir DeseTour para el tour {{2}}. Tu opinión es muy importante para nosotros y nos ayuda muchísimo: ¿podrías dejarnos una reseña y tu puntuación aquí? {{3}} ¡Muchas gracias!' },
      pt_BR: { body: 'Olá {{1}}! Obrigado por escolher a DeseTour para o passeio {{2}}. Sua opinião é muito importante para nós e nos ajuda muito: você poderia deixar uma avaliação e a sua nota aqui? {{3}} Muito obrigado!' },
      it: { body: 'Ciao {{1}}! Grazie per aver scelto DeseTour per il tour {{2}}. La tua opinione è molto importante per noi e ci aiuta tantissimo: potresti lasciarci una recensione e il tuo voto qui? {{3}} Grazie mille!' },
      en: { body: 'Hi {{1}}! Thank you for choosing DeseTour for the {{2}} tour. Your opinion is very important to us and helps us a lot: could you leave a review and your rating here? {{3}} Thank you so much!' },
      tr: { body: "Merhaba {{1}}! {{2}} turu için DeseTour'u seçtiğiniz için teşekkürler. Görüşünüz bizim için çok önemli ve bize çok yardımcı oluyor: buradan yorum ve puan bırakabilir misiniz? {{3}} Çok teşekkürler!" },
    },
  },
};

// Free-form follow-ups, sent inside the 24-hour window the customer's
// answer opens: guide score → open comment → thanks.
const FEEDBACK_REPLIES = {
  es: { guide: '¡Gracias! ¿Y tu guía? ¿Quedaste satisfecho/a? Responde con un número del 1 (nada) al 5 (muchísimo).', comment: '¡Gracias! Para poder ofrecer un mejor servicio, ¿te gustaría dejarnos algún comentario? Puedes escribirlo aquí.', thanks: '¡Muchas gracias por tu tiempo! Tu opinión nos ayuda a mejorar. 🙏' },
  pt_BR: { guide: 'Obrigado! E o seu guia? Você ficou satisfeito(a)? Responda com um número de 1 (nada) a 5 (muito).', comment: 'Obrigado! Para oferecermos um serviço melhor, você gostaria de nos deixar algum comentário? Pode escrever aqui.', thanks: 'Muito obrigado pelo seu tempo! Sua opinião nos ajuda a melhorar. 🙏' },
  it: { guide: 'Grazie! E la tua guida? Sei rimasto/a soddisfatto/a? Rispondi con un numero da 1 (per niente) a 5 (moltissimo).', comment: 'Grazie! Per offrire un servizio migliore, vuoi lasciarci un commento? Puoi scriverlo qui.', thanks: 'Grazie mille per il tuo tempo! La tua opinione ci aiuta a migliorare. 🙏' },
  en: { guide: 'Thank you! And your guide? Were you satisfied? Reply with a number from 1 (not at all) to 5 (very much).', comment: 'Thank you! To help us offer a better service, would you like to leave us any feedback? You can write it here.', thanks: 'Thank you so much for your time! Your opinion helps us improve. 🙏' },
  tr: { guide: 'Teşekkürler! Peki rehberinizden memnun kaldınız mı? 1 (hiç) ile 5 (çok) arasında bir rakam yazar mısınız?', comment: 'Teşekkürler! Daha iyi hizmet verebilmemiz için bize geri bildirimde bulunmak ister misiniz? Buraya yazabilirsiniz.', thanks: 'Zaman ayırdığınız için çok teşekkürler! Görüşünüz gelişmemize yardımcı oluyor. 🙏' },
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

module.exports = { TEMPLATES, FEEDBACK_REPLIES, LANGUAGE_CODE, surveyLanguage, templateParams, templateLanguage, templateBody, renderPreview, cleanParam };
