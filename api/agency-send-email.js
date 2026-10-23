/**
 * api/agency-send-email.js — Vercel Serverless Function
 * ─────────────────────────────────────────────────────────────────────────
 * Dese Tour Operations Center — Agency Mailbox Phase A, human-approved
 * outbound outreach send.
 *
 * Browser → POST /api/agency-send-email { agency_id, agency_email_id } +
 * `Authorization: Bearer <access_token>` → this function:
 *   1. requireAgencyRole(req) — UNCHANGED from Acenteler Phase 2: real
 *      Supabase identity, linked active staff_users row, role admin/
 *      sales, AAL2. No new authorization logic is introduced here.
 *   2. Loads the Agency and the draft row from Supabase using the
 *      service_role key — NEVER trusts any browser-supplied sender
 *      email, staff id, role, status, provider id, or created_by. Only
 *      agency_id and agency_email_id (identifiers, not data) come from
 *      the request body.
 *   3. Validates: agency exists, draft exists, draft.agency_id matches,
 *      direction is outbound, status is exactly 'draft', agency has a
 *      usable recipient email, subject present, body present.
 *   4. Atomically CLAIMS the draft row (send_claimed_at) before ever
 *      calling Gmail — see claimDraftForSending for the exact mechanism
 *      this uses to make a double-click/browser retry/duplicate POST
 *      provably incapable of sending twice, without relying on the
 *      frontend disabling its own button.
 *   5. Sends via api/_agencies/gmailSendClient.js (hello@desetour.com —
 *      completely separate OAuth credentials from the read-only
 *      reservation@desetour.com Civitatis integration).
 *   6. On success: persists provider identifiers + status='sent' on the
 *      exact claimed row, conditionally advances agencies.status
 *      (Aday → İletişime Geçildi only — never downgrades a more-advanced
 *      status), and writes one safe activity_logs row (no email body).
 *
 * FAILURE SAFETY — see handleSend's own comments at each stage for the
 * precise rule, summarized here:
 *   - Gmail rejects the send (before acceptance): claim is released
 *     (send_claimed_at cleared), draft stays 'draft', agency untouched,
 *     clean Turkish error returned. Safe to retry immediately.
 *   - Gmail ACCEPTS the send but a later persistence step fails: the
 *     email WAS sent — this function never re-sends and never clears
 *     the claim in this case. It returns a distinct
 *     reconciliation_required error carrying whatever provider
 *     identifiers were obtained, so a human can verify in Gmail's Sent
 *     folder and reconcile the row manually. See
 *     handlePersistenceFailureAfterSend.
 *   - A later, non-critical step fails (agency status/last_contact_at
 *     update, or the activity log insert) AFTER the core agency_emails
 *     row was already marked sent: treated as a soft warning, not an
 *     error — the authoritative "was this sent" answer (agency_emails
 *     row) is already correct and persisted.
 *
 * No automatic send, no bulk send, no scheduled send, no follow-up
 * automation, no inbound sync — all explicitly out of scope for Phase A.
 * ─────────────────────────────────────────────────────────────────────────
 */
'use strict';

const { requireAgencyRole } = require('./_agencies/authorize');
const gmailSendClient = require('./_agencies/gmailSendClient');

class ConfigurationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConfigurationError';
  }
}

