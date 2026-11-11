-- ============================================================
-- DESE TOUR OPERATIONS CENTER
-- READ-ONLY PREFLIGHT: which tours are Topkapı products?
-- ============================================================
-- Run BEFORE supabase_migration_finance_topkapi_rule.sql. Writes nothing
-- (SELECT only). Shows every tour that visits Topkapı, its channel identity
-- and whether it already has an active Topkapı ticket rule (any label) —
-- the €40 internal cost is linked to that existing rule.
-- ============================================================

-- 1. Every tour with a Topkapı itinerary stop, its channel identity, and
--    whether it already has an active Topkapı rule.
SELECT t.id AS tour_id, t.name AS tour_name, t.status AS tour_status,
       s.stop_order, s.place_name,
       (s.place_name ILIKE '%harem%') AS is_harem_stop,
       string_agg(DISTINCT src.slug || ':' || COALESCE(tc.external_product_id,'') || ':' || COALESCE(tc.booking_language,''), ', ') AS channels,
       EXISTS (SELECT 1 FROM public.tour_preparation_rules r
                WHERE r.tour_id = t.id AND r.is_active AND r.preparation_type = 'entrance_ticket' AND r.label ILIKE ANY (ARRAY['%Topkapı%', '%Topkapi%'])) AS has_topkapi_rule
  FROM public.tours t
  JOIN public.tour_itinerary_stops s ON s.tour_id = t.id
  LEFT JOIN public.tour_channels tc ON tc.tour_id = t.id
  LEFT JOIN public.sources src ON src.id = tc.source_id
 WHERE s.place_name ILIKE ANY (ARRAY['%Topkapı%', '%Topkapi%'])
 GROUP BY t.id, t.name, t.status, s.stop_order, s.place_name
 ORDER BY t.name, s.stop_order;

-- 2. Tours whose NAME mentions Topkapı / Historic Istanbul but have NO
--    itinerary stops at all (e.g. auto-provisioned draft tours). These
--    cannot be matched safely and need itinerary data or an explicit id.
SELECT t.id AS tour_id, t.name, t.status
  FROM public.tours t
 WHERE (t.name ILIKE ANY (ARRAY['%Topkap%', '%Hist%rica%', '%Historic%', '%Histórica%']))
   AND NOT EXISTS (SELECT 1 FROM public.tour_itinerary_stops s WHERE s.tour_id = t.id)
 ORDER BY t.name;

-- 3. Upcoming, non-cancelled reservations on those tours and whether a
--    Topkapı preparation row is already materialized for them.
SELECT t.name AS tour_name, r.check_in, COUNT(*) AS reservations,
       SUM(r.pax_adult + COALESCE(r.pax_child, 0)) AS guests,
       COUNT(*) FILTER (WHERE EXISTS (
         SELECT 1 FROM public.reservation_preparations p
           JOIN public.tour_preparation_rules tr ON tr.id = p.preparation_rule_id
          WHERE p.reservation_id = r.id AND p.status IN ('pending','completed')
            AND tr.label ILIKE ANY (ARRAY['%Topkapı%', '%Topkapi%']))) AS with_topkapi_preparation
  FROM public.reservations r
  JOIN public.tours t ON t.id = r.tour_id
 WHERE r.status <> 'cancelled'
   AND r.check_in >= (now() AT TIME ZONE 'Europe/Istanbul')::date
   AND EXISTS (SELECT 1 FROM public.tour_itinerary_stops s
                WHERE s.tour_id = t.id AND s.place_name ILIKE ANY (ARRAY['%Topkapı%', '%Topkapi%']))
 GROUP BY t.name, r.check_in
 ORDER BY r.check_in, t.name;
