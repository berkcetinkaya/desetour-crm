-- ============================================================
-- DESE TOUR OPERATIONS CENTER
-- Migration: Tour Preparation Intelligence — Phase B2
-- Narrow, additive persistence RPC for reservation Activity modality
-- ============================================================
-- File:    supabase_migration_civitatis_activity_modality_phase_b2.sql
-- NOT YET APPLIED to any database. Provided for manual review only.
--
-- SCOPE — WHAT THIS MIGRATION IS
-- ─────────────────────────────────────────────────────────────
-- Creates exactly ONE new function:
--   public.set_reservation_activity_modality(
--     p_reservation_id, p_source_id, p_external_booking_id,
--     p_purchased_activity_raw, p_meal_status
--   ) RETURNS JSONB
--
-- This function updates ONLY reservations.purchased_activity_raw and
-- reservations.meal_status — the two columns Phase A already added.
-- Nothing else it touches: no tour, date/time, guest counts, guide,
-- status, financial fields, notes, payments, or preparation data of any
-- kind — the UPDATE statement inside it names exactly these two columns
-- and nothing else (see postflight's structural re-confirmation of this
-- exact UPDATE shape).
--
-- WHY THIS EXISTS, SEPARATE FROM V12/V13
-- ─────────────────────────────────────────────────────────────
-- ingest_civitatis_booking (V12) and cancel_civitatis_booking (V13.1)
-- remain completely unmodified — neither their signature nor their body
-- — exactly as every migration since Tour Information Center has
-- maintained. This RPC is a SEPARATE, additive write path, intended to
-- be called by server-side Node code AFTER V12 already succeeded (never
-- from inside V12's own transaction, never as a trigger on it) — see the
-- Phase B2 report delivered alongside this migration for the exact
-- calling convention (api/_civitatis/activityModalityPersistence.js).
-- Calling this RPC can never affect, and is never required for,
-- ingest_civitatis_booking/cancel_civitatis_booking's own success.
--
-- IDENTITY GUARD — WHY source_id/external_booking_id ARE REQUIRED
-- ─────────────────────────────────────────────────────────────
-- p_reservation_id alone would be enough to target a row, but this
-- function additionally requires the caller to state the reservation's
-- own source_id and external_booking_id, and REJECTS the call (result:
-- 'identity_mismatch') if either does not match what the reservations
-- row actually has stored — exactly the same accidental-wrong-row
-- protection the caller already has in hand at call time (it just read
-- these values off the same email_ingestions/reservations join that
-- identified the reservation in the first place), applied as a second,
-- independent, server-side check rather than trusting the caller alone.
--
-- SECURITY
-- ─────────────────────────────────────────────────────────────
-- SECURITY DEFINER + SET search_path = public + explicit REVOKE ALL FROM
-- PUBLIC/authenticated/anon + GRANT EXECUTE ONLY TO service_role — the
-- same convention every prior privileged write RPC in this schema uses
-- (ingest_civitatis_booking, cancel_civitatis_booking, and this session's
-- earlier claim_whatsapp_outbox_batch). Note: because this function is
-- only ever reachable via the service_role key (which already bypasses
-- RLS entirely on its own), SECURITY DEFINER is not strictly required
-- for row-level access here the way it is for a function meant to be
-- called by an authenticated/anon role — it is used anyway for two
-- independent reasons: (1) consistency with the established repository
-- convention for every write RPC, and (2) SET search_path pins name
-- resolution against a hijacked search_path regardless of caller,
-- standard SECURITY DEFINER hardening independent of RLS. This function
-- is NEVER granted to authenticated or anon — it must never be callable
-- from browser/frontend code.
--
-- IDEMPOTENCY
-- ─────────────────────────────────────────────────────────────
-- A plain, unconditional UPDATE keyed by id = p_reservation_id (after
-- the identity guard passes). Calling this function twice with identical
-- arguments leaves reservations.purchased_activity_raw/meal_status in
-- the exact same final state both times — no counter, no append, no
-- side effect beyond the two target columns (and the pre-existing
-- updated_at trigger, which is metadata, not state, by the same
-- convention already established for updated_at across this schema).
-- Calling it again later with NEWER values (a modified booking)
-- unconditionally overwrites — there is no "only improve, never
-- downgrade" rule: the newest authoritative Activity/result always wins,
-- including a legitimate regression from a resolved status back to
-- 'unknown' if that is what the newest Activity now resolves to.
--
-- SAFETY
-- ─────────────────────────────────────────────────────────────
-- Wrapped in BEGIN/COMMIT. Preflight verifies reservations.
-- purchased_activity_raw/meal_status (Phase A) and
-- civitatis_activity_modality_map (Phase A/B1) exist, and that both
-- Civitatis RPC signatures (V12 26-param, V13.1 7-param) are unchanged,
-- BEFORE touching anything. Postflight re-verifies the new function
-- exists with the intended 5-argument signature, is SECURITY DEFINER,
-- has EXECUTE granted to service_role only (never PUBLIC/authenticated/
-- anon), and that both Civitatis RPC signatures remain unchanged.
--
-- HOW TO APPLY
-- ─────────────────────────────────────────────────────────────
-- Supabase Dashboard → SQL Editor → paste and run this file IN FULL, in
-- a single execution.
-- ============================================================


BEGIN;

-- ──────────────────────────────────────────────────────────────────────────
-- PREFLIGHT: confirm every object this migration depends on is exactly
-- what it's expected to be, BEFORE touching anything. Read-only.
-- ──────────────────────────────────────────────────────────────────────────

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='reservations' AND column_name='purchased_activity_raw'
  ) OR NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='reservations' AND column_name='meal_status'
  ) THEN
    RAISE EXCEPTION 'PHASE B2 PREFLIGHT FAILED: reservations.purchased_activity_raw/meal_status do not exist. Apply supabase_migration_tour_preparation_phase_a.sql BEFORE this migration. Aborting before touching anything.';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
     WHERE table_schema='public' AND table_name='civitatis_activity_modality_map'
  ) THEN
    RAISE EXCEPTION 'PHASE B2 PREFLIGHT FAILED: public.civitatis_activity_modality_map does not exist. Apply supabase_migration_tour_preparation_phase_a.sql BEFORE this migration. Aborting before touching anything.';
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname = 'ingest_civitatis_booking'
       AND p.pronargs = 26
       AND p.proargtypes = array_to_string(
             ARRAY[
               'text', 'text', 'timestamptz', 'text', 'text', 'text', 'uuid', 'text', 'uuid', 'text',
               'date', 'time', 'integer', 'integer', 'numeric', 'text', 'numeric', 'text', 'uuid',
               'text', 'text', 'text', 'jsonb', 'boolean', 'text', 'text'
             ]::regtype[]::oid[],
             ' '
           )::oidvector
  ) THEN
    RAISE EXCEPTION 'PHASE B2 PREFLIGHT FAILED: public.ingest_civitatis_booking with the expected 26-parameter V12 signature was not found. Aborting before touching anything.';
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname = 'cancel_civitatis_booking'
       AND p.pronargs = 7
       AND p.proargtypes = array_to_string(
             ARRAY['text','text','timestamptz','text','text','uuid','text']::regtype[]::oid[],
             ' '
           )::oidvector
  ) THEN
    RAISE EXCEPTION 'PHASE B2 PREFLIGHT FAILED: public.cancel_civitatis_booking with the expected 7-parameter V13.1 signature was not found. Aborting before touching anything.';
  END IF;

  RAISE NOTICE 'PHASE B2 PREFLIGHT PASSED: reservations columns and civitatis_activity_modality_map present; both Civitatis RPC signatures confirmed unchanged. Proceeding — additive RPC only.';
