-- ============================================================
-- DESE TOUR OPERATIONS CENTER
-- Migration: AAL2 (TOTP MFA) Enforcement — RLS + Staff Bootstrap
-- ============================================================
-- File:    supabase_migration_aal2_enforcement.sql
-- Depends: supabase_schema.sql, supabase_rls_policies.sql,
--          supabase_migration_guides.sql, supabase_migration_agencies.sql,
--          supabase_migration_civitatis_ingestion.sql,
--          supabase_migration_reviews.sql, supabase_migration_tour_channels.sql,
--          supabase_migration_tour_information_center.sql,
--          supabase_migration_tour_preparation_phase_a.sql,
--          supabase_migration_whatsapp_core.sql,
--          supabase_migration_civitatis_settlement_phase1.sql
--          (all already applied)
-- Version: TOTP MFA Security Hardening — October 2026
-- Includes: follow-up hardening (inactive-staff RLS fail-closed +
--           staff_users self-update column guard) found during this
--           phase's own security audit, before any part of this
--           migration was ever applied — see STEP 1b and STEP 2b below.
--
-- WHY THIS EXISTS
-- ─────────────────────────────────────────────────────────────
-- The frontend TOTP MFA work (DeseTourDashboard.jsx's AuthGuard) makes
-- AAL2 mandatory for CRM access in the UI: an authenticated, active,
-- role-linked staff member who has not completed TOTP verification is
-- shown the mandatory enrollment/verification screens, never the
-- operational app. But RLS — this project's own stated "real database
-- security boundary" — never checked assurance level at all. A stolen
-- password alone (producing a normal AAL1 session) was already
-- sufficient to read/write every table a role's existing RLS policies
-- already permitted, via a direct Supabase REST call, completely
-- bypassing the frontend's MFA gate. This migration closes that gap at
-- the one place that can't be bypassed by skipping the UI.
--
-- WHAT THIS DOES
-- ─────────────────────────────────────────────────────────────
--   1. Adds public.is_aal2() — a small, non-privileged helper reading the
--      current request's JWT `aal` claim via the standard, documented
--      auth.jwt() function. See its own comment below for why it is
--      deliberately NOT SECURITY DEFINER.
--   2. Splits staff_users' "all staff can read" policy into:
--        - a NEW, unconditional "own profile" SELECT (auth.uid() = id,
--          no role check, no AAL2 check) — the minimum needed for the
--          frontend's AAL1 bootstrap (resolve role/is_active, then drive
--          the user to MFA enrollment/verification) to work at all;
--        - the EXISTING broader "staff directory" SELECT, now ALSO
--          requiring is_aal2() — reading OTHER staff rows (assignment
--          pickers, dropdowns) is normal operational access, not bootstrap.
--      staff_users' own-profile UPDATE is left untouched (AAL1) — it is
--      not part of the MFA bootstrap flow either way and was not asked
--      for; admin update-any/insert/delete now require AAL2 (ADMINISTRATION,
--      explicitly called for).
--   3. Every OTHER table's EXISTING role-gated policy gets `AND is_aal2()`
--      appended to its USING (and WITH CHECK, where present) clause —
--      the exact "existing role condition AND is_aal2()" shape asked for.
--      No role-scoping condition is removed, reworded, or widened — only
--      is_aal2() is added. is_admin()/is_sales()/is_operations()/
--      is_guide()/is_staff()/get_current_staff_role() themselves are
--      UNTOUCHED, exactly as instructed — the addition happens at each
--      policy site, never inside the shared role helpers.
--   4. service_role is never touched: it was never granted via any policy
--      here (it bypasses RLS entirely, by Postgres/Supabase design), so
--      every service-role-only table (ref_number_counters: RLS enabled,
--      zero policies for `authenticated` at all — a pre-existing,
--      deliberate design this migration does not change) and every
--      service-role write path (Civitatis ingestion, WhatsApp/email
--      ingestion tables' INSERT, exchange_rates' cron writer) continues
--      to work completely unaffected.
--   5. (STEP 1b) Hardens get_current_staff_role() itself to add
--      `AND is_active = TRUE` — a deactivated staff member's role helpers
--      (is_admin()/is_sales()/is_operations()/is_guide()/is_staff()) now
--      all correctly evaluate to false/NULL, closing an RLS gap found
--      during this phase's own audit: inactive staff previously still
--      passed every role check directly through the database layer, even
--      though the frontend and server-side APIs already blocked them.
--      Role names and ACTIVE-staff permissions are completely unchanged.
--   6. (STEP 2b) Adds a BEFORE UPDATE trigger on staff_users blocking a
--      normal (non-admin, non-service_role) staff member's own-row UPDATE
--      from changing role, is_active, id, or email — closing a CRITICAL
--      self-escalation/self-reactivation gap also found during this
--      phase's audit (proven live in the disposable sandbox: a plain
--      sales/operations/guide account, at EITHER AAL1 or AAL2, could
--      PATCH their own row directly via Supabase REST and set
--      role='admin' or is_active=TRUE). Legitimate admin staff
--      administration (via "admin update any") and service_role are
--      both completely unaffected.
--
-- TABLE CLASSIFICATION (see implementation report for the full per-table
-- rationale) — every table with at least one RLS policy in this schema:
--   AAL1 bootstrap allowed:        staff_users (own-row SELECT + own-row
--                                   UPDATE, now column-guarded — see STEP 2b)
--   AAL2 required (this migration): every other policy on every other
--                                   table listed below
--   Service role only (untouched): ref_number_counters (RLS enabled, no
--                                   authenticated policy at all)
--
-- VALIDATED in a disposable local PostgreSQL sandbox (never against
-- production) — see the implementation report for the exact scenarios
-- and results. NOT executed against Supabase by this phase; apply by
-- hand after review.
-- ============================================================


-- ──────────────────────────────────────────────────────────────────────────
-- STEP 1: is_aal2() helper
-- ──────────────────────────────────────────────────────────────────────────
-- Reads the CURRENT request's JWT `aal` claim via auth.jwt() — the same
-- documented Supabase-provided function auth.uid() is built on, already
-- relied on implicitly throughout supabase_rls_policies.sql. Returns TRUE
-- only when the claim is exactly 'aal2' — a missing claim, a null claim,
-- 'aal1', or any other value all correctly evaluate to FALSE (fail
-- closed), never erroring and never defaulting to TRUE.
--
-- Deliberately NOT SECURITY DEFINER: unlike get_current_staff_role() (which
-- MUST elevate privilege to read staff_users, a table RLS itself protects),
-- this function touches no table at all — auth.jwt() reads a per-request
-- Postgres session GUC (request.jwt.claims), not a row — so there is
-- nothing here for the calling role's own RLS restrictions to block, and
-- therefore nothing for SECURITY DEFINER to usefully bypass. Running as
-- the caller's own privilege is the SMALLER, safer surface; search_path
-- pinning (SET search_path = public) is likewise a SECURITY DEFINER
-- concern this function does not have, so it is correctly left unpinned.
CREATE OR REPLACE FUNCTION public.is_aal2()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
AS $$
  SELECT COALESCE(auth.jwt() ->> 'aal', '') = 'aal2';
$$;

COMMENT ON FUNCTION public.is_aal2 IS
  'TRUE only when the current request''s JWT aal claim is exactly ''aal2''. Reads auth.jwt() directly (the documented Supabase JWT-claims accessor) — never a table, never an application-supplied value. Not SECURITY DEFINER: touches no table, so there is nothing for it to need elevated privilege to bypass. Fails closed on any missing/null/other value.';


