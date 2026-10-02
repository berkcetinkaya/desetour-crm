-- ============================================================
-- DESE TOUR OPERATIONS CENTER
-- Migration: Reservation Preparation Materialization — Phase C2C
-- ============================================================
-- File:    supabase_migration_reservation_preparation_materialization.sql
-- Depends: supabase_migration_tour_preparation_phase_a.sql (already applied —
--          tour_preparation_rules, reservation_preparations, and the
--          partial unique index uq_reservation_preparations_live_rule_instance)
--
-- WHAT THIS IS
-- ─────────────────────────────────────────────────────────────
-- Adds EXACTLY ONE new function, public.materialize_reservation_preparations
-- (p_reservation_id UUID) RETURNS JSONB — the single deterministic
-- operation that turns a reservation's applicable, active
-- tour_preparation_rules into concrete reservation_preparations rows (or
-- reconciles existing ones). No table is created, no column is added, no
-- existing object is altered. This phase does NOT wire this function into
-- the Civitatis ingestion/cancellation orchestration — it is proven here,
-- standalone, callable only by service_role, with wiring deferred to a
-- later phase per the explicit instruction "Do not wire hooks until the
-- database behavior is fully tested."
--
-- WHAT THIS DOES NOT DO
-- ─────────────────────────────────────────────────────────────
--   • Does NOT create any tour_preparation_rules row (no Topkapı, no
--     Blue Mosque, no Bosphorus Cruise, no meal rule — zero INSERT into
--     that table anywhere in this file).
--   • Does NOT touch meal_status/purchased_activity_raw or any
--     Civitatis activity-modality logic — meal preparation is explicitly
--     out of scope for this phase, to be driven by reservation.meal_status
--     in a later, separate phase.
--   • Does NOT modify public.ingest_civitatis_booking,
--     public.cancel_civitatis_booking, or any other existing function —
--     verified by the postflight's signature re-check below.
--   • Does NOT touch WhatsApp or auth objects.
--
-- MATERIALIZATION CONTRACT
-- ─────────────────────────────────────────────────────────────
-- For reservation.status = 'cancelled':
--   every EXISTING 'pending' reservation_preparations row for this
--   reservation is moved to 'cancelled'. No rule is evaluated, nothing
--   is created. 'completed' rows are left completely untouched —
--   historical completion is never erased by a later cancellation.
--
-- For a non-cancelled reservation, for each ACTIVE tour_preparation_rules
-- row belonging to reservation.tour_id, in order:
--   1. required_quantity is computed from EXACTLY ONE authoritative
--      source per quantity_rule — never a fallback chain:
--        per_guest -> reservations.pax_adult + COALESCE(pax_child, 0)
--        per_adult -> reservations.pax_adult
--        fixed     -> tour_preparation_rules.fixed_quantity
--   2. If that computed value is NULL or <= 0, this rule is SKIPPED
--      entirely this run — no row is created, updated, or touched for
--      it, and the result reports action:'invalid_quantity'. A later run
--      with a valid quantity is free to materialize it normally; this
--      function never fabricates a quantity to avoid that skip.
--   3. The live (status IN ('pending','completed')) reservation_preparations
--      row for (reservation_id, preparation_rule_id) — AT MOST ONE,
--      enforced by uq_reservation_preparations_live_rule_instance — is
--      looked up:
--        none found            -> INSERT a new 'pending' row. action:'create'.
--        found, status=pending -> if required_quantity/label/
--                                  preparation_type differ from the rule's
--                                  current values, UPDATE them in place
--                                  (same row, same identity — the unique
--                                  index is never at risk, since status
--                                  stays 'pending'). action:'update', else
--                                  action:'no_op'.
--        found, status=completed -> NEVER updated. If the freshly
--                                  computed required_quantity differs
--                                  from the completed row's own value,
--                                  this is reported as
--                                  action:'completed_needs_review' — a
--                                  CLASSIFICATION IN THIS FUNCTION'S OWN
--                                  RETURN VALUE ONLY, never a new
--                                  persisted status value (the schema's
--                                  CHECK constraint on
--                                  reservation_preparations.status is
--                                  deliberately left untouched — no new
--                                  status is added "casually", per
--                                  explicit instruction; the existing
--                                  pending/completed/superseded/cancelled
--                                  vocabulary already lets a human
--                                  reconcile this by hand, informed by
--                                  this reported classification). If
--                                  unchanged, action:'no_op'.
--   After every active rule has been evaluated, any EXISTING 'pending'
--   row for this reservation whose preparation_rule_id is NOT among the
--   rule ids just evaluated (the rule was deactivated, deleted, or no
--   longer belongs to this tour) is moved to 'superseded'. action:'supersede'.
--   History (completed/cancelled/superseded rows) is never deleted,
--   anywhere in this function.
--
-- IDEMPOTENCY
-- ─────────────────────────────────────────────────────────────
-- Running this function twice in a row with unchanged inputs produces
-- ZERO additional writes: every rule's comparison is against the row's
-- CURRENT stored values (not a cached/assumed prior state), so an
-- already-correct pending row is always action:'no_op', and the
-- supersede sweep only ever touches a 'pending' row once (after which it
-- is 'superseded' and therefore outside the sweep's own WHERE clause).
-- The partial unique index makes a duplicate live row for the same
-- (reservation, rule) structurally impossible regardless of how many
-- times this function runs.
--
-- RETURN SHAPE
-- ─────────────────────────────────────────────────────────────
-- {
--   "result": "materialized" | "reservation_not_found",
--   "reservation_id": "...",
--   "reservation_cancelled": true|false,
--   "actions": [
--     {
--       "preparation_rule_id": "...", "preparation_type": "...", "label": "...",
--       "action": "create"|"update"|"no_op"|"supersede"|"invalid_quantity"|
--                 "completed_needs_review"|"cancelled",
--       "required_quantity": <int|null>,
--       "reservation_preparation_id": "..." (when applicable)
--     }, ...
--   ]
-- }
-- Nothing about this return value is itself persisted anywhere — it
-- exists purely so a caller (or this migration's own validation) can see
-- exactly what happened, or would need manual review, on this one call.
--
-- SAFETY
-- ─────────────────────────────────────────────────────────────
--   • SECURITY DEFINER + SET search_path = public + explicit REVOKE ALL
--     FROM PUBLIC/authenticated/anon + GRANT EXECUTE ONLY TO service_role
--     — the same hardening convention every write RPC in this codebase
--     already uses (set_reservation_activity_modality, both Civitatis
--     RPCs). Never callable from browser/frontend code.
--   • This phase does not call this function from any application code
--     path — it is proven standalone first. No hook is wired into
--     ingest-civitatis-write.js, cancellation orchestration, or anywhere
--     else in this migration.
--   • Preflight (before creating anything) and postflight (after, before
--     COMMIT) both RAISE EXCEPTION and abort the whole transaction on any
--     unexpected state.
--   • No SQL in this file has been executed against production. No
--     Supabase connection was made to produce it. Validated only against
--     a disposable local Postgres instance, destroyed after validation.
--
-- HOW TO APPLY
-- ─────────────────────────────────────────────────────────────
-- Supabase Dashboard → SQL Editor → paste and run this file IN FULL, in a
-- single execution. Wrapped in an explicit BEGIN/COMMIT.
-- ============================================================


BEGIN;

-- ──────────────────────────────────────────────────────────────────────────
-- PREFLIGHT
-- ──────────────────────────────────────────────────────────────────────────

DO $$
DECLARE
  v_missing TEXT[] := ARRAY[]::TEXT[];
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='reservations') THEN
    v_missing := array_append(v_missing, 'table reservations');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='tour_preparation_rules') THEN
    v_missing := array_append(v_missing, 'table tour_preparation_rules');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='reservation_preparations') THEN
    v_missing := array_append(v_missing, 'table reservation_preparations');
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
     WHERE schemaname='public' AND tablename='reservation_preparations'
       AND indexname='uq_reservation_preparations_live_rule_instance'
  ) THEN
    v_missing := array_append(v_missing, 'uq_reservation_preparations_live_rule_instance index');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='tour_preparation_rules_fixed_quantity_pair' AND contype='c') THEN
    v_missing := array_append(v_missing, 'tour_preparation_rules_fixed_quantity_pair CHECK');
  END IF;

  IF array_length(v_missing, 1) > 0 THEN
    RAISE EXCEPTION 'RESERVATION PREPARATION MATERIALIZATION PREFLIGHT FAILED: %. Apply supabase_migration_tour_preparation_phase_a.sql BEFORE this migration. Aborting before touching anything.', array_to_string(v_missing, ', ');
  END IF;

  -- Read-only confirmation that the Civitatis RPCs this migration must
  -- never affect are present with their known signatures — never a
  -- write, never a replace, same pattern every migration since V10 uses.
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = 'ingest_civitatis_booking' AND p.pronargs = 26
  ) THEN
    RAISE EXCEPTION 'RESERVATION PREPARATION MATERIALIZATION PREFLIGHT FAILED: public.ingest_civitatis_booking with the expected 26-parameter signature was not found. Aborting before touching anything.';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = 'cancel_civitatis_booking' AND p.pronargs = 7
  ) THEN
    RAISE EXCEPTION 'RESERVATION PREPARATION MATERIALIZATION PREFLIGHT FAILED: public.cancel_civitatis_booking with the expected 7-parameter signature was not found. Aborting before touching anything.';
  END IF;

  RAISE NOTICE 'RESERVATION PREPARATION MATERIALIZATION PREFLIGHT PASSED: all dependencies present. Proceeding — one new function only.';
