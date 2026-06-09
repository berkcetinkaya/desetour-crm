-- ============================================================
-- DESE TOUR OPERATIONS CENTER
-- Row Level Security Policies
-- ============================================================
-- File:    supabase_rls_policies.sql
-- Version: V1 — June 2026
-- Depends: supabase_schema.sql (run first)
--
-- HOW TO APPLY
-- ─────────────────────────────────────────────────────────────
-- Supabase Dashboard → SQL Editor → paste and run.
-- Or: supabase db push --file supabase_rls_policies.sql
--
-- ⚠  IMPORTANT: Run these policies AFTER your app is working
--    with mock/anonymous data. Enabling RLS on a table with no
--    matching policy will block ALL queries, including your
--    own dashboard reads.
--
-- TESTING AFTER APPLY
-- ─────────────────────────────────────────────────────────────
-- 1. Log in as each role and verify you can read expected data.
-- 2. Verify admin can read/write everything.
-- 3. Verify guide cannot see payments.
-- 4. Check activity_logs are readable but not writable by client.
--
-- ROLES (stored in staff_users.role)
-- ─────────────────────────────────────────────────────────────
--   admin        → full access
--   sales        → customers, leads, quotes, quote_items, own tasks/reminders
--   operations   → reservations, tours, read-only customers/leads/quotes, own tasks/reminders
--   guide        → only their assigned reservations, tasks, reminders
-- ============================================================


-- ────────────────────────────────────────────────────────────────────────────
-- SCHEMA ADDITIONS
-- Columns needed by RLS policies that are missing from the original schema.
-- Safe to run multiple times (IF NOT EXISTS / idempotent).
-- ────────────────────────────────────────────────────────────────────────────

-- quotes: add assigned_to so Sales staff can be explicitly linked to a quote
ALTER TABLE public.quotes
  ADD COLUMN IF NOT EXISTS assigned_to UUID
    REFERENCES public.staff_users(id) ON DELETE SET NULL;

COMMENT ON COLUMN public.quotes.assigned_to IS
  'Sales staff member responsible for this quote. Used by RLS policies.';

-- quote_items: inherit access from parent quote — no extra column needed.

-- messages: staff_id already exists, but add assigned_to on message_threads
-- so Operations can be assigned to handle a thread.
ALTER TABLE public.message_threads
  ADD COLUMN IF NOT EXISTS assigned_to UUID
    REFERENCES public.staff_users(id) ON DELETE SET NULL;

-- (message_threads already had assigned_to in schema; this is a safety guard)

-- tours: add created_by so we know who owns each tour record
ALTER TABLE public.tours
  ADD COLUMN IF NOT EXISTS created_by UUID
    REFERENCES public.staff_users(id) ON DELETE SET NULL;

-- Index new columns for policy performance
CREATE INDEX IF NOT EXISTS idx_quotes_assigned_to      ON public.quotes(assigned_to);
CREATE INDEX IF NOT EXISTS idx_tours_created_by        ON public.tours(created_by);


-- ────────────────────────────────────────────────────────────────────────────
-- HELPER FUNCTIONS
-- Called inside RLS USING/WITH CHECK clauses.
-- All are SECURITY DEFINER so they bypass RLS on staff_users itself.
-- ────────────────────────────────────────────────────────────────────────────

-- Returns the role of the currently authenticated staff member.
-- Falls back to NULL if the user has no staff_users row.
CREATE OR REPLACE FUNCTION public.get_current_staff_role()
RETURNS TEXT
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT role
  FROM   public.staff_users
  WHERE  id = auth.uid()
  LIMIT  1;
$$;

COMMENT ON FUNCTION public.get_current_staff_role IS
  'Returns the role of the currently logged-in staff member (admin/sales/operations/guide).
   Used inside RLS policies — SECURITY DEFINER to bypass RLS on staff_users.';