-- ──────────────────────────────────────────────────────────────────────────
-- STEP 1b: get_current_staff_role() ignores inactive staff (RLS fail-closed
-- for deactivated accounts)
-- ──────────────────────────────────────────────────────────────────────────
-- FOUND DURING A SECURITY AUDIT of the AAL2 work above: get_current_staff_role()
-- (and therefore is_admin()/is_sales()/is_operations()/is_guide()/is_staff(),
-- every one of which is DERIVED from it) never checked staff_users.is_active.
-- An inactive staff member who still holds a valid, completed-MFA (AAL2)
-- session therefore still passed every role check at the RLS layer — the
-- frontend AuthGuard and the server-side requireStaffRole()/requireAgencyRole()
-- both already independently block inactive staff, but direct Supabase REST
-- calls bypass both of those and go straight to RLS, which did not.
--
-- Smallest safe fix: add `AND is_active = TRUE` to the one query this
-- function already makes. No role name changes, no permission changes for
-- any ACTIVE staff member, no change to auth.users identity linkage, no
-- effect on service_role (which bypasses RLS and never calls this function).
-- is_admin()/is_sales()/is_operations()/is_guide()/is_staff() themselves are
-- NOT redefined — they stay exactly as they are, and inherit this fix purely
-- because they all call get_current_staff_role() for their answer.
--
-- Validated in the disposable sandbox: an inactive admin's is_admin() now
-- evaluates to NULL/false (previously true), while every currently-active
-- admin/sales/operations/guide keeps their exact prior access, unchanged.
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
    AND  is_active = TRUE
  LIMIT  1;
$$;

COMMENT ON FUNCTION public.get_current_staff_role IS
  'Returns the role of the currently logged-in staff member (admin/sales/operations/guide), but ONLY when that staff_users row has is_active = TRUE. An inactive row returns NULL, which correctly makes is_admin()/is_sales()/is_operations()/is_guide()/is_staff() all evaluate to false/NULL for a deactivated account, closing the previous RLS gap where a deactivated staff member retained full role-based access at the database layer. Used inside RLS policies — SECURITY DEFINER to bypass RLS on staff_users.';


-- ──────────────────────────────────────────────────────────────────────────
-- STEP 2: staff_users — bootstrap exception + AAL2 on broader/admin access
-- ──────────────────────────────────────────────────────────────────────────

-- NEW: own-row SELECT, no role or AAL2 requirement at all — this is the
-- AAL1 bootstrap path AuthGuard's useAuth() depends on (resolve role,
-- is_active, staffLinked; decide whether MFA enrollment/verification is
-- needed) and must keep working for a session that, by definition, has
-- not completed MFA yet.
DROP POLICY IF EXISTS "staff_users: own profile select at aal1" ON public.staff_users;
CREATE POLICY "staff_users: own profile select at aal1"
  ON public.staff_users FOR SELECT TO authenticated
  USING ( auth.uid() = id );

-- MODIFIED: the broader "read every staff row" directory policy (dropdowns,
-- assignment pickers) now also requires AAL2. Own-row access is already
-- covered by the policy above regardless (RLS policies for the same
-- command are OR'd), so this never removes anything the new policy above
-- doesn't already grant at AAL1.
DROP POLICY IF EXISTS "staff_users: all staff can read" ON public.staff_users;
CREATE POLICY "staff_users: all staff can read"
  ON public.staff_users FOR SELECT TO authenticated
  USING ( is_staff() AND is_aal2() );

-- UNCHANGED (left AAL1): "staff_users: own profile update" — not part of
-- the MFA bootstrap flow, not called out as needing AAL2, and restricted
-- to the caller's own row either way. No DROP/CREATE needed; not touched.

-- MODIFIED: admin update-any / insert / delete — "privileged administration",
-- explicitly called for.
DROP POLICY IF EXISTS "staff_users: admin update any" ON public.staff_users;
CREATE POLICY "staff_users: admin update any"
  ON public.staff_users FOR UPDATE TO authenticated
  USING ( is_admin() AND is_aal2() )
  WITH CHECK ( is_admin() AND is_aal2() );

DROP POLICY IF EXISTS "staff_users: admin insert" ON public.staff_users;
CREATE POLICY "staff_users: admin insert"
  ON public.staff_users FOR INSERT TO authenticated
  WITH CHECK ( is_admin() AND is_aal2() );

DROP POLICY IF EXISTS "staff_users: admin delete" ON public.staff_users;
CREATE POLICY "staff_users: admin delete"
  ON public.staff_users FOR DELETE TO authenticated
  USING ( is_admin() AND is_aal2() );


-- ──────────────────────────────────────────────────────────────────────────
-- STEP 2b: staff_users self-update column guard (CRITICAL fix)
-- ──────────────────────────────────────────────────────────────────────────
-- FOUND DURING A SECURITY AUDIT: "staff_users: own profile update"
-- (USING/WITH CHECK: auth.uid() = id) is purely ROW-scoped — RLS policies
-- have no concept of column-level restriction on their own. Proven live in
-- the disposable sandbox: a normal sales/operations/guide staff member, at
-- EITHER AAL1 or AAL2, could PATCH their own staff_users row via direct
-- Supabase REST and freely set role='admin' (self-promotion) or
-- is_active=TRUE (self-reactivation after being deactivated) or change
-- their own email — because the only other UPDATE policy on this table,
-- "staff_users: admin update any" (USING/WITH CHECK: is_admin()), is a
-- SEPARATE, OR'd PERMISSIVE policy: Postgres combines multiple permissive
-- policies' USING/WITH CHECK with OR, so a non-admin's own-row UPDATE was
-- validated ENTIRELY by "own profile update" alone, which never looked at
-- which columns changed. Changing `id` was already blocked (the new row's
-- id must still equal auth.uid() for "own profile update"'s own WITH CHECK
-- to pass), but role/is_active/email were wide open. This is exactly why a
-- smarter RLS policy expression cannot fix this alone (there's no OLD/NEW
-- comparison available inside a plain policy without also querying the
-- table itself, which is both fragile and still only ORs against the
-- existing admin policy) — a BEFORE UPDATE trigger is the smallest correct
-- mechanism, consistent with this project's existing
-- enforce_guide_reservation_update_columns() pattern
-- (supabase_migration_guide_reservation_update_hardening.sql).
--
-- Column-level GRANT/REVOKE was considered and rejected: Postgres column
-- privileges apply to the `authenticated` Postgres ROLE as a whole, not per
-- RLS policy, so revoking UPDATE on role/is_active/email for `authenticated`
-- would also block admins from changing OTHER staff members' role/is_active
-- via "admin update any" — there is no separate Postgres role for "staff
-- who happen to be admins". Only a trigger (which can call is_admin() at
-- runtime) can tell the two cases apart.
--
-- Behavior:
--   - service_role: never restricted (bypasses RLS already; this trigger
--     explicitly exempts it too, so Civitatis ingestion, cron, and any
--     future service-role staff-management script are unaffected).
--   - is_admin() (AAL2, active, per the hardened get_current_staff_role()
--     above): never restricted — legitimate staff administration (via
--     "admin update any") must keep working exactly as before, including
--     administering another staff member's role/is_active, and an admin's
--     own row.
--   - Everyone else updating their OWN row (the only other case that can
--     reach this trigger at all, since no other UPDATE policy exists):
--     role, is_active, id, and email must be unchanged. full_name, phone,
--     and avatar_url remain freely self-editable (the only columns besides
--     these four and the server-set created_at/updated_at) — the app does
--     not currently call staff_users.update() for ANY field, so this is a
--     deny-list of exactly the dangerous columns, not a new feature.
CREATE OR REPLACE FUNCTION public.enforce_staff_self_update_columns()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF current_setting('role', true) = 'service_role' THEN
    RETURN NEW;
  END IF;

  IF public.is_admin() THEN
    RETURN NEW;
  END IF;

  IF auth.uid() = OLD.id THEN
    IF NEW.role IS DISTINCT FROM OLD.role THEN
      RAISE EXCEPTION 'staff_users: self-update may not change role';
    END IF;
    IF NEW.is_active IS DISTINCT FROM OLD.is_active THEN
      RAISE EXCEPTION 'staff_users: self-update may not change is_active';
    END IF;
    IF NEW.id IS DISTINCT FROM OLD.id THEN
      RAISE EXCEPTION 'staff_users: self-update may not change id';
    END IF;
    IF NEW.email IS DISTINCT FROM OLD.email THEN
      RAISE EXCEPTION 'staff_users: self-update may not change email';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.enforce_staff_self_update_columns IS
  'BEFORE UPDATE guard on staff_users: a non-admin, non-service_role caller updating their own row may not change role, is_active, id, or email. Prevents self role-escalation and self-reactivation via direct Supabase REST, which RLS policies alone cannot express once an OR''d admin policy also exists on the same command. Never restricts service_role or an active admin (via "admin update any").';

