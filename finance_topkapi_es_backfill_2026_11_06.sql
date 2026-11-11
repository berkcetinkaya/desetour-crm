-- ============================================================
-- DESE TOUR OPERATIONS CENTER
-- SEPARATE, REVIEWED STEP — Spanish Topkapı ticket backfill for 6 Nov 2026
-- ============================================================
-- Run ONLY after supabase_migration_finance_topkapi_es_rule.sql (applied).
-- Owner request (2026-11-11): include the Topkapı tickets of the already
-- completed 6 November 2026 operation of "Topkapi Palace Complete Tour:
-- Harem & Hagia Irene" in Finance (2 reservations, 6 guests → 6 × €40).
--
-- Calls the existing public.materialize_reservation_preparations(id) — the
-- ONE quantity engine (per_guest = pax_adult + pax_child) — for the
-- non-cancelled reservations of that tour on 2026-11-06 ONLY. Nothing else
-- is touched. Idempotent: re-running creates nothing new.
--
-- The dashboard "Tur Hazırlıkları" panel lists upcoming tours only, so no
-- past task appears there; the ticket row is visible on the reservation
-- detail page, where it can be marked "Tamamlandı". Enter the real ticket
-- spend with "Gider Ekle" on the reservation when known.
-- ============================================================

BEGIN;

SELECT r.reservation_number, r.check_in, r.pax_adult + COALESCE(r.pax_child, 0) AS guests,
       public.materialize_reservation_preparations(r.id) AS result
  FROM public.reservations r
 WHERE r.tour_id = '3d3a335a-1320-4277-977d-62a19fa7090a'
   AND r.status <> 'cancelled'
   AND r.check_in = DATE '2026-11-06'
 ORDER BY r.reservation_number;

COMMIT;