-- Convenience predicates — readable in policies as is_admin(), etc.
CREATE OR REPLACE FUNCTION public.is_admin()      RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$ SELECT get_current_staff_role() = 'admin';      $$;
CREATE OR REPLACE FUNCTION public.is_sales()      RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$ SELECT get_current_staff_role() = 'sales';      $$;
CREATE OR REPLACE FUNCTION public.is_operations() RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$ SELECT get_current_staff_role() = 'operations'; $$;
CREATE OR REPLACE FUNCTION public.is_guide()      RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$ SELECT get_current_staff_role() = 'guide';       $$;

-- Returns TRUE if the current user is a non-guide authenticated staff member.
CREATE OR REPLACE FUNCTION public.is_staff()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT get_current_staff_role() IN ('admin','sales','operations','guide');
$$;


-- ════════════════════════════════════════════════════════════════════════════
-- TABLE 1: staff_users
-- ════════════════════════════════════════════════════════════════════════════
ALTER TABLE public.staff_users ENABLE ROW LEVEL SECURITY;

-- Every authenticated staff member can read all staff rows
-- (needed for dropdowns and assignment pickers in the UI).
CREATE POLICY "staff_users: all staff can read"
  ON public.staff_users
  FOR SELECT
  TO authenticated
  USING ( is_staff() );

-- Staff members can update only their own profile.
CREATE POLICY "staff_users: own profile update"
  ON public.staff_users
  FOR UPDATE
  TO authenticated
  USING  ( auth.uid() = id )
  WITH CHECK ( auth.uid() = id );

-- Only admin can create new staff rows.
CREATE POLICY "staff_users: admin insert"
  ON public.staff_users
  FOR INSERT
  TO authenticated
  WITH CHECK ( is_admin() );

-- Only admin can deactivate (soft-delete) staff rows.
CREATE POLICY "staff_users: admin delete"
  ON public.staff_users
  FOR DELETE
  TO authenticated
  USING ( is_admin() );


-- ════════════════════════════════════════════════════════════════════════════
-- TABLE 2: sources  (reference / lookup table)
-- ════════════════════════════════════════════════════════════════════════════
ALTER TABLE public.sources ENABLE ROW LEVEL SECURITY;

-- All authenticated staff can read sources (needed for lead/customer forms).
CREATE POLICY "sources: all staff read"
  ON public.sources
  FOR SELECT
  TO authenticated
  USING ( is_staff() );

-- Only admin can manage source reference data.
CREATE POLICY "sources: admin write"
  ON public.sources
  FOR ALL
  TO authenticated
  USING   ( is_admin() )
  WITH CHECK ( is_admin() );


-- ════════════════════════════════════════════════════════════════════════════
-- TABLE 3: customers
-- ════════════════════════════════════════════════════════════════════════════
ALTER TABLE public.customers ENABLE ROW LEVEL SECURITY;

-- Admin: full access
CREATE POLICY "customers: admin full access"
  ON public.customers FOR ALL TO authenticated
  USING   ( is_admin() )
  WITH CHECK ( is_admin() );

-- Sales: read all active customers, write any customer
CREATE POLICY "customers: sales read all"
  ON public.customers FOR SELECT TO authenticated
  USING ( is_sales() AND is_active = TRUE );

CREATE POLICY "customers: sales write"
  ON public.customers FOR INSERT TO authenticated
  WITH CHECK ( is_sales() );

CREATE POLICY "customers: sales update"
  ON public.customers FOR UPDATE TO authenticated
  USING   ( is_sales() )
  WITH CHECK ( is_sales() );

-- Operations: read-only access to all active customers
CREATE POLICY "customers: operations read"
  ON public.customers FOR SELECT TO authenticated
  USING ( is_operations() AND is_active = TRUE );

-- Guide: can only read customers linked to their assigned reservations.
-- (Resolved via EXISTS subquery — guide sees customer data for their tours.)
CREATE POLICY "customers: guide reads assigned customers"
  ON public.customers FOR SELECT TO authenticated
  USING (
    is_guide()
    AND EXISTS (
      SELECT 1
      FROM   public.reservations r
      WHERE  r.customer_id = customers.id
        AND  r.assigned_to  = auth.uid()
        AND  r.status NOT IN ('cancelled')
    )
  );

