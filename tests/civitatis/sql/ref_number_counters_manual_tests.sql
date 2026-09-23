-- ============================================================
-- MANUAL / STAGING DATABASE TEST PLAN
-- public.next_ref_number(...) / public.ref_number_counters
-- ============================================================
-- NOT EXECUTED as part of preparing this task. These tests require a
-- real PostgreSQL/Supabase database with supabase_schema.sql AND
-- supabase_migration_ref_number_counters.sql already applied (the
-- second is NOT applied anywhere yet — that is exactly what this file
-- exists to help verify before it is). Run this file (e.g. via `psql`
-- or the Supabase SQL editor) against a STAGING database only, never
-- production.
--
-- WHY THIS EXISTS AS SQL, NOT A JS TEST
-- The core claims here — atomic counter allocation, safe first-time
-- seeding from real historical data, and concurrency-safety under a
-- genuine PostgreSQL row lock — can only be proven by PostgreSQL itself
-- executing them, exactly as with the Civitatis RPC's own manual test
-- plan (see ingest_civitatis_booking_manual_tests.sql in this same
-- directory for the established pattern this file follows).
--
-- EACH SINGLE-SESSION TEST BLOCK is wrapped in its own BEGIN ...
-- ROLLBACK, so running the single-session tests leaves no residue even
-- against a database with real data. The two CONCURRENCY tests (items 3
-- and 4) are documented manual two-session procedures instead — true
-- concurrency cannot be exercised inside one script/session — and DO
-- leave residue that must be cleaned up per their own final step.
--
-- HOW TO READ A FAILURE: every assertion uses
--   IF NOT (<condition>) THEN RAISE EXCEPTION '<test name>: FAILED — <detail>'; END IF;
-- A silent, error-free run of the single-session tests means they all
-- passed.
-- ============================================================


-- ══════════════════════════════════════════════════════════════════════════
-- TEST R1 — first-time initialization for a (prefix, table_name, year)
-- key respects the HIGHEST EXISTING valid reference already in the
-- target table — never blindly starts at 1 (item #1)
-- ══════════════════════════════════════════════════════════════════════════
BEGIN;
DO $$
DECLARE
  v_year TEXT := TO_CHAR(NOW(), 'YYYY');
  v_next TEXT;
BEGIN
  -- Seed a fake table_name so this test is fully self-contained and
  -- never depends on (or perturbs) real reservations/leads/etc data —
  -- but next_ref_number(...) only accepts its five known legitimate
  -- combinations, so this test instead seeds REAL history directly into
  -- the reservations table using a throwaway tour/customer, exactly
  -- like the Civitatis manual tests already do for their own fixtures.
  DECLARE
    v_tour_id UUID; v_customer_id UUID;
  BEGIN
    INSERT INTO public.tours (name, is_active) VALUES ('REFNUM TEST R1 Tour', TRUE) RETURNING id INTO v_tour_id;
    INSERT INTO public.customers (full_name) VALUES ('RefNum Test R1 Customer') RETURNING id INTO v_customer_id;

    -- Simulate pre-existing history: a manually-created reservation
    -- already numbered R-<year>-0041, WITHOUT ever going through
    -- next_ref_number(...) — i.e. exactly what a database that already
    -- had reservations before this migration was applied looks like.
    INSERT INTO public.reservations (
      reservation_number, customer_id, tour_id, status, payment_status,
      destination, check_in, check_out, check_in_time, pax_adult, pax_child,
      total_amount, currency
    ) VALUES (
      'R-' || v_year || '-0041', v_customer_id, v_tour_id, 'pending_confirmation', 'pending',
      'REFNUM TEST R1 Tour', CURRENT_DATE + 10, CURRENT_DATE + 10, '09:00', 2, 0,
      1000, 'EUR'
    );
  END;

  -- No counter row exists yet for (R, reservations, v_year) in THIS
  -- transaction's view (a fresh staging DB, or this is genuinely the
  -- first call ever made) — first counter-backed call must continue
  -- from 0041, i.e. return 0042, never 0001.
  v_next := public.next_ref_number('R', 'reservations', 'reservation_number');
  IF v_next <> 'R-' || v_year || '-0042' THEN
    RAISE EXCEPTION 'TEST R1: FAILED — expected R-%-0042 (continuing from existing history), got %', v_year, v_next;
  END IF;

  RAISE NOTICE 'TEST R1: PASSED';
