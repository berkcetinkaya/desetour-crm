'use strict';
/**
 * api/whatsapp.js — the ONE WhatsApp endpoint (keeps the Vercel function
 * count low). Routes:
 *   GET  ?hub.mode=subscribe…          Meta webhook verification
 *   POST (no action; Meta signature or ?key=WHATSAPP_WEBHOOK_KEY)   Meta webhook: statuses + inbound
 *   POST ?action=enqueue               CRM staff (admin/operations, AAL2):
 *        { kind:'guide_brief', reservationId, note?, meetingPoint?, requestId }
 *        { kind:'operations_notice', title, details, requestId }
 *        → queues the message(s) and immediately tries to send them
 *   GET  ?action=status                CRM staff: is Meta configured?
 *   POST ?action=worker                scheduler (Bearer WHATSAPP_SCHEDULER_SECRET): send due messages
 *   POST ?action=daily-summary         scheduler: tomorrow's operations → operations list, then send
 *   POST ?action=post-tour-surveys     scheduler: today's tours → customer survey, then send
 *        (enqueue also takes { kind:'survey' | 'review_request', reservationId } and
 *         { kind:'reply', phone, text } for the CRM WhatsApp window; the worker run also
 *         announces new CRM events to the operations list)
 */
const { getWhatsAppConfig } = require('./_whatsapp/config');
const { verifyHandshake, verifySignature, verifyUrlKey, processWebhook } = require('./_whatsapp/webhook');
const { runWorker } = require('./_whatsapp/worker');
const { enqueueGuideBrief, enqueueOperationsNotice, enqueueDailySummary, enqueueGuideAssignments, notifyGuideAssignments, enqueueGuideReminders, istanbulISODate } = require('./_whatsapp/enqueue');
const { enqueueSurvey, enqueueReviewRequest, feedbackReminder } = require('./_whatsapp/survey');
const { toTurkish, toCustomer } = require('./_whatsapp/translate');
const { enqueueEventNotices } = require('./_whatsapp/events');
const { sendReply } = require('./_whatsapp/inbox');
const { telegramConfig, listGroups, getTelegramDestination, connectGroup, disconnectGroup, sendTelegramNotice } = require('./_whatsapp/telegram');
const { requireStaffRole } = require('./_shared/authorize');
const { getAdminDb } = require('./_whatsapp/db');

async function readRaw(req) {
  if (typeof req.rawBody === 'string' || Buffer.isBuffer(req.rawBody)) return Buffer.from(req.rawBody);
  const chunks = [];
  for await (const c of req) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
  return Buffer.concat(chunks);
}
const isScheduler = (req, cfg) => !!cfg.schedulerSecret && req.headers['authorization'] === `Bearer ${cfg.schedulerSecret}`;