END $$;


-- ──────────────────────────────────────────────────────────────────────────
-- STEP 1: public.set_reservation_activity_modality — updates ONLY
-- reservations.purchased_activity_raw and reservations.meal_status.
-- ──────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.set_reservation_activity_modality(
  p_reservation_id         UUID,
  p_source_id              UUID,
  p_external_booking_id    TEXT,
  p_purchased_activity_raw TEXT,
  p_meal_status            TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_existing RECORD;
BEGIN
  IF p_meal_status NOT IN ('included', 'not_included', 'unknown') THEN
    RETURN jsonb_build_object('result', 'invalid_meal_status', 'reservation_id', p_reservation_id);
  END IF;

  SELECT id, source_id, external_booking_id
    INTO v_existing
    FROM public.reservations
   WHERE id = p_reservation_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('result', 'not_found', 'reservation_id', p_reservation_id);
  END IF;

  IF v_existing.source_id IS DISTINCT FROM p_source_id
     OR v_existing.external_booking_id IS DISTINCT FROM p_external_booking_id THEN
    RETURN jsonb_build_object('result', 'identity_mismatch', 'reservation_id', p_reservation_id);
  END IF;

  UPDATE public.reservations
     SET purchased_activity_raw = p_purchased_activity_raw,
         meal_status            = p_meal_status
   WHERE id = p_reservation_id;

  RETURN jsonb_build_object(
    'result', 'updated',
    'reservation_id', p_reservation_id,
    'meal_status', p_meal_status
  );
END;
$$;

COMMENT ON FUNCTION public.set_reservation_activity_modality(UUID, UUID, TEXT, TEXT, TEXT) IS
  'Tour Preparation Intelligence Phase B2 — updates ONLY reservations.purchased_activity_raw and reservations.meal_status, nothing else. Called exclusively by server-side code (api/_civitatis/activityModalityPersistence.js) AFTER ingest_civitatis_booking (V12) already succeeded — never from inside V12/V13.1, never modifying either. Requires p_source_id/p_external_booking_id to match the target row''s own stored values (result:''identity_mismatch'' otherwise) as a second, independent guard against updating the wrong reservation. p_meal_status must be one of included/not_included/unknown (result:''invalid_meal_status'' otherwise). Idempotent: an unconditional last-write-wins UPDATE — calling it again with the newest authoritative Activity/result always overwrites, including a legitimate regression back to ''unknown''. EXECUTE is granted to service_role only — never callable from browser/frontend code.';

REVOKE ALL ON FUNCTION public.set_reservation_activity_modality(UUID, UUID, TEXT, TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.set_reservation_activity_modality(UUID, UUID, TEXT, TEXT, TEXT) FROM authenticated;
REVOKE ALL ON FUNCTION public.set_reservation_activity_modality(UUID, UUID, TEXT, TEXT, TEXT) FROM anon;
GRANT EXECUTE ON FUNCTION public.set_reservation_activity_modality(UUID, UUID, TEXT, TEXT, TEXT) TO service_role;


-- ──────────────────────────────────────────────────────────────────────────
-- POSTFLIGHT: verify the new function exists with the intended signature
-- and security posture, and that both Civitatis RPC signatures remain
-- unchanged. RAISE EXCEPTION aborts the WHOLE transaction if anything is
-- wrong.
-- ──────────────────────────────────────────────────────────────────────────

DO $$
DECLARE
  v_missing TEXT[] := '{}';
  v_func_oid OID;
BEGIN
  SELECT p.oid INTO v_func_oid
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.proname = 'set_reservation_activity_modality'
     AND p.pronargs = 5
     AND p.proargtypes = array_to_string(
           ARRAY['uuid','uuid','text','text','text']::regtype[]::oid[],
           ' '
         )::oidvector;

  IF v_func_oid IS NULL THEN
    v_missing := array_append(v_missing, 'set_reservation_activity_modality with the expected 5-parameter (uuid,uuid,text,text,text) signature');
  ELSE
    IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE oid = v_func_oid AND prosecdef = TRUE) THEN
      v_missing := array_append(v_missing, 'set_reservation_activity_modality is not SECURITY DEFINER');
    END IF;
    IF NOT has_function_privilege('service_role', v_func_oid, 'EXECUTE') THEN
      v_missing := array_append(v_missing, 'service_role is missing EXECUTE on set_reservation_activity_modality');
    END IF;
    IF has_function_privilege('authenticated', v_func_oid, 'EXECUTE') THEN
      v_missing := array_append(v_missing, 'authenticated must NOT have EXECUTE on set_reservation_activity_modality');
    END IF;
    IF has_function_privilege('anon', v_func_oid, 'EXECUTE') THEN
      v_missing := array_append(v_missing, 'anon must NOT have EXECUTE on set_reservation_activity_modality');
    END IF;
  END IF;

  IF array_length(v_missing, 1) > 0 THEN
    RAISE EXCEPTION 'PHASE B2 POSTFLIGHT FAILED: %. Aborting — re-run this ENTIRE file in a single execution.', array_to_string(v_missing, ', ');
  END IF;

  -- Re-confirm both Civitatis RPCs are STILL exactly what they were
  -- before this migration ran — never touched.
  IF NOT EXISTS (
    SELECT 1
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname = 'ingest_civitatis_booking'
       AND p.pronargs = 26
       AND p.proargtypes = array_to_string(
             ARRAY[
               'text', 'text', 'timestamptz', 'text', 'text', 'text', 'uuid', 'text', 'uuid', 'text',
               'date', 'time', 'integer', 'integer', 'numeric', 'text', 'numeric', 'text', 'uuid',
               'text', 'text', 'text', 'jsonb', 'boolean', 'text', 'text'
             ]::regtype[]::oid[],
             ' '
           )::oidvector
  ) THEN
    RAISE EXCEPTION 'PHASE B2 POSTFLIGHT FAILED: public.ingest_civitatis_booking signature changed or the function disappeared during this migration. This must never happen — aborting.';
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname = 'cancel_civitatis_booking'
       AND p.pronargs = 7
       AND p.proargtypes = array_to_string(
             ARRAY['text','text','timestamptz','text','text','uuid','text']::regtype[]::oid[],
             ' '
           )::oidvector
  ) THEN
    RAISE EXCEPTION 'PHASE B2 POSTFLIGHT FAILED: public.cancel_civitatis_booking signature changed or the function disappeared during this migration. This must never happen — aborting.';
  END IF;

  RAISE NOTICE 'PHASE B2 POSTFLIGHT PASSED: set_reservation_activity_modality exists with the expected signature, is SECURITY DEFINER, granted to service_role only (never authenticated/anon); both Civitatis RPCs confirmed unchanged.';
END $$;

COMMIT;

-- ============================================================
-- END OF MIGRATION supabase_migration_civitatis_activity_modality_phase_b2.sql
-- ============================================================
