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
 * DUPLICATE ANNOTATION: for every candidate, checks against the agencies
 * already in the CRM (website / email / normalized name) and attaches
 * existingAgencyId/existingAgencyName so the UI can show "Zaten CRM'de"
 * instead of letting the user import a second row for the same agency.
 * ─────────────────────────────────────────────────────────────────────────
 */
'use strict';

const { requireAgencyRole } = require('./_agencies/authorize');
const researchProvider = require('./_agencies/researchProvider');
const { findLikelyDuplicate } = require('./_agencies/duplicateMatching');

async function fetchExistingAgenciesForDuplicateCheck() {
  const url = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceRoleKey) return []; // duplicate annotation is best-effort, never blocks research results
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

  let result;
  try {
    result = await researchProvider.researchAgencies(input);
  } catch (err) {
    if (err instanceof researchProvider.ConfigurationError) {
      return res.status(503).json({ error: err.message, stage: 'provider_configuration' });
    }
    if (err instanceof researchProvider.ProviderError) {
      return res.status(502).json({ error: err.message, stage: 'provider_response' });
    }
    console.error('[agency-research] Unexpected error:', err.message);
    return res.status(500).json({ error: 'Agency research failed unexpectedly. See function logs for details.' });
  }

  const existingAgencies = await fetchExistingAgenciesForDuplicateCheck();
  const candidates = result.candidates.map(candidate => {
    const dup = findLikelyDuplicate(candidate, existingAgencies);
    return {
      ...candidate,
      existingAgencyId: dup ? dup.id : null,
      existingAgencyName: dup ? dup.name : null,
    };
  });

  return res.status(200).json({ candidates });
}

module.exports = handler;