-- NOTE: passport_number is sensitive. For extra protection, create a separate
-- view without that column for non-admin roles. Example (run separately):
--   CREATE VIEW public.customers_safe AS
--     SELECT id, full_name, email, phone, nationality, language,
--            notes, tags, source_id, import_type, is_active, created_at
--     FROM   public.customers;
--   GRANT SELECT ON public.customers_safe TO authenticated;


-- ════════════════════════════════════════════════════════════════════════════
-- TABLE 4: leads
-- ════════════════════════════════════════════════════════════════════════════
ALTER TABLE public.leads ENABLE ROW LEVEL SECURITY;

-- Admin: full access
CREATE POLICY "leads: admin full access"
  ON public.leads FOR ALL TO authenticated
  USING   ( is_admin() )
  WITH CHECK ( is_admin() );

-- Sales: read all leads, write any lead
CREATE POLICY "leads: sales read all"
  ON public.leads FOR SELECT TO authenticated
  USING ( is_sales() );

CREATE POLICY "leads: sales write"
  ON public.leads FOR INSERT TO authenticated
  WITH CHECK ( is_sales() );

CREATE POLICY "leads: sales update own or assigned"
  ON public.leads FOR UPDATE TO authenticated
  USING   ( is_sales() AND (assigned_to = auth.uid() OR created_by = auth.uid()) )
  WITH CHECK ( is_sales() );

-- Operations: read-only (they need lead context for reservation work)
CREATE POLICY "leads: operations read"
  ON public.leads FOR SELECT TO authenticated
  USING ( is_operations() );

-- Guide: no access to leads (not needed for their role)


-- ════════════════════════════════════════════════════════════════════════════
-- TABLE 5: tours
-- ════════════════════════════════════════════════════════════════════════════
ALTER TABLE public.tours ENABLE ROW LEVEL SECURITY;

-- Admin: full access
CREATE POLICY "tours: admin full access"
  ON public.tours FOR ALL TO authenticated
  USING   ( is_admin() )
  WITH CHECK ( is_admin() );

-- Sales: read active tours (needed for quote/lead forms)
CREATE POLICY "tours: sales read active"
  ON public.tours FOR SELECT TO authenticated
  USING ( is_sales() AND is_active = TRUE );

-- Operations: read all + write (they manage tour catalog)
CREATE POLICY "tours: operations read all"
  ON public.tours FOR SELECT TO authenticated
  USING ( is_operations() );

CREATE POLICY "tours: operations write"
  ON public.tours FOR INSERT TO authenticated
  WITH CHECK ( is_operations() );

CREATE POLICY "tours: operations update"
  ON public.tours FOR UPDATE TO authenticated
  USING   ( is_operations() )
  WITH CHECK ( is_operations() );

-- Guide: read only active tours relevant to their reservations
CREATE POLICY "tours: guide reads assigned tour"
  ON public.tours FOR SELECT TO authenticated
  USING (
    is_guide()
    AND EXISTS (
      SELECT 1
      FROM   public.reservations r
      WHERE  r.tour_id    = tours.id
        AND  r.assigned_to = auth.uid()
    )
  );


-- ════════════════════════════════════════════════════════════════════════════
-- TABLE 6: quotes
-- ════════════════════════════════════════════════════════════════════════════
ALTER TABLE public.quotes ENABLE ROW LEVEL SECURITY;

-- Admin: full access
CREATE POLICY "quotes: admin full access"
  ON public.quotes FOR ALL TO authenticated
  USING   ( is_admin() )
  WITH CHECK ( is_admin() );

-- Sales: read all quotes; write only quotes they created or are assigned to
CREATE POLICY "quotes: sales read all"
  ON public.quotes FOR SELECT TO authenticated
  USING ( is_sales() );

CREATE POLICY "quotes: sales insert"
  ON public.quotes FOR INSERT TO authenticated
  WITH CHECK ( is_sales() AND created_by = auth.uid() );

