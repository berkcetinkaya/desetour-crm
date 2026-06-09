/**
 * /api/send-email.js — Vercel Serverless Function
 * ─────────────────────────────────────────────────────────────────────────────
 * Dese Tour Operations Center — Secure Email Gateway with PDF Attachment
 * Sprint 15: Full PDF attachment support via base64 content
 *
 * SECURITY MODEL:
 *   • RESEND_API_KEY lives ONLY in Vercel env vars (server-side)
 *   • Browser sends { to, subject, html, attachments?, metadata? }
 *   • This function validates, sanitizes, and proxies to Resend
 *   • Attachments: only application/pdf accepted; max 5MB per attachment
 *
 * FLOW:
 *   Browser → POST /api/send-email → Vercel → Resend API → Inbox
 *
 * LIMITS (see EMAIL_SETUP.md for details):
 *   • Vercel function payload: 4.5MB (Hobby) / unlimited (Pro)
 *   • Resend attachment total: 40MB per email
 *   • Rate limit: 20 emails / 5 minutes per IP (configurable)
 * ─────────────────────────────────────────────────────────────────────────────
 */

const { Resend } = require('resend');

// ─── Environment variables ────────────────────────────────────────────────────
const RESEND_API_KEY   = process.env.RESEND_API_KEY;
const FROM_EMAIL       = process.env.FROM_EMAIL   || 'hello@desetour.com';
const FROM_NAME        = process.env.FROM_NAME    || 'Dese Tour';
const ALLOWED_ORIGINS  = (process.env.ALLOWED_ORIGINS || '')
  .split(',').map(s => s.trim()).filter(Boolean);
const MAX_ATTACH_BYTES = parseInt(process.env.MAX_ATTACH_BYTES || '5242880'); // 5MB default

// ─── Validation helpers ───────────────────────────────────────────────────────
function isValidEmail(email) {
  return typeof email === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
}

function isValidFilename(name) {
  // Allow only safe filenames — no path traversal, no shell chars
  return typeof name === 'string' && /^[A-Za-z0-9._-]{1,100}$/.test(name);
}

function isValidBase64(str) {
  if (typeof str !== 'string') return false;
  // Base64 chars only (+ padding)
  return /^[A-Za-z0-9+/]+=*$/.test(str) && str.length > 0;
}

function validateAttachment(att, index) {
  const errs = [];

  if (!att.filename)                      errs.push(`attachments[${index}].filename required`);
  else if (!isValidFilename(att.filename)) errs.push(`attachments[${index}].filename contains invalid characters`);
  else if (!att.filename.endsWith('.pdf')) errs.push(`attachments[${index}].filename must end with .pdf`);

  if (!att.content)                       errs.push(`attachments[${index}].content required`);
  else if (!isValidBase64(att.content))   errs.push(`attachments[${index}].content must be valid base64`);
  else {
    // Check decoded size
    const decodedBytes = Math.round(att.content.length * 0.75);
    if (decodedBytes > MAX_ATTACH_BYTES) {
      errs.push(`attachments[${index}] too large (${Math.round(decodedBytes/1024)}KB > ${Math.round(MAX_ATTACH_BYTES/1024)}KB limit)`);
    }
  }

  if (att.contentType && att.contentType !== 'application/pdf') {
    errs.push(`attachments[${index}].contentType must be application/pdf`);
  }

  return errs;
}

function validateBody(body) {
  const errors = [];

  if (!body.to)                          errors.push('to is required');
  else if (!isValidEmail(body.to))       errors.push('to must be a valid email address');

  if (!body.subject)                     errors.push('subject is required');
  else if (typeof body.subject !== 'string') errors.push('subject must be a string');
  else if (body.subject.length > 500)    errors.push('subject too long (max 500 chars)');

  if (!body.html && !body.text)          errors.push('html or text body is required');
  if (body.html && body.html.length > 250_000) errors.push('html body too large (max 250KB)');

  if (body.attachments !== undefined) {
    if (!Array.isArray(body.attachments))  errors.push('attachments must be an array');
    else if (body.attachments.length > 5)  errors.push('max 5 attachments per email');
    else {
      body.attachments.forEach((att, i) => {
        errors.push(...validateAttachment(att, i));
      });
    }
  }

  return errors;
}

// ─── CORS ─────────────────────────────────────────────────────────────────────
function getCorsHeaders(origin) {
  const allowed = ALLOWED_ORIGINS.length === 0 || ALLOWED_ORIGINS.includes(origin)
    ? origin || '*'
    : 'null';
  return {
    'Access-Control-Allow-Origin':  allowed,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age':       '86400',
  };
}

// ─── Rate limiting (in-memory; use Redis/Upstash KV for multi-instance) ───────
const _rateMap = new Map();
const RATE_MAX = parseInt(process.env.RATE_LIMIT_MAX || '20');
const RATE_WIN = parseInt(process.env.RATE_LIMIT_WIN || '300') * 1000; // ms

