'use strict';
// Service-role Supabase client for the WhatsApp endpoint (server only).
let cached = null;
function getAdminDb() {
  if (cached) return cached;
  const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('WhatsApp is not configured: SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing.');
  cached = require('@supabase/supabase-js').createClient(url, key, { auth: { persistSession: false } });
  return cached;
}
module.exports = { getAdminDb };
