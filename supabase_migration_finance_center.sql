-- ============================================================
-- DESE TOUR OPERATIONS CENTER
-- Migration: Finance Center — Phase C (cost catalog + actual expenses)
-- ============================================================
-- File:    supabase_migration_finance_center.sql
-- Rollback: supabase_migration_finance_center_ROLLBACK.sql
-- Depends: supabase_schema.sql, supabase_rls_policies.sql,
--          supabase_migration_guides.sql (guide_payments),
--          supabase_migration_tour_preparation_phase_a.sql
--          (tour_preparation_rules), supabase_migration_civitatis_settlement_phase1.sql
--          (exchange_rates), supabase_migration_aal2_enforcement.sql (is_aal2),
--          supabase_migration_agency_mailbox.sql (latest activity_logs
--          entity_type CHECK) — all already applied.
-- Version: Finance Center Phase C — NOT YET APPROVED FOR PRODUCTION.
--
-- WHAT THIS DOES
-- ─────────────────────────────────────────────────────────────
--   1. public.finance_cost_items — a small, auditable cost catalog.
--      kind='internal' rows drive Finance forecasts; kind='public_reference'
--      rows are reference information ONLY and are never read by any
--      calculation (enforced in the single Finance calculation layer and
--      by the structural CHECKs below). Nothing ever overwrites an
--      internal row from a reference row.
--   2. public.reservation_expenses — ACTUAL non-guide operating expenses
--      (ticket / meal / transport / other). Guide actual cost is NOT
--      storable here: the category CHECK structurally excludes 'guide';
--      public.guide_payments stays the one actual-guide-cost ledger.
--   3. Historical FX freezing for reservation_expenses: a BEFORE trigger
--      writes exchange_rate_used / exchange_rate_date / try_amount as one
--      coherent set from public.exchange_rates at record time (same
--      auditability philosophy as civitatis_settlement_items). Client-
--      supplied values for those three columns are always ignored, and
--      they are recomputed ONLY when the amount, currency or expense date
--      itself changes — never because today's ECB rate moved.
--   4. RLS mirroring public.guide_payments: admin and operations full
--      access, both requiring is_aal2(); sales and guide get nothing.
--   5. activity_logs entity_type CHECK widened by exactly two values
--      ('finance_cost_item', 'reservation_expense'), after verifying that
--      the live constraint contains no value this list would drop.
--   6. INTERNAL planning seeds: Guide Service €150 per guide-service group
--      (global), Included Meal €10 per guest (global). The Topkapı €40
--      item is seeded by supabase_migration_finance_topkapi_rule.sql,
--      because it is linked to that migration's preparation rule.
--
-- WHAT THIS DOES NOT DO
-- ─────────────────────────────────────────────────────────────
--   • Does NOT touch payments, guide_payments, civitatis_settlement_items,
--     reservations, reservation_preparations or exchange_rates data.
--   • Does NOT create a guide-service table: guide services are derived
--     deterministically from reservations (check_in + tour_id + language).
--   • Does NOT seed any price that was not explicitly approved (Hagia
--     Sophia, Bosphorus cruise, tea, … stay "Maliyet girilmemiş").
-- ============================================================

BEGIN;

-- ──────────────────────────────────────────────────────────────────────────
-- PREFLIGHT
-- ──────────────────────────────────────────────────────────────────────────
DO $$
DECLARE v_missing TEXT[] := ARRAY[]::TEXT[];
BEGIN
  IF to_regclass('public.reservations') IS NULL THEN v_missing := v_missing || 'public.reservations'; END IF;
  IF to_regclass('public.tours') IS NULL THEN v_missing := v_missing || 'public.tours'; END IF;
  IF to_regclass('public.tour_preparation_rules') IS NULL THEN v_missing := v_missing || 'public.tour_preparation_rules'; END IF;
  IF to_regclass('public.exchange_rates') IS NULL THEN v_missing := v_missing || 'public.exchange_rates'; END IF;
  IF to_regclass('public.guide_payments') IS NULL THEN v_missing := v_missing || 'public.guide_payments'; END IF;
  IF to_regclass('public.staff_users') IS NULL THEN v_missing := v_missing || 'public.staff_users'; END IF;
  IF to_regprocedure('public.is_aal2()') IS NULL THEN v_missing := v_missing || 'public.is_aal2()'; END IF;
  IF to_regprocedure('public.is_admin()') IS NULL THEN v_missing := v_missing || 'public.is_admin()'; END IF;
  IF to_regprocedure('public.is_operations()') IS NULL THEN v_missing := v_missing || 'public.is_operations()'; END IF;
  IF to_regprocedure('public.set_updated_at()') IS NULL THEN v_missing := v_missing || 'public.set_updated_at()'; END IF;
  IF array_length(v_missing, 1) > 0 THEN
    RAISE EXCEPTION 'FINANCE CENTER MIGRATION PREFLIGHT FAILED: missing %. Aborting before touching anything.', array_to_string(v_missing, ', ');
  END IF;
