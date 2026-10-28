/**
 * api/agency-research.js — Vercel Serverless Function
 * ─────────────────────────────────────────────────────────────────────────
 * Dese Tour Operations Center — Acenteler Phase 2, market research.
 *
 * Browser → POST /api/agency-research → this function → Anthropic (web
 * search) → candidate list back to the browser. The browser never talks
 * to the research provider directly (see api/_agencies/researchProvider.js
 * for why), and research results are NEVER written to public.agencies by
 * this endpoint — it only returns candidates for the user to review;
 * importing one is a separate, explicit action the existing
 * getActiveRepo("agency").create() mutation already handles (Phase 1).
 *
 * AUTHENTICATION: api/_agencies/authorize.js's requireAgencyRole — verifies
 * the caller's own Supabase session (the same access_token the frontend
 * already holds) and checks staff_users.role is admin/sales. Not a new
 * auth mechanism; see that file's header for why this is still needed
 * even though this is a browser-called endpoint.
 *
 * EARLY EXCLUSION (outreach-quality follow-up): the agencies already in
 * the CRM are fetched BEFORE calling the research provider and passed in
 * as researchAgencies' own existingAgencies dep — a candidate matching one
 * of them (canonical website domain first, then email, then normalized
 * name — see duplicateMatching.js) is silently dropped inside
 * researchProvider.js itself, never returned here, never shown in the
 * result list. This replaced the previous behavior of annotating every
 * candidate with existingAgencyId/existingAgencyName for the UI to show a
 * late "Zaten CRM'de" warning on — that was correct but too late; this
 * endpoint no longer returns a result for an agency already in the CRM at
 * all. See DeseTourDashboard.jsx's SupabaseAgencyRepo.create() for the
 * separate, final defense-in-depth check immediately before persistence.
 * ─────────────────────────────────────────────────────────────────────────
 */
'use strict';

const { requireAgencyRole } = require('./_agencies/authorize');
const researchProvider = require('./_agencies/researchProvider');

async function fetchExistingAgenciesForDuplicateCheck() {
  const url = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceRoleKey) return []; // early exclusion is best-effort — never blocks research results on its own
  const { createClient } = require('@supabase/supabase-js');
  const client = createClient(url, serviceRoleKey);
  const { data, error } = await client.from('agencies').select('id,name,website,email');
  if (error) return [];
  return data || [];
}

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
    console.error('[agency-research] Auth check error:', err.message);
    return res.status(500).json({ error: 'Authorization check failed unexpectedly. See function logs for details.' });
  }
  if (!auth.ok) {
    return res.status(auth.status).json({ error: auth.error });
  }

  let input;
  try {
    input = researchProvider.validateResearchInput(req.body || {});
  } catch (err) {
    if (err instanceof researchProvider.ValidationError) {
      return res.status(400).json({ error: 'Invalid research input.', fields: err.errors });
    }
    throw err;
  }

  const existingAgencies = await fetchExistingAgenciesForDuplicateCheck();

  let result;
  try {
    result = await researchProvider.researchAgencies(input, { existingAgencies });
  } catch (err) {
    if (err instanceof researchProvider.ConfigurationError) {
      return res.status(503).json({ error: err.message, stage: 'provider_configuration' });
    }
    if (err instanceof researchProvider.ProviderError) {
      // Never echo err.message to the browser — it is an internal parser/
      // provider diagnostic (e.g. "...did not contain a parseable candidate
      // list"), in English, meaningless to a CRM user, and not something
      // the UI should surface verbatim. The real detail is already logged
      // server-side (see researchProvider.js's researchAgencies, which logs
      // safe structural diagnostics on exactly this failure) — here the
      // browser gets one clean, generic Turkish message instead.
      console.error('[agency-research] Provider error:', err.message);
      return res.status(502).json({ error: 'Araştırma sonucu işlenemedi. Lütfen tekrar deneyin.', stage: 'provider_response' });
    }
    console.error('[agency-research] Unexpected error:', err.message);
    return res.status(500).json({ error: 'Agency research failed unexpectedly. See function logs for details.' });
  }

  // PART 5 — safe summary counts (see researchProvider.js's researchAgencies
  // for exactly what each one means and its one honest limitation). Only
  // ever structural counts, never candidate content.
  return res.status(200).json({ candidates: result.candidates, summary: result.summary });
}

module.exports = handler;
