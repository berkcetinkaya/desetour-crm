-- ============================================================
-- DESE TOUR OPERATIONS CENTER
-- Migration: Civitatis Settlement Engine — Phase 1 Foundation
-- Phase 1.2 — Final Production Safety Revision
-- ============================================================
-- File:    supabase_migration_civitatis_settlement_phase1.sql
-- Depends: supabase_schema.sql, supabase_rls_policies.sql,
--          supabase_migration_civitatis_ingestion.sql (reservations.
--          source_id/retail_amount/retail_currency),
--          supabase_migration_tour_channels.sql (tours.status,
--          activity_logs.entity_type's most recent widening — this
--          migration widens it again, additively, same as that one did)
--          (all already applied)
--
-- PHASE 1.2 REVISION NOTE — WHAT CHANGED AND WHY
-- ─────────────────────────────────────────────────────────────
-- The architecture and business logic from Phase 1 are APPROVED and
-- UNCHANGED. This revision adds exactly five production-safety
-- hardenings, nothing else:
--   1. The entire migration (every CREATE/ALTER/DROP/backfill) is now
--      wrapped in one explicit BEGIN;/COMMIT; — if ANY statement fails,
--      Postgres rolls back everything, so no partial schema and no
--      partial backfill can ever remain. This no longer relies on the
--      Supabase SQL Editor's own behavior for atomicity.
--   2. fn_ensure_civitatis_settlement_item now ALSO requires check_in
--      to be NOT NULL before computing settlement_period/claimable_at.
--      Previously, a reservation marked completed with a NULL check_in
--      would compute settlement_period = date_trunc('month', NULL) =
--      NULL, and the INSERT into a NOT NULL column would raise a real
--      exception — INSIDE the trigger that fires on the reservation's
--      own UPDATE, meaning a single malformed reservation could have
--      aborted that staff member's ordinary "mark as completed" action
--      entirely. Now it returns NULL (no settlement item, no error)
--      before ever reaching that computation. completed_at is still
--      never used for the settlement month — check_in remains the
--      only valid source, exactly as before.
--   3. Currency validation is hardened from "NOT NULL" to "NOT NULL
--      AND NOT blank/whitespace-only" (btrim(currency) <> ''). The TL
--      -> TRY normalization and every valid EUR/USD/GBP/TRY value are
--      completely unchanged; only NULL/''/'   ' are now also treated
--      as "unknown currency, create nothing" rather than risking an
--      empty-string original_currency ever reaching the table.
--   4. public.fn_ensure_civitatis_settlement_item(uuid) and
--      public.fn_cancel_civitatis_settlement_item_if_exists(uuid) are
--      now REVOKEd from PUBLIC immediately after creation — neither is
--      directly callable by the anon/authenticated Supabase roles (no
--      browser-reachable financial write path), matching the same
--      "no public RPC surface for a financial state change" posture
--      the rest of this project already holds. The ongoing trigger and
--      this migration's own backfill both keep working: the trigger
--      function (fn_trg_civitatis_settlement_on_reservation_change) is
--      now ALSO marked SECURITY DEFINER (it previously ran with
--      invoker rights), so its internal PERFORM calls into the two
--      now-locked-down functions execute under the DEFINER's own
--      privileges — exactly the same mechanism supabase_rls_policies.sql's
--      is_admin()/is_operations() already rely on — never under the
--      privileges of whichever role's UPDATE statement fired the
--      trigger. The backfill SELECT below runs as whichever role
--      executes this migration file (a privileged admin/service
--      connection via the Supabase SQL Editor), which — as the owner of
--      every function created in this same script — always retains
--      EXECUTE on its own functions regardless of the PUBLIC
--      revocation. No RLS policy anywhere in this file was changed for
--      this hardening; it is a function-privilege change only.
--   5. A read-only verification section is added AFTER the COMMIT,
--      confirming object existence and the real September 2026
--      production numbers.
-- Every other line below (table shapes, eligibility rule, TL/TRY
-- normalization, settlement period math, RLS policies, the
-- activity_logs widening, the backfill's own logic) is IDENTICAL in
-- substance to the approved Phase 1 design — see the unchanged
-- explanatory sections immediately below for the full original
-- rationale, which still applies verbatim.
--
-- SCOPE OF THIS MIGRATION (Phase 0 audit → Phase 1 implementation)
-- ─────────────────────────────────────────────────────────────
-- Purely additive. Creates two new tables (civitatis_settlement_items,
-- exchange_rates), one new trigger on the EXISTING reservations table
-- (fires only for Civitatis-sourced rows transitioning to completed/
-- cancelled — never touches any reservations column, never touches
-- total_amount/currency/retail_amount/retail_currency), and widens
-- activity_logs.entity_type the same additive way tour_channels/guides/
-- reviews already did. It does NOT touch public.payments, does NOT
-- touch reservations.payment_status, does NOT touch the Civitatis
-- ingestion RPCs (ingest_civitatis_booking / the cancellation RPC),
-- and does NOT modify any existing reservation's stored amount or
-- currency — Phase 0's own explicit finding was that those are already
-- correct; the problem was in the REPORTING layer, which this phase
-- does not touch either (Reports stays broken until its own dedicated
-- phase, by instruction).
--
-- WHY A NEW TABLE, NOT AN EXTENSION OF public.payments
-- ─────────────────────────────────────────────────────────────
-- public.payments models money a GUEST owes/pays Dese Tour directly
-- (customer_id NOT NULL, method IN ('cash','bank_transfer',...)). A
-- Civitatis settlement is a different relationship entirely — Dese
-- Tour's receivable FROM Civitatis, never from the guest — the same
-- reasoning that already keeps guide_payments structurally separate
-- from payments ("Kept separate... so the two are never mixed without
-- an explicit join/union", supabase_migration_guides.sql). Overloading
-- payments with a nullable "is this a marketplace settlement" branch
-- would mean most of that table's own columns (customer_id, method)
-- stop making sense for every Civitatis row — a third, purpose-built
-- table is the cleaner fit, matching this project's own established
-- precedent of one new table per genuinely distinct money relationship.
--
-- ONE ROW PER RESERVATION, NOT PER SETTLEMENT PERIOD
-- ─────────────────────────────────────────────────────────────
-- reservation_id is UNIQUE. This keeps the audit trail granular — "which
-- completed reservations make up this month's total" (an explicit Phase 2
-- requirement) is then a plain WHERE settlement_period = X with no
-- separate join table, and the UNIQUE constraint is itself the primary
-- idempotency guarantee: a backfill or a trigger firing twice for the
-- same reservation can never produce two rows.
--
-- TL / TRY NORMALIZATION — WITHIN THIS TABLE ONLY
-- ─────────────────────────────────────────────────────────────
-- Phase 0 found that Civitatis's own email text for a Turkish-Lira Net
-- price is parsed and stored VERBATIM as the literal string 'TL' in
-- reservations.currency/retail_currency (api/_civitatis/parser.js),
-- while every manually-created reservation uses the ISO code 'TRY'.
-- 'TL' and 'TRY' are the same real currency with no conversion between
-- them (rate = 1). This migration's helper function normalizes 'TL' to
-- 'TRY' ONLY inside civitatis_settlement_items.original_currency — it
-- never rewrites reservations.currency/retail_currency itself (the
-- reservation remains the immutable source record, exactly as
-- instructed). Every other currency (EUR, USD, GBP, and the ISO 'TRY'
-- itself) passes through unchanged into original_currency.
--
-- AUTOMATIC CREATION — DATABASE TRIGGER, NOT A REACT COMPONENT
-- ─────────────────────────────────────────────────────────────
-- fn_ensure_civitatis_settlement_item(uuid) contains the ONE copy of the
-- eligibility/period/normalization logic. It is called from:
--   (a) the backfill statement at the bottom of this file (once, for
--       every currently-eligible existing reservation), and
--   (b) trg_civitatis_settlement_on_reservation_change, AFTER INSERT OR
--       UPDATE ON reservations, for every future completion — from ANY
--       caller (the existing Civitatis RPCs, a manual status edit in
--       the CRM, or any future interface), because a database trigger
--       fires regardless of which code path performed the UPDATE. This
--       is the "prefer server-side/database-level enforcement" the
--       brief asks for, and it is why this migration never needs to
--       touch ingest_civitatis_booking's own body at all.
-- A second small function, fn_cancel_civitatis_settlement_item_if_exists,
-- handles the corrective direction: if a reservation that already has a
-- settlement item is later cancelled, that item's status moves to
-- 'cancelled' (never deleted, and never touched if it is already
-- 'paid' — a paid settlement is a closed historical fact that a later
-- reservation-side correction must not silently erase; a real
-- post-payment correction is an 'adjusted' state, a deliberate human
-- action reserved for Phase 2, not something this trigger invents).
-- ============================================================


BEGIN;


-- ──────────────────────────────────────────────────────────────────────────
-- TABLE: civitatis_settlement_items
-- One row per Civitatis reservation that has become eligible for
-- settlement (see fn_ensure_civitatis_settlement_item for the exact
-- eligibility rule). Snapshots the reservation's own total_amount/
-- currency at the moment of completion — never retail_amount/
-- retail_currency (Dese Tour's receivable is the Net price Civitatis
-- owes, never the traveler-facing Retail price).
-- ──────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.civitatis_settlement_items (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  reservation_id      UUID        NOT NULL UNIQUE REFERENCES public.reservations(id) ON DELETE RESTRICT,
  settlement_period   DATE        NOT NULL,  -- first day of the month reservations.check_in falls in
  original_amount     NUMERIC(12,2) NOT NULL CHECK (original_amount > 0),
  original_currency   TEXT        NOT NULL,  -- snapshot of reservations.currency, with 'TL' normalized to 'TRY'
  claimable_at        DATE        NOT NULL,  -- first day of the month AFTER settlement_period
  status              TEXT        NOT NULL DEFAULT 'accrued'
                                   CHECK (status IN ('accrued','claimable','requested','paid','adjusted','cancelled')),
  -- Historical/frozen conversion — deliberately NULL until a later phase
  -- (Phase 2's "mark as paid", or an explicit finalization step) snapshots
  -- the actual rate used, so it never silently drifts as FX rates move.
  -- The LIVE homepage estimate in Phase 1 computes its own TRY value at
  -- read time from the exchange_rates cache and never writes it here.
  exchange_rate_used  NUMERIC,
  exchange_rate_date  DATE,
  try_amount          NUMERIC(12,2),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- A frozen conversion must carry both its rate and the amount it
  -- produced together, or neither — never a try_amount with no recorded
  -- rate behind it (which would be an unauditable number) and never a
  -- recorded rate with no resulting amount.
  CONSTRAINT civitatis_settlement_items_try_amount_pair CHECK (
    (try_amount IS NULL AND exchange_rate_used IS NULL)
    OR (try_amount IS NOT NULL AND exchange_rate_used IS NOT NULL)
  )
);

COMMENT ON TABLE  public.civitatis_settlement_items IS 'Dese Tour''s Civitatis receivable, one row per eligible completed reservation. Additive to the existing payments architecture — never a replacement for it, never written to by the Civitatis ingestion RPCs directly.';
COMMENT ON COLUMN public.civitatis_settlement_items.original_amount   IS 'Snapshot of reservations.total_amount (Dese Tour''s own Net-price receivable) at the moment this item was created. Never retail_amount.';
COMMENT ON COLUMN public.civitatis_settlement_items.original_currency IS 'Snapshot of reservations.currency, with the literal Civitatis-parser string ''TL'' normalized to the ISO code ''TRY''. Every other currency passes through unchanged.';
COMMENT ON COLUMN public.civitatis_settlement_items.settlement_period IS 'First day of the calendar month reservations.check_in falls in — the tour date, never completed_at.';
COMMENT ON COLUMN public.civitatis_settlement_items.claimable_at      IS 'First day of the month immediately after settlement_period.';
COMMENT ON COLUMN public.civitatis_settlement_items.status            IS 'Stored state. accrued -> claimable is a pure function of claimable_at vs. today and is derived at read time, never by a scheduled job (see fn application-layer helper). requested/paid/adjusted/cancelled are explicit human actions.';
COMMENT ON COLUMN public.civitatis_settlement_items.try_amount        IS 'Frozen TRY conversion, set once (Phase 2 "mark as paid" or an explicit finalization step) — never recomputed as rates move. NULL means not yet finalized; the live homepage estimate computes its own value separately and never writes it here.';

CREATE INDEX IF NOT EXISTS idx_civitatis_settlement_items_period ON public.civitatis_settlement_items(settlement_period);
CREATE INDEX IF NOT EXISTS idx_civitatis_settlement_items_status ON public.civitatis_settlement_items(status);
CREATE INDEX IF NOT EXISTS idx_civitatis_settlement_items_claimable_at ON public.civitatis_settlement_items(claimable_at);

DROP TRIGGER IF EXISTS trg_civitatis_settlement_items_updated_at ON public.civitatis_settlement_items;
CREATE TRIGGER trg_civitatis_settlement_items_updated_at
  BEFORE UPDATE ON public.civitatis_settlement_items
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.civitatis_settlement_items ENABLE ROW LEVEL SECURITY;

-- Same "admin + operations manage, nobody else" shape as
-- reservation_preparations — settlement state is operational/financial
-- logistics, not sales- or guide-facing information. No row in this
-- table is ever written by anonymous/public access; only the
-- authenticated admin/operations roles (and the service_role key used
-- server-side by the trigger/backfill, which bypasses RLS by design).
DROP POLICY IF EXISTS "civitatis_settlement_items: admin full access" ON public.civitatis_settlement_items;
CREATE POLICY "civitatis_settlement_items: admin full access"
  ON public.civitatis_settlement_items FOR ALL TO authenticated
  USING   ( is_admin() )
  WITH CHECK ( is_admin() );

DROP POLICY IF EXISTS "civitatis_settlement_items: operations full access" ON public.civitatis_settlement_items;
CREATE POLICY "civitatis_settlement_items: operations full access"
  ON public.civitatis_settlement_items FOR ALL TO authenticated
  USING   ( is_operations() )
  WITH CHECK ( is_operations() );


-- ──────────────────────────────────────────────────────────────────────────
-- TABLE: exchange_rates
-- Daily cache of reference FX rates, fetched server-side (see
-- api/cron-fetch-exchange-rates.js) from the European Central Bank's
-- published reference feed. Never written from the browser — no
-- authenticated-role INSERT/UPDATE policy exists below; only the
-- service_role key (used exclusively by the server-side cron function)
-- can write, which bypasses RLS entirely by Supabase design, the exact
-- same boundary api/_civitatis/supabaseAdmin.js already establishes.
-- ──────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.exchange_rates (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  rate_date       DATE        NOT NULL,
  base_currency   TEXT        NOT NULL,
  quote_currency  TEXT        NOT NULL,
  rate            NUMERIC     NOT NULL CHECK (rate > 0),
  source          TEXT        NOT NULL DEFAULT 'ECB',
  fetched_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT exchange_rates_date_base_quote_key UNIQUE (rate_date, base_currency, quote_currency)
);

COMMENT ON TABLE  public.exchange_rates IS 'Daily cached FX reference rates (ECB). base_currency -> quote_currency, e.g. EUR -> TRY. Written only by the server-side cron function using the service_role key — never from browser code.';
COMMENT ON COLUMN public.exchange_rates.rate IS 'Multiply 1 unit of base_currency by this to get quote_currency, e.g. base=EUR, quote=TRY, rate=35.2 means 1 EUR = 35.2 TRY.';

CREATE INDEX IF NOT EXISTS idx_exchange_rates_pair_date ON public.exchange_rates(base_currency, quote_currency, rate_date DESC);

ALTER TABLE public.exchange_rates ENABLE ROW LEVEL SECURITY;

-- Read-only reference data for every authenticated staff member — no
-- sensitivity concern (a public FX rate), and several future surfaces
-- (homepage card, future Reports fix, future Payments page) will all
-- need to read it. No INSERT/UPDATE/DELETE policy for `authenticated`
-- at all — the only write path is the service_role key, which bypasses
-- RLS by design and therefore needs no policy of its own.
DROP POLICY IF EXISTS "exchange_rates: authenticated staff can read" ON public.exchange_rates;
CREATE POLICY "exchange_rates: authenticated staff can read"
  ON public.exchange_rates FOR SELECT TO authenticated
  USING ( TRUE );


-- ──────────────────────────────────────────────────────────────────────────
-- FUNCTION: fn_ensure_civitatis_settlement_item
-- The ONE copy of the eligibility + period + currency-normalization
-- logic. Called by the backfill statement below and by the trigger
-- further down — never duplicated. SECURITY DEFINER so it can run from
-- the trigger regardless of which role performed the UPDATE that fired
-- it (same reasoning as this project's other SECURITY DEFINER helpers
-- in supabase_rls_policies.sql), with search_path pinned to public.
--
-- PHASE 1.2 HARDENING: eligibility now ALSO requires check_in IS NOT
-- NULL (computing settlement_period/claimable_at from a NULL check_in
-- would produce NULL values that violate this table's own NOT NULL
-- columns, raising an exception INSIDE the caller's own reservation
-- UPDATE — this guard returns NULL, no-op, before that can ever
-- happen) and treats a blank/whitespace-only currency the same as NULL
-- (never lets an empty string reach original_currency).
-- ──────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.fn_ensure_civitatis_settlement_item(p_reservation_id UUID)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_res             RECORD;
  v_is_civitatis    BOOLEAN;
  v_norm_currency   TEXT;
  v_settlement_period DATE;
  v_claimable_at    DATE;
  v_new_id          UUID;
BEGIN
  SELECT r.id, r.status, r.total_amount, r.currency, r.check_in, r.source_id, r.reservation_number
    INTO v_res
    FROM public.reservations r
   WHERE r.id = p_reservation_id;

  IF v_res IS NULL THEN
    RETURN NULL;
  END IF;

  -- Eligibility (Phase 1 brief, section 2; hardened in Phase 1.2):
  -- source = Civitatis, status = completed (status itself already
  -- excludes cancelled — the CHECK on reservations.status only allows
  -- one value at a time, so a completed reservation is, by
  -- construction, not a cancelled one), total_amount > 0, currency
  -- known (NOT NULL and not blank/whitespace-only), AND check_in known
  -- (NOT NULL — settlement_period/claimable_at are both derived from
  -- it below and are NOT NULL columns on this table; a NULL check_in
  -- must never reach that computation). Never eligible from check_in
  -- alone — a past tour date with no completed status creates nothing.
  SELECT EXISTS (
    SELECT 1 FROM public.sources s WHERE s.id = v_res.source_id AND s.slug = 'civitatis'
  ) INTO v_is_civitatis;

  IF NOT v_is_civitatis
     OR v_res.status IS DISTINCT FROM 'completed'
     OR v_res.total_amount IS NULL
     OR v_res.total_amount <= 0
     OR v_res.currency IS NULL
     OR btrim(v_res.currency) = ''
     OR v_res.check_in IS NULL
  THEN
    RETURN NULL;
  END IF;

  -- TL/TRY normalization — see migration header. Every other currency
  -- (including the ISO 'TRY' itself) passes through unchanged.
  v_norm_currency := CASE WHEN v_res.currency = 'TL' THEN 'TRY' ELSE v_res.currency END;

  -- Settlement period = the tour date's own calendar month (check_in),
  -- NEVER completed_at — an operator might mark a tour completed days
  -- after it actually happened; the settlement month must not shift
  -- because of that administrative delay. check_in is guaranteed
  -- NOT NULL at this point by the eligibility guard above.
  v_settlement_period := date_trunc('month', v_res.check_in)::DATE;
  v_claimable_at       := (date_trunc('month', v_res.check_in) + INTERVAL '1 month')::DATE;

  INSERT INTO public.civitatis_settlement_items (
    reservation_id, settlement_period, original_amount, original_currency,
    claimable_at, status
  ) VALUES (
    v_res.id, v_settlement_period, v_res.total_amount, v_norm_currency,
    v_claimable_at, 'accrued'
  )
  ON CONFLICT (reservation_id) DO NOTHING
  RETURNING id INTO v_new_id;

  -- Only log (and only return a non-NULL id) when a row was actually
  -- inserted — a conflict (this reservation already has a settlement
  -- item, from an earlier backfill run or an earlier trigger fire) is a
  -- silent, correct no-op, never a duplicate log entry. entity_type
  -- 'civitatis_settlement' is this migration's own additive widening
  -- below — the same pattern 'tour_channel'/'guide_payment' etc. already
  -- established. performed_by NULL: system-generated, same convention
  -- the Civitatis tour auto-provisioning path already uses.
  IF v_new_id IS NOT NULL THEN
    INSERT INTO public.activity_logs (entity_type, entity_id, action, description, metadata, performed_by)
    VALUES (
      'civitatis_settlement', v_new_id, 'created',
      'Civitatis hakediş kalemi oluşturuldu: ' || COALESCE(v_res.reservation_number, v_res.id::TEXT) ||
        ' (' || v_res.total_amount || ' ' || v_norm_currency || ', dönem ' || to_char(v_settlement_period, 'YYYY-MM') || ')',
      jsonb_build_object(
        'reservation_id', v_res.id,
        'settlement_period', v_settlement_period,
        'original_amount', v_res.total_amount,
        'original_currency', v_norm_currency,
        'claimable_at', v_claimable_at
      ),
      NULL
    );
  END IF;

  RETURN v_new_id;
END;
$$;

COMMENT ON FUNCTION public.fn_ensure_civitatis_settlement_item(UUID) IS 'Idempotent: creates exactly one civitatis_settlement_items row for an eligible completed Civitatis reservation (status=completed, source=Civitatis, total_amount>0, currency non-blank, check_in non-null), or no-ops (returns NULL) if ineligible or already created. The one copy of this logic — called by both the one-time backfill and the ongoing trigger.';

-- PHASE 1.2 HARDENING: no direct browser-callable financial write path.
-- Only this function's owner (the role that runs this migration) and
-- the SECURITY DEFINER trigger function below (which executes under
-- that same owner's privileges) may ever call this — never the
-- anon/authenticated Supabase roles directly.
REVOKE EXECUTE ON FUNCTION public.fn_ensure_civitatis_settlement_item(UUID) FROM PUBLIC;


-- ──────────────────────────────────────────────────────────────────────────
-- FUNCTION: fn_cancel_civitatis_settlement_item_if_exists
-- Corrective direction: a reservation that already has a settlement
-- item is later cancelled (e.g. a post-completion chargeback/correction
-- recorded by staff). Moves that item to 'cancelled' — never deletes it,
-- and never touches one already 'paid' (a closed historical fact; a
-- genuine post-payment correction is a deliberate 'adjusted' action
-- reserved for a later phase, not something this trigger infers).
-- ──────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.fn_cancel_civitatis_settlement_item_if_exists(p_reservation_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_item_id UUID;
BEGIN
  UPDATE public.civitatis_settlement_items
     SET status = 'cancelled'
   WHERE reservation_id = p_reservation_id
     AND status NOT IN ('paid', 'cancelled')
  RETURNING id INTO v_item_id;

  IF v_item_id IS NOT NULL THEN
    INSERT INTO public.activity_logs (entity_type, entity_id, action, description, metadata, performed_by)
    VALUES (
      'civitatis_settlement', v_item_id, 'cancelled',
      'Civitatis hakediş kalemi iptal edildi: ilişkili rezervasyon iptal edildi',
      jsonb_build_object('reservation_id', p_reservation_id),
      NULL
    );
  END IF;
END;
$$;

COMMENT ON FUNCTION public.fn_cancel_civitatis_settlement_item_if_exists(UUID) IS 'No-op if no settlement item exists, or if it is already paid/cancelled. Never deletes a row.';

-- PHASE 1.2 HARDENING: same reasoning as fn_ensure_civitatis_settlement_item
-- above — no direct browser-callable financial write path.
REVOKE EXECUTE ON FUNCTION public.fn_cancel_civitatis_settlement_item_if_exists(UUID) FROM PUBLIC;


-- ──────────────────────────────────────────────────────────────────────────
-- TRIGGER: trg_civitatis_settlement_on_reservation_change
-- Fires on reservations, not on civitatis_settlement_items — this is the
-- "server-side/database-level enforcement" that keeps the settlement
-- system correct no matter which interface (existing RPC, manual CRM
-- edit, a future interface) performs the status change. The WHEN clause
-- keeps this a true no-op for every reservation update that isn't a
-- transition into 'completed' or 'cancelled', so ordinary reservation
-- edits (guide assignment, pickup time, etc.) never even invoke the
-- function body.
--
-- PHASE 1.2 HARDENING: now SECURITY DEFINER (it previously ran with the
-- invoking role's own privileges). This is NOT required for the trigger
-- to fire — trigger invocation itself never goes through a normal
-- EXECUTE-privilege check — it is required so that THIS function's own
-- internal PERFORM calls into fn_ensure_civitatis_settlement_item /
-- fn_cancel_civitatis_settlement_item_if_exists (both now REVOKEd from
-- PUBLIC above) keep succeeding regardless of which role's UPDATE
-- statement fired the trigger (the authenticated app role via the CRM
-- UI, the service_role key via an RPC, or any future interface).
-- ──────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.fn_trg_civitatis_settlement_on_reservation_change()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.status = 'completed' THEN
    PERFORM public.fn_ensure_civitatis_settlement_item(NEW.id);
  ELSIF NEW.status = 'cancelled' THEN
    PERFORM public.fn_cancel_civitatis_settlement_item_if_exists(NEW.id);
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_civitatis_settlement_on_reservation_change ON public.reservations;
CREATE TRIGGER trg_civitatis_settlement_on_reservation_change
  AFTER INSERT OR UPDATE OF status ON public.reservations
  FOR EACH ROW
  WHEN (NEW.status IN ('completed', 'cancelled'))
  EXECUTE FUNCTION public.fn_trg_civitatis_settlement_on_reservation_change();

COMMENT ON FUNCTION public.fn_trg_civitatis_settlement_on_reservation_change() IS 'Keeps civitatis_settlement_items correct regardless of which interface transitions a reservation to completed/cancelled. Never modifies reservations itself (RETURN NEW, no column assignment). SECURITY DEFINER so its internal calls into the two REVOKEd-from-PUBLIC helper functions keep working under any invoking role.';


-- ──────────────────────────────────────────────────────────────────────────
-- activity_logs: widen entity_type check constraint, additively, the
-- exact same way tour_channels/guides/reviews already did. Every
-- previously allowed value remains allowed; this adds exactly one new
-- value this migration's own functions use above.
-- ──────────────────────────────────────────────────────────────────────────

ALTER TABLE public.activity_logs DROP CONSTRAINT IF EXISTS activity_logs_entity_type_check;
ALTER TABLE public.activity_logs ADD CONSTRAINT activity_logs_entity_type_check
  CHECK (entity_type IN (
    'customer','lead','quote','reservation','payment',
    'task','reminder','tour','message','settings',
    'guide','guide_payment','reservation_review',
    'tour_language','tour_channel',
    'civitatis_settlement'
  ));


-- ──────────────────────────────────────────────────────────────────────────
-- BACKFILL — existing completed Civitatis reservations (Phase 1, section 7)
-- Idempotent by construction: fn_ensure_civitatis_settlement_item's own
-- ON CONFLICT (reservation_id) DO NOTHING means running this exact
-- SELECT any number of times only ever creates the rows that do not
-- already exist. Scoped to Civitatis-sourced, completed reservations
-- only — the function itself re-checks every eligibility condition
-- again defensively (including the Phase 1.2 check_in/blank-currency
-- guards), so this SELECT's own WHERE clause is a cheap pre-filter,
-- not the sole guard. Runs as whichever role executes this migration
-- file, which — as the owner of fn_ensure_civitatis_settlement_item —
-- retains EXECUTE on it regardless of the REVOKE FROM PUBLIC above.
-- ──────────────────────────────────────────────────────────────────────────

SELECT public.fn_ensure_civitatis_settlement_item(r.id)
  FROM public.reservations r
  JOIN public.sources s ON s.id = r.source_id
 WHERE s.slug = 'civitatis'
   AND r.status = 'completed';


COMMIT;


-- ============================================================
-- POST-MIGRATION READ-ONLY VERIFICATION (run AFTER the COMMIT above —
-- every statement below is a plain SELECT; none writes anything)
-- ============================================================

-- A. Object existence
SELECT
  (SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='public' AND table_name='civitatis_settlement_items') AS settlement_table_exists,
  (SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='public' AND table_name='exchange_rates') AS fx_table_exists,
  (SELECT COUNT(*) FROM pg_trigger WHERE tgname='trg_civitatis_settlement_on_reservation_change') AS trigger_exists,
  (SELECT COUNT(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='fn_ensure_civitatis_settlement_item') AS ensure_fn_exists,
  (SELECT COUNT(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='fn_cancel_civitatis_settlement_item_if_exists') AS cancel_fn_exists;

-- B. Total settlement item count
SELECT COUNT(*) AS total_settlement_items FROM public.civitatis_settlement_items;

-- C. Settlement items grouped by settlement_period and original_currency
SELECT settlement_period, original_currency, COUNT(*) AS item_count, SUM(original_amount) AS original_amount_total
  FROM public.civitatis_settlement_items
 GROUP BY settlement_period, original_currency
 ORDER BY settlement_period, original_currency;

-- D. September 2026 reconciliation, including guest counts from the
-- linked reservations (expected: 2026-09-01 / TRY / 3 / 8 / 14400.00)
SELECT
  csi.settlement_period,
  csi.original_currency,
  COUNT(*) AS reservation_count,
  SUM(r.pax_adult + r.pax_child) AS guest_count,
  SUM(csi.original_amount) AS original_amount_total
FROM public.civitatis_settlement_items csi
JOIN public.reservations r ON r.id = csi.reservation_id
WHERE csi.settlement_period = '2026-09-01'
GROUP BY csi.settlement_period, csi.original_currency;

-- E. Every September 2026 settlement item, with stored vs. effective
-- status shown side by side (effective status is derived here at read
-- time — exactly how the application layer computes it — never written
-- back to the stored column by this query or by any scheduled job).
SELECT
  r.reservation_number,
  r.external_booking_id,
  r.check_in,
  csi.original_amount,
  csi.original_currency,
  csi.claimable_at,
  csi.status AS stored_status,
  CASE
    WHEN csi.status = 'accrued' AND csi.claimable_at <= CURRENT_DATE THEN 'claimable'
    ELSE csi.status
  END AS effective_status
FROM public.civitatis_settlement_items csi
JOIN public.reservations r ON r.id = csi.reservation_id
WHERE csi.settlement_period = '2026-09-01'
ORDER BY r.check_in;

-- ============================================================
-- END OF supabase_migration_civitatis_settlement_phase1.sql
-- ============================================================