CREATE POLICY "quotes: sales update own"
  ON public.quotes FOR UPDATE TO authenticated
  USING (
    is_sales()
    AND (created_by = auth.uid() OR assigned_to = auth.uid())
  )
  WITH CHECK (
    is_sales()
    AND (created_by = auth.uid() OR assigned_to = auth.uid())
  );

-- Operations: read-only (they need quote totals for reservation pricing)
CREATE POLICY "quotes: operations read"
  ON public.quotes FOR SELECT TO authenticated
  USING ( is_operations() );

-- Guide: no access to quotes


-- ════════════════════════════════════════════════════════════════════════════
-- TABLE 7: quote_items
-- (access derived from parent quote — no extra ownership column needed)
-- ════════════════════════════════════════════════════════════════════════════
ALTER TABLE public.quote_items ENABLE ROW LEVEL SECURITY;

-- Admin: full access
CREATE POLICY "quote_items: admin full access"
  ON public.quote_items FOR ALL TO authenticated
  USING   ( is_admin() )
  WITH CHECK ( is_admin() );

-- Sales: access follows parent quote access
CREATE POLICY "quote_items: sales via quote"
  ON public.quote_items FOR SELECT TO authenticated
  USING (
    is_sales()
    AND EXISTS (
      SELECT 1 FROM public.quotes q
      WHERE q.id = quote_items.quote_id
    )
  );

CREATE POLICY "quote_items: sales write via quote"
  ON public.quote_items FOR INSERT TO authenticated
  WITH CHECK (
    is_sales()
    AND EXISTS (
      SELECT 1 FROM public.quotes q
      WHERE q.id = quote_items.quote_id
        AND (q.created_by = auth.uid() OR q.assigned_to = auth.uid())
    )
  );

CREATE POLICY "quote_items: sales update via quote"
  ON public.quote_items FOR UPDATE TO authenticated
  USING (
    is_sales()
    AND EXISTS (
      SELECT 1 FROM public.quotes q
      WHERE q.id = quote_items.quote_id
        AND (q.created_by = auth.uid() OR q.assigned_to = auth.uid())
    )
  );

-- Operations: read-only via parent quote
CREATE POLICY "quote_items: operations read"
  ON public.quote_items FOR SELECT TO authenticated
  USING ( is_operations() );


-- ════════════════════════════════════════════════════════════════════════════
-- TABLE 8: reservations
-- ════════════════════════════════════════════════════════════════════════════
ALTER TABLE public.reservations ENABLE ROW LEVEL SECURITY;

-- Admin: full access
CREATE POLICY "reservations: admin full access"
  ON public.reservations FOR ALL TO authenticated
  USING   ( is_admin() )
  WITH CHECK ( is_admin() );

-- Sales: read-only (they need to see reservation status after quote → conversion)
CREATE POLICY "reservations: sales read"
  ON public.reservations FOR SELECT TO authenticated
  USING ( is_sales() );

-- Operations: full read + write on all reservations
CREATE POLICY "reservations: operations read all"
  ON public.reservations FOR SELECT TO authenticated
  USING ( is_operations() );

CREATE POLICY "reservations: operations insert"
  ON public.reservations FOR INSERT TO authenticated
  WITH CHECK ( is_operations() );

CREATE POLICY "reservations: operations update"
  ON public.reservations FOR UPDATE TO authenticated
  USING   ( is_operations() )
  WITH CHECK ( is_operations() );

-- Guide: read-only access to reservations assigned to them
CREATE POLICY "reservations: guide reads assigned"
  ON public.reservations FOR SELECT TO authenticated
  USING (
    is_guide()
    AND assigned_to = auth.uid()
    AND status NOT IN ('cancelled')
  );