DROP TRIGGER IF EXISTS trg_staff_users_self_update_guard ON public.staff_users;
CREATE TRIGGER trg_staff_users_self_update_guard
  BEFORE UPDATE ON public.staff_users
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_staff_self_update_columns();


-- ──────────────────────────────────────────────────────────────────────────
-- STEP 3: every other table — AND is_aal2() on every existing policy
-- ──────────────────────────────────────────────────────────────────────────
-- Uniform shape throughout: the exact pre-existing USING/WITH CHECK
-- expression, with `AND is_aal2()` appended — no row-scope condition is
-- removed, reworded, or widened.

-- sources
DROP POLICY IF EXISTS "sources: all staff read" ON public.sources;
CREATE POLICY "sources: all staff read" ON public.sources FOR SELECT TO authenticated USING ( is_staff() AND is_aal2() );
DROP POLICY IF EXISTS "sources: admin write" ON public.sources;
CREATE POLICY "sources: admin write" ON public.sources FOR ALL TO authenticated USING ( is_admin() AND is_aal2() ) WITH CHECK ( is_admin() AND is_aal2() );

-- customers
DROP POLICY IF EXISTS "customers: admin full access" ON public.customers;
CREATE POLICY "customers: admin full access" ON public.customers FOR ALL TO authenticated USING ( is_admin() AND is_aal2() ) WITH CHECK ( is_admin() AND is_aal2() );
DROP POLICY IF EXISTS "customers: sales read all" ON public.customers;
CREATE POLICY "customers: sales read all" ON public.customers FOR SELECT TO authenticated USING ( is_sales() AND is_active = TRUE AND is_aal2() );
DROP POLICY IF EXISTS "customers: sales write" ON public.customers;
CREATE POLICY "customers: sales write" ON public.customers FOR INSERT TO authenticated WITH CHECK ( is_sales() AND is_aal2() );
DROP POLICY IF EXISTS "customers: sales update" ON public.customers;
CREATE POLICY "customers: sales update" ON public.customers FOR UPDATE TO authenticated USING ( is_sales() AND is_aal2() ) WITH CHECK ( is_sales() AND is_aal2() );
DROP POLICY IF EXISTS "customers: operations read" ON public.customers;
CREATE POLICY "customers: operations read" ON public.customers FOR SELECT TO authenticated USING ( is_operations() AND is_active = TRUE AND is_aal2() );
DROP POLICY IF EXISTS "customers: guide reads assigned customers" ON public.customers;
CREATE POLICY "customers: guide reads assigned customers" ON public.customers FOR SELECT TO authenticated
  USING ( is_guide() AND is_aal2() AND EXISTS (SELECT 1 FROM public.reservations r WHERE r.customer_id = customers.id AND r.assigned_to = auth.uid() AND r.status NOT IN ('cancelled')) );

-- leads
DROP POLICY IF EXISTS "leads: admin full access" ON public.leads;
CREATE POLICY "leads: admin full access" ON public.leads FOR ALL TO authenticated USING ( is_admin() AND is_aal2() ) WITH CHECK ( is_admin() AND is_aal2() );
DROP POLICY IF EXISTS "leads: sales read all" ON public.leads;
CREATE POLICY "leads: sales read all" ON public.leads FOR SELECT TO authenticated USING ( is_sales() AND is_aal2() );
DROP POLICY IF EXISTS "leads: sales write" ON public.leads;
CREATE POLICY "leads: sales write" ON public.leads FOR INSERT TO authenticated WITH CHECK ( is_sales() AND is_aal2() );
DROP POLICY IF EXISTS "leads: sales update own or assigned" ON public.leads;
CREATE POLICY "leads: sales update own or assigned" ON public.leads FOR UPDATE TO authenticated
  USING ( is_sales() AND (assigned_to = auth.uid() OR created_by = auth.uid()) AND is_aal2() )
  WITH CHECK ( is_sales() AND is_aal2() );
DROP POLICY IF EXISTS "leads: operations read" ON public.leads;
CREATE POLICY "leads: operations read" ON public.leads FOR SELECT TO authenticated USING ( is_operations() AND is_aal2() );

-- tours
DROP POLICY IF EXISTS "tours: admin full access" ON public.tours;
CREATE POLICY "tours: admin full access" ON public.tours FOR ALL TO authenticated USING ( is_admin() AND is_aal2() ) WITH CHECK ( is_admin() AND is_aal2() );
DROP POLICY IF EXISTS "tours: sales read active" ON public.tours;
CREATE POLICY "tours: sales read active" ON public.tours FOR SELECT TO authenticated USING ( is_sales() AND is_active = TRUE AND is_aal2() );
DROP POLICY IF EXISTS "tours: operations read all" ON public.tours;
CREATE POLICY "tours: operations read all" ON public.tours FOR SELECT TO authenticated USING ( is_operations() AND is_aal2() );
DROP POLICY IF EXISTS "tours: operations write" ON public.tours;
CREATE POLICY "tours: operations write" ON public.tours FOR INSERT TO authenticated WITH CHECK ( is_operations() AND is_aal2() );
DROP POLICY IF EXISTS "tours: operations update" ON public.tours;
CREATE POLICY "tours: operations update" ON public.tours FOR UPDATE TO authenticated USING ( is_operations() AND is_aal2() ) WITH CHECK ( is_operations() AND is_aal2() );
DROP POLICY IF EXISTS "tours: guide reads assigned tour" ON public.tours;
CREATE POLICY "tours: guide reads assigned tour" ON public.tours FOR SELECT TO authenticated
  USING ( is_guide() AND is_aal2() AND EXISTS (SELECT 1 FROM public.reservations r WHERE r.tour_id = tours.id AND r.assigned_to = auth.uid()) );

-- quotes
DROP POLICY IF EXISTS "quotes: admin full access" ON public.quotes;
CREATE POLICY "quotes: admin full access" ON public.quotes FOR ALL TO authenticated USING ( is_admin() AND is_aal2() ) WITH CHECK ( is_admin() AND is_aal2() );
DROP POLICY IF EXISTS "quotes: sales read all" ON public.quotes;
CREATE POLICY "quotes: sales read all" ON public.quotes FOR SELECT TO authenticated USING ( is_sales() AND is_aal2() );
DROP POLICY IF EXISTS "quotes: sales insert" ON public.quotes;
CREATE POLICY "quotes: sales insert" ON public.quotes FOR INSERT TO authenticated WITH CHECK ( is_sales() AND created_by = auth.uid() AND is_aal2() );
DROP POLICY IF EXISTS "quotes: sales update own" ON public.quotes;
CREATE POLICY "quotes: sales update own" ON public.quotes FOR UPDATE TO authenticated
  USING ( is_sales() AND (created_by = auth.uid() OR assigned_to = auth.uid()) AND is_aal2() )
  WITH CHECK ( is_sales() AND (created_by = auth.uid() OR assigned_to = auth.uid()) AND is_aal2() );