function checkRate(ip) {
  const now   = Date.now();
  const entry = _rateMap.get(ip);
  if (!entry || entry.resetAt < now) {
    _rateMap.set(ip, { count: 1, resetAt: now + RATE_WIN });
    return true;
  }
  if (entry.count >= RATE_MAX) return false;
  entry.count++;
  return true;
}

// ─── Sanitise metadata (strip PII beyond what we need) ───────────────────────
function sanitiseMeta(raw) {
  if (!raw || typeof raw !== 'object') return undefined;
  return {
    type:           String(raw.type          || 'general').slice(0, 30),
    quoteId:        raw.quoteId        ? String(raw.quoteId).slice(0, 60)   : undefined,
    reservationId:  raw.reservationId  ? String(raw.reservationId).slice(0,60) : undefined,
    hasAttachment:  !!raw.hasAttachment,
  };
}

// ─── Main handler ─────────────────────────────────────────────────────────────
module.exports = async function handler(req, res) {
  const origin      = req.headers.origin || '';
  const corsHeaders = getCorsHeaders(origin);

  // Preflight
  if (req.method === 'OPTIONS') {
    return res.status(200).set(corsHeaders).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).set(corsHeaders).json({ error: 'Method not allowed.' });
  }

  // Check key is configured
  if (!RESEND_API_KEY) {
    console.error('[send-email] RESEND_API_KEY not set');
    return res.status(503).set(corsHeaders).json({
      error: 'Email service not configured. Set RESEND_API_KEY in Vercel env vars.',
    });
  }

  // Rate limit
  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim()
    || req.socket?.remoteAddress
    || 'unknown';
  if (!checkRate(ip)) {
    return res.status(429).set(corsHeaders).json({
      error: `Rate limit exceeded. Max ${RATE_MAX} emails per ${RATE_WIN/60000} minutes.`,
    });
  }

  // Parse body
  let body;
  try {
    body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    if (!body || typeof body !== 'object') throw new Error('Expected JSON object');
  } catch (_) {
    return res.status(400).set(corsHeaders).json({ error: 'Invalid JSON body.' });
  }

  // Validate
  const validationErrors = validateBody(body);
  if (validationErrors.length) {
    return res.status(400).set(corsHeaders).json({ error: validationErrors.join('; ') });
  }

  // Build Resend payload
  const emailPayload = {
    from:    `${FROM_NAME} <${FROM_EMAIL}>`,
    to:      [body.to.trim()],
    subject: body.subject,
    html:    body.html,
    text:    body.text,
    headers: { 'X-Mailer': 'Dese Tour Operations Center v1.0' },
    tags:    [],
  };

  // Sanitise metadata → tags (Resend tags: max 10, key max 36 chars, value max 256)
  const meta = sanitiseMeta(body.metadata);
  if (meta) {
    if (meta.type)    emailPayload.tags.push({ name: 'type',    value: meta.type });
    if (meta.quoteId) emailPayload.tags.push({ name: 'quoteId', value: meta.quoteId });
  }

  // ── Attachments ─────────────────────────────────────────────────────────────
  if (body.attachments && body.attachments.length > 0) {
    emailPayload.attachments = body.attachments.map(att => ({
      filename: att.filename,
      content:  Buffer.from(att.content, 'base64'),
      // Resend accepts Buffer for content
    }));

    const totalKB = body.attachments.reduce(
      (sum, att) => sum + Math.round(att.content.length * 0.75 / 1024), 0
    );
    console.info('[send-email] Attachments:', {
      count:   body.attachments.length,
      files:   body.attachments.map(a => a.filename),
      totalKB,
    });
  }

  // ── Send via Resend ──────────────────────────────────────────────────────────
  const resend = new Resend(RESEND_API_KEY);

  try {
    const { data, error } = await resend.emails.send(emailPayload);

    if (error) {
      console.error('[send-email] Resend error:', { code: error.name, message: error.message });
      return res.status(500).set(corsHeaders).json({
        error: `Email gönderilemedi: ${error.message}`,
      });
    }

    // Success — log without PII
    console.info('[send-email] Sent OK:', {
      id:            data.id,
      to:            body.to,
      type:          meta?.type,
      hasAttachment: !!emailPayload.attachments,
    });

    return res.status(200).set(corsHeaders).json({
      id:            data.id,
      success:       true,
      provider:      'resend',
      hasAttachment: !!emailPayload.attachments,
    });

  } catch (err) {
    // Only log error message — never log request body (may contain customer data)
    console.error('[send-email] Unexpected error:', err.message);
    return res.status(500).set(corsHeaders).json({
      error: 'Sunucu hatası. Vercel function loglarını kontrol edin.',
    });
  }
};
