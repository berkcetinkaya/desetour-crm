-- ============================================================
-- DESE TOUR OPERATIONS CENTER
-- SEPARATE, REVIEWED STEP — Topkapı preparation backfill
-- ============================================================
-- NOT part of any migration and NOT auto-run. Run ONLY after
-- supabase_migration_finance_topkapi_rule.sql has been applied and the
-- owner has approved writing reservation_preparations.
--
-- Calls the existing, already-deployed
-- public.materialize_reservation_preparations(reservation_id) — the ONE
-- quantity engine — for every UPCOMING, non-cancelled reservation on a tour
-- that has an active Topkapı rule. It does not compute any quantity itself.
-- That function is idempotent (create / update-pending / no-op; completed
-- rows are never rewritten), so re-running this is safe.
-- Past and cancelled reservations are deliberately left alone.
-- ============================================================

BEGIN;

SELECT r.id AS reservation_id, r.reservation_number, r.check_in,
       public.materialize_reservation_preparations(r.id) AS result
  FROM public.reservations r
 WHERE r.status <> 'cancelled'
   AND r.check_in >= (now() AT TIME ZONE 'Europe/Istanbul')::date
   AND r.tour_id IN (SELECT tour_id FROM public.tour_preparation_rules
                      WHERE is_active AND label = 'Topkapı Sarayı Kombine Giriş Bileti')
 ORDER BY r.check_in;

COMMIT;