DROP POLICY IF EXISTS "quotes: operations read" ON public.quotes;
CREATE POLICY "quotes: operations read" ON public.quotes FOR SELECT TO authenticated USING ( is_operations() AND is_aal2() );

-- quote_items
DROP POLICY IF EXISTS "quote_items: admin full access" ON public.quote_items;
CREATE POLICY "quote_items: admin full access" ON public.quote_items FOR ALL TO authenticated USING ( is_admin() AND is_aal2() ) WITH CHECK ( is_admin() AND is_aal2() );
DROP POLICY IF EXISTS "quote_items: sales via quote" ON public.quote_items;
CREATE POLICY "quote_items: sales via quote" ON public.quote_items FOR SELECT TO authenticated
  USING ( is_sales() AND is_aal2() AND EXISTS (SELECT 1 FROM public.quotes q WHERE q.id = quote_items.quote_id) );
DROP POLICY IF EXISTS "quote_items: sales write via quote" ON public.quote_items;
CREATE POLICY "quote_items: sales write via quote" ON public.quote_items FOR INSERT TO authenticated
  WITH CHECK ( is_sales() AND is_aal2() AND EXISTS (SELECT 1 FROM public.quotes q WHERE q.id = quote_items.quote_id AND (q.created_by = auth.uid() OR q.assigned_to = auth.uid())) );
DROP POLICY IF EXISTS "quote_items: sales update via quote" ON public.quote_items;
CREATE POLICY "quote_items: sales update via quote" ON public.quote_items FOR UPDATE TO authenticated
  USING ( is_sales() AND is_aal2() AND EXISTS (SELECT 1 FROM public.quotes q WHERE q.id = quote_items.quote_id AND (q.created_by = auth.uid() OR q.assigned_to = auth.uid())) );
DROP POLICY IF EXISTS "quote_items: operations read" ON public.quote_items;
CREATE POLICY "quote_items: operations read" ON public.quote_items FOR SELECT TO authenticated USING ( is_operations() AND is_aal2() );

-- reservations
DROP POLICY IF EXISTS "reservations: admin full access" ON public.reservations;
CREATE POLICY "reservations: admin full access" ON public.reservations FOR ALL TO authenticated USING ( is_admin() AND is_aal2() ) WITH CHECK ( is_admin() AND is_aal2() );
DROP POLICY IF EXISTS "reservations: sales read" ON public.reservations;
CREATE POLICY "reservations: sales read" ON public.reservations FOR SELECT TO authenticated USING ( is_sales() AND is_aal2() );
DROP POLICY IF EXISTS "reservations: operations read all" ON public.reservations;
CREATE POLICY "reservations: operations read all" ON public.reservations FOR SELECT TO authenticated USING ( is_operations() AND is_aal2() );
DROP POLICY IF EXISTS "reservations: operations insert" ON public.reservations;
CREATE POLICY "reservations: operations insert" ON public.reservations FOR INSERT TO authenticated WITH CHECK ( is_operations() AND is_aal2() );
DROP POLICY IF EXISTS "reservations: operations update" ON public.reservations;
CREATE POLICY "reservations: operations update" ON public.reservations FOR UPDATE TO authenticated USING ( is_operations() AND is_aal2() ) WITH CHECK ( is_operations() AND is_aal2() );
DROP POLICY IF EXISTS "reservations: guide reads assigned" ON public.reservations;
CREATE POLICY "reservations: guide reads assigned" ON public.reservations FOR SELECT TO authenticated
  USING ( is_guide() AND assigned_to = auth.uid() AND status NOT IN ('cancelled') AND is_aal2() );
DROP POLICY IF EXISTS "reservations: guide update own status" ON public.reservations;
CREATE POLICY "reservations: guide update own status" ON public.reservations FOR UPDATE TO authenticated
  USING ( is_guide() AND assigned_to = auth.uid() AND is_aal2() )
  WITH CHECK ( is_guide() AND assigned_to = auth.uid() AND is_aal2() );

-- payments
DROP POLICY IF EXISTS "payments: admin full access" ON public.payments;
CREATE POLICY "payments: admin full access" ON public.payments FOR ALL TO authenticated USING ( is_admin() AND is_aal2() ) WITH CHECK ( is_admin() AND is_aal2() );
DROP POLICY IF EXISTS "payments: sales read own" ON public.payments;
CREATE POLICY "payments: sales read own" ON public.payments FOR SELECT TO authenticated
  USING ( is_sales() AND is_aal2() AND EXISTS (SELECT 1 FROM public.leads l WHERE l.customer_id = payments.customer_id AND (l.assigned_to = auth.uid() OR l.created_by = auth.uid())) );
DROP POLICY IF EXISTS "payments: operations full access" ON public.payments;
CREATE POLICY "payments: operations full access" ON public.payments FOR ALL TO authenticated USING ( is_operations() AND is_aal2() ) WITH CHECK ( is_operations() AND is_aal2() );

-- tasks
DROP POLICY IF EXISTS "tasks: admin full access" ON public.tasks;
CREATE POLICY "tasks: admin full access" ON public.tasks FOR ALL TO authenticated USING ( is_admin() AND is_aal2() ) WITH CHECK ( is_admin() AND is_aal2() );
DROP POLICY IF EXISTS "tasks: sales own tasks" ON public.tasks;
CREATE POLICY "tasks: sales own tasks" ON public.tasks FOR SELECT TO authenticated USING ( is_sales() AND (assigned_to = auth.uid() OR created_by = auth.uid()) AND is_aal2() );
DROP POLICY IF EXISTS "tasks: sales insert" ON public.tasks;
CREATE POLICY "tasks: sales insert" ON public.tasks FOR INSERT TO authenticated WITH CHECK ( is_sales() AND created_by = auth.uid() AND is_aal2() );
DROP POLICY IF EXISTS "tasks: sales update own" ON public.tasks;
CREATE POLICY "tasks: sales update own" ON public.tasks FOR UPDATE TO authenticated
  USING ( is_sales() AND (assigned_to = auth.uid() OR created_by = auth.uid()) AND is_aal2() )
  WITH CHECK ( is_sales() AND (assigned_to = auth.uid() OR created_by = auth.uid()) AND is_aal2() );
DROP POLICY IF EXISTS "tasks: operations own tasks" ON public.tasks;
CREATE POLICY "tasks: operations own tasks" ON public.tasks FOR SELECT TO authenticated USING ( is_operations() AND (assigned_to = auth.uid() OR created_by = auth.uid()) AND is_aal2() );
DROP POLICY IF EXISTS "tasks: operations insert" ON public.tasks;
CREATE POLICY "tasks: operations insert" ON public.tasks FOR INSERT TO authenticated WITH CHECK ( is_operations() AND created_by = auth.uid() AND is_aal2() );
DROP POLICY IF EXISTS "tasks: operations update own" ON public.tasks;
CREATE POLICY "tasks: operations update own" ON public.tasks FOR UPDATE TO authenticated USING ( is_operations() AND (assigned_to = auth.uid() OR created_by = auth.uid()) AND is_aal2() );
DROP POLICY IF EXISTS "tasks: guide assigned tasks" ON public.tasks;
CREATE POLICY "tasks: guide assigned tasks" ON public.tasks FOR SELECT TO authenticated USING ( is_guide() AND assigned_to = auth.uid() AND is_aal2() );
DROP POLICY IF EXISTS "tasks: guide update assigned" ON public.tasks;
CREATE POLICY "tasks: guide update assigned" ON public.tasks FOR UPDATE TO authenticated
  USING ( is_guide() AND assigned_to = auth.uid() AND is_aal2() )
  WITH CHECK ( is_guide() AND assigned_to = auth.uid() AND is_aal2() );

