-- ============================================================
-- DESE TOUR OPERATIONS CENTER
-- Migration: Civitatis Settlement Engine — Phase 2
-- Requested / Paid period-level transitions
-- ============================================================
-- File:    supabase_migration_civitatis_settlement_phase2.sql
-- Depends: supabase_migration_civitatis_settlement_phase1.sql (Phase 1.2
--          revision — civitatis_settlement_items, exchange_rates,
--          fn_ensure_civitatis_settlement_item, is_admin()/is_operations()
--          from supabase_rls_policies.sql) (already applied)
--
-- PHASE 2A AUDIT SUMMARY (see chat report for full detail)
-- ─────────────────────────────────────────────────────────────
-- - civitatis_settlement_items already has: id, reservation_id, status
--   (accrued/claimable/requested/paid/adjusted/cancelled), claimable_at,
--   settlement_period, original_amount, original_currency, plus the
--   Phase 1 reserved-but-unused exchange_rate_used/exchange_rate_date/
--   try_amount columns. Nothing stores requested_at/paid_at yet.
-- - activity_logs.entity_type already allows 'civitatis_settlement'
--   (Phase 1); activity_logs.action already allows 'status_changed' in
--   the ORIGINAL base CHECK (supabase_schema.sql) — never widened by any
--   migration. Neither CHECK needs changing for this phase.
-- - Every existing staff-facing financial mutation in this project
--   (payments, guide_payments, reservations) is a PLAIN table write from
--   the browser's own authenticated session, authorized purely by RLS
--   (is_admin()/is_operations() inside USING/WITH CHECK). The only
--   SECURITY DEFINER RPC functions that exist are GRANTed to
--   service_role ONLY, for webhook/cron-driven server-side flows
--   (ingest_civitatis_booking, claim_whatsapp_outbox_batch,
--   materialize_reservation_preparations) — never called directly from
--   the browser.
-- - This phase's requirement — one atomic statement that conditionally
--   transitions MANY rows in a period together AND writes their audit
--   trail in the same transaction — fits neither existing pattern
--   cleanly: a plain RLS-gated bulk UPDATE from the browser could do the
--   multi-row transition atomically, but writing the activity_logs
--   evidence would need a SECOND round trip with no shared transaction,
--   meaning a crash between the two calls could leave a real status
--   change with zero audit evidence — exactly what the brief says must
--   never happen. So this migration introduces a NEW (for this project)
--   but minimal pattern: a SECURITY DEFINER function, like the Phase 1
--   settlement functions, but GRANTed to `authenticated` (not just
--   service_role) because it IS meant to be called directly from the
--   browser by a staff member clicking a button — with its OWN internal
--   is_admin()/is_operations() check standing in for RLS (Postgres GRANT
--   cannot distinguish admin/operations/sales/guide — they are all the
--   same `authenticated` Postgres role; the distinction lives in
--   staff_users.role, checked via is_admin()/is_operations(), exactly
--   the same predicates RLS policies already use, just called from
--   inside the function body instead of from inside a policy).
--
-- SCOPE OF THIS MIGRATION
-- ─────────────────────────────────────────────────────────────
-- Purely additive. Adds two nullable TIMESTAMPTZ columns to the
-- EXISTING civitatis_settlement_items table (requested_at, paid_at) and
-- two new SECURITY DEFINER functions. Does NOT touch original_amount,
-- original_currency, settlement_period, reservation_id, claimable_at,
-- exchange_rate_used, exchange_rate_date, or try_amount — the fixed
-- 55 TRY EUR display rate (Phase 1.3) is presentation logic only and is
-- never written into this table by anything in this migration. Does NOT
-- touch reservations, public.payments, reservations.payment_status, the
-- Civitatis ingestion RPCs, exchange_rates, or any RLS policy.
--
-- WHY PERIOD-SCOPED, NOT ROW-SCOPED
-- ─────────────────────────────────────────────────────────────
-- PHASE 2.1 REVISION — PERIOD INTEGRITY HARDENING (approved financial
-- integrity review). The original Phase 2 design moved whatever subset
-- of a period happened to match a bare UPDATE WHERE clause, silently
-- leaving the rest alone. That is unsafe specifically for a period-
-- level financial action: a settlement item can legitimately be
-- created LATE for an already-processed period (a reservation for a
-- past tour date gets marked completed weeks after the fact — exactly
-- the kind of operational delay Phase 0's own audit already found).
-- Under the original design, the next click of either button would
-- silently fold that late-arriving item into a brand new transition,
-- recording "this item's claim/payment was made" even though it was
-- never actually part of the real external action already taken for
-- that period. This revision closes that gap with an explicit,
-- DB-enforced ALL-OR-NOTHING invariant per period, never relying on the
-- UI alone to catch it.
--
-- ACTIONABLE SET (both functions): every row sharing the target
-- settlement_period whose status is NOT 'cancelled' and NOT 'adjusted'.
-- Those two states are intentionally outside the normal flow forever —
-- they must never block the rest of the period merely by existing, and
-- must never themselves be touched by either transition.
--
-- REQUESTED invariant: before changing ANYTHING, lock and classify the
-- whole actionable set (FOR UPDATE, so a concurrent call against the
-- same period cannot interleave between the check and the update):
--   - empty actionable set, but the period has cancelled/adjusted rows
--     -> 'no_actionable_items'
--   - the period has no rows at all -> 'period_not_found'
--   - every actionable row already 'requested' -> 'already_requested'
--     (idempotent no-op, no audit row)
--   - every actionable row already 'paid' -> 'already_paid' (terminal,
--     never re-requested)
--   - every actionable row still accrued with claimable_at in the
--     future -> 'not_yet_claimable' (clean "too early", not a mix)
--   - anything else (the actionable set disagrees — some claimable,
--     some future, some already requested/paid together) ->
--     'mixed_or_ineligible_period': REJECT THE WHOLE CALL, move nothing
--   - only when EVERY actionable row is accrued/claimable with
--     claimable_at already passed: atomically transition the COMPLETE
--     actionable set to 'requested', stamp requested_at, write one
--     activity_logs row per transitioned item -> 'requested'
--
-- PAID invariant: same structure, but the only state that may advance
-- is a uniformly 'requested' actionable set -> 'paid'. Any other
-- non-uniform mix (including a stray accrued/claimable item, per the
-- late-arrival case above) is 'mixed_or_ineligible_period', never a
-- partial pay.
--
-- Returns JSONB (the exact pattern already established by
-- cancel_civitatis_booking's own 'result' field in
-- supabase_migration_civitatis_write_v13_cancellation.sql), never a
-- bare INTEGER — a frontend reading only an affected_count cannot tell
-- "already done" from "invalid" from "nonexistent period" apart, which
-- this revision's review flagged as a real (non-financial) ambiguity.
--
-- WHY ONE ACTIVITY_LOGS ROW PER AFFECTED ITEM, NOT ONE ROW PER BATCH
-- ─────────────────────────────────────────────────────────────
-- Every existing activity_logs writer in this project (Phase 1's own
-- fn_ensure_civitatis_settlement_item included) logs one row per
-- mutated entity, with entity_id set to that entity's own id —
-- activity_logs.entity_id is NOT NULL with no FK ("entity may be
-- deleted"), and there is no established convention anywhere in this
-- project for a single log row representing many mutated rows at once.
-- Rather than invent one, this migration keeps the established
-- convention (one row per settlement item actually transitioned) and
-- additionally stamps every row in the same batch with an identical
-- metadata->>'batch_affected_count' (the exact number of items this one
-- function call transitioned) and metadata->>'settlement_period', so
-- "how many settlement items were affected" and "which period" are both
-- directly readable from any single row in the batch, with no need to
-- COUNT(*) across rows to reconstruct it.
-- ============================================================


BEGIN;


-- ──────────────────────────────────────────────────────────────────────────
-- COLUMNS: civitatis_settlement_items.requested_at / paid_at
-- When staff recorded the transition in the CRM — never when Civitatis
-- itself actually paid or acknowledged the claim (this project has no
-- way to know that moment; these timestamps are explicitly "when CRM
-- was told", not "when the bank moved money").
-- ──────────────────────────────────────────────────────────────────────────

ALTER TABLE public.civitatis_settlement_items
  ADD COLUMN IF NOT EXISTS requested_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS paid_at      TIMESTAMPTZ;

COMMENT ON COLUMN public.civitatis_settlement_items.requested_at IS 'When staff recorded (in the CRM) that the Civitatis claim for this item''s period was made externally. NULL until the requested transition. Never the actual Civitatis claim timestamp.';
COMMENT ON COLUMN public.civitatis_settlement_items.paid_at      IS 'When staff recorded (in the CRM) that Civitatis paid this item''s period. NULL until the paid transition. Never the actual bank settlement timestamp.';


-- ──────────────────────────────────────────────────────────────────────────
-- FUNCTION: fn_mark_civitatis_settlement_period_requested
-- PHASE 2.1: whole-actionable-set invariant (see the revision note
-- above) — returns JSONB, never a bare INTEGER. Locks the actionable
-- set with FOR UPDATE before deciding anything, so two concurrent calls
-- against the same period can never both decide to proceed from stale
-- data (the second one blocks until the first commits, then re-reads
-- the now-current state and correctly sees already_requested instead
-- of double-transitioning).
-- DROP FUNCTION first: this migration has never been applied to
-- production, so there is no live function with the old INTEGER return
-- type to migrate around — this guards only a partially-run DRAFT of
-- this same file (e.g. an earlier attempt against a staging/disposable
-- database), since CREATE OR REPLACE cannot itself change a function's
-- return type.
-- ──────────────────────────────────────────────────────────────────────────

DROP FUNCTION IF EXISTS public.fn_mark_civitatis_settlement_period_requested(DATE);

CREATE OR REPLACE FUNCTION public.fn_mark_civitatis_settlement_period_requested(p_settlement_period DATE)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_total         INTEGER;
  v_claimable_cnt INTEGER;
  v_future_cnt    INTEGER;
  v_requested_cnt INTEGER;
  v_paid_cnt      INTEGER;
  v_ids           UUID[];
  v_count         INTEGER;
BEGIN
  -- Postgres GRANT cannot distinguish staff_users.role sub-types — every
  -- staff member is the same `authenticated` role — so, exactly like
  -- RLS policies elsewhere in this project, the real authorization
  -- check is is_admin() OR is_operations(). Sales and guide (and any
  -- unauthenticated caller) are rejected here, matching this project's
  -- existing "payments: operations full access" / "payments: admin full
  -- access" authorization shape (sales is read-only on payments, guide
  -- has zero policy = zero access at all).
  -- IS NOT TRUE, never bare NOT(...): if auth.uid() has no matching
  -- staff_users row (no session, or a deleted staff account — exactly
  -- the NULL fallback get_current_staff_role() itself documents),
  -- is_admin()/is_operations() both return NULL, and plain
  -- "NOT (NULL OR NULL)" is NULL — which a plpgsql IF treats as FALSE,
  -- silently skipping the exception and letting an unauthenticated
  -- caller through. This was caught live in disposable-Postgres
  -- validation (an empty auth.uid() mutated real rows before this
  -- fix). "IS NOT TRUE" correctly treats NULL as unauthorized.
  IF (public.is_admin() OR public.is_operations()) IS NOT TRUE THEN
    RAISE EXCEPTION 'Bu islem icin yonetici veya operasyon rolu gereklidir' USING ERRCODE = '42501';
  END IF;

  IF p_settlement_period IS NULL THEN
    RAISE EXCEPTION 'settlement_period zorunludur';
  END IF;

  -- Lock + classify the whole actionable set (cancelled/adjusted
  -- excluded entirely — they never block, and are never counted here)
  -- in one pass, before deciding anything.
  SELECT
    COUNT(*),
    COUNT(*) FILTER (WHERE status IN ('accrued', 'claimable') AND claimable_at <= CURRENT_DATE),
    COUNT(*) FILTER (WHERE status = 'accrued' AND claimable_at > CURRENT_DATE),
    COUNT(*) FILTER (WHERE status = 'requested'),
    COUNT(*) FILTER (WHERE status = 'paid')
  INTO v_total, v_claimable_cnt, v_future_cnt, v_requested_cnt, v_paid_cnt
  FROM (
    SELECT status, claimable_at FROM public.civitatis_settlement_items
     WHERE settlement_period = p_settlement_period
       AND status NOT IN ('cancelled', 'adjusted')
     FOR UPDATE
  ) actionable;

  IF v_total = 0 THEN
    IF EXISTS (SELECT 1 FROM public.civitatis_settlement_items WHERE settlement_period = p_settlement_period) THEN
      RETURN jsonb_build_object('result', 'no_actionable_items', 'affected_count', 0, 'settlement_period', p_settlement_period);
    END IF;
    RETURN jsonb_build_object('result', 'period_not_found', 'affected_count', 0, 'settlement_period', p_settlement_period);
  END IF;

  IF v_requested_cnt = v_total THEN
    RETURN jsonb_build_object('result', 'already_requested', 'affected_count', 0, 'settlement_period', p_settlement_period);
  END IF;

  IF v_paid_cnt = v_total THEN
    RETURN jsonb_build_object('result', 'already_paid', 'affected_count', 0, 'settlement_period', p_settlement_period);
  END IF;

  IF v_future_cnt = v_total THEN
    RETURN jsonb_build_object('result', 'not_yet_claimable', 'affected_count', 0, 'settlement_period', p_settlement_period);
  END IF;

  -- Every actionable row must be claimable right now, or the whole
  -- call is rejected — never a partial move. This is what closes the
  -- late-arrival gap: a straggler accrued/claimable row sharing a
  -- period with already-requested/paid rows (or with a still-future
  -- row) makes v_claimable_cnt <> v_total, so nothing moves.
  IF v_claimable_cnt <> v_total THEN
    RETURN jsonb_build_object('result', 'mixed_or_ineligible_period', 'affected_count', 0, 'settlement_period', p_settlement_period);
  END IF;

  WITH u AS (
    UPDATE public.civitatis_settlement_items
       SET status       = 'requested',
           requested_at = NOW(),
           updated_at   = NOW()
     WHERE settlement_period = p_settlement_period
       AND status NOT IN ('cancelled', 'adjusted')
    RETURNING id
  )
  SELECT array_agg(id) INTO v_ids FROM u;

  v_count := COALESCE(array_length(v_ids, 1), 0);

  INSERT INTO public.activity_logs (entity_type, entity_id, action, description, metadata, performed_by)
  SELECT
    'civitatis_settlement', csi.id, 'status_changed',
    'Civitatis hakedis talebi kaydedildi: donem ' || to_char(p_settlement_period, 'YYYY-MM') ||
      ' (' || v_count || ' kalem)',
    jsonb_build_object(
      'settlement_period', p_settlement_period,
      'from_status', 'accrued',
      'to_status', 'requested',
      'reservation_id', csi.reservation_id,
      'original_amount', csi.original_amount,
      'original_currency', csi.original_currency,
      'batch_affected_count', v_count
    ),
    auth.uid()
  FROM public.civitatis_settlement_items csi
  WHERE csi.id = ANY(v_ids);

  RETURN jsonb_build_object('result', 'requested', 'affected_count', v_count, 'settlement_period', p_settlement_period);
END;
$$;

COMMENT ON FUNCTION public.fn_mark_civitatis_settlement_period_requested(DATE) IS 'Admin/operations only. Whole-actionable-set invariant: every non-cancelled/non-adjusted row in the period must currently be accrued/claimable with claimable_at passed, or the entire call is rejected (mixed_or_ineligible_period) rather than moving a subset. Returns JSONB {result, affected_count, settlement_period}; result is one of requested/already_requested/already_paid/not_yet_claimable/mixed_or_ineligible_period/no_actionable_items/period_not_found. Never touches original_amount/original_currency/settlement_period/reservation_id/claimable_at/exchange_rate_used/exchange_rate_date/try_amount.';

REVOKE EXECUTE ON FUNCTION public.fn_mark_civitatis_settlement_period_requested(DATE) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.fn_mark_civitatis_settlement_period_requested(DATE) TO authenticated;


-- ──────────────────────────────────────────────────────────────────────────
-- FUNCTION: fn_mark_civitatis_settlement_period_paid
-- PHASE 2.1: same whole-actionable-set invariant as the requested
-- transition above. The only state allowed to advance is a uniformly
-- 'requested' actionable set; any other mix (including a stray
-- accrued/claimable straggler, or a period already partly paid) is
-- rejected outright. accrued->paid, claimable->paid, and cancelled->
-- paid remain structurally impossible — not merely blocked by the UI.
-- ──────────────────────────────────────────────────────────────────────────

DROP FUNCTION IF EXISTS public.fn_mark_civitatis_settlement_period_paid(DATE);

CREATE OR REPLACE FUNCTION public.fn_mark_civitatis_settlement_period_paid(p_settlement_period DATE)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_total         INTEGER;
  v_requested_cnt INTEGER;
  v_paid_cnt      INTEGER;
  v_ids           UUID[];
  v_count         INTEGER;
BEGIN
  -- IS NOT TRUE, never bare NOT(...) — see the identical comment in
  -- fn_mark_civitatis_settlement_period_requested above; the same NULL-
  -- auth bypass applies here and is fixed the same way.
  IF (public.is_admin() OR public.is_operations()) IS NOT TRUE THEN
    RAISE EXCEPTION 'Bu islem icin yonetici veya operasyon rolu gereklidir' USING ERRCODE = '42501';
  END IF;

  IF p_settlement_period IS NULL THEN
    RAISE EXCEPTION 'settlement_period zorunludur';
  END IF;

  SELECT
    COUNT(*),
    COUNT(*) FILTER (WHERE status = 'requested'),
    COUNT(*) FILTER (WHERE status = 'paid')
  INTO v_total, v_requested_cnt, v_paid_cnt
  FROM (
    SELECT status FROM public.civitatis_settlement_items
     WHERE settlement_period = p_settlement_period
       AND status NOT IN ('cancelled', 'adjusted')
     FOR UPDATE
  ) actionable;

  IF v_total = 0 THEN
    IF EXISTS (SELECT 1 FROM public.civitatis_settlement_items WHERE settlement_period = p_settlement_period) THEN
      RETURN jsonb_build_object('result', 'no_actionable_items', 'affected_count', 0, 'settlement_period', p_settlement_period);
    END IF;
    RETURN jsonb_build_object('result', 'period_not_found', 'affected_count', 0, 'settlement_period', p_settlement_period);
  END IF;

  IF v_paid_cnt = v_total THEN
    RETURN jsonb_build_object('result', 'already_paid', 'affected_count', 0, 'settlement_period', p_settlement_period);
  END IF;

  -- Every actionable row must already be 'requested', or the whole
  -- call is rejected — an accrued/claimable straggler, a period
  -- already partly paid, or any other mix never pays a subset.
  IF v_requested_cnt <> v_total THEN
    RETURN jsonb_build_object('result', 'mixed_or_ineligible_period', 'affected_count', 0, 'settlement_period', p_settlement_period);
  END IF;

  WITH u AS (
    UPDATE public.civitatis_settlement_items
       SET status     = 'paid',
           paid_at    = NOW(),
           updated_at = NOW()
     WHERE settlement_period = p_settlement_period
       AND status NOT IN ('cancelled', 'adjusted')
    RETURNING id
  )
  SELECT array_agg(id) INTO v_ids FROM u;

  v_count := COALESCE(array_length(v_ids, 1), 0);

  INSERT INTO public.activity_logs (entity_type, entity_id, action, description, metadata, performed_by)
  SELECT
    'civitatis_settlement', csi.id, 'status_changed',
    'Civitatis hakedis odemesi kaydedildi: donem ' || to_char(p_settlement_period, 'YYYY-MM') ||
      ' (' || v_count || ' kalem)',
    jsonb_build_object(
      'settlement_period', p_settlement_period,
      'from_status', 'requested',
      'to_status', 'paid',
      'reservation_id', csi.reservation_id,
      'original_amount', csi.original_amount,
      'original_currency', csi.original_currency,
      'batch_affected_count', v_count
    ),
    auth.uid()
  FROM public.civitatis_settlement_items csi
  WHERE csi.id = ANY(v_ids);

  RETURN jsonb_build_object('result', 'paid', 'affected_count', v_count, 'settlement_period', p_settlement_period);
END;
$$;

COMMENT ON FUNCTION public.fn_mark_civitatis_settlement_period_paid(DATE) IS 'Admin/operations only. Whole-actionable-set invariant: every non-cancelled/non-adjusted row in the period must currently be requested, or the entire call is rejected (mixed_or_ineligible_period) rather than paying a subset. Returns JSONB {result, affected_count, settlement_period}; result is one of paid/already_paid/mixed_or_ineligible_period/no_actionable_items/period_not_found. accrued/claimable/adjusted/cancelled can never be paid.';

REVOKE EXECUTE ON FUNCTION public.fn_mark_civitatis_settlement_period_paid(DATE) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.fn_mark_civitatis_settlement_period_paid(DATE) TO authenticated;


COMMIT;


-- ============================================================
-- POST-MIGRATION READ-ONLY VERIFICATION (run AFTER the COMMIT above —
-- every statement below is a plain SELECT; none writes anything)
-- ============================================================

-- A. Object existence
SELECT
  (SELECT COUNT(*) FROM information_schema.columns WHERE table_schema='public' AND table_name='civitatis_settlement_items' AND column_name='requested_at') AS requested_at_exists,
  (SELECT COUNT(*) FROM information_schema.columns WHERE table_schema='public' AND table_name='civitatis_settlement_items' AND column_name='paid_at') AS paid_at_exists,
  (SELECT COUNT(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='fn_mark_civitatis_settlement_period_requested') AS requested_fn_exists,
  (SELECT COUNT(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='fn_mark_civitatis_settlement_period_paid') AS paid_fn_exists;

-- B. Current state by period and status (no mutation — for staff review
-- before using either transition for the first time in production)
SELECT settlement_period, status, COUNT(*) AS item_count, SUM(original_amount) AS original_amount_total
  FROM public.civitatis_settlement_items
 GROUP BY settlement_period, status
 ORDER BY settlement_period, status;

-- ============================================================
-- END OF supabase_migration_civitatis_settlement_phase2.sql
-- ============================================================