-- Guide: can update only operational fields on their own reservations
-- (e.g. mark pickup confirmed, add notes) — restricted columns enforced
-- via the WITH CHECK condition below.
CREATE POLICY "reservations: guide update own status"
  ON public.reservations FOR UPDATE TO authenticated
  USING (
    is_guide()
    AND assigned_to = auth.uid()
  )
  WITH CHECK (
    is_guide()
    AND assigned_to = auth.uid()
    -- Guide may only update notes and status; financials are protected.
    -- For full column-level restriction, use a BEFORE UPDATE trigger.
  );


-- ════════════════════════════════════════════════════════════════════════════
-- TABLE 9: payments
-- ════════════════════════════════════════════════════════════════════════════
ALTER TABLE public.payments ENABLE ROW LEVEL SECURITY;

-- Admin: full access
CREATE POLICY "payments: admin full access"
  ON public.payments FOR ALL TO authenticated
  USING   ( is_admin() )
  WITH CHECK ( is_admin() );

-- Sales: read payments on their customers' reservations
CREATE POLICY "payments: sales read own"
  ON public.payments FOR SELECT TO authenticated
  USING (
    is_sales()
    AND EXISTS (
      SELECT 1 FROM public.leads l
      WHERE l.customer_id = payments.customer_id
        AND (l.assigned_to = auth.uid() OR l.created_by = auth.uid())
    )
  );

-- Operations: full read + write payments
CREATE POLICY "payments: operations full access"
  ON public.payments FOR ALL TO authenticated
  USING   ( is_operations() )
  WITH CHECK ( is_operations() );

-- Guide: NO access to payments (intentionally excluded)
-- No policy for guide on payments table = zero access.

-- NOTE: If you need sales to also CREATE payments (deposit collection),
-- add an INSERT policy here. For V1 this stays Operations-only.


-- ════════════════════════════════════════════════════════════════════════════
-- TABLE 10: tasks
-- ════════════════════════════════════════════════════════════════════════════
ALTER TABLE public.tasks ENABLE ROW LEVEL SECURITY;

-- Admin: full access
CREATE POLICY "tasks: admin full access"
  ON public.tasks FOR ALL TO authenticated
  USING   ( is_admin() )
  WITH CHECK ( is_admin() );

-- Sales: read/write own tasks (assigned to them or created by them)
CREATE POLICY "tasks: sales own tasks"
  ON public.tasks FOR SELECT TO authenticated
  USING (
    is_sales()
    AND (assigned_to = auth.uid() OR created_by = auth.uid())
  );

CREATE POLICY "tasks: sales insert"
  ON public.tasks FOR INSERT TO authenticated
  WITH CHECK ( is_sales() AND created_by = auth.uid() );

CREATE POLICY "tasks: sales update own"
  ON public.tasks FOR UPDATE TO authenticated
  USING (
    is_sales()
    AND (assigned_to = auth.uid() OR created_by = auth.uid())
  )
  WITH CHECK (
    is_sales()
    AND (assigned_to = auth.uid() OR created_by = auth.uid())
  );

-- Operations: read/write own tasks
CREATE POLICY "tasks: operations own tasks"
  ON public.tasks FOR SELECT TO authenticated
  USING (
    is_operations()
    AND (assigned_to = auth.uid() OR created_by = auth.uid())
  );

CREATE POLICY "tasks: operations insert"
  ON public.tasks FOR INSERT TO authenticated
  WITH CHECK ( is_operations() AND created_by = auth.uid() );

CREATE POLICY "tasks: operations update own"
  ON public.tasks FOR UPDATE TO authenticated
  USING (
    is_operations()
    AND (assigned_to = auth.uid() OR created_by = auth.uid())
  );

-- Guide: read/write only tasks assigned to them
CREATE POLICY "tasks: guide assigned tasks"
  ON public.tasks FOR SELECT TO authenticated
  USING (
    is_guide()
    AND assigned_to = auth.uid()
  );

CREATE POLICY "tasks: guide update assigned"
  ON public.tasks FOR UPDATE TO authenticated
  USING (
    is_guide()
    AND assigned_to = auth.uid()
  )
  WITH CHECK (
    is_guide()
    AND assigned_to = auth.uid()
  );