function createHandler(deps = {}) {
  return async function handler(req, res) {
    const cfg = (deps.getConfig || getWhatsAppConfig)();
    const q = req.query || {};
    const action = q.action || null;
    const db = () => (deps.getDb || getAdminDb)();
    const tg = (deps.getTelegramConfig || telegramConfig)();
    // Team notices go to the Telegram group when one is connected,
    // otherwise to the WhatsApp operations list.
    const teamNotifier = async () => {
      const dest = tg.configured ? await getTelegramDestination(db()) : null;
      return dest ? (a) => sendTelegramNotice({ db: db(), tg, dest, fetchImpl: deps.fetchImpl, ...a }) : (a) => enqueueOperationsNotice({ db: db(), ...a });
    };
    try {
      if (req.method === 'GET' && q['hub.mode']) {
        const v = verifyHandshake(q, cfg);
        return v.ok ? res.status(200).send(v.challenge) : res.status(403).send('Forbidden');
      }
      if (req.method === 'POST' && !action) {
        const raw = await readRaw(req);
        // Our own Meta app's signature, or the secret in the webhook URL.
        if (!verifySignature(raw, req.headers['x-hub-signature-256'], cfg.appSecret) && !verifyUrlKey(q.key, cfg.webhookKey)) return res.status(401).json({ error: 'Invalid signature.' });
        let payload; try { payload = JSON.parse(raw.toString('utf8')); } catch (_) { return res.status(400).json({ error: 'Bad JSON.' }); }
        const out = await processWebhook(payload, db(), { config: cfg, fetchImpl: deps.fetchImpl, notify: await teamNotifier() });
        return res.status(200).json(out);
      }
      if (action === 'worker' || action === 'daily-summary') {
        if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed.' });
        if (!isScheduler(req, cfg)) return res.status(401).json({ error: 'Unauthorized.' });
        const notify = await teamNotifier();
        let summary = null, reminders = null, feedback = null;
        if (action === 'daily-summary') {
          // Evening run: tomorrow's summary to the team, a reminder to every
          // guide with a tour tomorrow, and the feedback to-do list.
          summary = await enqueueDailySummary({ db: db(), notify });
          reminders = await enqueueGuideReminders({ db: db() });
          const fr = await feedbackReminder({ db: db() });
          if (fr) { const sent = await notify({ eventType: 'feedback_reminder', title: fr.title, details: fr.details, key: `feedback_reminder:${istanbulISODate()}` }); feedback = { ask: fr.ask, noPhone: fr.noPhone, review: fr.review, ok: sent.ok }; }
        }
        // Every run: new CRM events (booking / cancellation / change /
        // Civitatis message) to the team, and the assignment + tour details
        // to every newly assigned guide.
        const events = await enqueueEventNotices({ db: db(), notify });
        const assignments = await enqueueGuideAssignments({ db: db() });
        const assignmentNotices = await notifyGuideAssignments({ db: db(), notify });
        const worker = await runWorker({ db: db(), config: cfg, fetchImpl: deps.fetchImpl });
        const slim = (x) => x && { operations: x.operations, queued: x.queued, missingPhone: x.missingPhone };
        return res.status(200).json({ summary, reminders: slim(reminders), feedback, assignments: slim(assignments), assignmentNotices: { announced: assignmentNotices.announced, skipped: assignmentNotices.skipped }, events: { events: events.events, queued: events.queued, skipped: events.skipped }, worker });
      }
      if (action === 'status' || action === 'enqueue') {
        const auth = await (deps.requireStaffRole || requireStaffRole)(req, ['admin', 'operations']);
        if (!auth.ok) return res.status(auth.status).json({ error: auth.error });
        if (action === 'status') {
          const dest = tg.configured ? await getTelegramDestination(db()) : null;
          return res.status(200).json({ sendingConfigured: cfg.sendingConfigured, webhookConfigured: !!((cfg.appSecret || cfg.webhookKey) && cfg.verifyToken),
            telegram: { botConfigured: tg.configured, group: dest ? dest.title : null } });
        }
        if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed.' });
        const body = JSON.parse((await readRaw(req)).toString('utf8') || '{}');
        const requestId = String(body.requestId || '').slice(0, 64);
        if (!requestId) return res.status(400).json({ error: 'requestId gerekli.' });
        let r;
        if (body.kind === 'guide_brief') r = await enqueueGuideBrief({ db: db(), reservationId: body.reservationId, note: body.note, meetingPoint: body.meetingPoint, requestId });
        else if (body.kind === 'operations_notice') {
          const title = String(body.title || '').trim(), details = String(body.details || '').trim();
          if (!title || !details) return res.status(400).json({ error: 'Başlık ve mesaj gerekli.' });
          r = await (await teamNotifier())({ eventType: 'operations_notice', title, details, key: `operations_notice:${requestId}` });
        } else if (body.kind === 'survey') r = await enqueueSurvey({ db: db(), reservationId: body.reservationId });
        else if (body.kind === 'review_request') r = await enqueueReviewRequest({ db: db(), reservationId: body.reservationId });
        else if (body.kind === 'telegram_groups' || body.kind === 'telegram_connect' || body.kind === 'telegram_disconnect') {
          if (!tg.configured) return res.status(409).json({ error: 'Telegram bot anahtarı (TELEGRAM_BOT_TOKEN) sunucuya eklenmemiş.' });
          const out = body.kind === 'telegram_groups' ? await listGroups(tg, deps.fetchImpl)
            : body.kind === 'telegram_connect' ? await connectGroup({ db: db(), tg, chatId: body.chatId, title: body.title, fetchImpl: deps.fetchImpl })
            : await disconnectGroup({ db: db() });
          return out.ok ? res.status(200).json(out) : res.status(out.status || 502).json({ error: out.error });
        }
        else if (body.kind === 'translate') {
          const apiKey = (deps.getEnv ? deps.getEnv() : process.env).ANTHROPIC_API_KEY;
          if (!apiKey) return res.status(409).json({ error: 'Çeviri için sunucuda ANTHROPIC_API_KEY tanımlı değil.' });
          const out = body.direction === 'to_customer'
            ? await toCustomer({ apiKey, text: body.text, language: body.language, sample: body.sample, fetchImpl: deps.fetchImpl })
            : await toTurkish({ apiKey, items: body.items, fetchImpl: deps.fetchImpl });
          return out.ok ? res.status(200).json(out) : res.status(out.status || 502).json({ error: 'Çeviri yapılamadı: ' + out.error });
        }
        else if (body.kind === 'reply') {
          const out = await sendReply({ db: db(), config: cfg, phone: body.phone, text: body.text, requestId, fetchImpl: deps.fetchImpl });
          return out.ok ? res.status(200).json({ ok: true }) : res.status(out.status).json({ error: out.error });
        }
        else return res.status(400).json({ error: 'Bilinmeyen mesaj türü.' });
        if (!r.ok) return res.status(r.status).json({ error: r.error });
        const worker = r.ids.length ? await runWorker({ db: db(), config: cfg, ids: r.ids, fetchImpl: deps.fetchImpl }) : null;
        return res.status(200).json({ ...r, sendingConfigured: cfg.sendingConfigured, worker });
      }
      return res.status(404).json({ error: 'Not found.' });
    } catch (e) {
      console.error('[whatsapp]', e && e.message);
      return res.status(500).json({ error: 'WhatsApp işlemi başarısız oldu.' });
    }
  };
}

module.exports = createHandler();
module.exports.createHandler = createHandler;
