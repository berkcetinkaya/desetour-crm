/**
 * api/agency-draft-outreach.js — Vercel Serverless Function
 * ─────────────────────────────────────────────────────────────────────────
 * Dese Tour Operations Center — Acenteler Phase 2, outreach drafting.
 *
 * Browser → POST /api/agency-draft-outreach → this function →
 * Anthropic (plain text generation, no web search) → one draft back to
 * the browser. ZERO email is sent here — this endpoint only returns
 * {subject, body, personalization_signal, angle_reason, fit_level,
 * fit_reason} for the user to review/edit; saving it as a real draft row
 * (status='draft', no sent_at, no agencies.last_contact_at change) is a
 * separate action the frontend performs via the existing agency-email
 * repository (getActiveRepo("agencyEmail").create(...)), and there is no
 * code path anywhere in this phase that calls Resend, api/send-email.js,
 * or any EmailService.send* method.
 *
 * AUTHENTICATION: same api/_agencies/authorize.js check as
 * api/agency-research.js — admin/sales only.
 * ─────────────────────────────────────────────────────────────────────────
 */
'use strict';

const { requireAgencyRole } = require('./_agencies/authorize');
const outreachDraftProvider = require('./_agencies/outreachDraftProvider');

async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed.' });
  }

  let auth;
  try {
    auth = await requireAgencyRole(req);
  } catch (err) {
    if (err && err.name === 'ConfigurationError') {
      return res.status(503).json({ error: err.message, stage: 'auth_configuration' });
    }
    console.error('[agency-draft-outreach] Auth check error:', err.message);
    return res.status(500).json({ error: 'Authorization check failed unexpectedly. See function logs for details.' });
  }
  if (!auth.ok) {
    return res.status(auth.status).json({ error: auth.error });
  }

  let input;
  try {
    input = outreachDraftProvider.validateDraftInput(req.body || {});
  } catch (err) {
    if (err instanceof outreachDraftProvider.ValidationError) {
      return res.status(400).json({ error: 'Invalid draft-outreach input.', fields: err.errors });
    }
    throw err;
  }

  try {
    const draft = await outreachDraftProvider.draftOutreach(input);
    return res.status(200).json(draft);
  } catch (err) {
    if (err instanceof outreachDraftProvider.ConfigurationError) {
      return res.status(503).json({ error: err.message, stage: 'provider_configuration' });
    }
    if (err instanceof outreachDraftProvider.ProviderError) {
      // Never echo err.message to the browser — it is an internal parser/
      // validation diagnostic (e.g. "...did not contain a parseable draft
      // object"), in English, meaningless to a CRM user, and not something
      // the UI should surface verbatim. The real detail is already logged
      // server-side (see outreachDraftProvider.js's draftOutreach, which
      // logs safe structural diagnostics on exactly this failure) — here
      // the browser gets one clean, generic Turkish message instead.
      console.error('[agency-draft-outreach] Provider error:', err.message);
      return res.status(502).json({ error: 'E posta taslağı işlenemedi. Lütfen tekrar deneyin.', stage: 'provider_response' });
    }
    console.error('[agency-draft-outreach] Unexpected error:', err.message);
    return res.status(500).json({ error: 'Outreach drafting failed unexpectedly. See function logs for details.' });
  }
}

module.exports = handler;
