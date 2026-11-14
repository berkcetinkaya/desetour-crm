-- ============================================================
-- DESE TOUR OPERATIONS CENTER
-- ONE-TIME BACKFILL — €150 guide fee for every EXISTING guide assignment
-- ============================================================
-- Owner request (2026-11-14): every guide assigned so far gets a €150 fee.
-- Same guide + same day + same tour = ONE operation = ONE €150 (never 2×).
-- From now on the fee is entered at guide assignment (CRM 13.18).
--
-- Writes one row per operation into guide_operation_cost_overrides with the
-- 13.18 key  fee|<tour date>|<tour id>|g:<guide id>  — exactly the key the
-- CRM computes. Non-cancelled reservations with a guide_id only.
-- Operations that already have a fee are NOT touched (ON CONFLICT DO NOTHING),
-- so re-running is safe. Afterwards a fee can be corrected per operation
-- from the reservation's Finance card ("Ücreti düzelt").
-- ============================================================

BEGIN;

INSERT INTO public.guide_operation_cost_overrides
       (operation_key, tour_date, tour_id, reservation_id, amount, currency, reason)
SELECT 'fee|' || to_char(r.check_in::date, 'YYYY-MM-DD') || '|' || r.tour_id::text || '|g:' || r.guide_id::text,
       r.check_in::date,
       r.tour_id,
       (array_agg(r.id ORDER BY r.reservation_number))[1],
       150, 'EUR',
       'Toplu giriş: mevcut rehber atamaları €150 (2026-11-14)'
  FROM public.reservations r
 WHERE r.guide_id IS NOT NULL
   AND r.tour_id IS NOT NULL
   AND r.status <> 'cancelled'
 GROUP BY r.check_in::date, r.tour_id, r.guide_id
ON CONFLICT (operation_key) DO NOTHING;

-- Check: one row per operation, how many reservations share each €150.
SELECT o.tour_date, t.name AS tour, o.amount, o.currency,
       (SELECT COUNT(*) FROM public.reservations r
         WHERE r.status <> 'cancelled' AND r.guide_id IS NOT NULL
           AND 'fee|' || to_char(r.check_in::date, 'YYYY-MM-DD') || '|' || r.tour_id::text || '|g:' || r.guide_id::text = o.operation_key) AS reservations
  FROM public.guide_operation_cost_overrides o
  LEFT JOIN public.tours t ON t.id = o.tour_id
 WHERE o.operation_key LIKE 'fee|%'
 ORDER BY o.tour_date;

COMMIT;
