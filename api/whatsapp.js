'use strict';
/**
 * api/whatsapp.js — the ONE WhatsApp endpoint (keeps the Vercel function
 * count low). Routes:
 *   GET  ?hub.mode=subscribe…          Meta webhook verification
 *   POST (no action, Meta signature)   Meta webhook: statuses + inbound
 *   POST ?action=enqueue               CRM staff (admin/operations, AAL2):
 *        { kind:'guide_brief', reservationId, note?, meetingPoint?, requestId }
 *        { kind:'operations_notice', title, details, requestId }
 *        → queues the message(s) and immediately tries to send them
 *   GET  ?action=status                CRM staff: is Meta configured?
 *   POST ?action=worker                scheduler (Bearer WHATSAPP_SCHEDULER_SECRET): send due messages
 *   POST ?action=daily-summary         scheduler: tomorrow's operations → operations list, then send
 *   POST ?action=post-tour-surveys     scheduler: today's tours → customer survey, then send
 *        (enqueue also takes { kind:'survey', reservationId } for a manual survey)
 */
const { getWhatsAppConfig } = require('./_whatsapp/config');
const { verifyHandshake, verifySignature, processWebhook } = require('./_whatsapp/webhook');
const { runWorker } = require('./_whatsapp/worker');
const { enqueueGuideBrief, enqueueOperationsNotice, enqueueDailySummary } = require('./_whatsapp/enqueue');
const { enqueueSurvey, enqueueDailySurveys } = require('./_whatsapp/survey');
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
    try {
      if (req.method === 'GET' && q['hub.mode']) {
        const v = verifyHandshake(q, cfg);
        return v.ok ? res.status(200).send(v.challenge) : res.status(403).send('Forbidden');
      }
      if (req.method === 'POST' && !action) {
        const raw = await readRaw(req);
        if (!verifySignature(raw, req.headers['x-hub-signature-256'], cfg.appSecret)) return res.status(401).json({ error: 'Invalid signature.' });
        let payload; try { payload = JSON.parse(raw.toString('utf8')); } catch (_) { return res.status(400).json({ error: 'Bad JSON.' }); }
        const out = await processWebhook(payload, db(), { config: cfg, fetchImpl: deps.fetchImpl });
        return res.status(200).json(out);
      }
      if (action === 'worker' || action === 'daily-summary' || action === 'post-tour-surveys') {
        if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed.' });
        if (!isScheduler(req, cfg)) return res.status(401).json({ error: 'Unauthorized.' });
        const summary = action === 'daily-summary' ? await enqueueDailySummary({ db: db() })
          : action === 'post-tour-surveys' ? await enqueueDailySurveys({ db: db() }) : null;
        const worker = await runWorker({ db: db(), config: cfg, fetchImpl: deps.fetchImpl });
        return res.status(200).json({ summary, worker });
      }
      if (action === 'status' || action === 'enqueue') {
        const auth = await (deps.requireStaffRole || requireStaffRole)(req, ['admin', 'operations']);
        if (!auth.ok) return res.status(auth.status).json({ error: auth.error });
        if (action === 'status') return res.status(200).json({ sendingConfigured: cfg.sendingConfigured, webhookConfigured: !!(cfg.appSecret && cfg.verifyToken) });
        if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed.' });
        const body = JSON.parse((await readRaw(req)).toString('utf8') || '{}');
        const requestId = String(body.requestId || '').slice(0, 64);
        if (!requestId) return res.status(400).json({ error: 'requestId gerekli.' });
        let r;
        if (body.kind === 'guide_brief') r = await enqueueGuideBrief({ db: db(), reservationId: body.reservationId, note: body.note, meetingPoint: body.meetingPoint, requestId });
        else if (body.kind === 'operations_notice') {
          const title = String(body.title || '').trim(), details = String(body.details || '').trim();
          if (!title || !details) return res.status(400).json({ error: 'Başlık ve mesaj gerekli.' });
          r = await enqueueOperationsNotice({ db: db(), eventType: 'operations_notice', title, details, key: `operations_notice:${requestId}` });
        } else if (body.kind === 'survey') r = await enqueueSurvey({ db: db(), reservationId: body.reservationId });
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
