/**
 * api/_civitatis/activityModalityRules.js
 * ─────────────────────────────────────────────────────────────────────────
 * Tour Preparation Intelligence — Phase B1: narrow, read-only server-side
 * repository for public.civitatis_activity_modality_map.
 *
 * Reuses api/_civitatis/supabaseAdmin.js's existing, already-production
 * getServiceRoleClient() singleton — the SAME service_role client every
 * other Civitatis server-side read in that file already uses — rather
 * than constructing a second credential path. This file adds a NEW,
 * independent export; it does not modify supabaseAdmin.js in any way.
 *
 * public.civitatis_activity_modality_map remains the sole authoritative
 * source for modality rules — nothing here caches across invocations or
 * hardcodes a phrase; every call reads the table fresh. The service_role
 * key this depends on is never reachable from browser code (see
 * supabaseAdmin.js's own header) — this module is server-only, imported
 * exclusively by other api/_civitatis/*.js / api/*.js files.
 * ─────────────────────────────────────────────────────────────────────────
 */
'use strict';

const { getServiceRoleClient } = require('./supabaseAdmin');

/**
 * Active civitatis_activity_modality_map rows, optionally narrowed
 * server-side to one canonical language_code (preferred — avoids
 * shipping every language's rules to every call site when the caller
 * already knows which language it needs). Returns the plain column shape
 * api/_civitatis/activityModality.js's normalizer expects, in no
 * particular order — the normalizer's own matchedRuleId tie-break is
 * deliberately independent of result ordering.
 *
 * @param {{ languageCode?: string }} [opts]
 * @returns {Promise<Array<{id:string,language_code:string,match_type:string,match_text:string,meal_status:string,is_active:boolean}>>}
 */
async function getActiveCivitatisModalityRules({ languageCode } = {}) {
  const sb = getServiceRoleClient();
  let query = sb.from('civitatis_activity_modality_map')
    .select('id,language_code,match_type,match_text,meal_status,is_active')
    .eq('is_active', true);
  if (languageCode) query = query.eq('language_code', languageCode);
  const { data, error } = await query;
  if (error) throw new Error(`Supabase error reading civitatis_activity_modality_map: ${error.message}`);
  return data || [];
}

module.exports = {
  getActiveCivitatisModalityRules,
};
