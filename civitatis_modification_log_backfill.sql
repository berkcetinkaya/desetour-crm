-- ============================================================
-- DESE TOUR OPERATIONS CENTER
-- ONE-TIME BACKFILL — Civitatis date changes applied BEFORE V16
-- ============================================================
-- Run ONLY after supabase_migration_civitatis_write_v16_modification_log.sql.
-- Two "Booking modified" emails changed a tour date before V16 existed;
-- they were applied to the reservation but left no trace. Verified
-- read-only on 2026-11-16 by comparing each booking's original and
-- modified email (only the DATE line differs — people, hour, language and
-- net price are identical):
--   A42711975 / R-2026-0058  Topkapı   19.11.2026 → 20.11.2026  (applied 15 Nov)
--   A42459545 / R-2026-0039  Bosforo   05.11.2026 → 05.12.2026  (applied 1 Nov)
-- Writes the same activity row V16 writes, timestamped when the change was
-- applied, so it shows on the reservation page (and as an unread change on
-- the home page / bell). Idempotent: a booking that already has a
-- civitatis_modified row is skipped.
-- ============================================================

BEGIN;

INSERT INTO public.activity_logs (entity_type, entity_id, action, description, metadata, performed_by, created_at)
SELECT 'reservation', r.id, 'updated',
       'Civitatis değişikliği: ' || r.reservation_number || ' · Tarih ' || v.from_date || ' → ' || v.to_date,
       jsonb_build_object(
         'auto_ingested', true, 'source', 'civitatis', 'alert_type', 'civitatis_modified',
         'external_booking_id', v.ext, 'reservation_number', r.reservation_number,
         'tour_name', r.destination, 'tour_date', r.check_in,
         'changes', jsonb_build_array(jsonb_build_object('field', 'check_in', 'label', 'Tarih', 'from', v.from_date, 'to', v.to_date)),
         'guide_assigned', (r.guide_id IS NOT NULL OR NULLIF(btrim(r.guide_name), '') IS NOT NULL),
         'guide_name', NULLIF(btrim(r.guide_name), ''),
         'backfilled', true),
       NULL, v.applied_at
  FROM (VALUES
    ('42711975', '19.11.2026', '20.11.2026', DATE '2026-11-20', TIMESTAMPTZ '2026-11-15 22:04:55+00'),
    ('42459545', '05.11.2026', '05.12.2026', DATE '2026-12-05', TIMESTAMPTZ '2026-11-01 16:24:08+00')
  ) AS v(ext, from_date, to_date, expected_date, applied_at)
  JOIN public.reservations r ON r.external_booking_id = v.ext AND r.check_in = v.expected_date
 WHERE NOT EXISTS (SELECT 1 FROM public.activity_logs a
                    WHERE a.entity_id = r.id AND a.metadata->>'alert_type' = 'civitatis_modified');

SELECT a.created_at, a.description FROM public.activity_logs a
 WHERE a.metadata->>'alert_type' = 'civitatis_modified' ORDER BY a.created_at;

COMMIT;