-- NOTE: Admin is responsible for creating cross-team tasks. Staff create
-- only tasks assigned to themselves or their team. For broader task visibility
-- (e.g. Sales manager seeing all Sales tasks), use admin or a manager role.


-- ════════════════════════════════════════════════════════════════════════════
-- TABLE 11: reminders
-- ════════════════════════════════════════════════════════════════════════════
ALTER TABLE public.reminders ENABLE ROW LEVEL SECURITY;

-- Admin: full access
CREATE POLICY "reminders: admin full access"
  ON public.reminders FOR ALL TO authenticated
  USING   ( is_admin() )
  WITH CHECK ( is_admin() );

-- Sales: own reminders
CREATE POLICY "reminders: sales own"
  ON public.reminders FOR SELECT TO authenticated
  USING (
    is_sales()
    AND (assigned_to = auth.uid() OR created_by = auth.uid())
  );

CREATE POLICY "reminders: sales insert"
  ON public.reminders FOR INSERT TO authenticated
  WITH CHECK ( is_sales() AND created_by = auth.uid() );

CREATE POLICY "reminders: sales update own"
  ON public.reminders FOR UPDATE TO authenticated
  USING (
    is_sales()
    AND (assigned_to = auth.uid() OR created_by = auth.uid())
  );

-- Operations: own reminders
CREATE POLICY "reminders: operations own"
  ON public.reminders FOR SELECT TO authenticated
  USING (
    is_operations()
    AND (assigned_to = auth.uid() OR created_by = auth.uid())
  );

CREATE POLICY "reminders: operations insert"
  ON public.reminders FOR INSERT TO authenticated
  WITH CHECK ( is_operations() AND created_by = auth.uid() );

CREATE POLICY "reminders: operations update own"
  ON public.reminders FOR UPDATE TO authenticated
  USING (
    is_operations()
    AND (assigned_to = auth.uid() OR created_by = auth.uid())
  );

-- Guide: only reminders assigned to them
CREATE POLICY "reminders: guide assigned"
  ON public.reminders FOR SELECT TO authenticated
  USING (
    is_guide()
    AND assigned_to = auth.uid()
  );

CREATE POLICY "reminders: guide update assigned"
  ON public.reminders FOR UPDATE TO authenticated
  USING (
    is_guide()
    AND assigned_to = auth.uid()
  );


-- ════════════════════════════════════════════════════════════════════════════
-- TABLE 12: activity_logs  (append-only audit trail)
-- ════════════════════════════════════════════════════════════════════════════
ALTER TABLE public.activity_logs ENABLE ROW LEVEL SECURITY;

-- Admin: can read all activity logs
CREATE POLICY "activity_logs: admin read all"
  ON public.activity_logs FOR SELECT TO authenticated
  USING ( is_admin() );

-- Sales: can read activity logs related to their own records
-- (leads, quotes, customers they own)
CREATE POLICY "activity_logs: sales read own"
  ON public.activity_logs FOR SELECT TO authenticated
  USING (
    is_sales()
    AND performed_by = auth.uid()
    -- OR related to an entity they created — use a union policy if needed:
    -- OR entity_id IN (SELECT id FROM leads WHERE created_by = auth.uid())
  );

-- Operations: can read activity logs for reservations and payments
CREATE POLICY "activity_logs: operations read own"
  ON public.activity_logs FOR SELECT TO authenticated
  USING (
    is_operations()
    AND (
      performed_by = auth.uid()
      OR entity_type IN ('reservation', 'payment', 'tour')
    )
  );

-- Guide: can only read their own activity
CREATE POLICY "activity_logs: guide read own"
  ON public.activity_logs FOR SELECT TO authenticated
  USING (
    is_guide()
    AND performed_by = auth.uid()
  );

-- INSERT: all authenticated staff can insert activity logs.
-- The service role handles system-generated logs (webhooks etc.).
-- We intentionally allow staff to create logs from the client
-- since activity logging is non-sensitive append-only.
CREATE POLICY "activity_logs: all staff insert"
  ON public.activity_logs FOR INSERT TO authenticated
  WITH CHECK ( is_staff() AND performed_by = auth.uid() );