-- reminders
DROP POLICY IF EXISTS "reminders: admin full access" ON public.reminders;
CREATE POLICY "reminders: admin full access" ON public.reminders FOR ALL TO authenticated USING ( is_admin() AND is_aal2() ) WITH CHECK ( is_admin() AND is_aal2() );
DROP POLICY IF EXISTS "reminders: sales own" ON public.reminders;
CREATE POLICY "reminders: sales own" ON public.reminders FOR SELECT TO authenticated USING ( is_sales() AND (assigned_to = auth.uid() OR created_by = auth.uid()) AND is_aal2() );
DROP POLICY IF EXISTS "reminders: sales insert" ON public.reminders;
CREATE POLICY "reminders: sales insert" ON public.reminders FOR INSERT TO authenticated WITH CHECK ( is_sales() AND created_by = auth.uid() AND is_aal2() );
DROP POLICY IF EXISTS "reminders: sales update own" ON public.reminders;
CREATE POLICY "reminders: sales update own" ON public.reminders FOR UPDATE TO authenticated USING ( is_sales() AND (assigned_to = auth.uid() OR created_by = auth.uid()) AND is_aal2() );
DROP POLICY IF EXISTS "reminders: operations own" ON public.reminders;
CREATE POLICY "reminders: operations own" ON public.reminders FOR SELECT TO authenticated USING ( is_operations() AND (assigned_to = auth.uid() OR created_by = auth.uid()) AND is_aal2() );
DROP POLICY IF EXISTS "reminders: operations insert" ON public.reminders;
CREATE POLICY "reminders: operations insert" ON public.reminders FOR INSERT TO authenticated WITH CHECK ( is_operations() AND created_by = auth.uid() AND is_aal2() );
DROP POLICY IF EXISTS "reminders: operations update own" ON public.reminders;
CREATE POLICY "reminders: operations update own" ON public.reminders FOR UPDATE TO authenticated USING ( is_operations() AND (assigned_to = auth.uid() OR created_by = auth.uid()) AND is_aal2() );
DROP POLICY IF EXISTS "reminders: guide assigned" ON public.reminders;
CREATE POLICY "reminders: guide assigned" ON public.reminders FOR SELECT TO authenticated USING ( is_guide() AND assigned_to = auth.uid() AND is_aal2() );
DROP POLICY IF EXISTS "reminders: guide update assigned" ON public.reminders;
CREATE POLICY "reminders: guide update assigned" ON public.reminders FOR UPDATE TO authenticated USING ( is_guide() AND assigned_to = auth.uid() AND is_aal2() );

-- activity_logs
DROP POLICY IF EXISTS "activity_logs: admin read all" ON public.activity_logs;
CREATE POLICY "activity_logs: admin read all" ON public.activity_logs FOR SELECT TO authenticated USING ( is_admin() AND is_aal2() );
DROP POLICY IF EXISTS "activity_logs: sales read own" ON public.activity_logs;
CREATE POLICY "activity_logs: sales read own" ON public.activity_logs FOR SELECT TO authenticated USING ( is_sales() AND performed_by = auth.uid() AND is_aal2() );
DROP POLICY IF EXISTS "activity_logs: sales read system-generated reservation notifications" ON public.activity_logs;
CREATE POLICY "activity_logs: sales read system-generated reservation notifications" ON public.activity_logs FOR SELECT TO authenticated
  USING ( is_sales() AND entity_type = 'reservation' AND performed_by IS NULL AND metadata->>'auto_ingested' = 'true' AND is_aal2() );
DROP POLICY IF EXISTS "activity_logs: operations read own" ON public.activity_logs;
CREATE POLICY "activity_logs: operations read own" ON public.activity_logs FOR SELECT TO authenticated
  USING ( is_operations() AND (performed_by = auth.uid() OR entity_type IN ('reservation', 'payment', 'tour')) AND is_aal2() );
DROP POLICY IF EXISTS "activity_logs: guide read own" ON public.activity_logs;
CREATE POLICY "activity_logs: guide read own" ON public.activity_logs FOR SELECT TO authenticated USING ( is_guide() AND performed_by = auth.uid() AND is_aal2() );
DROP POLICY IF EXISTS "activity_logs: all staff insert" ON public.activity_logs;
CREATE POLICY "activity_logs: all staff insert" ON public.activity_logs FOR INSERT TO authenticated WITH CHECK ( is_staff() AND performed_by = auth.uid() AND is_aal2() );

-- settings
DROP POLICY IF EXISTS "settings: all staff read public" ON public.settings;
CREATE POLICY "settings: all staff read public" ON public.settings FOR SELECT TO authenticated USING ( is_staff() AND is_public = TRUE AND is_aal2() );
DROP POLICY IF EXISTS "settings: admin read all" ON public.settings;
CREATE POLICY "settings: admin read all" ON public.settings FOR SELECT TO authenticated USING ( is_admin() AND is_aal2() );
DROP POLICY IF EXISTS "settings: admin write" ON public.settings;
CREATE POLICY "settings: admin write" ON public.settings FOR ALL TO authenticated USING ( is_admin() AND is_aal2() ) WITH CHECK ( is_admin() AND is_aal2() );

-- message_threads
DROP POLICY IF EXISTS "message_threads: admin full access" ON public.message_threads;
CREATE POLICY "message_threads: admin full access" ON public.message_threads FOR ALL TO authenticated USING ( is_admin() AND is_aal2() ) WITH CHECK ( is_admin() AND is_aal2() );
DROP POLICY IF EXISTS "message_threads: sales read assigned or open" ON public.message_threads;
CREATE POLICY "message_threads: sales read assigned or open" ON public.message_threads FOR SELECT TO authenticated
  USING ( is_sales() AND (assigned_to = auth.uid() OR assigned_to IS NULL) AND status = 'open' AND is_aal2() );
DROP POLICY IF EXISTS "message_threads: sales update assigned" ON public.message_threads;
CREATE POLICY "message_threads: sales update assigned" ON public.message_threads FOR UPDATE TO authenticated
  USING ( is_sales() AND (assigned_to = auth.uid() OR assigned_to IS NULL) AND is_aal2() )
  WITH CHECK ( is_sales() AND (assigned_to = auth.uid() OR assigned_to IS NULL) AND is_aal2() );
DROP POLICY IF EXISTS "message_threads: operations read assigned or open" ON public.message_threads;
CREATE POLICY "message_threads: operations read assigned or open" ON public.message_threads FOR SELECT TO authenticated
  USING ( is_operations() AND (assigned_to = auth.uid() OR assigned_to IS NULL) AND status = 'open' AND is_aal2() );
DROP POLICY IF EXISTS "message_threads: operations update assigned" ON public.message_threads;
CREATE POLICY "message_threads: operations update assigned" ON public.message_threads FOR UPDATE TO authenticated
  USING ( is_operations() AND (assigned_to = auth.uid() OR assigned_to IS NULL) AND is_aal2() );

