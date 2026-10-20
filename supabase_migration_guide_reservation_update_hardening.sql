-- ============================================================
-- DESE TOUR OPERATIONS CENTER
-- Migration: Guide Reservation UPDATE Column Hardening (Security Foundation Phase 1)
-- ============================================================
-- File:    supabase_migration_guide_reservation_update_hardening.sql
-- Depends: supabase_schema.sql, supabase_rls_policies.sql (already applied)
-- Version: Security Foundation — October 2026
--
-- WHY THIS EXISTS
-- ─────────────────────────────────────────────────────────────
-- The security audit of this CRM found a real, proven RLS gap: the
-- existing policy "reservations: guide update own status"
-- (supabase_rls_policies.sql:445-456) correctly restricts WHICH ROW a
-- guide may update (their own assigned, non-cancelled reservation), but
-- its WITH CHECK clause does not restrict WHICH COLUMNS may change —
-- its own comment admits this: "Guide may only update notes and
-- status; financials are protected... For full column-level
-- restriction, use a BEFORE UPDATE trigger." A guide, via a direct
-- Supabase REST/PATCH call bypassing the UI entirely, could today set
-- total_amount, deposit_amount, currency, customer_id, or any other
-- column on their own assigned reservation.
--
-- This migration is that BEFORE UPDATE trigger. It does NOT touch the
-- existing RLS policy at all — RLS still decides WHICH ROW a guide may
-- reach; this trigger additionally decides WHICH COLUMNS may change on
-- that row, for the guide role only.
--
-- EXACT GUIDE-EDITABLE COLUMNS — PROVEN FROM THE CURRENT APPLICATION,
-- NOT ASSUMED
-- ─────────────────────────────────────────────────────────────
-- Every reservation UPDATE a guide-role user can reach today comes from
-- exactly three UI actions, all routed through the same
-- SupabaseReservationRepo.update(id, patch) call (DeseTourDashboard.jsx),
-- confirmed against tests/dashboard/reservationQuickActionsRoleSafety.test.js
-- (which proves a guide sees exactly "Rehber Ata", "Pickup Bilgisi
-- Ekle", and "Turu Tamamlandı Olarak İşaretle" in ResQuickActions, and
-- nothing else):
--
--   1. "Rehber Ata" -> assignReservationGuide() -> patch {guideId, guide}
--      -> columns written: guide_id, guide_name
--   2. "Pickup Bilgisi Ekle" -> PickupEditModal -> patch {pickup, pickupTime}
--      -> columns written: pickup_location, pickup_time
--   3. "Turu Tamamlandı Olarak İşaretle" -> handleTamamlandi() ->
--      patch {opStatus:"Tamamlandı"} -> SupabaseReservationRepo.update's
--      own field-mapping writes: status (mapped from opStatus) AND,
--      as a same-call side effect of that specific value, completed_at.
--
-- No other guide-reachable UI path writes to public.reservations. This
-- was proven, not assumed, by reading SupabaseReservationRepo.update's
-- exact field map and the exact RES_ACTIONS array guides are shown.
--
-- Also allowed, defensively, regardless of role: updated_at — the
-- pre-existing trg_reservations_updated_at trigger (supabase_schema.sql:
-- 463-465) legitimately overwrites this column on every single UPDATE,
-- by every role, as a side effect that has nothing to do with what the
-- updating user chose to change. Excluding it from this guard avoids a
-- brand-new false rejection that has nothing to do with the actual
-- security gap being closed.
--
-- WHY A COLUMN-DENYLIST-BY-SUBTRACTION, NOT A HAND-ENUMERATED DENYLIST
-- ─────────────────────────────────────────────────────────────
-- Rather than hand-listing every OTHER reservations column (there are
-- ~35 across multiple migration files, several added well after the
-- base schema), the trigger strips the small, proven ALLOWED set from
-- both OLD and NEW via the standard `jsonb - text[]` operator and
-- compares what remains. This means any column added to reservations
-- in the future is automatically, correctly DENIED to the guide role by
-- default — a hand-enumerated denylist would instead silently ALLOW a
-- brand-new column until someone remembered to add it to the list,
-- which is the unsafe direction for this kind of guard to fail in.
--
-- WHO THIS TRIGGER DOES NOT AFFECT
-- ─────────────────────────────────────────────────────────────
-- The trigger body's first line checks
-- public.get_current_staff_role() = 'guide' and returns immediately
-- (RETURN NEW, no check at all) for every other case: admin, operations,
-- any other staff role, an unlinked/unauthenticated session, and —
-- critically — any service_role write (the Civitatis booking-ingestion
-- RPC, cron jobs). A service_role connection carries no user JWT, so
-- auth.uid() is NULL for it, get_current_staff_role() correspondingly
-- returns NULL, and `NULL = 'guide'` is NULL (not TRUE) in the IF
-- condition below — service_role writes fall through exactly like
-- admin/operations do, completely unaffected. Triggers fire regardless
-- of RLS/role (they are not an RLS mechanism), which is exactly why
-- this explicit role check is the first thing the function does.
--
-- WHAT THIS DOES NOT DO
-- ─────────────────────────────────────────────────────────────
--   • Does NOT change the existing RLS policy's row-visibility logic at
--     all (which reservation a guide may reach is unchanged).
--   • Does NOT restrict WHICH VALUE a guide may set status/guide_id/etc.
--     to — only WHICH COLUMNS may change. Value-level restriction was
--     not part of the proven gap and is out of this phase's scope.
--   • Does NOT affect INSERT at all (guides have no INSERT policy on
--     reservations today — this is UPDATE-only, matching the proven gap).
--   • Does NOT touch admin, operations, or service_role behavior in any way.
--
-- SAFETY
-- ─────────────────────────────────────────────────────────────
--   • Purely protective: it can only ever make a guide-role UPDATE
--     MORE restrictive than it is today, never less. No existing
--     legitimate guide action (proven above) is blocked.
--   • Idempotent: CREATE OR REPLACE FUNCTION and DROP TRIGGER IF EXISTS
--     + CREATE TRIGGER can both be run any number of times without
--     error and without changing the end result.
--   • No new table, no new column, no data touched.
--
-- HOW TO APPLY
-- ─────────────────────────────────────────────────────────────
-- Supabase Dashboard → SQL Editor → paste and run this file.
-- NOT executed as part of this change — review, then apply by hand.
-- ============================================================