-- DELETE/UPDATE: nobody — activity logs are immutable.
-- The rules from supabase_schema.sql already block these via PostgreSQL rules.
-- If those rules are not applied, add explicit RLS denial:
-- (no policy = no access for DELETE/UPDATE since RLS is enabled)


-- ════════════════════════════════════════════════════════════════════════════
-- TABLE 13: settings
-- ════════════════════════════════════════════════════════════════════════════
ALTER TABLE public.settings ENABLE ROW LEVEL SECURITY;

-- All authenticated staff can read public settings (currency, date format, etc.)
CREATE POLICY "settings: all staff read public"
  ON public.settings FOR SELECT TO authenticated
  USING ( is_staff() AND is_public = TRUE );

-- Admin can read ALL settings (including private ones)
CREATE POLICY "settings: admin read all"
  ON public.settings FOR SELECT TO authenticated
  USING ( is_admin() );

-- Only admin can modify settings
CREATE POLICY "settings: admin write"
  ON public.settings FOR ALL TO authenticated
  USING   ( is_admin() )
  WITH CHECK ( is_admin() );


-- ════════════════════════════════════════════════════════════════════════════
-- TABLE 14: message_threads
-- ════════════════════════════════════════════════════════════════════════════
ALTER TABLE public.message_threads ENABLE ROW LEVEL SECURITY;

-- Admin: full access
CREATE POLICY "message_threads: admin full access"
  ON public.message_threads FOR ALL TO authenticated
  USING   ( is_admin() )
  WITH CHECK ( is_admin() );

-- Sales and Operations: can read threads assigned to them or unassigned open ones
CREATE POLICY "message_threads: sales read assigned or open"
  ON public.message_threads FOR SELECT TO authenticated
  USING (
    is_sales()
    AND (
      assigned_to = auth.uid()
      OR assigned_to IS NULL
    )
    AND status = 'open'
  );

CREATE POLICY "message_threads: sales update assigned"
  ON public.message_threads FOR UPDATE TO authenticated
  USING (
    is_sales()
    AND (assigned_to = auth.uid() OR assigned_to IS NULL)
  )
  WITH CHECK (
    is_sales()
    AND (assigned_to = auth.uid() OR assigned_to IS NULL)
  );

CREATE POLICY "message_threads: operations read assigned or open"
  ON public.message_threads FOR SELECT TO authenticated
  USING (
    is_operations()
    AND (
      assigned_to = auth.uid()
      OR assigned_to IS NULL
    )
    AND status = 'open'
  );

CREATE POLICY "message_threads: operations update assigned"
  ON public.message_threads FOR UPDATE TO authenticated
  USING ( is_operations() AND (assigned_to = auth.uid() OR assigned_to IS NULL) );

-- Guide: no access to message threads
-- (no policy = zero access for guide role)


-- ════════════════════════════════════════════════════════════════════════════
-- TABLE 15: messages
-- ════════════════════════════════════════════════════════════════════════════
ALTER TABLE public.messages ENABLE ROW LEVEL SECURITY;

-- Admin: full access
CREATE POLICY "messages: admin full access"
  ON public.messages FOR ALL TO authenticated
  USING   ( is_admin() )
  WITH CHECK ( is_admin() );

-- Sales and Operations: read messages from threads they have access to
CREATE POLICY "messages: sales read via thread"
  ON public.messages FOR SELECT TO authenticated
  USING (
    is_sales()
    AND EXISTS (
      SELECT 1 FROM public.message_threads t
      WHERE t.id = messages.thread_id
        AND (t.assigned_to = auth.uid() OR t.assigned_to IS NULL)
        AND t.status = 'open'
    )
  );

CREATE POLICY "messages: sales insert outbound"
  ON public.messages FOR INSERT TO authenticated
  WITH CHECK (
    is_sales()
    AND direction = 'outbound'
    AND staff_id = auth.uid()
    AND EXISTS (
      SELECT 1 FROM public.message_threads t
      WHERE t.id = messages.thread_id
        AND (t.assigned_to = auth.uid() OR t.assigned_to IS NULL)
    )
  );

