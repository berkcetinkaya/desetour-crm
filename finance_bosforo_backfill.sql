-- ============================================================
-- DESE TOUR OPERATIONS CENTER
-- SEPARATE, REVIEWED STEP — Bosforo (PT + IT) Ayasofya ticket backfill
-- ============================================================
-- Run ONLY after supabase_migration_finance_bosforo_it_costs.sql.
-- Calls the existing public.materialize_reservation_preparations(id) — the
-- ONE quantity engine (per_guest = pax_adult + pax_child) — for the
-- non-cancelled reservations of BOTH "Bosforo y Barrio Sultanahmet"
-- products (PT 8f308669-…, IT 2ea5551f-…) with a tour date from
-- 1 November 2026 on, so November is complete and every upcoming tour gets
-- its "Ayasofya Giriş Bileti" task. The Bosphorus cruise is per guest and
-- needs no preparation. Idempotent: re-running creates nothing new.
-- ============================================================

BEGIN;

SELECT r.reservation_number, r.tour_id, r.check_in, r.pax_adult + COALESCE(r.pax_child, 0) AS guests,
       public.materialize_reservation_preparations(r.id) AS result
  FROM public.reservations r
 WHERE r.tour_id IN ('2ea5551f-f59f-4ba4-976c-0b5c916094a8', '8f308669-2bb6-42ac-9b2f-a07f77e231d4')
   AND r.status <> 'cancelled'
   AND r.check_in >= DATE '2026-11-01'
 ORDER BY r.check_in;

COMMIT;