function getSupabaseEnv() {
  const url = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const missing = [
    !url && 'SUPABASE_URL',
    !serviceRoleKey && 'SUPABASE_SERVICE_ROLE_KEY',
  ].filter(Boolean);
  if (missing.length > 0) {
    throw new ConfigurationError(
      `Agency send is not configured: missing environment variable(s): ${missing.join(', ')}. ` +
      'Set these as server-side Vercel environment variables — never in browser-reachable config.'
    );
  }
  return { url, serviceRoleKey };
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function isValidEmailAddress(email) {
  return typeof email === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
}

/**
 * Loads the agency and draft rows using ONLY the server-trusted
 * agency_id/agency_email_id from the request body, then runs every
 * precondition check listed in this file's header. Returns either
 * {ok:true, agency, email} or {ok:false, status, error}. Makes no Gmail
 * call and takes no claim — purely read + validate.
 */
async function loadAndValidate({ adminClient, agencyId, agencyEmailId }) {
  const { data: agency, error: agencyError } = await adminClient
    .from('agencies').select('id, email, status').eq('id', agencyId).maybeSingle();
  if (agencyError) return { ok: false, status: 502, error: 'Acente bilgisi okunamadı.' };
  if (!agency) return { ok: false, status: 404, error: 'Acente bulunamadı.' };

  const { data: email, error: emailError } = await adminClient
    .from('agency_emails').select('id, agency_id, direction, status, subject, body, sent_at, provider_message_id, provider_thread_id')
    .eq('id', agencyEmailId).maybeSingle();
  if (emailError) return { ok: false, status: 502, error: 'Taslak bilgisi okunamadı.' };
  if (!email) return { ok: false, status: 404, error: 'Taslak bulunamadı.' };
  if (email.agency_id !== agencyId) {
    return { ok: false, status: 400, error: 'Taslak bu acenteye ait değil.' };
  }
  if (email.direction !== 'outbound') {
    return { ok: false, status: 400, error: 'Yalnızca giden taslaklar gönderilebilir.' };
  }
  if (email.status === 'sent') {
    // Safe, deterministic, non-error response for a duplicate/retried
    // request after a real send already completed — never an error, and
    // never a second send. See this file's header + the implementation
    // report for why this is intentionally NOT treated as a failure.
    return {
      ok: true, alreadySent: true, agency, email,
    };
  }
  if (email.status !== 'draft') {
    return { ok: false, status: 409, error: 'Bu taslak gönderime uygun durumda değil.' };
  }
  if (!isNonEmptyString(email.subject)) {
    return { ok: false, status: 400, error: 'Taslakta konu eksik.' };
  }
  if (!isNonEmptyString(email.body)) {
    return { ok: false, status: 400, error: 'Taslakta e-posta içeriği eksik.' };
  }
  if (!isValidEmailAddress(agency.email)) {
    return { ok: false, status: 400, error: 'Acentenin geçerli bir e-posta adresi yok.' };
  }
  return { ok: true, alreadySent: false, agency, email };
}

/**
 * Agency Mailbox Phase 7 (hardened) — loads the conversation context for
 * an EXPLICIT reply, keyed by the exact CRM row the caller selected
 * (replyToAgencyEmailId) — deliberately never "the agency's most recent
 * thread": an agency can have more than one Gmail conversation, and the
 * Reply action always attaches to the specific message/conversation it
 * was invoked on, never whichever one happens to be newest.
 *
 * Loads that row SERVER SIDE and verifies, in order:
 *   1. it exists;
 *   2. it belongs to this exact agency (never trusts anything else about
 *      a browser-supplied row id — a mismatched agency is treated
 *      identically to "not found", never as a hint to use anyway);
 *   3. it carries a provider_thread_id — the one hard requirement for "a
 *      valid stored conversation context" (Gmail's own thread grouping
 *      needs at least this; a missing RFC Message-Id is tolerated below,
 *      same leniency this module has always had).
 *
 * Derives, from that row's OWN already-stored, already-trusted fields —
 * never from anything browser-supplied:
 *   - threadId:   the row's provider_thread_id (Gmail's own thread id).
 *   - inReplyTo:  the row's own internet_message_id — the specific
 *                 RFC Message-Id of the message actually being replied to.
 *   - references: that same internet_message_id, prefixed with the row's
 *                 own prior in_reply_to chain when it has one — a fuller,
 *                 still purely server-derived reference chain.
 *
 * Returns null (never fabricated data, never a guess) when the row
 * doesn't exist, belongs to a different agency, or has no stored thread
 * at all — the caller treats null exactly like a failed lookup: fail
 * closed, never fall back to a different thread.
 */
async function loadReplyContext({ adminClient, agencyId, replyToAgencyEmailId }) {
  const { data, error } = await adminClient
    .from('agency_emails')
    .select('id, agency_id, provider_thread_id, internet_message_id, in_reply_to')
    .eq('id', replyToAgencyEmailId)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  if (data.agency_id !== agencyId) return null;
  if (!data.provider_thread_id) return null;
  const referencesChain = [data.in_reply_to, data.internet_message_id].filter(Boolean).join(' ');
  return {
    threadId: data.provider_thread_id,
    inReplyTo: data.internet_message_id || null,
    references: referencesChain || null,
  };
}

/**
 * The ONLY place a draft row is marked as "a send is actually happening
 * right now" — a single atomic UPDATE whose WHERE clause re-checks every
 * condition that matters (same row, same agency, still outbound, still
 * draft, not already claimed). Postgres row-level locking makes this
 * provably safe under concurrency: two requests racing this exact
 * statement can never both get a row back — only one UPDATE can ever
 * affect the row, the other necessarily affects zero rows once the
 * winner's write is visible. This is the real guard against double-
 * click/browser-retry/duplicate-POST double-sending — the frontend
 * disabling its Send button is a UX nicety on top of this, never the
 * actual safety mechanism.
 *
 * Returns the claimed row, or null if the claim could not be taken
 * (someone else already claimed it, or it's no longer a sendable draft).
 */
async function claimDraftForSending({ adminClient, agencyEmailId, agencyId }) {
  const { data, error } = await adminClient
    .from('agency_emails')
    .update({ send_claimed_at: new Date().toISOString() })
    .eq('id', agencyEmailId)
    .eq('agency_id', agencyId)
    .eq('direction', 'outbound')
    .eq('status', 'draft')
    .is('send_claimed_at', null)
    .select()
    .maybeSingle();
  if (error) throw error;
  return data || null;
}

/** Releases a claim that never resulted in an accepted Gmail send — safe
 * to call any number of times; only ever clears send_claimed_at, never
 * touches status, so the row returns to being a plain, retryable draft. */
async function releaseClaim({ adminClient, agencyEmailId }) {
  await adminClient.from('agency_emails').update({ send_claimed_at: null }).eq('id', agencyEmailId);
}

/**
 * Persists a successful send onto the exact claimed row. If this throws,
 * the caller (handler, below) treats it as the dangerous partial-success
 * case — see this file's header. Never called unless Gmail has already
 * accepted the message.
 */
async function persistSentEmail({ adminClient, agencyEmailId, sendResult, internetMessageId, toEmail }) {
  const { error } = await adminClient
    .from('agency_emails')
    .update({
      status: 'sent',
      sent_at: new Date().toISOString(),
      provider: 'gmail',
      provider_message_id: sendResult.gmailMessageId,
      provider_thread_id: sendResult.gmailThreadId,
      internet_message_id: internetMessageId,
      from_email: sendResult.fromEmail,
      to_email: toEmail,
    })
    .eq('id', agencyEmailId);
  if (error) throw error;
}

/**
 * Advances agencies.last_contact_at unconditionally and agencies.status
 * Aday -> İletişime Geçildi only, never downgrading Görüşülüyor/Partner/
 * Uygun Değil. A read-then-conditionally-write pair rather than one
 * atomic SQL statement — the supabase-js query builder has no way to
 * express a server-side CASE expression in .update(), and a short
 * read/write race here (two sends to the SAME agency landing within
 * microseconds of each other) only risks this one non-critical status
 * nudge being slightly stale, never a security or data-integrity
 * problem, never the email-sent fact itself. Any failure here is logged
 * and surfaced as a soft warning, never as an error — the authoritative
 * "was this sent" fact already persisted in agency_emails is unaffected
 * either way.
 */
async function advanceAgencyContactState({ adminClient, agencyId }) {
  try {
    const { data: current, error: readError } = await adminClient
      .from('agencies').select('status').eq('id', agencyId).maybeSingle();
    if (readError || !current) return { ok: false, error: (readError && readError.message) || 'agency not found' };

    const patch = { last_contact_at: new Date().toISOString() };
    if (current.status === 'Aday') patch.status = 'İletişime Geçildi';

    const { error: writeError } = await adminClient.from('agencies').update(patch).eq('id', agencyId);
    if (writeError) return { ok: false, error: writeError.message };
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/** One safe, high-level activity event — never the email body, never a
 * credential, never a token. Failure here is logged and treated as a
 * soft warning only. */
async function logOutreachSent({ adminClient, agencyId, agencyEmailId, performedBy }) {
  try {
    await adminClient.from('activity_logs').insert({
      entity_type: 'agency_email',
      entity_id: agencyEmailId,
      action: 'outreach_sent',
      description: 'Acenteye ilk temas e-postası gönderildi.',
      metadata: { agency_id: agencyId, agency_email_id: agencyEmailId, provider: 'gmail' },
      performed_by: performedBy,
    });
  } catch (_err) {
    // Soft warning only — see this function's own header comment.
  }
}

async function handler(req, res, deps = {}) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed.' });
  }

  let auth;
  try {
    auth = await requireAgencyRole(req, deps);
  } catch (err) {
    if (err && err.name === 'ConfigurationError') {
      return res.status(503).json({ error: err.message, stage: 'auth_configuration' });
    }
    console.error('[agency-send-email] Auth check error:', err.message);
    return res.status(500).json({ error: 'Authorization check failed unexpectedly. See function logs for details.' });
  }
  if (!auth.ok) {
    return res.status(auth.status).json({ error: auth.error });
  }

  const body = req.body || {};
  const agencyId = typeof body.agency_id === 'string' ? body.agency_id : null;
  const agencyEmailId = typeof body.agency_email_id === 'string' ? body.agency_email_id : null;
  if (!agencyId || !agencyEmailId) {
    return res.status(400).json({ error: 'agency_id ve agency_email_id zorunludur.' });
  }

  // Agency Mailbox Phase 7 hardening — the caller's INTENT (a brand new
  // outreach vs. an explicit reply inside an existing conversation) is
  // now part of the API contract, never inferred from whatever the
  // database happens to contain. 'new_outreach' is the default (and the
  // only value the one existing Send flow has ever sent), so every
  // pre-existing caller's behavior is unchanged: it never looks up or
  // attaches to a prior thread, exactly as before this phase ever
  // existed. Any other, unrecognized value is rejected outright — never
  // silently coerced to a default, since that would hide a client bug
  // exactly where thread continuity matters most.
  const sendMode = typeof body.send_mode === 'string' ? body.send_mode : 'new_outreach';
  if (sendMode !== 'new_outreach' && sendMode !== 'reply') {
    return res.status(400).json({ error: 'Geçersiz gönderim modu (send_mode).' });
  }
  // Agency Mailbox Phase 7 (hardened) — an explicit reply is attached to
  // the SPECIFIC CRM row the caller selected, never "the agency's most
  // recent thread" (an agency can have more than one Gmail conversation).
  // Only read when sendMode is actually 'reply' — a new_outreach request
  // never looks at this field at all, even if present.
  const replyToAgencyEmailId = sendMode === 'reply' && typeof body.reply_to_agency_email_id === 'string'
    ? body.reply_to_agency_email_id
    : null;

  let adminClient;
  try {
    const { url, serviceRoleKey } = getSupabaseEnv();
    const createClient = deps.createClient || require('@supabase/supabase-js').createClient;
    adminClient = createClient(url, serviceRoleKey);
  } catch (err) {
    if (err instanceof ConfigurationError) {
      return res.status(503).json({ error: err.message, stage: 'db_configuration' });
    }
    throw err;
  }

  let validated;
  try {
    validated = await loadAndValidate({ adminClient, agencyId, agencyEmailId });
  } catch (err) {
    console.error('[agency-send-email] Validation lookup error:', err.message);
    return res.status(500).json({ error: 'Taslak doğrulanırken beklenmeyen bir hata oluştu.' });
  }
  if (!validated.ok) {
    return res.status(validated.status).json({ error: validated.error });
  }
  if (validated.alreadySent) {
    return res.status(200).json({
      ok: true,
      alreadySent: true,
      status: 'sent',
      sentAt: validated.email.sent_at,
      providerMessageId: validated.email.provider_message_id,
      providerThreadId: validated.email.provider_thread_id,
    });
  }

  let claimed;
  try {
    claimed = await claimDraftForSending({ adminClient, agencyEmailId, agencyId });
  } catch (err) {
    console.error('[agency-send-email] Claim error:', err.message);
    return res.status(500).json({ error: 'Gönderim başlatılamadı. Lütfen tekrar deneyin.' });
  }
  if (!claimed) {
    return res.status(409).json({ error: 'Bu taslak şu anda gönderiliyor veya zaten işlendi. Lütfen sayfayı yenileyin.' });
  }

  const { agency, email } = validated;

  // Agency Mailbox Phase 7 (hardened) — thread continuation is used ONLY
  // for an EXPLICIT reply, never inferred merely from an old thread
  // existing. 'new_outreach' never even looks any thread up: threadContext
  // stays null and Gmail always starts a fresh thread, exactly as this
  // endpoint behaved before thread continuation existed at all.
  //
  // 'reply' REQUIRES a resolvable context for the SPECIFIC CRM row the
  // caller selected (reply_to_agency_email_id) — this is the one place a
  // missing field, a lookup failure, or an unresolvable/mismatched target
  // is NOT swallowed into "just start a new thread": doing so would
  // silently fragment a conversation the caller explicitly asked to
  // continue, with no visible signal to anyone. Any of those failure
  // modes fails the whole request closed, before Gmail is ever called,
  // with the SAME safe, generic, Turkish user-facing message — never a
  // raw database/Gmail error, and never a hint about which specific check
  // failed (that would leak information about other agencies' rows to a
  // caller probing with a mismatched id).
  let threadContext = null;
  if (sendMode === 'reply') {
    const lookup = replyToAgencyEmailId
      ? await loadReplyContext({ adminClient, agencyId, replyToAgencyEmailId }).catch(err => {
          console.error('[agency-send-email] Reply context lookup failed for an explicit reply:', err.message);
          return undefined; // distinct from "looked up, found nothing" (null)
        })
      : undefined;
    if (lookup === undefined || lookup === null || !lookup.threadId) {
      await releaseClaim({ adminClient, agencyEmailId }).catch(() => {});
      return res.status(409).json({
        error: 'Bu e-posta konuşmasının yanıt bilgileri bulunamadı. Mesaj gönderilmedi.',
        stage: 'reply_thread_context_unresolved',
      });
    }
    threadContext = lookup;
  }

  let sendResult;
  try {
    sendResult = await gmailSendClient.sendMessage(
      {
        toEmail: agency.email, subject: email.subject, bodyText: email.body,
        threadId: threadContext ? threadContext.threadId : undefined,
        inReplyTo: threadContext && threadContext.inReplyTo ? threadContext.inReplyTo : undefined,
        references: threadContext && threadContext.references ? threadContext.references : undefined,
      },
      deps.gmailDeps || {}
    );
  } catch (err) {
    // Gmail did NOT accept the message — release the claim so this exact
    // draft can be retried immediately, touch nothing else.
    await releaseClaim({ adminClient, agencyEmailId }).catch(() => {});
    if (err instanceof gmailSendClient.ConfigurationError) {
      return res.status(503).json({ error: err.message, stage: 'gmail_configuration' });
    }
    console.error('[agency-send-email] Gmail send rejected:', err.message);
    return res.status(502).json({ error: 'E-posta gönderilemedi. Lütfen tekrar deneyin.', stage: 'gmail_send' });
  }

  // Gmail has ACCEPTED the message. From here on, this function must
  // never attempt to send again — any failure below is a persistence
  // problem on an email that has already left the building.
  const internetMessageId = await gmailSendClient.fetchMessageIdHeader(sendResult.gmailMessageId, deps.gmailDeps || {});

  try {
    await persistSentEmail({ adminClient, agencyEmailId, sendResult, internetMessageId, toEmail: agency.email });
  } catch (err) {
    // DANGEROUS PARTIAL SUCCESS — see this file's header. Never retried
    // automatically; never silently swallowed either.
    console.error('[agency-send-email] Persistence failed after a successful Gmail send. Manual reconciliation required.', {
      agencyEmailId, gmailMessageId: sendResult.gmailMessageId, gmailThreadId: sendResult.gmailThreadId,
    });
    return res.status(500).json({
      error: 'E-posta gönderildi ancak CRM kaydı güncellenemedi. Lütfen bir yöneticiye bildirin.',
      stage: 'reconciliation_required',
      providerMessageId: sendResult.gmailMessageId,
      providerThreadId: sendResult.gmailThreadId,
    });
  }

  const contactStateResult = await advanceAgencyContactState({ adminClient, agencyId });
  await logOutreachSent({ adminClient, agencyId, agencyEmailId, performedBy: auth.userId });

  return res.status(200).json({
    ok: true,
    alreadySent: false,
    status: 'sent',
    agencyId,
    agencyEmailId,
    providerMessageId: sendResult.gmailMessageId,
    providerThreadId: sendResult.gmailThreadId,
    ...(contactStateResult.ok ? {} : { warning: 'Acente son iletişim bilgisi güncellenemedi.' }),
  });
}

module.exports = handler;
module.exports.ConfigurationError = ConfigurationError;
module.exports.loadAndValidate = loadAndValidate;
module.exports.claimDraftForSending = claimDraftForSending;
module.exports.releaseClaim = releaseClaim;
module.exports.persistSentEmail = persistSentEmail;
module.exports.advanceAgencyContactState = advanceAgencyContactState;
module.exports.logOutreachSent = logOutreachSent;
module.exports.loadReplyContext = loadReplyContext;