-- messages
DROP POLICY IF EXISTS "messages: admin full access" ON public.messages;
CREATE POLICY "messages: admin full access" ON public.messages FOR ALL TO authenticated USING ( is_admin() AND is_aal2() ) WITH CHECK ( is_admin() AND is_aal2() );
DROP POLICY IF EXISTS "messages: sales read via thread" ON public.messages;
CREATE POLICY "messages: sales read via thread" ON public.messages FOR SELECT TO authenticated
  USING ( is_sales() AND is_aal2() AND EXISTS (SELECT 1 FROM public.message_threads t WHERE t.id = messages.thread_id AND (t.assigned_to = auth.uid() OR t.assigned_to IS NULL) AND t.status = 'open') );
DROP POLICY IF EXISTS "messages: sales insert outbound" ON public.messages;
CREATE POLICY "messages: sales insert outbound" ON public.messages FOR INSERT TO authenticated
  WITH CHECK ( is_sales() AND direction = 'outbound' AND staff_id = auth.uid() AND is_aal2() AND EXISTS (SELECT 1 FROM public.message_threads t WHERE t.id = messages.thread_id AND (t.assigned_to = auth.uid() OR t.assigned_to IS NULL)) );
DROP POLICY IF EXISTS "messages: operations read via thread" ON public.messages;
CREATE POLICY "messages: operations read via thread" ON public.messages FOR SELECT TO authenticated
  USING ( is_operations() AND is_aal2() AND EXISTS (SELECT 1 FROM public.message_threads t WHERE t.id = messages.thread_id AND (t.assigned_to = auth.uid() OR t.assigned_to IS NULL) AND t.status = 'open') );
DROP POLICY IF EXISTS "messages: operations insert outbound" ON public.messages;
CREATE POLICY "messages: operations insert outbound" ON public.messages FOR INSERT TO authenticated
  WITH CHECK ( is_operations() AND direction = 'outbound' AND staff_id = auth.uid() AND is_aal2() );

-- guides
DROP POLICY IF EXISTS "guides: admin full access" ON public.guides;
CREATE POLICY "guides: admin full access" ON public.guides FOR ALL TO authenticated USING ( is_admin() AND is_aal2() ) WITH CHECK ( is_admin() AND is_aal2() );
DROP POLICY IF EXISTS "guides: operations full access" ON public.guides;
CREATE POLICY "guides: operations full access" ON public.guides FOR ALL TO authenticated USING ( is_operations() AND is_aal2() ) WITH CHECK ( is_operations() AND is_aal2() );
DROP POLICY IF EXISTS "guides: sales read" ON public.guides;
CREATE POLICY "guides: sales read" ON public.guides FOR SELECT TO authenticated USING ( is_sales() AND is_aal2() );
DROP POLICY IF EXISTS "guides: guide role read" ON public.guides;
CREATE POLICY "guides: guide role read" ON public.guides FOR SELECT TO authenticated USING ( is_guide() AND is_aal2() );

-- guide_languages
DROP POLICY IF EXISTS "guide_languages: admin full access" ON public.guide_languages;
CREATE POLICY "guide_languages: admin full access" ON public.guide_languages FOR ALL TO authenticated USING ( is_admin() AND is_aal2() ) WITH CHECK ( is_admin() AND is_aal2() );
DROP POLICY IF EXISTS "guide_languages: operations full access" ON public.guide_languages;
CREATE POLICY "guide_languages: operations full access" ON public.guide_languages FOR ALL TO authenticated USING ( is_operations() AND is_aal2() ) WITH CHECK ( is_operations() AND is_aal2() );
DROP POLICY IF EXISTS "guide_languages: sales read" ON public.guide_languages;
CREATE POLICY "guide_languages: sales read" ON public.guide_languages FOR SELECT TO authenticated USING ( is_sales() AND is_aal2() );
DROP POLICY IF EXISTS "guide_languages: guide role read" ON public.guide_languages;
CREATE POLICY "guide_languages: guide role read" ON public.guide_languages FOR SELECT TO authenticated USING ( is_guide() AND is_aal2() );

-- guide_payments
DROP POLICY IF EXISTS "guide_payments: admin full access" ON public.guide_payments;
CREATE POLICY "guide_payments: admin full access" ON public.guide_payments FOR ALL TO authenticated USING ( is_admin() AND is_aal2() ) WITH CHECK ( is_admin() AND is_aal2() );
DROP POLICY IF EXISTS "guide_payments: operations full access" ON public.guide_payments;
CREATE POLICY "guide_payments: operations full access" ON public.guide_payments FOR ALL TO authenticated USING ( is_operations() AND is_aal2() ) WITH CHECK ( is_operations() AND is_aal2() );

-- agencies
DROP POLICY IF EXISTS "agencies: admin select" ON public.agencies;
CREATE POLICY "agencies: admin select" ON public.agencies FOR SELECT TO authenticated USING ( is_admin() AND is_aal2() );
DROP POLICY IF EXISTS "agencies: admin insert" ON public.agencies;
CREATE POLICY "agencies: admin insert" ON public.agencies FOR INSERT TO authenticated WITH CHECK ( is_admin() AND is_aal2() );
DROP POLICY IF EXISTS "agencies: admin update" ON public.agencies;
CREATE POLICY "agencies: admin update" ON public.agencies FOR UPDATE TO authenticated USING ( is_admin() AND is_aal2() ) WITH CHECK ( is_admin() AND is_aal2() );
DROP POLICY IF EXISTS "agencies: sales select" ON public.agencies;
CREATE POLICY "agencies: sales select" ON public.agencies FOR SELECT TO authenticated USING ( is_sales() AND is_aal2() );
DROP POLICY IF EXISTS "agencies: sales insert" ON public.agencies;
CREATE POLICY "agencies: sales insert" ON public.agencies FOR INSERT TO authenticated WITH CHECK ( is_sales() AND is_aal2() );
DROP POLICY IF EXISTS "agencies: sales update" ON public.agencies;
CREATE POLICY "agencies: sales update" ON public.agencies FOR UPDATE TO authenticated USING ( is_sales() AND is_aal2() ) WITH CHECK ( is_sales() AND is_aal2() );

-- agency_emails
DROP POLICY IF EXISTS "agency_emails: admin select" ON public.agency_emails;
CREATE POLICY "agency_emails: admin select" ON public.agency_emails FOR SELECT TO authenticated USING ( is_admin() AND is_aal2() );
DROP POLICY IF EXISTS "agency_emails: admin insert" ON public.agency_emails;
CREATE POLICY "agency_emails: admin insert" ON public.agency_emails FOR INSERT TO authenticated WITH CHECK ( is_admin() AND is_aal2() );
DROP POLICY IF EXISTS "agency_emails: admin update" ON public.agency_emails;
CREATE POLICY "agency_emails: admin update" ON public.agency_emails FOR UPDATE TO authenticated USING ( is_admin() AND is_aal2() ) WITH CHECK ( is_admin() AND is_aal2() );
DROP POLICY IF EXISTS "agency_emails: sales select" ON public.agency_emails;
CREATE POLICY "agency_emails: sales select" ON public.agency_emails FOR SELECT TO authenticated USING ( is_sales() AND is_aal2() );
DROP POLICY IF EXISTS "agency_emails: sales insert" ON public.agency_emails;
CREATE POLICY "agency_emails: sales insert" ON public.agency_emails FOR INSERT TO authenticated WITH CHECK ( is_sales() AND is_aal2() );
DROP POLICY IF EXISTS "agency_emails: sales update" ON public.agency_emails;
CREATE POLICY "agency_emails: sales update" ON public.agency_emails FOR UPDATE TO authenticated USING ( is_sales() AND is_aal2() ) WITH CHECK ( is_sales() AND is_aal2() );