END $$;

-- ──────────────────────────────────────────────────────────────────────────
-- TABLE: finance_cost_items — the cost catalog
-- ──────────────────────────────────────────────────────────────────────────
-- basis semantics (the ONLY quantity rules Finance knows):
--   per_guest             amount × (pax_adult + pax_child) of the reservation
--   per_adult             amount × pax_adult
--   fixed_per_reservation amount × 1 per active reservation
--   fixed                 amount × 1 per operational group (date + tour + language)
--   preparation_rule      amount × reservation_preparations.required_quantity
--                         materialized from the linked tour_preparation_rules row
--                         (Finance never recomputes that quantity itself)
--   guide_service_group   amount × 1 per unique guide service
--                         (check_in + tour_id + normalized booking language)
CREATE TABLE IF NOT EXISTS public.finance_cost_items (
  id                   UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  label                TEXT        NOT NULL CHECK (btrim(label) <> ''),
  category             TEXT        NOT NULL CHECK (category IN ('ticket','guide','meal','transport','other')),
  basis                TEXT        NOT NULL CHECK (basis IN ('per_guest','per_adult','fixed_per_reservation','fixed','preparation_rule','guide_service_group')),
  amount               NUMERIC(12,2) NOT NULL CHECK (amount >= 0),
  currency             TEXT        NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  tour_id              UUID        REFERENCES public.tours(id) ON DELETE RESTRICT,
  preparation_rule_id  UUID        REFERENCES public.tour_preparation_rules(id) ON DELETE RESTRICT,
  valid_from           DATE        NOT NULL DEFAULT CURRENT_DATE,
  valid_to             DATE,
  is_active            BOOLEAN     NOT NULL DEFAULT TRUE,
  kind                 TEXT        NOT NULL CHECK (kind IN ('internal','public_reference')),
  -- TRUE = an internal planning amount that is only a stand-in (e.g. a
  -- current public price) until a real supplier / negotiated rate is known.
  -- Finance uses it but labels it "Geçici maliyet". Only internal rows can be
  -- provisional; a public_reference row never drives Finance at all.
  is_provisional       BOOLEAN     NOT NULL DEFAULT FALSE,
  source_note          TEXT        NOT NULL DEFAULT '',
  source_url           TEXT,
  last_verified_date   DATE,
  created_by           UUID        REFERENCES public.staff_users(id) ON DELETE SET NULL,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT finance_cost_items_valid_range CHECK (valid_to IS NULL OR valid_to >= valid_from),
  -- Guide cost is ONLY ever a per-guide-service amount — never
  -- fixed_per_reservation, never per_guest — and the guide-service basis
  -- is never used for anything but guide cost.
  CONSTRAINT finance_cost_items_guide_basis CHECK ((category = 'guide') = (basis = 'guide_service_group')),
  CONSTRAINT finance_cost_items_rule_basis CHECK ((basis = 'preparation_rule') = (preparation_rule_id IS NOT NULL)),
  -- Ticket / transport / other costs must say WHAT they apply to: a tour or
  -- a preparation rule. Only guide and meal may be global defaults.
  CONSTRAINT finance_cost_items_scope CHECK (category IN ('guide','meal') OR tour_id IS NOT NULL OR preparation_rule_id IS NOT NULL),
  CONSTRAINT finance_cost_items_source_url CHECK (source_url IS NULL OR source_url ~ '^https?://'),
  CONSTRAINT finance_cost_items_provisional_internal CHECK (NOT is_provisional OR kind = 'internal'),
  -- A provisional amount must say where it came from.
  CONSTRAINT finance_cost_items_provisional_sourced CHECK (NOT is_provisional OR (btrim(source_note) <> '' AND source_url IS NOT NULL))
);

COMMENT ON TABLE public.finance_cost_items IS 'Finance cost catalog. kind=internal rows drive planning; kind=public_reference rows are reference information only and never drive any calculation or overwrite an internal row.';
COMMENT ON COLUMN public.finance_cost_items.basis IS 'per_guest | per_adult | fixed_per_reservation | fixed (once per date+tour+language group) | preparation_rule (quantity = materialized reservation_preparations.required_quantity) | guide_service_group (once per unique check_in+tour_id+language guide service).';
COMMENT ON COLUMN public.finance_cost_items.kind IS 'internal = DeseTour operating/planning cost used by Finance; public_reference = official/public price kept for reference only.';