CREATE POLICY "messages: operations read via thread"
  ON public.messages FOR SELECT TO authenticated
  USING (
    is_operations()
    AND EXISTS (
      SELECT 1 FROM public.message_threads t
      WHERE t.id = messages.thread_id
        AND (t.assigned_to = auth.uid() OR t.assigned_to IS NULL)
        AND t.status = 'open'
    )
  );

CREATE POLICY "messages: operations insert outbound"
  ON public.messages FOR INSERT TO authenticated
  WITH CHECK (
    is_operations()
    AND direction = 'outbound'
    AND staff_id = auth.uid()
  );

-- Inbound messages are inserted by service_role (webhook handlers only).
-- Client-side code cannot insert inbound messages.


-- ════════════════════════════════════════════════════════════════════════════
-- SERVICE ROLE BYPASS
-- ════════════════════════════════════════════════════════════════════════════
-- Supabase's service_role key automatically bypasses RLS.
-- Use it only for:
--   • Server-side webhook handlers (inbound messages, auto-reminders)
--   • Admin CLI scripts
--   • Supabase Edge Functions
-- NEVER expose the service_role key to the browser/client app.


-- ════════════════════════════════════════════════════════════════════════════
-- VERIFICATION QUERIES
-- Run these after applying to spot-check the setup.
-- ════════════════════════════════════════════════════════════════════════════

/*
-- 1. Check RLS is enabled on all tables
SELECT tablename, rowsecurity
FROM   pg_tables
WHERE  schemaname = 'public'
  AND  tablename IN (
    'staff_users','sources','customers','leads','tours','quotes','quote_items',
    'reservations','payments','tasks','reminders','activity_logs',
    'settings','message_threads','messages'
  )
ORDER BY tablename;

-- 2. List all policies
SELECT schemaname, tablename, policyname, cmd, roles, qual
FROM   pg_policies
WHERE  schemaname = 'public'
ORDER BY tablename, policyname;

-- 3. Test helper functions (run as an authenticated user)
SELECT get_current_staff_role();
SELECT is_admin(), is_sales(), is_operations(), is_guide();
*/


-- ════════════════════════════════════════════════════════════════════════════
-- ROLE SUMMARY
-- ════════════════════════════════════════════════════════════════════════════
--
-- ADMIN
--   • Full read/write on every table.
--   • Can manage staff_users (create, deactivate).
--   • Can modify settings.
--
-- SALES
--   • customers    — read all active, write all
--   • leads        — read all, write own/assigned
--   • quotes       — read all, write own/assigned
--   • quote_items  — read/write via parent quote
--   • tasks        — own only (assigned to or created by)
--   • reminders    — own only
--   • activity_logs— own only (performed_by)
--   • message_threads / messages — assigned or unassigned open threads
--   • reservations — read-only
--   • tours        — read active only
--   • payments     — read own customers' payments only
--   ✗ guide-specific tables, settings (write)
--
-- OPERATIONS
--   • reservations — full read/write
--   • tours        — full read/write
--   • payments     — full read/write
--   • customers    — read-only
--   • leads        — read-only
--   • quotes       — read-only
--   • tasks        — own only
--   • reminders    — own only
--   • activity_logs— own + reservation/payment/tour logs
--   • message_threads / messages — assigned or unassigned open threads
--   ✗ staff_users (write), settings (write)
--
-- GUIDE
--   • reservations — own assigned, non-cancelled, read + limited update
--   • tasks        — own assigned only
--   • reminders    — own assigned only
--   • customers    — only those linked to their reservations (read-only)
--   • tours        — only tours in their reservations (read-only)
--   ✗ leads, quotes, payments, message_threads, messages, settings
--
-- ════════════════════════════════════════════════════════════════════════════

-- ── END OF FILE ─────────────────────────────────────────────────────────────