-- reservation_guests
DROP POLICY IF EXISTS "reservation_guests: admin full access" ON public.reservation_guests;
CREATE POLICY "reservation_guests: admin full access" ON public.reservation_guests FOR ALL TO authenticated USING ( is_admin() AND is_aal2() ) WITH CHECK ( is_admin() AND is_aal2() );
DROP POLICY IF EXISTS "reservation_guests: operations full access" ON public.reservation_guests;
CREATE POLICY "reservation_guests: operations full access" ON public.reservation_guests FOR ALL TO authenticated USING ( is_operations() AND is_aal2() ) WITH CHECK ( is_operations() AND is_aal2() );
DROP POLICY IF EXISTS "reservation_guests: sales read" ON public.reservation_guests;
CREATE POLICY "reservation_guests: sales read" ON public.reservation_guests FOR SELECT TO authenticated USING ( is_sales() AND is_aal2() );
DROP POLICY IF EXISTS "reservation_guests: guide reads assigned" ON public.reservation_guests;
CREATE POLICY "reservation_guests: guide reads assigned" ON public.reservation_guests FOR SELECT TO authenticated
  USING ( is_guide() AND is_aal2() AND EXISTS (SELECT 1 FROM public.reservations r WHERE r.id = reservation_guests.reservation_id AND r.assigned_to = auth.uid() AND r.status NOT IN ('cancelled')) );

-- email_ingestions (read-only for admin/operations; writes are service_role only, untouched)
DROP POLICY IF EXISTS "email_ingestions: admin read" ON public.email_ingestions;
CREATE POLICY "email_ingestions: admin read" ON public.email_ingestions FOR SELECT TO authenticated USING ( is_admin() AND is_aal2() );
DROP POLICY IF EXISTS "email_ingestions: operations read" ON public.email_ingestions;
CREATE POLICY "email_ingestions: operations read" ON public.email_ingestions FOR SELECT TO authenticated USING ( is_operations() AND is_aal2() );

-- activity_log_reads
DROP POLICY IF EXISTS "activity_log_reads: staff insert own" ON public.activity_log_reads;
CREATE POLICY "activity_log_reads: staff insert own" ON public.activity_log_reads FOR INSERT TO authenticated WITH CHECK ( staff_id = auth.uid() AND is_aal2() );
DROP POLICY IF EXISTS "activity_log_reads: staff read own" ON public.activity_log_reads;
CREATE POLICY "activity_log_reads: staff read own" ON public.activity_log_reads FOR SELECT TO authenticated USING ( staff_id = auth.uid() AND is_aal2() );
DROP POLICY IF EXISTS "activity_log_reads: admin read all" ON public.activity_log_reads;
CREATE POLICY "activity_log_reads: admin read all" ON public.activity_log_reads FOR SELECT TO authenticated USING ( is_admin() AND is_aal2() );

-- reservation_reviews
DROP POLICY IF EXISTS "reservation_reviews: admin full access" ON public.reservation_reviews;
CREATE POLICY "reservation_reviews: admin full access" ON public.reservation_reviews FOR ALL TO authenticated USING ( is_admin() AND is_aal2() ) WITH CHECK ( is_admin() AND is_aal2() );
DROP POLICY IF EXISTS "reservation_reviews: operations full access" ON public.reservation_reviews;
CREATE POLICY "reservation_reviews: operations full access" ON public.reservation_reviews FOR ALL TO authenticated USING ( is_operations() AND is_aal2() ) WITH CHECK ( is_operations() AND is_aal2() );
DROP POLICY IF EXISTS "reservation_reviews: sales read" ON public.reservation_reviews;
CREATE POLICY "reservation_reviews: sales read" ON public.reservation_reviews FOR SELECT TO authenticated USING ( is_sales() AND is_aal2() );
DROP POLICY IF EXISTS "reservation_reviews: guide role read" ON public.reservation_reviews;
CREATE POLICY "reservation_reviews: guide role read" ON public.reservation_reviews FOR SELECT TO authenticated USING ( is_guide() AND is_aal2() );

-- tour_languages
DROP POLICY IF EXISTS "tour_languages: admin full access" ON public.tour_languages;
CREATE POLICY "tour_languages: admin full access" ON public.tour_languages FOR ALL TO authenticated USING ( is_admin() AND is_aal2() ) WITH CHECK ( is_admin() AND is_aal2() );
DROP POLICY IF EXISTS "tour_languages: operations full access" ON public.tour_languages;
CREATE POLICY "tour_languages: operations full access" ON public.tour_languages FOR ALL TO authenticated USING ( is_operations() AND is_aal2() ) WITH CHECK ( is_operations() AND is_aal2() );
DROP POLICY IF EXISTS "tour_languages: sales read" ON public.tour_languages;
CREATE POLICY "tour_languages: sales read" ON public.tour_languages FOR SELECT TO authenticated USING ( is_sales() AND is_aal2() );
DROP POLICY IF EXISTS "tour_languages: guide read" ON public.tour_languages;
CREATE POLICY "tour_languages: guide read" ON public.tour_languages FOR SELECT TO authenticated USING ( is_guide() AND is_aal2() );

-- tour_channels
DROP POLICY IF EXISTS "tour_channels: admin full access" ON public.tour_channels;
CREATE POLICY "tour_channels: admin full access" ON public.tour_channels FOR ALL TO authenticated USING ( is_admin() AND is_aal2() ) WITH CHECK ( is_admin() AND is_aal2() );
DROP POLICY IF EXISTS "tour_channels: operations full access" ON public.tour_channels;
CREATE POLICY "tour_channels: operations full access" ON public.tour_channels FOR ALL TO authenticated USING ( is_operations() AND is_aal2() ) WITH CHECK ( is_operations() AND is_aal2() );

-- tour_itinerary_stops
DROP POLICY IF EXISTS "tour_itinerary_stops: admin full access" ON public.tour_itinerary_stops;
CREATE POLICY "tour_itinerary_stops: admin full access" ON public.tour_itinerary_stops FOR ALL TO authenticated USING ( is_admin() AND is_aal2() ) WITH CHECK ( is_admin() AND is_aal2() );
DROP POLICY IF EXISTS "tour_itinerary_stops: operations full access" ON public.tour_itinerary_stops;
CREATE POLICY "tour_itinerary_stops: operations full access" ON public.tour_itinerary_stops FOR ALL TO authenticated USING ( is_operations() AND is_aal2() ) WITH CHECK ( is_operations() AND is_aal2() );
DROP POLICY IF EXISTS "tour_itinerary_stops: sales read active tour" ON public.tour_itinerary_stops;
CREATE POLICY "tour_itinerary_stops: sales read active tour" ON public.tour_itinerary_stops FOR SELECT TO authenticated
  USING ( is_sales() AND is_aal2() AND EXISTS (SELECT 1 FROM public.tours t WHERE t.id = tour_itinerary_stops.tour_id AND t.is_active = TRUE) );
DROP POLICY IF EXISTS "tour_itinerary_stops: guide reads assigned tour" ON public.tour_itinerary_stops;
CREATE POLICY "tour_itinerary_stops: guide reads assigned tour" ON public.tour_itinerary_stops FOR SELECT TO authenticated
  USING ( is_guide() AND is_aal2() AND EXISTS (SELECT 1 FROM public.reservations r WHERE r.tour_id = tour_itinerary_stops.tour_id AND r.assigned_to = auth.uid()) );