-- One internal row per scope + start date (Finance picks the newest valid_from that covers a date).
CREATE UNIQUE INDEX IF NOT EXISTS uq_finance_cost_items_internal_scope
  ON public.finance_cost_items (category, basis,
    COALESCE(tour_id, '00000000-0000-0000-0000-000000000000'::uuid),
    COALESCE(preparation_rule_id, '00000000-0000-0000-0000-000000000000'::uuid),
    valid_from)
  WHERE kind = 'internal' AND is_active;
CREATE INDEX IF NOT EXISTS idx_finance_cost_items_tour ON public.finance_cost_items(tour_id);
CREATE INDEX IF NOT EXISTS idx_finance_cost_items_rule ON public.finance_cost_items(preparation_rule_id);

DROP TRIGGER IF EXISTS trg_finance_cost_items_updated_at ON public.finance_cost_items;
CREATE TRIGGER trg_finance_cost_items_updated_at
  BEFORE UPDATE ON public.finance_cost_items
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ──────────────────────────────────────────────────────────────────────────
-- TABLE: reservation_expenses — ACTUAL non-guide operating expenses
-- ──────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.reservation_expenses (
  id                    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  reservation_id        UUID        NOT NULL REFERENCES public.reservations(id) ON DELETE RESTRICT,
  -- 'guide' is deliberately NOT allowed: guide actual cost lives ONLY in
  -- public.guide_payments, so it can never be recorded twice.
  category              TEXT        NOT NULL CHECK (category IN ('ticket','meal','transport','other')),
  description           TEXT        NOT NULL DEFAULT '',
  quantity              NUMERIC(12,2) CHECK (quantity IS NULL OR quantity > 0),
  unit_amount           NUMERIC(12,2) CHECK (unit_amount IS NULL OR unit_amount >= 0),
  total_amount          NUMERIC(12,2) NOT NULL CHECK (total_amount > 0),
  currency              TEXT        NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  expense_date          DATE        NOT NULL,
  finance_cost_item_id  UUID        REFERENCES public.finance_cost_items(id) ON DELETE SET NULL,
  exchange_rate_used    NUMERIC(18,8),
  exchange_rate_date    DATE,
  try_amount            NUMERIC(14,2),
  notes                 TEXT        NOT NULL DEFAULT '',
  created_by            UUID        REFERENCES public.staff_users(id) ON DELETE SET NULL,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT reservation_expenses_qty_total CHECK (quantity IS NULL OR unit_amount IS NULL OR total_amount = ROUND(quantity * unit_amount, 2)),
  -- The frozen FX set is all-or-nothing (same paired-CHECK philosophy as
  -- civitatis_settlement_items), and internally consistent.
  CONSTRAINT reservation_expenses_fx_frozen_set CHECK (
    (exchange_rate_used IS NULL AND exchange_rate_date IS NULL AND try_amount IS NULL)
    OR (exchange_rate_used IS NOT NULL AND exchange_rate_used > 0 AND exchange_rate_date IS NOT NULL
        AND try_amount IS NOT NULL AND try_amount = ROUND(total_amount * exchange_rate_used, 2))
  )
);

COMMENT ON TABLE public.reservation_expenses IS 'ACTUAL non-guide operating expenses per reservation (ticket/meal/transport/other), original currency kept. Guide actual cost is never stored here — public.guide_payments is the only guide-cost ledger.';
COMMENT ON COLUMN public.reservation_expenses.try_amount IS 'Frozen TRY equivalent written by trg_reservation_expenses_freeze_fx at record time; never recomputed because today''s ECB rate changed.';

CREATE INDEX IF NOT EXISTS idx_reservation_expenses_reservation ON public.reservation_expenses(reservation_id);
CREATE INDEX IF NOT EXISTS idx_reservation_expenses_date ON public.reservation_expenses(expense_date);