END $$;
ROLLBACK;


-- ══════════════════════════════════════════════════════════════════════════
-- TEST R2 — sequential calls increment correctly, one at a time, with no
-- gaps under normal (non-concurrent) use (item #2)
-- ══════════════════════════════════════════════════════════════════════════
BEGIN;
DO $$
DECLARE
  v_year TEXT := TO_CHAR(NOW(), 'YYYY');
  v_n1 TEXT; v_n2 TEXT; v_n3 TEXT;
BEGIN
  -- Use the LEAD/leads/lead_number combination so this test's counter
  -- key is independent of whatever reservations history exists.
  v_n1 := public.next_ref_number('LEAD', 'leads', 'lead_number');
  v_n2 := public.next_ref_number('LEAD', 'leads', 'lead_number');
  v_n3 := public.next_ref_number('LEAD', 'leads', 'lead_number');

  IF v_n2 <> (SPLIT_PART(v_n1, '-', 1) || '-' || SPLIT_PART(v_n1, '-', 2) || '-' ||
              LPAD((SPLIT_PART(v_n1, '-', 3)::int + 1)::text, 4, '0')) THEN
    RAISE EXCEPTION 'TEST R2: FAILED — second call did not increment by exactly 1 from the first (got % then %)', v_n1, v_n2;
  END IF;
  IF v_n3 <> (SPLIT_PART(v_n2, '-', 1) || '-' || SPLIT_PART(v_n2, '-', 2) || '-' ||
              LPAD((SPLIT_PART(v_n2, '-', 3)::int + 1)::text, 4, '0')) THEN
    RAISE EXCEPTION 'TEST R2: FAILED — third call did not increment by exactly 1 from the second (got % then %)', v_n2, v_n3;
  END IF;
  -- All three distinct, none skipped or repeated:
  IF v_n1 = v_n2 OR v_n2 = v_n3 OR v_n1 = v_n3 THEN
    RAISE EXCEPTION 'TEST R2: FAILED — expected three distinct sequential numbers, got %, %, %', v_n1, v_n2, v_n3;
  END IF;

  RAISE NOTICE 'TEST R2: PASSED (% -> % -> %)', v_n1, v_n2, v_n3;
END $$;
ROLLBACK;


-- ══════════════════════════════════════════════════════════════════════════
-- TEST R3 — two CONCURRENT FIRST-TIME calls for the SAME
-- (prefix, table_name, year) key (no counter row exists yet for either)
-- must NEVER return the same number (item #3). Requires two separate
-- database sessions — documented manual procedure.
--
--   1. Confirm no counter row exists yet for this test's key:
--        SELECT * FROM public.ref_number_counters
--         WHERE prefix='Q' AND table_name='quotes'
--           AND year = TO_CHAR(NOW(),'YYYY');
--      (If a leftover row exists from a prior run, DELETE it first —
--      see cleanup step below — so this really is a first-time key.)
--   2. Open two separate `psql` (or two Supabase SQL editor tabs)
--      sessions against the same staging database — session A and
--      session B.
--   3. In session A, run:
--        BEGIN;
--        SELECT public.next_ref_number('Q', 'quotes', 'quote_number');
--      but do NOT COMMIT yet — leave the transaction open. Note the
--      returned number as <A-number>.
--   4. In session B, run the EXACT SAME call:
--        BEGIN;
--        SELECT public.next_ref_number('Q', 'quotes', 'quote_number');
--      Session B should BLOCK (visibly hang) — it is waiting on the
--      row-level lock Postgres takes resolving session A's still-open
--      conflicting INSERT into ref_number_counters (see the migration
--      file's CONCURRENCY ANALYSIS for the full mechanism: this is the
--      SAME class of row-lock serialization the Civitatis RPC's own
--      booking-level advisory lock produces, just via an ordinary
--      UNIQUE-constraint conflict here instead of an advisory lock).
--   5. COMMIT session A. Session B should then unblock and return ITS
--      OWN number as <B-number> — via the ON CONFLICT DO UPDATE branch,
--      incrementing the row session A just committed, regardless of
--      what session B's own (redundant) seed computation produced.
--      COMMIT session B too.
--   6. Verify: <A-number> and <B-number> must be DIFFERENT, and must be
--      exactly consecutive (e.g. Q-2026-0001 and Q-2026-0002, in
--      whichever order the two sessions actually resolved).
--   7. Clean up: DELETE FROM public.ref_number_counters WHERE prefix='Q'
--      AND table_name='quotes' AND year = TO_CHAR(NOW(),'YYYY');
-- ══════════════════════════════════════════════════════════════════════════


-- ══════════════════════════════════════════════════════════════════════════
-- TEST R4 — two CONCURRENT LATER calls (a counter row already exists)
-- for the SAME (prefix, table_name, year) key must NEVER return the
-- same number (item #4). Requires two separate database sessions —
-- documented manual procedure.
--
--   1. In a single session, first produce an existing counter row (this
--      call commits on its own):
--        SELECT public.next_ref_number('GP', 'guide_payments', 'payment_number');
--      Note the returned number.
--   2. Open two separate sessions — session A and session B.
--   3. In session A, run:
--        BEGIN;
--        SELECT public.next_ref_number('GP', 'guide_payments', 'payment_number');
--      Do NOT COMMIT yet — leave the transaction open. Note <A-number>.
--   4. In session B, run the EXACT SAME call:
--        BEGIN;
--        SELECT public.next_ref_number('GP', 'guide_payments', 'payment_number');
--      Session B should BLOCK — waiting on the row-level lock session A
--      holds on the (now-existing) counter row via its own
--      ON CONFLICT DO UPDATE.
--   5. COMMIT session A. Session B should then unblock, read session
--      A's newly-committed last_value, and return ITS OWN, further-
--      incremented number as <B-number>. COMMIT session B.
--   6. Verify: <A-number> and <B-number> are different and consecutive,
--      each exactly 1 greater than the value before it.
--   7. Clean up: DELETE FROM public.ref_number_counters WHERE prefix='GP'
--      AND table_name='guide_payments' AND year = TO_CHAR(NOW(),'YYYY');
--      Also delete the throwaway payment_number rows this produced if
--      any payments table row was created by a caller using them
--      (this test only calls next_ref_number(...) itself, never
--      inserts into payments, so no payments cleanup is normally
--      needed).
-- ══════════════════════════════════════════════════════════════════════════


-- ══════════════════════════════════════════════════════════════════════════
-- TEST R5 — output format remains EXACTLY PREFIX-YYYY-NNNN, unchanged
-- from before this migration (item #5)
-- ══════════════════════════════════════════════════════════════════════════
BEGIN;
DO $$
DECLARE
  v_year TEXT := TO_CHAR(NOW(), 'YYYY');
  v_result TEXT;
BEGIN
  v_result := public.next_ref_number('PAY', 'payments', 'payment_number');
  IF v_result !~ ('^PAY-' || v_year || '-[0-9]{4}$') THEN
    RAISE EXCEPTION 'TEST R5: FAILED — expected format PAY-%-NNNN (4 digits), got %', v_year, v_result;
  END IF;
  -- A number beyond 9999 still returns (LPAD does not truncate, it only
  -- pads when shorter) — not asserted here since it requires 10,000
  -- prior calls, but documented: the function never raises or silently
  -- truncates on overflow, it simply prints a wider digit string.

  RAISE NOTICE 'TEST R5: PASSED (%)', v_result;
END $$;
ROLLBACK;


-- ══════════════════════════════════════════════════════════════════════════
-- TEST R6 — every known legitimate (prefix, table_name, number_col)
-- combination still works, and an UNRECOGNIZED combination is refused
-- (item #6, plus the migration's own SECURITY allow-list guarantee)
-- ══════════════════════════════════════════════════════════════════════════
BEGIN;
DO $$
DECLARE
  v_year TEXT := TO_CHAR(NOW(), 'YYYY');
  v_r TEXT; v_lead TEXT; v_pay TEXT; v_gp TEXT; v_q TEXT;
  v_rejected BOOLEAN := FALSE;
BEGIN
  v_r    := public.next_ref_number('R',    'reservations',   'reservation_number');
  v_lead := public.next_ref_number('LEAD', 'leads',          'lead_number');
  v_pay  := public.next_ref_number('PAY',  'payments',       'payment_number');
  v_gp   := public.next_ref_number('GP',   'guide_payments', 'payment_number');
  v_q    := public.next_ref_number('Q',    'quotes',         'quote_number');

  IF v_r    !~ ('^R-'    || v_year || '-[0-9]{4}$') THEN RAISE EXCEPTION 'TEST R6: FAILED — R/reservations/reservation_number produced %', v_r; END IF;
  IF v_lead !~ ('^LEAD-' || v_year || '-[0-9]{4}$') THEN RAISE EXCEPTION 'TEST R6: FAILED — LEAD/leads/lead_number produced %', v_lead; END IF;
  IF v_pay  !~ ('^PAY-'  || v_year || '-[0-9]{4}$') THEN RAISE EXCEPTION 'TEST R6: FAILED — PAY/payments/payment_number produced %', v_pay; END IF;
  IF v_gp   !~ ('^GP-'   || v_year || '-[0-9]{4}$') THEN RAISE EXCEPTION 'TEST R6: FAILED — GP/guide_payments/payment_number produced %', v_gp; END IF;
  IF v_q    !~ ('^Q-'    || v_year || '-[0-9]{4}$') THEN RAISE EXCEPTION 'TEST R6: FAILED — Q/quotes/quote_number produced %', v_q; END IF;

  -- An unrecognized combination must be refused, not silently executed
  -- against an arbitrary table:
  BEGIN
    PERFORM public.next_ref_number('HACK', 'customers', 'email');
    v_rejected := FALSE;
  EXCEPTION WHEN OTHERS THEN
    v_rejected := TRUE;
  END;
  IF NOT v_rejected THEN
    RAISE EXCEPTION 'TEST R6: FAILED — an unrecognized prefix/table_name/number_col combination was NOT refused';
  END IF;

  RAISE NOTICE 'TEST R6: PASSED (R=%, LEAD=%, PAY=%, GP=%, Q=%, unrecognized combo correctly refused)', v_r, v_lead, v_pay, v_gp, v_q;
END $$;
ROLLBACK;


-- ══════════════════════════════════════════════════════════════════════════
-- TEST R7 — public.ref_number_counters cannot be directly read or
-- mutated by anon/authenticated roles (item #7). This requires a
-- session actually authenticated AS one of those roles (not the
-- superuser/service_role connection these other tests assume) —
-- documented as an exact manual procedure using SET ROLE, plus the
-- static verification queries the migration file itself already
-- documents.
--
--   1. As the same privileged session used for the other tests here,
--      confirm the static facts directly:
--        SELECT relrowsecurity FROM pg_class WHERE relname = 'ref_number_counters';
--        -- Expect true.
--        SELECT * FROM pg_policies WHERE tablename = 'ref_number_counters';
--        -- Expect ZERO rows (no policy exists to grant anon/authenticated
--        -- access, regardless of what table-level GRANTs exist).
--        SELECT grantee, privilege_type FROM information_schema.role_table_grants
--         WHERE table_name = 'ref_number_counters';
--        -- Expect no row naming anon, authenticated, or PUBLIC.
--   2. To confirm behaviorally (requires a role that can SET ROLE to
--      anon/authenticated in this database, which a plain staging
--      superuser session usually can):
--        SET ROLE authenticated;
--        SELECT * FROM public.ref_number_counters LIMIT 1;
--        -- Expect: permission denied for table ref_number_counters
--        -- (from the REVOKE), or an empty result with no rows visible
--        -- (from RLS) — either way, no counter row's contents are
--        -- ever exposed to this role.
--        INSERT INTO public.ref_number_counters (prefix, table_name, year, last_value)
--          VALUES ('HACK', 'x', '2026', 999999);
--        -- Expect: permission denied.
--        RESET ROLE;
--   3. Confirm the function itself still works fine for this same
--      'authenticated' role (it must — this is exactly what the
--      SECURITY DEFINER wrapper is for):
--        SET ROLE authenticated;
--        SELECT public.next_ref_number('Q', 'quotes', 'quote_number');
--        -- Expect: a normal Q-YYYY-NNNN result, no permission error —
--        -- proving the function's OWN callability is unchanged even
--        -- though the table it now uses internally is fully locked
--        -- down from this same role.
--        RESET ROLE;
-- ══════════════════════════════════════════════════════════════════════════


-- ══════════════════════════════════════════════════════════════════════════
-- TEST R8 — existing function call interface remains fully compatible:
-- same name, same 3 arguments in the same order/types, same TEXT return
-- — callable exactly as every existing application call site already
-- does, with no changes required at any call site (item #8)
-- ══════════════════════════════════════════════════════════════════════════
BEGIN;
DO $$
DECLARE
  v_argcount INT;
  v_rettype TEXT;
  v_result TEXT;
BEGIN
  SELECT pronargs INTO v_argcount FROM pg_proc WHERE proname = 'next_ref_number';
  IF v_argcount <> 3 THEN
    RAISE EXCEPTION 'TEST R8: FAILED — expected exactly 3 arguments, found %', v_argcount;
  END IF;

  SELECT format_type(prorettype, NULL) INTO v_rettype FROM pg_proc WHERE proname = 'next_ref_number';
  IF v_rettype <> 'text' THEN
    RAISE EXCEPTION 'TEST R8: FAILED — expected TEXT return type, found %', v_rettype;
  END IF;

  -- Exactly the same positional call shape every existing call site
  -- already uses (e.g. sb.rpc('next_ref_number', {prefix, table_name,
  -- number_col}) from DeseTourDashboard.jsx's ReservationRepository.create):
  v_result := public.next_ref_number('R', 'reservations', 'reservation_number');
  IF v_result IS NULL OR v_result = '' THEN
    RAISE EXCEPTION 'TEST R8: FAILED — the existing positional call shape did not return a usable value';
  END IF;

  RAISE NOTICE 'TEST R8: PASSED (interface unchanged, sample result %)', v_result;
END $$;
ROLLBACK;


-- ══════════════════════════════════════════════════════════════════════════
-- CROSS-REFERENCE
-- ══════════════════════════════════════════════════════════════════════════
--   #1 existing max is respected on first initialization        -> TEST R1
--   #2 sequential calls increment correctly                     -> TEST R2
--   #3 two concurrent first-time calls cannot collide            -> TEST R3 (two-session manual procedure)
--   #4 two concurrent later calls cannot collide                 -> TEST R4 (two-session manual procedure)
--   #5 output format remains unchanged                           -> TEST R5
--   #6 each known legitimate combination still works              -> TEST R6
--   #7 counter table cannot be directly mutated by browser roles   -> TEST R7 (manual SET ROLE procedure + static checks)
--   #8 existing function call interface remains compatible          -> TEST R8
-- ══════════════════════════════════════════════════════════════════════════

-- ── END OF MANUAL TEST PLAN ─────────────────────────────────────────────────