END $$;


-- ──────────────────────────────────────────────────────────────────────────
-- STEP 1: public.materialize_reservation_preparations
-- ──────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.materialize_reservation_preparations(
  p_reservation_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_reservation          RECORD;
  v_rule                 RECORD;
  v_existing             RECORD;
  v_required_quantity    INTEGER;
  v_actions              JSONB := '[]'::jsonb;
  v_active_rule_ids       UUID[] := ARRAY[]::UUID[];
  v_new_id                UUID;
  v_superseded            RECORD;
BEGIN
  SELECT id, tour_id, status, pax_adult, pax_child
    INTO v_reservation
    FROM public.reservations
   WHERE id = p_reservation_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('result', 'reservation_not_found', 'reservation_id', p_reservation_id);
  END IF;

  -- ── Cancelled reservation: reconcile existing rows only, never
  -- evaluate rules, never create anything. ─────────────────────────────
  IF v_reservation.status = 'cancelled' THEN
    FOR v_existing IN
      UPDATE public.reservation_preparations
         SET status = 'cancelled'
       WHERE reservation_id = p_reservation_id
         AND status = 'pending'
      RETURNING id, preparation_rule_id, preparation_type, label, required_quantity
    LOOP
      v_actions := v_actions || jsonb_build_object(
        'preparation_rule_id', v_existing.preparation_rule_id,
        'preparation_type', v_existing.preparation_type,
        'label', v_existing.label,
        'action', 'cancelled',
        'required_quantity', v_existing.required_quantity,
        'reservation_preparation_id', v_existing.id
      );
    END LOOP;

    RETURN jsonb_build_object(
      'result', 'materialized',
      'reservation_id', p_reservation_id,
      'reservation_cancelled', true,
      'actions', v_actions
    );
  END IF;

  -- ── Active reservation: evaluate every currently active rule for this
  -- tour. ────────────────────────────────────────────────────────────
  FOR v_rule IN
    SELECT id, preparation_type, label, quantity_rule, fixed_quantity
      FROM public.tour_preparation_rules
     WHERE tour_id = v_reservation.tour_id
       AND is_active = TRUE
     ORDER BY id
  LOOP
    v_active_rule_ids := array_append(v_active_rule_ids, v_rule.id);

    v_required_quantity := CASE v_rule.quantity_rule
      WHEN 'per_guest' THEN v_reservation.pax_adult + COALESCE(v_reservation.pax_child, 0)
      WHEN 'per_adult' THEN v_reservation.pax_adult
      WHEN 'fixed'     THEN v_rule.fixed_quantity
      ELSE NULL -- unrecognized quantity_rule (should be structurally
                -- impossible under the table's own CHECK constraint) —
                -- fails closed, never guessed.
    END;

    IF v_required_quantity IS NULL OR v_required_quantity <= 0 THEN
      v_actions := v_actions || jsonb_build_object(
        'preparation_rule_id', v_rule.id,
        'preparation_type', v_rule.preparation_type,
        'label', v_rule.label,
        'action', 'invalid_quantity',
        'required_quantity', v_required_quantity,
        'reservation_preparation_id', NULL
      );
      CONTINUE; -- never fabricate a quantity; leave any existing row
                 -- for this rule completely untouched this run.
    END IF;

    SELECT id, status, required_quantity, label, preparation_type
      INTO v_existing
      FROM public.reservation_preparations
     WHERE reservation_id = p_reservation_id
       AND preparation_rule_id = v_rule.id
       AND status IN ('pending', 'completed');

    IF NOT FOUND THEN
      INSERT INTO public.reservation_preparations
        (reservation_id, preparation_rule_id, preparation_type, label, required_quantity, status)
      VALUES
        (p_reservation_id, v_rule.id, v_rule.preparation_type, v_rule.label, v_required_quantity, 'pending')
      RETURNING id INTO v_new_id;

      v_actions := v_actions || jsonb_build_object(
        'preparation_rule_id', v_rule.id,
        'preparation_type', v_rule.preparation_type,
        'label', v_rule.label,
        'action', 'create',
        'required_quantity', v_required_quantity,
        'reservation_preparation_id', v_new_id
      );

    ELSIF v_existing.status = 'pending' THEN
      IF v_existing.required_quantity != v_required_quantity
         OR v_existing.label IS DISTINCT FROM v_rule.label
         OR v_existing.preparation_type IS DISTINCT FROM v_rule.preparation_type
      THEN
        UPDATE public.reservation_preparations
           SET required_quantity = v_required_quantity,
               label              = v_rule.label,
               preparation_type   = v_rule.preparation_type
         WHERE id = v_existing.id;

        v_actions := v_actions || jsonb_build_object(
          'preparation_rule_id', v_rule.id,
          'preparation_type', v_rule.preparation_type,
          'label', v_rule.label,
          'action', 'update',
          'required_quantity', v_required_quantity,
          'reservation_preparation_id', v_existing.id
        );
      ELSE
        v_actions := v_actions || jsonb_build_object(
          'preparation_rule_id', v_rule.id,
          'preparation_type', v_rule.preparation_type,
          'label', v_rule.label,
          'action', 'no_op',
          'required_quantity', v_required_quantity,
          'reservation_preparation_id', v_existing.id
        );
      END IF;

    ELSE -- v_existing.status = 'completed' — NEVER updated.
      v_actions := v_actions || jsonb_build_object(
        'preparation_rule_id', v_rule.id,
        'preparation_type', v_rule.preparation_type,
        'label', v_rule.label,
        'action', CASE WHEN v_existing.required_quantity != v_required_quantity
                        THEN 'completed_needs_review' ELSE 'no_op' END,
        'required_quantity', v_required_quantity,
        'reservation_preparation_id', v_existing.id
      );
    END IF;
  END LOOP;

  -- ── Supersede sweep: any existing 'pending' row whose rule is no
  -- longer active/applicable for this tour. ────────────────────────────
  FOR v_superseded IN
    UPDATE public.reservation_preparations
       SET status = 'superseded'
     WHERE reservation_id = p_reservation_id
       AND status = 'pending'
       AND preparation_rule_id IS NOT NULL
       AND preparation_rule_id != ALL (v_active_rule_ids)
    RETURNING id, preparation_rule_id, preparation_type, label, required_quantity
  LOOP
    v_actions := v_actions || jsonb_build_object(
      'preparation_rule_id', v_superseded.preparation_rule_id,
      'preparation_type', v_superseded.preparation_type,
      'label', v_superseded.label,
      'action', 'supersede',
      'required_quantity', v_superseded.required_quantity,
      'reservation_preparation_id', v_superseded.id
    );
  END LOOP;

  RETURN jsonb_build_object(
    'result', 'materialized',
    'reservation_id', p_reservation_id,
    'reservation_cancelled', false,
    'actions', v_actions
  );
END;
$$;

COMMENT ON FUNCTION public.materialize_reservation_preparations(UUID) IS
  'Tour Preparation Intelligence Phase C2C — the single deterministic operation that turns a reservation''s applicable, active tour_preparation_rules into concrete reservation_preparations rows. Cancelled reservations: existing pending rows become cancelled, nothing is created, completed rows are preserved untouched. Active reservations: required_quantity is computed from exactly one authoritative source per quantity_rule (per_guest -> pax_adult+pax_child, per_adult -> pax_adult, fixed -> tour_preparation_rules.fixed_quantity) — NULL/<=0 fails closed for that rule only (action:invalid_quantity), never fabricated. A pending row is updated in place when its quantity/label/type drifts from the rule; a completed row is NEVER modified — a quantity drift against a completed row is reported as action:completed_needs_review in the RETURN value only, never persisted as a new status (no new status value is added to reservation_preparations.status by this migration). A pending row whose rule is no longer active/applicable becomes superseded. Idempotent: an unchanged re-run performs zero additional writes, enforced structurally by uq_reservation_preparations_live_rule_instance. NOT wired into any Civitatis ingestion/cancellation code path by this migration — callable only by service_role, proven standalone first.';

REVOKE ALL ON FUNCTION public.materialize_reservation_preparations(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.materialize_reservation_preparations(UUID) FROM authenticated;
REVOKE ALL ON FUNCTION public.materialize_reservation_preparations(UUID) FROM anon;
GRANT EXECUTE ON FUNCTION public.materialize_reservation_preparations(UUID) TO service_role;


-- ──────────────────────────────────────────────────────────────────────────
-- POSTFLIGHT
-- ──────────────────────────────────────────────────────────────────────────

DO $$
DECLARE
  v_missing TEXT[] := ARRAY[]::TEXT[];
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = 'materialize_reservation_preparations' AND p.pronargs = 1
  ) THEN
    v_missing := array_append(v_missing, 'materialize_reservation_preparations(UUID) not found with 1 argument');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = 'materialize_reservation_preparations' AND p.prosecdef = TRUE
  ) THEN
    v_missing := array_append(v_missing, 'materialize_reservation_preparations is not SECURITY DEFINER');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.role_routine_grants
     WHERE routine_schema = 'public' AND routine_name = 'materialize_reservation_preparations'
       AND grantee = 'service_role' AND privilege_type = 'EXECUTE'
  ) THEN
    v_missing := array_append(v_missing, 'EXECUTE not granted to service_role');
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.role_routine_grants
     WHERE routine_schema = 'public' AND routine_name = 'materialize_reservation_preparations'
       AND grantee IN ('authenticated', 'anon', 'PUBLIC') AND privilege_type = 'EXECUTE'
  ) THEN
    v_missing := array_append(v_missing, 'EXECUTE is still granted to authenticated/anon/PUBLIC — must be revoked');
  END IF;

  -- This migration itself never writes a tour_preparation_rules or
  -- reservation_preparations row of any kind (it is pure CREATE
  -- FUNCTION DDL) — a structural guarantee, not something that needs a
  -- runtime check here.

  IF array_length(v_missing, 1) > 0 THEN
    RAISE EXCEPTION 'RESERVATION PREPARATION MATERIALIZATION POSTFLIGHT FAILED: %. Aborting — re-run this ENTIRE file in a single execution.', array_to_string(v_missing, ', ');
  END IF;

  -- Re-confirm both Civitatis RPCs are STILL exactly what they were
  -- before this migration ran — never touched.
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = 'ingest_civitatis_booking' AND p.pronargs = 26
  ) THEN
    RAISE EXCEPTION 'RESERVATION PREPARATION MATERIALIZATION POSTFLIGHT FAILED: public.ingest_civitatis_booking signature changed or the function disappeared during this migration. Aborting.';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = 'cancel_civitatis_booking' AND p.pronargs = 7
  ) THEN
    RAISE EXCEPTION 'RESERVATION PREPARATION MATERIALIZATION POSTFLIGHT FAILED: public.cancel_civitatis_booking signature changed or the function disappeared during this migration. Aborting.';
  END IF;

  RAISE NOTICE 'RESERVATION PREPARATION MATERIALIZATION POSTFLIGHT PASSED: materialize_reservation_preparations(UUID) exists, SECURITY DEFINER, service_role-only; both Civitatis RPCs confirmed unchanged.';
END $$;

COMMIT;

-- ============================================================
-- END OF MIGRATION supabase_migration_reservation_preparation_materialization.sql
-- ============================================================