DROP TRIGGER IF EXISTS trg_reservation_expenses_updated_at ON public.reservation_expenses;
CREATE TRIGGER trg_reservation_expenses_updated_at
  BEFORE UPDATE ON public.reservation_expenses
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ──────────────────────────────────────────────────────────────────────────
-- FX FREEZE — server-side, never trusted from the browser
-- ──────────────────────────────────────────────────────────────────────────
-- Rate = the newest ECB-backed public.exchange_rates row (base=currency,
-- quote=TRY) whose rate_date is on or before expense_date and no more than
-- 7 days older (the same freshness rule as the Dashboard). TRY/TL freeze at
-- rate 1. No usable rate → the set stays NULL (Finance shows the expense in
-- its original currency and marks the TRY figure unresolved) — never a
-- guessed or hardcoded rate. SECURITY DEFINER only so the read of
-- exchange_rates never depends on the caller's session state; it writes
-- nothing but the NEW row's own three columns.
CREATE OR REPLACE FUNCTION public.fn_reservation_expenses_freeze_fx()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_rate NUMERIC; v_rate_date DATE;
BEGIN
  NEW.currency := upper(btrim(NEW.currency));
  IF NEW.currency = 'TL' THEN NEW.currency := 'TRY'; END IF;

  IF TG_OP = 'UPDATE'
     AND NEW.total_amount IS NOT DISTINCT FROM OLD.total_amount
     AND NEW.currency IS NOT DISTINCT FROM OLD.currency
     AND NEW.expense_date IS NOT DISTINCT FROM OLD.expense_date THEN
    -- Nothing monetary changed: keep the historical frozen set exactly.
    NEW.exchange_rate_used := OLD.exchange_rate_used;
    NEW.exchange_rate_date := OLD.exchange_rate_date;
    NEW.try_amount         := OLD.try_amount;
    RETURN NEW;
  END IF;

  IF NEW.currency = 'TRY' THEN
    NEW.exchange_rate_used := 1;
    NEW.exchange_rate_date := NEW.expense_date;
    NEW.try_amount         := ROUND(NEW.total_amount, 2);
    RETURN NEW;
  END IF;

  SELECT er.rate, er.rate_date INTO v_rate, v_rate_date
    FROM public.exchange_rates er
   WHERE er.base_currency = NEW.currency
     AND er.quote_currency = 'TRY'
     AND er.rate > 0
     AND er.rate_date <= NEW.expense_date
     AND er.rate_date >= NEW.expense_date - 7
   ORDER BY er.rate_date DESC
   LIMIT 1;

  IF v_rate IS NULL THEN
    NEW.exchange_rate_used := NULL;
    NEW.exchange_rate_date := NULL;
    NEW.try_amount         := NULL;
  ELSE
    NEW.exchange_rate_used := v_rate;
    NEW.exchange_rate_date := v_rate_date;
    NEW.try_amount         := ROUND(NEW.total_amount * v_rate, 2);
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.fn_reservation_expenses_freeze_fx() FROM PUBLIC;

DROP TRIGGER IF EXISTS trg_reservation_expenses_freeze_fx ON public.reservation_expenses;
CREATE TRIGGER trg_reservation_expenses_freeze_fx
  BEFORE INSERT OR UPDATE ON public.reservation_expenses
  FOR EACH ROW EXECUTE FUNCTION public.fn_reservation_expenses_freeze_fx();

-- ──────────────────────────────────────────────────────────────────────────
-- RLS — same posture as public.guide_payments (admin + operations, AAL2)
-- ──────────────────────────────────────────────────────────────────────────
ALTER TABLE public.finance_cost_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.reservation_expenses ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "finance_cost_items: admin full access" ON public.finance_cost_items;
CREATE POLICY "finance_cost_items: admin full access" ON public.finance_cost_items FOR ALL TO authenticated USING ( is_admin() AND is_aal2() ) WITH CHECK ( is_admin() AND is_aal2() );
DROP POLICY IF EXISTS "finance_cost_items: operations full access" ON public.finance_cost_items;
CREATE POLICY "finance_cost_items: operations full access" ON public.finance_cost_items FOR ALL TO authenticated USING ( is_operations() AND is_aal2() ) WITH CHECK ( is_operations() AND is_aal2() );

DROP POLICY IF EXISTS "reservation_expenses: admin full access" ON public.reservation_expenses;
CREATE POLICY "reservation_expenses: admin full access" ON public.reservation_expenses FOR ALL TO authenticated USING ( is_admin() AND is_aal2() ) WITH CHECK ( is_admin() AND is_aal2() );
DROP POLICY IF EXISTS "reservation_expenses: operations full access" ON public.reservation_expenses;
CREATE POLICY "reservation_expenses: operations full access" ON public.reservation_expenses FOR ALL TO authenticated USING ( is_operations() AND is_aal2() ) WITH CHECK ( is_operations() AND is_aal2() );