-- civitatis_activity_modality_map
DROP POLICY IF EXISTS "civitatis_activity_modality_map: admin full access" ON public.civitatis_activity_modality_map;
CREATE POLICY "civitatis_activity_modality_map: admin full access" ON public.civitatis_activity_modality_map FOR ALL TO authenticated USING ( is_admin() AND is_aal2() ) WITH CHECK ( is_admin() AND is_aal2() );
DROP POLICY IF EXISTS "civitatis_activity_modality_map: operations full access" ON public.civitatis_activity_modality_map;
CREATE POLICY "civitatis_activity_modality_map: operations full access" ON public.civitatis_activity_modality_map FOR ALL TO authenticated USING ( is_operations() AND is_aal2() ) WITH CHECK ( is_operations() AND is_aal2() );

-- tour_preparation_rules
DROP POLICY IF EXISTS "tour_preparation_rules: admin full access" ON public.tour_preparation_rules;
CREATE POLICY "tour_preparation_rules: admin full access" ON public.tour_preparation_rules FOR ALL TO authenticated USING ( is_admin() AND is_aal2() ) WITH CHECK ( is_admin() AND is_aal2() );
DROP POLICY IF EXISTS "tour_preparation_rules: operations full access" ON public.tour_preparation_rules;
CREATE POLICY "tour_preparation_rules: operations full access" ON public.tour_preparation_rules FOR ALL TO authenticated USING ( is_operations() AND is_aal2() ) WITH CHECK ( is_operations() AND is_aal2() );
DROP POLICY IF EXISTS "tour_preparation_rules: guide reads assigned tour" ON public.tour_preparation_rules;
CREATE POLICY "tour_preparation_rules: guide reads assigned tour" ON public.tour_preparation_rules FOR SELECT TO authenticated
  USING ( is_guide() AND is_aal2() AND EXISTS (SELECT 1 FROM public.reservations r WHERE r.tour_id = tour_preparation_rules.tour_id AND r.assigned_to = auth.uid()) );

-- reservation_preparations
DROP POLICY IF EXISTS "reservation_preparations: admin full access" ON public.reservation_preparations;
CREATE POLICY "reservation_preparations: admin full access" ON public.reservation_preparations FOR ALL TO authenticated USING ( is_admin() AND is_aal2() ) WITH CHECK ( is_admin() AND is_aal2() );
DROP POLICY IF EXISTS "reservation_preparations: operations full access" ON public.reservation_preparations;
CREATE POLICY "reservation_preparations: operations full access" ON public.reservation_preparations FOR ALL TO authenticated USING ( is_operations() AND is_aal2() ) WITH CHECK ( is_operations() AND is_aal2() );
DROP POLICY IF EXISTS "reservation_preparations: guide reads assigned" ON public.reservation_preparations;
CREATE POLICY "reservation_preparations: guide reads assigned" ON public.reservation_preparations FOR SELECT TO authenticated
  USING ( is_guide() AND is_aal2() AND EXISTS (SELECT 1 FROM public.reservations r WHERE r.id = reservation_preparations.reservation_id AND r.assigned_to = auth.uid() AND r.status NOT IN ('cancelled')) );

-- whatsapp_destinations
DROP POLICY IF EXISTS "whatsapp_destinations: admin full access" ON public.whatsapp_destinations;
CREATE POLICY "whatsapp_destinations: admin full access" ON public.whatsapp_destinations FOR ALL TO authenticated USING ( is_admin() AND is_aal2() ) WITH CHECK ( is_admin() AND is_aal2() );
DROP POLICY IF EXISTS "whatsapp_destinations: operations full access" ON public.whatsapp_destinations;
CREATE POLICY "whatsapp_destinations: operations full access" ON public.whatsapp_destinations FOR ALL TO authenticated USING ( is_operations() AND is_aal2() ) WITH CHECK ( is_operations() AND is_aal2() );

-- whatsapp_destination_recipients
DROP POLICY IF EXISTS "whatsapp_destination_recipients: admin full access" ON public.whatsapp_destination_recipients;
CREATE POLICY "whatsapp_destination_recipients: admin full access" ON public.whatsapp_destination_recipients FOR ALL TO authenticated USING ( is_admin() AND is_aal2() ) WITH CHECK ( is_admin() AND is_aal2() );
DROP POLICY IF EXISTS "whatsapp_destination_recipients: operations full access" ON public.whatsapp_destination_recipients;
CREATE POLICY "whatsapp_destination_recipients: operations full access" ON public.whatsapp_destination_recipients FOR ALL TO authenticated USING ( is_operations() AND is_aal2() ) WITH CHECK ( is_operations() AND is_aal2() );

-- whatsapp_messages (read-only for admin/operations; writes are service_role only, untouched)
DROP POLICY IF EXISTS "whatsapp_messages: admin read" ON public.whatsapp_messages;
CREATE POLICY "whatsapp_messages: admin read" ON public.whatsapp_messages FOR SELECT TO authenticated USING ( is_admin() AND is_aal2() );
DROP POLICY IF EXISTS "whatsapp_messages: operations read" ON public.whatsapp_messages;
CREATE POLICY "whatsapp_messages: operations read" ON public.whatsapp_messages FOR SELECT TO authenticated USING ( is_operations() AND is_aal2() );

-- civitatis_settlement_items
DROP POLICY IF EXISTS "civitatis_settlement_items: admin full access" ON public.civitatis_settlement_items;
CREATE POLICY "civitatis_settlement_items: admin full access" ON public.civitatis_settlement_items FOR ALL TO authenticated USING ( is_admin() AND is_aal2() ) WITH CHECK ( is_admin() AND is_aal2() );
DROP POLICY IF EXISTS "civitatis_settlement_items: operations full access" ON public.civitatis_settlement_items;
CREATE POLICY "civitatis_settlement_items: operations full access" ON public.civitatis_settlement_items FOR ALL TO authenticated USING ( is_operations() AND is_aal2() ) WITH CHECK ( is_operations() AND is_aal2() );

-- exchange_rates (low-sensitivity reference data, but still normal
-- operational CRM access — every authenticated staff member, no role
-- distinction, so is_aal2() alone replaces the previous unconditional
-- TRUE; writes remain service_role-only/cron, untouched)
DROP POLICY IF EXISTS "exchange_rates: authenticated staff can read" ON public.exchange_rates;
CREATE POLICY "exchange_rates: authenticated staff can read" ON public.exchange_rates FOR SELECT TO authenticated USING ( is_aal2() );

-- ref_number_counters: RLS is already enabled with ZERO policies for the
-- authenticated role (service_role only, by pre-existing design) — no
-- change needed or made here.


-- ──────────────────────────────────────────────────────────────────────────
-- POSTFLIGHT — read-only verification that is_aal2() exists and every
-- policy this migration touched is still present (by name). Does not
-- inspect row data, does not modify anything.
-- ──────────────────────────────────────────────────────────────────────────
SELECT
  (SELECT COUNT(*) FROM pg_proc WHERE proname = 'is_aal2') AS is_aal2_exists,
  (SELECT COUNT(*) FROM pg_policies WHERE schemaname = 'public' AND policyname = 'staff_users: own profile select at aal1') AS bootstrap_policy_exists,
  (SELECT COUNT(*) FROM pg_policies WHERE schemaname = 'public' AND qual ILIKE '%is_aal2()%') AS policies_now_referencing_is_aal2,
  (SELECT COUNT(*) FROM pg_proc WHERE proname = 'get_current_staff_role' AND prosrc ILIKE '%is_active%') AS get_current_staff_role_checks_is_active,
  (SELECT COUNT(*) FROM pg_proc WHERE proname = 'enforce_staff_self_update_columns') AS self_update_guard_function_exists,
  (SELECT COUNT(*) FROM pg_trigger WHERE tgname = 'trg_staff_users_self_update_guard' AND tgrelid = 'public.staff_users'::regclass) AS self_update_guard_trigger_exists;
