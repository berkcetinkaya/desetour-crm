-- ============================================================
-- DESE TOUR OPERATIONS CENTER
-- SEPARATE, REVIEWED STEP — Spanish Topkapı preparation backfill
-- ============================================================
-- Run ONLY after supabase_migration_finance_topkapi_es_rule.sql.
-- Calls the existing, already-deployed
-- public.materialize_reservation_preparations(reservation_id) — the ONE
-- quantity engine (per_guest = pax_adult + pax_child) — for UPCOMING,
-- non-cancelled reservations of the Spanish Topkapı product, so Operations
-- gets a "Topkapı Sarayı + Harem Bileti" ticket task for each of them.
-- Past reservations are deliberately left alone (no stale tasks for tours
-- that already happened). Idempotent: re-running creates nothing new.
-- ============================================================

BEGIN;

SELECT r.reservation_number, r.check_in, r.pax_adult + COALESCE(r.pax_child, 0) AS guests,
       public.materialize_reservation_preparations(r.id) AS result
  FROM public.reservations r
 WHERE r.tour_id = '3d3a335a-1320-4277-977d-62a19fa7090a'
   AND r.status <> 'cancelled'
   AND r.check_in >= (now() AT TIME ZONE 'Europe/Istanbul')::date
 ORDER BY r.check_in;

COMMIT;