-- ──────────────────────────────────────────────────────────────────────────
-- FUNCTION: enforce_guide_reservation_update_columns
-- ──────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.enforce_guide_reservation_update_columns()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_allowed_keys TEXT[] := ARRAY[
    'guide_id', 'guide_name',       -- "Rehber Ata"
    'pickup_location', 'pickup_time', -- "Pickup Bilgisi Ekle"
    'status', 'completed_at',       -- "Turu Tamamlandı Olarak İşaretle"
    'updated_at'                    -- set unconditionally by trg_reservations_updated_at, every role
  ];
BEGIN
  -- Every role other than guide (admin, operations, any future role, an
  -- unlinked session, or a service_role write with no staff row at all)
  -- is completely untouched by this trigger — see header comment.
  IF public.get_current_staff_role() IS DISTINCT FROM 'guide' THEN
    RETURN NEW;
  END IF;

  -- Strip the allowed columns from both the before- and after-image and
  -- compare what's left. If anything outside the proven-legitimate set
  -- changed, reject the whole UPDATE.
  IF (to_jsonb(OLD) - v_allowed_keys) IS DISTINCT FROM (to_jsonb(NEW) - v_allowed_keys) THEN
    RAISE EXCEPTION
      'Guides may only update guide assignment, pickup details, and completion status on their own reservations.'
      USING ERRCODE = '42501'; -- insufficient_privilege
  END IF;

  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.enforce_guide_reservation_update_columns IS
  'BEFORE UPDATE guard on public.reservations: for the guide role ONLY, rejects any column change outside {guide_id, guide_name, pickup_location, pickup_time, status, completed_at, updated_at} — the exact, proven set of fields the current application UI ever writes for a guide. Every other role (admin, operations, service_role) is unaffected. Does not replace or weaken the existing row-level RLS policy — this is a column-level guard on top of it.';

-- Idempotency: CREATE TRIGGER has no IF NOT EXISTS in PostgreSQL, so a
-- second run would fail with "trigger already exists" — guard with an
-- explicit DROP first. This only redefines the trigger's behavior, it
-- does not touch any row in public.reservations.
DROP TRIGGER IF EXISTS trg_reservations_guide_column_guard ON public.reservations;
CREATE TRIGGER trg_reservations_guide_column_guard
  BEFORE UPDATE ON public.reservations
  FOR EACH ROW EXECUTE FUNCTION public.enforce_guide_reservation_update_columns();


-- ──────────────────────────────────────────────────────────────────────────
-- POSTFLIGHT — confirms the trigger/function exist, RLS policy count and
-- the existing updated_at trigger are both unchanged. Read-only SELECTs only.
-- ──────────────────────────────────────────────────────────────────────────
SELECT
  (SELECT COUNT(*) FROM pg_proc WHERE proname = 'enforce_guide_reservation_update_columns') AS guard_function_exists,
  (SELECT COUNT(*) FROM pg_trigger WHERE tgname = 'trg_reservations_guide_column_guard' AND NOT tgisinternal) AS guard_trigger_exists,
  (SELECT COUNT(*) FROM pg_trigger WHERE tgname = 'trg_reservations_updated_at' AND NOT tgisinternal) AS updated_at_trigger_unchanged,
  (SELECT COUNT(*) FROM pg_policies WHERE schemaname='public' AND tablename='reservations') AS reservations_policy_count_unchanged;