-- ──────────────────────────────────────────────────────────────────────────
-- activity_logs entity_type — widen by exactly two values, never drop one
-- ──────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  v_def TEXT;
  v_live TEXT[];
  v_new TEXT[] := ARRAY[
    'customer','lead','quote','reservation','payment',
    'task','reminder','tour','message','settings',
    'guide','guide_payment','reservation_review',
    'tour_language','tour_channel',
    'civitatis_settlement',
    'agency','agency_email',
    'finance_cost_item','reservation_expense'
  ];
  v_dropped TEXT[];
BEGIN
  SELECT pg_get_constraintdef(oid) INTO v_def FROM pg_constraint
   WHERE conrelid = 'public.activity_logs'::regclass AND conname = 'activity_logs_entity_type_check';
  IF v_def IS NOT NULL THEN
    -- Handles both renderings: ARRAY['a'::text, ...] and '{a,b}'::text[].
    SELECT array_agg(DISTINCT btrim(v, '" ')) INTO v_live
      FROM regexp_matches(v_def, '''([^'']+)''', 'g') AS m,
           LATERAL unnest(CASE WHEN m[1] LIKE '{%}' THEN string_to_array(btrim(m[1], '{}'), ',') ELSE ARRAY[m[1]] END) AS v;
    SELECT array_agg(x) INTO v_dropped FROM unnest(v_live) AS x WHERE NOT (x = ANY (v_new));
    IF v_dropped IS NOT NULL THEN
      RAISE EXCEPTION 'FINANCE CENTER MIGRATION FAILED: the live activity_logs_entity_type_check allows % which this migration''s list does not include — refusing to drop them. Add them to v_new and re-run.', array_to_string(v_dropped, ', ');
    END IF;
  END IF;
  ALTER TABLE public.activity_logs DROP CONSTRAINT IF EXISTS activity_logs_entity_type_check;
  EXECUTE format('ALTER TABLE public.activity_logs ADD CONSTRAINT activity_logs_entity_type_check CHECK (entity_type IN (%s))',
                 (SELECT string_agg(quote_literal(x), ',') FROM unnest(v_new) AS x));
END $$;

-- ──────────────────────────────────────────────────────────────────────────
-- INTERNAL planning seeds (owner-approved DeseTour operating assumptions)
-- ──────────────────────────────────────────────────────────────────────────
INSERT INTO public.finance_cost_items (label, category, basis, amount, currency, valid_from, kind, source_note)
SELECT 'Guide Service', 'guide', 'guide_service_group', 150, 'EUR', DATE '2026-01-01', 'internal',
       'Internal DeseTour planning cost: one guide per unique check_in + tour + booking language service, regardless of reservation count or pax.'
WHERE NOT EXISTS (SELECT 1 FROM public.finance_cost_items
                   WHERE kind = 'internal' AND category = 'guide' AND tour_id IS NULL AND is_active);

INSERT INTO public.finance_cost_items (label, category, basis, amount, currency, valid_from, kind, source_note)
SELECT 'Included Meal', 'meal', 'per_guest', 10, 'EUR', DATE '2026-01-01', 'internal',
       'Internal DeseTour planning cost per guest, applied ONLY when reservations.meal_status = included.'
WHERE NOT EXISTS (SELECT 1 FROM public.finance_cost_items
                   WHERE kind = 'internal' AND category = 'meal' AND tour_id IS NULL AND is_active);

-- ──────────────────────────────────────────────────────────────────────────
-- POSTFLIGHT
-- ──────────────────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_class WHERE oid = 'public.finance_cost_items'::regclass AND relrowsecurity) THEN
    RAISE EXCEPTION 'FINANCE CENTER POSTFLIGHT FAILED: RLS not enabled on finance_cost_items.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_class WHERE oid = 'public.reservation_expenses'::regclass AND relrowsecurity) THEN
    RAISE EXCEPTION 'FINANCE CENTER POSTFLIGHT FAILED: RLS not enabled on reservation_expenses.';
  END IF;
  IF (SELECT COUNT(*) FROM public.finance_cost_items WHERE kind='internal' AND category='guide' AND tour_id IS NULL AND is_active) <> 1 THEN
    RAISE EXCEPTION 'FINANCE CENTER POSTFLIGHT FAILED: expected exactly one active global internal guide cost item.';
  END IF;
  IF (SELECT COUNT(*) FROM public.finance_cost_items WHERE kind='internal' AND category='meal' AND tour_id IS NULL AND is_active) <> 1 THEN
    RAISE EXCEPTION 'FINANCE CENTER POSTFLIGHT FAILED: expected exactly one active global internal meal cost item.';
  END IF;
  RAISE NOTICE 'FINANCE CENTER POSTFLIGHT PASSED: finance_cost_items + reservation_expenses created with RLS; guide €150 and meal €10 internal seeds present.';
END $$;

COMMIT;
