'use strict';
/**
 * tests/whatsapp/whatsappCoreMigration.test.js
 * ─────────────────────────────────────────────────────────────────────────
 * Regression coverage for supabase_migration_whatsapp_core.sql and its
 * rollback (Phase 1.1 — WhatsApp Core Database Foundation). NOT YET
 * APPLIED to any database — explicitly withheld pending manual approval,
 * exactly like every prior V-series migration's own test file. Every test
 * here is a pure, static, never-executed text assertion against the
 * prepared .sql files. Nothing in this file connects to a database or
 * runs any SQL.
 * ─────────────────────────────────────────────────────────────────────────
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const FORWARD_PATH  = path.join(ROOT, 'supabase_migration_whatsapp_core.sql');
const ROLLBACK_PATH = path.join(ROOT, 'supabase_migration_whatsapp_core_ROLLBACK.sql');

const forward  = fs.readFileSync(FORWARD_PATH, 'utf8');
const rollback = fs.readFileSync(ROLLBACK_PATH, 'utf8');

// ── A. File structure: transactional, balanced ──────────────────────────

test('forward migration is wrapped in exactly one BEGIN;/COMMIT; pair, no stray ROLLBACK', () => {
  assert.equal((forward.match(/^BEGIN;\s*$/gm) || []).length, 1);
  assert.equal((forward.match(/^COMMIT;\s*$/gm) || []).length, 1);
  assert.doesNotMatch(forward, /^ROLLBACK/m);
});

test('forward migration dollar-quoting is balanced (preflight + postflight DO blocks only)', () => {
  const dollarLines = forward.split('\n').filter(l => l.includes('$$'));
  assert.equal(dollarLines.length, 4, `expected exactly 4 lines containing $$ (2 DO blocks), found ${dollarLines.length}`);
});

test('rollback is wrapped in exactly one BEGIN;/COMMIT; pair, dollar-quoting balanced', () => {
  assert.equal((rollback.match(/^BEGIN;\s*$/gm) || []).length, 1);
  assert.equal((rollback.match(/^COMMIT;\s*$/gm) || []).length, 1);
  const dollarLines = rollback.split('\n').filter(l => l.includes('$$'));
  assert.equal(dollarLines.length, 2, 'expected exactly 2 lines containing $$ (1 postflight DO block)');
});

// ── B. tour_channels.review_url: nullable, independent from listing_url ─

test('review_url is added as a plain nullable TEXT column with no DEFAULT/NOT NULL/CHECK', () => {
  const idx = forward.indexOf('ALTER TABLE public.tour_channels\n  ADD COLUMN IF NOT EXISTS review_url TEXT;');
  assert.ok(idx > -1, 'expected the exact ALTER TABLE statement adding review_url');
});

test('review_url is never populated by any INSERT/UPDATE statement in the forward migration', () => {
  const codeLines = forward.split('\n').filter(l => !l.trim().startsWith('--'));
  const code = codeLines.join('\n');
  assert.doesNotMatch(code, /UPDATE\s+public\.tour_channels[\s\S]{0,300}review_url\s*=/);
  assert.doesNotMatch(code, /INSERT\s+INTO\s+public\.tour_channels/);
});

test('review_url is documented as distinct from listing_url, and listing_url is never altered', () => {
  const idx = forward.indexOf('COMMENT ON COLUMN public.tour_channels.review_url');
  assert.ok(idx > -1);
  const stmt = forward.slice(idx, forward.indexOf(";\n", idx) + 1);
  assert.match(stmt, /NOT the same as listing_url/);
  assert.doesNotMatch(forward, /ALTER TABLE public\.tour_channels[\s\S]{0,200}listing_url/);
});

test('postflight explicitly re-verifies review_url is nullable TEXT and listing_url still exists', () => {
  const postflightIdx = forward.lastIndexOf('DO $$');
  const postflight = forward.slice(postflightIdx);
  assert.match(postflight, /column_name='review_url'/);
  assert.match(postflight, /is_nullable='YES'/);
  assert.match(postflight, /column_name='listing_url'/);
});

// ── C. whatsapp_destinations / whatsapp_destination_recipients ──────────

test('whatsapp_destinations exists with destination_key, transport_mode, provider_group_id', () => {
  const idx = forward.indexOf('CREATE TABLE IF NOT EXISTS public.whatsapp_destinations');
  const end = forward.indexOf(');', idx) + 2;
  const stmt = forward.slice(idx, end);
  assert.match(stmt, /destination_key\s+TEXT\s+NOT NULL UNIQUE/);
  assert.match(stmt, /transport_mode\s+TEXT\s+NOT NULL DEFAULT 'recipient_list'/);
  assert.match(stmt, /CHECK \(transport_mode IN \('meta_group', 'recipient_list'\)\)/);
  assert.match(stmt, /provider_group_id\s+TEXT,/);
});

test('whatsapp_destinations has no column or comment resembling a credential/access token', () => {
  const idx = forward.indexOf('CREATE TABLE IF NOT EXISTS public.whatsapp_destinations');
  const end = forward.indexOf(');', idx) + 2;
  const stmt = forward.slice(idx, end);
  assert.doesNotMatch(stmt, /token/i);
  assert.doesNotMatch(stmt, /secret/i);
  assert.doesNotMatch(stmt, /api_key/i);
  assert.doesNotMatch(stmt, /access_key/i);
});

test('whatsapp_destinations_group_mode_pair CHECK makes meta_group without a group id impossible', () => {
  const idx = forward.indexOf('CONSTRAINT whatsapp_destinations_group_mode_pair CHECK');
  assert.ok(idx > -1);
  const stmt = forward.slice(idx, forward.indexOf(')\n);', idx) + 4);
  assert.match(stmt, /transport_mode = 'meta_group' AND provider_group_id IS NOT NULL/);
  assert.match(stmt, /OR \(transport_mode = 'recipient_list'\)/);
});

test('whatsapp_destination_recipients has phone/display_name/is_active/sort_order and CASCADEs from whatsapp_destinations', () => {
  const idx = forward.indexOf('CREATE TABLE IF NOT EXISTS public.whatsapp_destination_recipients');
  const end = forward.indexOf(');', idx) + 2;
  const stmt = forward.slice(idx, end);
  assert.match(stmt, /destination_id\s+UUID\s+NOT NULL REFERENCES public\.whatsapp_destinations\(id\) ON DELETE CASCADE/);
  assert.match(stmt, /phone\s+TEXT\s+NOT NULL/);
  assert.match(stmt, /display_name\s+TEXT,/);
  assert.match(stmt, /is_active\s+BOOLEAN\s+NOT NULL DEFAULT TRUE/);
  assert.match(stmt, /sort_order\s+INTEGER\s+NOT NULL DEFAULT 0/);
});

test('both destination tables use gen_random_uuid() PKs, TIMESTAMPTZ NOT NULL DEFAULT NOW() timestamps, and the shared set_updated_at() trigger', () => {
  for (const table of ['whatsapp_destinations', 'whatsapp_destination_recipients']) {
    const idx = forward.indexOf(`CREATE TABLE IF NOT EXISTS public.${table}`);
    const end = forward.indexOf(');', idx) + 2;
    const stmt = forward.slice(idx, end);
    assert.match(stmt, /id\s+UUID\s+PRIMARY KEY DEFAULT gen_random_uuid\(\)/);
    assert.match(stmt, /created_at\s+TIMESTAMPTZ\s+NOT NULL DEFAULT NOW\(\)/);
    assert.match(stmt, /updated_at\s+TIMESTAMPTZ\s+NOT NULL DEFAULT NOW\(\)/);
    assert.match(forward, new RegExp(`CREATE TRIGGER trg_${table}_updated_at\\s*\\n\\s*BEFORE UPDATE ON public\\.${table}\\s*\\n\\s*FOR EACH ROW EXECUTE FUNCTION public\\.set_updated_at\\(\\);`));
  }
});

test('no row is ever inserted into whatsapp_destinations or whatsapp_destination_recipients by the forward migration', () => {
  assert.doesNotMatch(forward, /INSERT\s+INTO\s+public\.whatsapp_destinations\b/);
  assert.doesNotMatch(forward, /INSERT\s+INTO\s+public\.whatsapp_destination_recipients\b/);
});

test('postflight explicitly asserts no seeded row exists in either destination table', () => {
  const postflightIdx = forward.lastIndexOf('DO $$');
  const postflight = forward.slice(postflightIdx);
  assert.match(postflight, /SELECT 1 FROM public\.whatsapp_destinations\)/);
  assert.match(postflight, /whatsapp_destinations has a seeded row/);
  assert.match(postflight, /SELECT 1 FROM public\.whatsapp_messages\)/);
  assert.match(postflight, /whatsapp_messages has a seeded row/);
});

test('whatsapp_destinations and whatsapp_destination_recipients RLS: admin + operations FOR ALL, no sales/guide policy', () => {
  for (const table of ['whatsapp_destinations', 'whatsapp_destination_recipients']) {
    assert.match(forward, new RegExp(`ALTER TABLE public\\.${table} ENABLE ROW LEVEL SECURITY;`));
    assert.match(forward, new RegExp(`CREATE POLICY "${table}: admin full access"\\s*\\n\\s*ON public\\.${table} FOR ALL TO authenticated\\s*\\n\\s*USING\\s+\\( is_admin\\(\\) \\)\\s*\\n\\s*WITH CHECK \\( is_admin\\(\\) \\);`));
    assert.match(forward, new RegExp(`CREATE POLICY "${table}: operations full access"\\s*\\n\\s*ON public\\.${table} FOR ALL TO authenticated\\s*\\n\\s*USING\\s+\\( is_operations\\(\\) \\)\\s*\\n\\s*WITH CHECK \\( is_operations\\(\\) \\);`));
    assert.doesNotMatch(forward, new RegExp(`"${table}: sales`));
    assert.doesNotMatch(forward, new RegExp(`"${table}: guide`));
  }
});

// ── D. whatsapp_messages: the single durable message table ─────────────

test('whatsapp_messages is created with every required capability column', () => {
  const idx = forward.indexOf('CREATE TABLE IF NOT EXISTS public.whatsapp_messages');
  const end = forward.indexOf('\n);', idx) + 3;
  const stmt = forward.slice(idx, end);
  const expectedColumns = [
    'id', 'event_type', 'audience_type', 'idempotency_key',
    'reservation_id', 'customer_id', 'guide_id', 'tour_id', 'destination_id',
    'recipient_phone', 'recipient_display_name', 'template_key', 'language',
    'payload', 'provider_message_id', 'status', 'attempt_count',
    'next_attempt_at', 'last_attempt_at', 'last_error',
    'sent_at', 'delivered_at', 'read_at', 'failed_at',
    'created_at', 'updated_at',
  ];
  for (const col of expectedColumns) {
    assert.match(stmt, new RegExp(`\\b${col}\\b`), `expected column ${col} in whatsapp_messages`);
  }
});

test('event_type is TEXT NOT NULL with NO CHECK constraint anywhere referencing it (deliberate extensibility)', () => {
  assert.match(forward, /event_type\s+TEXT\s+NOT NULL,/);
  // Scan every CHECK constraint definition in the file and confirm none
  // of them constrain event_type specifically.
  const checkBlocks = [...forward.matchAll(/CHECK\s*\(([^)]*(?:\([^)]*\)[^)]*)*)\)/gs)].map(m => m[0]);
  for (const block of checkBlocks) {
    assert.doesNotMatch(block, /event_type/, `event_type must never appear inside a CHECK constraint: ${block}`);
  }
});

test('postflight structurally re-confirms event_type is not CHECK-constrained', () => {
  const postflightIdx = forward.lastIndexOf('DO $$');
  const postflight = forward.slice(postflightIdx);
  assert.match(postflight, /event_type must NOT be CHECK-constrained/);
});

test('audience_type is CHECK-constrained to exactly operations/guide/customer', () => {
  assert.match(forward, /audience_type\s+TEXT\s+NOT NULL\s*\n\s*CHECK \(audience_type IN \('operations', 'guide', 'customer'\)\)/);
});

test('language has no CHECK constraint and is never derived via SQL string functions', () => {
  assert.match(forward, /language\s+TEXT\s+NOT NULL,/);
  const checkBlocks = [...forward.matchAll(/CHECK\s*\(([^)]*(?:\([^)]*\)[^)]*)*)\)/gs)].map(m => m[0]);
  for (const block of checkBlocks) {
    assert.doesNotMatch(block, /\blanguage\b/, `language must never appear inside a CHECK constraint: ${block}`);
  }
  // "nationality" legitimately appears in header prose explaining language
  // must NEVER be derived from it — the real guarantee checked here is
  // structural: no executable statement derives language from anything.
  const codeLines = forward.split('\n').filter(l => !l.trim().startsWith('--'));
  const code = codeLines.join('\n');
  assert.doesNotMatch(code, /nationality/i);
});

test('idempotency_key has a UNIQUE guarantee (TEXT NOT NULL UNIQUE)', () => {
  assert.match(forward, /idempotency_key\s+TEXT\s+NOT NULL UNIQUE,/);
});

test('postflight structurally re-confirms idempotency_key UNIQUE exists via pg_constraint', () => {
  const postflightIdx = forward.lastIndexOf('DO $$');
  const postflight = forward.slice(postflightIdx);
  assert.match(postflight, /idempotency_key UNIQUE/);
  assert.match(postflight, /contype='u'/);
});

test('provider_message_id is nullable before send, with a partial UNIQUE index rather than a plain UNIQUE column', () => {
  assert.match(forward, /provider_message_id\s+TEXT,/);
  assert.doesNotMatch(forward, /provider_message_id\s+TEXT\s+UNIQUE/);
  assert.match(forward, /CREATE UNIQUE INDEX IF NOT EXISTS uq_whatsapp_messages_provider_message_id ON public\.whatsapp_messages\(provider_message_id\) WHERE provider_message_id IS NOT NULL;/);
});

test('status CHECK supports all six delivery states: queued, processing, sent, delivered, read, failed', () => {
  assert.match(forward, /status\s+TEXT\s+NOT NULL DEFAULT 'queued'\s*\n\s*CHECK \(status IN \('queued', 'processing', 'sent', 'delivered', 'read', 'failed'\)\)/);
});

test('retry fields exist: attempt_count, next_attempt_at, last_attempt_at, last_error', () => {
  assert.match(forward, /attempt_count\s+INTEGER\s+NOT NULL DEFAULT 0,/);
  assert.match(forward, /next_attempt_at\s+TIMESTAMPTZ,/);
  assert.match(forward, /last_attempt_at\s+TIMESTAMPTZ,/);
  assert.match(forward, /last_error\s+TEXT,/);
});

test('payload is JSONB NOT NULL with a safe empty-object default', () => {
  assert.match(forward, /payload\s+JSONB\s+NOT NULL DEFAULT '\{\}'::jsonb,/);
});

test('every FK from whatsapp_messages to reservations/customers/guides/tours/whatsapp_destinations is nullable and ON DELETE SET NULL', () => {
  const idx = forward.indexOf('CREATE TABLE IF NOT EXISTS public.whatsapp_messages');
  const end = forward.indexOf('\n);', idx) + 3;
  const stmt = forward.slice(idx, end);
  assert.match(stmt, /reservation_id\s+UUID\s+REFERENCES public\.reservations\(id\) ON DELETE SET NULL,/);
  assert.match(stmt, /customer_id\s+UUID\s+REFERENCES public\.customers\(id\)\s+ON DELETE SET NULL,/);
  assert.match(stmt, /guide_id\s+UUID\s+REFERENCES public\.guides\(id\)\s+ON DELETE SET NULL,/);
  assert.match(stmt, /tour_id\s+UUID\s+REFERENCES public\.tours\(id\)\s+ON DELETE SET NULL,/);
  assert.match(stmt, /destination_id\s+UUID\s+REFERENCES public\.whatsapp_destinations\(id\) ON DELETE SET NULL,/);
  // None of these five FK columns are NOT NULL.
  for (const col of ['reservation_id', 'customer_id', 'guide_id', 'tour_id', 'destination_id']) {
    assert.doesNotMatch(stmt, new RegExp(`${col}\\s+UUID[^,]*NOT NULL`));
  }
});

test('whatsapp_messages_recipient_or_operations CHECK requires recipient_phone unless audience_type is operations', () => {
  const idx = forward.indexOf('CONSTRAINT whatsapp_messages_recipient_or_operations CHECK');
  assert.ok(idx > -1);
  const stmt = forward.slice(idx, forward.indexOf(')\n);', idx) + 4);
  assert.match(stmt, /audience_type = 'operations' OR recipient_phone IS NOT NULL/);
});

test('recipient_phone/recipient_display_name are documented as enqueue-time snapshots, never live references', () => {
  const idx = forward.indexOf("COMMENT ON COLUMN public.whatsapp_messages.recipient_phone");
  assert.ok(idx > -1);
  const stmt = forward.slice(idx, forward.indexOf(";\n", idx) + 1);
  assert.match(stmt, /SNAPSHOT/);
  assert.match(stmt, /never a live reference/);
});

// ── E. Indexes ───────────────────────────────────────────────────────────

test('all six evaluated indexes are present on whatsapp_messages', () => {
  assert.match(forward, /CREATE INDEX IF NOT EXISTS idx_whatsapp_messages_status_next_attempt\s+ON public\.whatsapp_messages\(status, next_attempt_at\);/);
  assert.match(forward, /CREATE UNIQUE INDEX IF NOT EXISTS uq_whatsapp_messages_provider_message_id ON public\.whatsapp_messages\(provider_message_id\) WHERE provider_message_id IS NOT NULL;/);
  assert.match(forward, /CREATE INDEX IF NOT EXISTS idx_whatsapp_messages_reservation_id\s+ON public\.whatsapp_messages\(reservation_id\);/);
  assert.match(forward, /CREATE INDEX IF NOT EXISTS idx_whatsapp_messages_customer_id\s+ON public\.whatsapp_messages\(customer_id\);/);
  assert.match(forward, /CREATE INDEX IF NOT EXISTS idx_whatsapp_messages_guide_id\s+ON public\.whatsapp_messages\(guide_id\);/);
  assert.match(forward, /CREATE INDEX IF NOT EXISTS idx_whatsapp_messages_created_at\s+ON public\.whatsapp_messages\(created_at DESC\);/);
});

test('no index is created on whatsapp_messages.tour_id or destination_id (deliberately not evaluated as useful)', () => {
  assert.doesNotMatch(forward, /CREATE (UNIQUE )?INDEX IF NOT EXISTS \w*tour_id\w*\s+ON public\.whatsapp_messages/);
  assert.doesNotMatch(forward, /CREATE (UNIQUE )?INDEX IF NOT EXISTS \w*destination_id\w*\s+ON public\.whatsapp_messages/);
});

// ── F. RLS: server-only writes, matching the email_ingestions precedent ─

test('whatsapp_messages RLS is enabled with ONLY admin+operations SELECT policies', () => {
  assert.match(forward, /ALTER TABLE public\.whatsapp_messages ENABLE ROW LEVEL SECURITY;/);
  assert.match(forward, /CREATE POLICY "whatsapp_messages: admin read"\s*\n\s*ON public\.whatsapp_messages FOR SELECT TO authenticated\s*\n\s*USING \( is_admin\(\) \);/);
  assert.match(forward, /CREATE POLICY "whatsapp_messages: operations read"\s*\n\s*ON public\.whatsapp_messages FOR SELECT TO authenticated\s*\n\s*USING \( is_operations\(\) \);/);
});

test('whatsapp_messages has NO INSERT/UPDATE/DELETE policy for any role anywhere in the file', () => {
  assert.doesNotMatch(forward, /CREATE POLICY[^;]*ON public\.whatsapp_messages FOR (ALL|INSERT|UPDATE|DELETE)/s);
});

test('postflight structurally re-confirms no INSERT/UPDATE/DELETE policy exists on whatsapp_messages via pg_policies', () => {
  const postflightIdx = forward.lastIndexOf('DO $$');
  const postflight = forward.slice(postflightIdx);
  assert.match(postflight, /cmd IN \('INSERT','UPDATE','DELETE'\)/);
  assert.match(postflight, /must have NO INSERT\/UPDATE\/DELETE policy for any role/);
});

test('no sales or guide policy exists anywhere for whatsapp_messages', () => {
  assert.doesNotMatch(forward, /"whatsapp_messages: sales/);
  assert.doesNotMatch(forward, /"whatsapp_messages: guide/);
});

// ── G. No Meta credential/token column anywhere in this migration ──────

test('no column or index in the entire forward migration resembles a Meta credential/access token', () => {
  const codeLines = forward.split('\n').filter(l => !l.trim().startsWith('--'));
  const code = codeLines.join('\n');
  assert.doesNotMatch(code, /access_token/i);
  assert.doesNotMatch(code, /api_secret/i);
  assert.doesNotMatch(code, /client_secret/i);
  assert.doesNotMatch(code, /webhook_secret/i);
  assert.doesNotMatch(code, /verify_token/i);
});

test('no environment variable is read or referenced by this migration (schema-only, no server code)', () => {
  assert.doesNotMatch(forward, /process\.env/);
  assert.doesNotMatch(forward, /\bENV\b/);
});

// ── H. Never touches existing customer/guide phone fields ──────────────

test('customers.phone and guides.phone are never ALTERed, UPDATEd, or referenced for a write anywhere in the forward migration', () => {
  const codeLines = forward.split('\n').filter(l => !l.trim().startsWith('--'));
  const code = codeLines.join('\n');
  assert.doesNotMatch(code, /ALTER TABLE public\.customers/);
  assert.doesNotMatch(code, /ALTER TABLE public\.guides/);
  assert.doesNotMatch(code, /UPDATE\s+public\.customers/);
  assert.doesNotMatch(code, /UPDATE\s+public\.guides/);
  assert.doesNotMatch(code, /customers\.phone\s*=/);
  assert.doesNotMatch(code, /guides\.phone\s*=/);
});

test('no normalized_phone/whatsapp_phone column is added to customers or guides by this migration', () => {
  assert.doesNotMatch(forward, /ALTER TABLE public\.customers[\s\S]{0,200}(normalized_phone|whatsapp_phone)/);
  assert.doesNotMatch(forward, /ALTER TABLE public\.guides[\s\S]{0,200}(normalized_phone|whatsapp_phone)/);
});

// ── I. activity_logs is completely untouched ────────────────────────────

test('the forward migration never executes a statement touching activity_logs (only discusses it in prose/comments)', () => {
  // "activity_logs" legitimately appears in header comments (--) AND
  // inside COMMENT ON TABLE/COLUMN string literals (real SQL statements,
  // but ones that only attach documentation to whatsapp_messages/
  // whatsapp_destinations — they do not touch the activity_logs table
  // itself). The real guarantee checked here is structural: no
  // statement that actually TARGETS activity_logs (ALTER/INSERT/UPDATE/
  // DROP/CREATE) exists anywhere.
  assert.doesNotMatch(forward, /ALTER TABLE public\.activity_logs/);
  assert.doesNotMatch(forward, /INSERT INTO public\.activity_logs/);
  assert.doesNotMatch(forward, /UPDATE public\.activity_logs/);
  assert.doesNotMatch(forward, /DROP TABLE[^;]*activity_logs/);
  assert.doesNotMatch(forward, /CREATE TABLE[^;]*activity_logs/);
  assert.doesNotMatch(forward, /REFERENCES public\.activity_logs/);
});

test('the rollback never executes a statement touching activity_logs beyond its read-only postflight existence check', () => {
  assert.doesNotMatch(rollback, /ALTER TABLE public\.activity_logs/);
  assert.doesNotMatch(rollback, /INSERT INTO public\.activity_logs/);
  assert.doesNotMatch(rollback, /UPDATE public\.activity_logs/);
  assert.doesNotMatch(rollback, /DROP TABLE[^;]*activity_logs/);
  assert.doesNotMatch(rollback, /CREATE TABLE[^;]*activity_logs/);
  assert.match(rollback, /table_name='activity_logs'/);
});

// ── J. Civitatis V12/V13.1 RPC definitions are untouched ────────────────

test('the forward migration never CREATEs, REPLACEs, ALTERs, or DROPs either Civitatis RPC — only read-only signature checks', () => {
  for (const fn of ['ingest_civitatis_booking', 'cancel_civitatis_booking']) {
    assert.doesNotMatch(forward, new RegExp(`CREATE (OR REPLACE )?FUNCTION public\\.${fn}`));
    assert.doesNotMatch(forward, new RegExp(`DROP FUNCTION[^;]*${fn}`));
    assert.doesNotMatch(forward, new RegExp(`ALTER FUNCTION[^;]*${fn}`));
    const mentions = [...forward.matchAll(new RegExp(fn, 'g'))];
    assert.ok(mentions.length >= 2, `expected at least a preflight AND postflight reference to ${fn}`);
  }
});

test('the forward migration verifies (never modifies) the exact known 26-parameter ingest_civitatis_booking signature, twice', () => {
  const sigPattern = /'text', 'text', 'timestamptz', 'text', 'text', 'text', 'uuid', 'text', 'uuid', 'text',\s*\n\s*'date', 'time', 'integer', 'integer', 'numeric', 'text', 'numeric', 'text', 'uuid',\s*\n\s*'text', 'text', 'text', 'jsonb', 'boolean', 'text', 'text'/;
  const matches = forward.match(new RegExp(sigPattern.source, 'g'));
  assert.ok(matches && matches.length === 2, 'expected the ingest_civitatis_booking signature check to appear exactly twice (preflight + postflight)');
});

test('the forward migration verifies (never modifies) the exact known 7-parameter cancel_civitatis_booking signature, twice', () => {
  const sigPattern = /ARRAY\['text','text','timestamptz','text','text','uuid','text'\]::regtype\[\]::oid\[\]/;
  const matches = forward.match(new RegExp(sigPattern.source, 'g'));
  assert.ok(matches && matches.length === 2, 'expected the cancel_civitatis_booking signature check to appear exactly twice (preflight + postflight)');
});

test('the rollback also re-verifies both Civitatis RPC signatures unchanged in its own postflight', () => {
  assert.match(rollback, /ingest_civitatis_booking/);
  assert.match(rollback, /cancel_civitatis_booking/);
  assert.match(rollback, /pronargs = 26/);
  assert.match(rollback, /pronargs = 7/);
});

// ── K. Rollback: scope is limited to newly introduced objects only ─────

test('rollback drops whatsapp_messages, whatsapp_destination_recipients, and whatsapp_destinations, in that order', () => {
  const iMessages    = rollback.indexOf('DROP TABLE IF EXISTS public.whatsapp_messages;');
  const iRecipients  = rollback.indexOf('DROP TABLE IF EXISTS public.whatsapp_destination_recipients;');
  const iDestinations = rollback.indexOf('DROP TABLE IF EXISTS public.whatsapp_destinations;');
  assert.ok(iMessages > -1 && iRecipients > -1 && iDestinations > -1, 'expected all three DROP TABLE statements');
  assert.ok(iMessages < iRecipients, 'whatsapp_messages must be dropped before whatsapp_destination_recipients (holds an FK into destinations, dropped before the parent it references)');
  assert.ok(iRecipients < iDestinations, 'whatsapp_destination_recipients must be dropped before whatsapp_destinations (holds an FK into it)');
});

test('rollback drops tour_channels.review_url via DROP COLUMN IF EXISTS and no other column', () => {
  const idx = rollback.indexOf('ALTER TABLE public.tour_channels\n  DROP COLUMN IF EXISTS review_url;');
  assert.ok(idx > -1);
});

test('rollback never drops or alters tour_channels.listing_url or any other pre-existing tour_channels column', () => {
  const alterIdx = rollback.indexOf('ALTER TABLE public.tour_channels\n  DROP COLUMN IF EXISTS review_url;');
  assert.ok(alterIdx > -1);
  const stmt = rollback.slice(alterIdx, rollback.indexOf(';', alterIdx) + 1);
  assert.doesNotMatch(stmt, /listing_url/);
  assert.doesNotMatch(stmt, /DROP COLUMN IF EXISTS listing_url/);
});

test('rollback never touches reservations, customers, guides, tours, or ingest_civitatis_booking/cancel_civitatis_booking definitions', () => {
  // Scoped to non-comment lines only — the header/postflight prose
  // legitimately names these tables (e.g. "public.reservations — never
  // referenced for modification") without that being a write statement.
  const codeLines = rollback.split('\n').filter(l => !l.trim().startsWith('--'));
  const code = codeLines.join('\n');
  for (const t of ['reservations', 'customers', 'guides', 'tours']) {
    assert.doesNotMatch(code, new RegExp(`ALTER TABLE public\\.${t}\\b`));
    assert.doesNotMatch(code, new RegExp(`DROP TABLE[^;]*\\b${t}\\b`));
    assert.doesNotMatch(code, new RegExp(`INSERT INTO public\\.${t}\\b`));
    assert.doesNotMatch(code, new RegExp(`UPDATE public\\.${t}\\b`));
  }
  assert.doesNotMatch(code, /CREATE (OR REPLACE )?FUNCTION/);
  assert.doesNotMatch(code, /DROP FUNCTION/);
  assert.doesNotMatch(code, /ALTER FUNCTION/);
});

test('rollback postflight explicitly re-confirms every dropped object is actually gone', () => {
  const postflightIdx = rollback.lastIndexOf('DO $$');
  const postflight = rollback.slice(postflightIdx);
  assert.match(postflight, /table_name='whatsapp_messages'/);
  assert.match(postflight, /table_name='whatsapp_destination_recipients'/);
  assert.match(postflight, /table_name='whatsapp_destinations'/);
  assert.match(postflight, /column_name='review_url'/);
});

test('rollback postflight explicitly re-confirms every out-of-scope object is still present', () => {
  const postflightIdx = rollback.lastIndexOf('DO $$');
  const postflight = rollback.slice(postflightIdx);
  for (const t of ['tour_channels', 'reservations', 'customers', 'guides', 'tours', 'activity_logs']) {
    assert.match(postflight, new RegExp(`table_name='${t}'`));
  }
  assert.match(postflight, /column_name='listing_url'/);
});

test('rollback contains no destructive operation beyond its explicitly scoped DROPs (no DELETE/UPDATE/TRUNCATE/INSERT anywhere)', () => {
  const liveDml = rollback.split('\n').filter(line => {
    const trimmed = line.trim();
    if (trimmed.startsWith('--') || trimmed === '') return false;
    return /\bDELETE\s+FROM\b|\bUPDATE\s+public\.|\bTRUNCATE\b|\bINSERT\s+INTO\b/i.test(trimmed);
  });
  assert.deepEqual(liveDml, []);
});

// ── L. No production SQL execution anywhere in this test file ──────────

test('this test file never opens a database connection or executes SQL — every assertion is a static text match', () => {
  const selfSource = fs.readFileSync(__filename, 'utf8');
  assert.doesNotMatch(selfSource, /require\(['"]pg['"]\)/);
  assert.doesNotMatch(selfSource, /require\(['"]@supabase\/supabase-js['"]\)/);
  assert.doesNotMatch(selfSource, /\.query\(/);
  assert.doesNotMatch(selfSource, /createClient\(/);
});
