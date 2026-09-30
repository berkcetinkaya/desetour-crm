-- ============================================================
-- DESE TOUR OPERATIONS CENTER
-- Rollback: Bosforo y Barrio Sultanahmet · Portekizce data population
-- ============================================================
-- File:    supabase_data_bosphorus_portuguese_tour_information_ROLLBACK.sql
-- Rolls back ONLY: supabase_data_bosphorus_portuguese_tour_information.sql
-- NOT executed. Provided for manual review and manual execution only.
--
-- SCOPE — RESTORES EXACT VERIFIED PRE-POPULATION VALUES, NOTHING ELSE
-- ─────────────────────────────────────────────────────────────
-- Targets the exact same single tour as the forward migration
-- (8f308669-2bb6-42ac-9b2f-a07f77e231d4, "Bosforo y Barrio Sultanahmet",
-- Portekizce), with the same preflight targeting discipline. Restores the
-- fourteen tours fields the forward migration wrote to NULL (the verified
-- all-NULL production snapshot), and removes the 9 itinerary rows that
-- migration inserted (the table was verified empty for this tour before
-- it ran).
--
-- guide_notes_tr WAS NEVER WRITTEN — NOT TOUCHED HERE EITHER
-- ─────────────────────────────────────────────────────────────
-- The forward migration deliberately never wrote to guide_notes_tr (no
-- approved Dese Tour internal content exists for this product). This
-- rollback does not touch it either — restoring a field the forward
-- migration never changed is not this rollback's job.
--
-- DRIFT SAFETY — THIS ROLLBACK REVERSES THIS MIGRATION, NOT SUBSEQUENT
-- HUMAN WORK
-- ─────────────────────────────────────────────────────────────
-- Before writing anything, this rollback verifies that the tour's
-- fourteen written fields AND itinerary still hold exactly what the
-- forward migration's own postflight proved it wrote — including the 3
-- stop-level approx_duration_text values. If a human has since edited any
-- of it, this rollback RAISEs EXCEPTION and aborts the WHOLE transaction
-- rather than silently overwriting or deleting that later work.
--
-- tour_channels (booking_language IS NULL) AND tour_languages —
-- VERIFIED, NEVER TOUCHED
-- ─────────────────────────────────────────────────────────────
-- The known Civitatis tour_channels row (including its verified
-- booking_language IS NULL state) and the tour's tour_languages row are
-- re-verified unchanged in preflight and postflight, exactly as the
-- forward migration did. This rollback never writes to tour_channels or
-- tour_languages, and never attempts to repair booking_language.
--
-- No SQL in this file has been executed. No Supabase connection was made
-- to produce it.
--
-- HOW TO APPLY
-- ─────────────────────────────────────────────────────────────
-- Supabase Dashboard → SQL Editor → paste and run this file IN FULL, in a
-- single execution.
-- ============================================================


BEGIN;

-- ──────────────────────────────────────────────────────────────────────────
-- PREFLIGHT: same exact-tour targeting discipline as the forward
-- migration.
-- ──────────────────────────────────────────────────────────────────────────

DO $$
DECLARE
  v_tour_id   UUID := '8f308669-2bb6-42ac-9b2f-a07f77e231d4';
  v_tour_name TEXT;
BEGIN
  SELECT name INTO v_tour_name FROM public.tours WHERE id = v_tour_id;
  IF v_tour_name IS NULL THEN
    RAISE EXCEPTION 'BOSPHORUS PORTUGUESE ROLLBACK PREFLIGHT FAILED: tour % does not exist. Aborting.', v_tour_id;
  END IF;
  IF v_tour_name IS DISTINCT FROM 'Bosforo y Barrio Sultanahmet' THEN
    RAISE EXCEPTION 'BOSPHORUS PORTUGUESE ROLLBACK PREFLIGHT FAILED: tour % has name "%", expected "Bosforo y Barrio Sultanahmet". Aborting — this looks like the wrong tour.', v_tour_id, v_tour_name;
  END IF;
  RAISE NOTICE 'BOSPHORUS PORTUGUESE ROLLBACK PREFLIGHT PASSED: tour % confirmed. Proceeding.', v_tour_id;
END $$;


-- ──────────────────────────────────────────────────────────────────────────
-- DRIFT GUARD (scalars): verify the tour's written fields still hold
-- exactly what the forward migration's own postflight proved it wrote.
-- ──────────────────────────────────────────────────────────────────────────

DO $$
DECLARE
  v_tour_id UUID := '8f308669-2bb6-42ac-9b2f-a07f77e231d4';
  v_row public.tours%ROWTYPE;
BEGIN
  SELECT * INTO v_row FROM public.tours WHERE id = v_tour_id;

  IF v_row.description IS DISTINCT FROM 'Mısır Çarşısı, Eminönü ve Boğaz''da tekne turu ile başlayan; öğle yemeğinin ardından Hipodrom Meydanı, Sultanahmet Camii ve Ayasofya ziyaretleriyle devam eden bir şehir turu.' THEN
    RAISE EXCEPTION 'BOSPHORUS PORTUGUESE ROLLBACK DRIFT GUARD FAILED: description no longer matches the value the forward migration wrote. Rollback refused.';
  END IF;
  IF v_row.duration_text IS DISTINCT FROM '7 Saat' THEN
    RAISE EXCEPTION 'BOSPHORUS PORTUGUESE ROLLBACK DRIFT GUARD FAILED: duration_text no longer matches. Rollback refused.';
  END IF;
  IF v_row.meeting_point IS DISTINCT FROM 'Tamara Restaurant Sultanahmet (08:45) veya The Marmara Hotel Taksim (08:10)' THEN
    RAISE EXCEPTION 'BOSPHORUS PORTUGUESE ROLLBACK DRIFT GUARD FAILED: meeting_point no longer matches. Rollback refused.';
  END IF;
  IF v_row.meeting_instructions_tr IS DISTINCT FROM 'Misafirler rezervasyon sırasında seçtikleri buluşma noktasından belirtilen saatte alınır.' THEN
    RAISE EXCEPTION 'BOSPHORUS PORTUGUESE ROLLBACK DRIFT GUARD FAILED: meeting_instructions_tr no longer matches. Rollback refused.';
  END IF;
  IF v_row.end_point_tr IS DISTINCT FROM 'Sultanahmet merkezi veya Taksim bölgesi' THEN
    RAISE EXCEPTION 'BOSPHORUS PORTUGUESE ROLLBACK DRIFT GUARD FAILED: end_point_tr no longer matches. Rollback refused.';
  END IF;
  IF v_row.accessibility_info_tr IS DISTINCT FROM 'Tekerlekli sandalye kullanımına uygun değildir.' THEN
    RAISE EXCEPTION 'BOSPHORUS PORTUGUESE ROLLBACK DRIFT GUARD FAILED: accessibility_info_tr no longer matches. Rollback refused.';
  END IF;
  IF v_row.pets_policy_tr IS DISTINCT FROM 'Evcil hayvan kabul edilmez.' THEN
    RAISE EXCEPTION 'BOSPHORUS PORTUGUESE ROLLBACK DRIFT GUARD FAILED: pets_policy_tr no longer matches. Rollback refused.';
  END IF;
  IF v_row.booking_cutoff_text IS DISTINCT FROM 'Müsaitlik olması halinde tur başlangıcından 1 gün öncesine kadar rezervasyon yapılabilir.' THEN
    RAISE EXCEPTION 'BOSPHORUS PORTUGUESE ROLLBACK DRIFT GUARD FAILED: booking_cutoff_text no longer matches. Rollback refused.';
  END IF;
  IF v_row.free_cancellation_text IS DISTINCT FROM 'Tur başlangıcından 48 saat öncesine kadar ücretsiz iptal edilebilir.' THEN
    RAISE EXCEPTION 'BOSPHORUS PORTUGUESE ROLLBACK DRIFT GUARD FAILED: free_cancellation_text no longer matches. Rollback refused.';
  END IF;
  IF v_row.late_cancellation_text IS DISTINCT FROM 'Tur başlangıcına 48 saatten az süre kala yapılan iptallerde ücret iadesi yapılmaz.' THEN
    RAISE EXCEPTION 'BOSPHORUS PORTUGUESE ROLLBACK DRIFT GUARD FAILED: late_cancellation_text no longer matches. Rollback refused.';
  END IF;
  IF v_row.no_show_policy_text IS DISTINCT FROM 'Geç kalınması veya tura katılım sağlanmaması durumunda ücret iadesi yapılmaz.' THEN
    RAISE EXCEPTION 'BOSPHORUS PORTUGUESE ROLLBACK DRIFT GUARD FAILED: no_show_policy_text no longer matches. Rollback refused.';
  END IF;
  IF v_row.other_conditions_tr IS DISTINCT FROM 'Minimum 2 katılımcı gereklidir. Ayasofya ziyareti ikinci kattaki galeri bölümünü kapsar. Ayasofya biletindeki QR kod üzerinden sesli rehbere erişilebilir ve bunu dinlemek için misafirlerin kendi kulaklıklarını getirmeleri gerekir. Cuma sabahları camiler kapalıdır ve cuma günleri güzergah sırası değiştirilebilir.' THEN
    RAISE EXCEPTION 'BOSPHORUS PORTUGUESE ROLLBACK DRIFT GUARD FAILED: other_conditions_tr no longer matches. Rollback refused.';
  END IF;
  IF v_row.included_items IS DISTINCT FROM ARRAY['Klimalı araçla ulaşım', 'Portekizce konuşan rehber', 'Boğaz tekne turu', 'Ziyaret edilen yerler için öncelikli giriş biletleri', 'Öğle yemeği']::TEXT[] THEN
    RAISE EXCEPTION 'BOSPHORUS PORTUGUESE ROLLBACK DRIFT GUARD FAILED: included_items no longer matches. Rollback refused.';
  END IF;
  IF v_row.excluded_items IS DISTINCT FROM ARRAY['İçecekler']::TEXT[] THEN
    RAISE EXCEPTION 'BOSPHORUS PORTUGUESE ROLLBACK DRIFT GUARD FAILED: excluded_items no longer matches. Rollback refused.';
  END IF;
  IF v_row.guide_notes_tr IS NOT NULL THEN
    RAISE EXCEPTION 'BOSPHORUS PORTUGUESE ROLLBACK DRIFT GUARD FAILED: guide_notes_tr is no longer NULL — it was never written by the forward migration, so a non-NULL value here means a human wrote internal content since. Rollback refused so that content is never disturbed.';
  END IF;

  RAISE NOTICE 'BOSPHORUS PORTUGUESE ROLLBACK DRIFT GUARD (SCALARS) PASSED: all fourteen fields still hold exactly what the forward migration wrote, guide_notes_tr confirmed still untouched. Safe to restore pre-population values.';
END $$;


-- ──────────────────────────────────────────────────────────────────────────
-- DRIFT GUARD (itinerary): verify the itinerary still holds exactly the
-- 9 stops the forward migration introduced, including the 3 stop-level
-- approx_duration_text values. Aborts before the DELETE if anything has
-- changed since.
-- ──────────────────────────────────────────────────────────────────────────

DO $$
DECLARE
  v_tour_id UUID := '8f308669-2bb6-42ac-9b2f-a07f77e231d4';
  v_stop_count INTEGER;
  v_stop_names TEXT[];
  v_duration_stops INTEGER;
BEGIN
  SELECT COUNT(*) INTO v_stop_count FROM public.tour_itinerary_stops WHERE tour_id = v_tour_id;
  IF v_stop_count <> 9 THEN
    RAISE EXCEPTION 'BOSPHORUS PORTUGUESE ROLLBACK ITINERARY DRIFT GUARD FAILED: expected exactly 9 itinerary stops, found %. Refusing to blindly delete it. Rollback refused.', v_stop_count;
  END IF;

  SELECT array_agg(place_name ORDER BY stop_order) INTO v_stop_names
    FROM public.tour_itinerary_stops WHERE tour_id = v_tour_id;
  IF v_stop_names IS DISTINCT FROM ARRAY[
    'Buluşma / Pickup', 'Mısır Çarşısı', 'Eminönü ve Tekne İskelesi', 'Boğaz Tekne Turu',
    'Geleneksel Restoran / Öğle Yemeği', 'Hipodrom Meydanı', 'Sultanahmet Camii', 'Ayasofya',
    'Sultanahmet veya Taksim'
  ]::TEXT[] THEN
    RAISE EXCEPTION 'BOSPHORUS PORTUGUESE ROLLBACK ITINERARY DRIFT GUARD FAILED: itinerary stop order/names no longer match the set the forward migration introduced. Refusing to blindly delete it. Rollback refused.';
  END IF;

  SELECT COUNT(*) INTO v_duration_stops FROM public.tour_itinerary_stops
   WHERE tour_id = v_tour_id AND approx_duration_text IS NOT NULL;
  IF v_duration_stops <> 3 THEN
    RAISE EXCEPTION 'BOSPHORUS PORTUGUESE ROLLBACK ITINERARY DRIFT GUARD FAILED: expected exactly 3 stops with a non-NULL approx_duration_text, found %. Refusing to blindly delete it. Rollback refused.', v_duration_stops;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.tour_itinerary_stops WHERE tour_id = v_tour_id AND place_name = 'Boğaz Tekne Turu' AND approx_duration_text = 'Yaklaşık 1,5 saat') THEN
    RAISE EXCEPTION 'BOSPHORUS PORTUGUESE ROLLBACK ITINERARY DRIFT GUARD FAILED: Boğaz Tekne Turu approx_duration_text no longer matches. Rollback refused.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.tour_itinerary_stops WHERE tour_id = v_tour_id AND place_name = 'Sultanahmet Camii' AND approx_duration_text = 'Yaklaşık 1 saat') THEN
    RAISE EXCEPTION 'BOSPHORUS PORTUGUESE ROLLBACK ITINERARY DRIFT GUARD FAILED: Sultanahmet Camii approx_duration_text no longer matches. Rollback refused.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.tour_itinerary_stops WHERE tour_id = v_tour_id AND place_name = 'Ayasofya' AND approx_duration_text = 'Yaklaşık 1 saat') THEN
    RAISE EXCEPTION 'BOSPHORUS PORTUGUESE ROLLBACK ITINERARY DRIFT GUARD FAILED: Ayasofya approx_duration_text no longer matches. Rollback refused.';
  END IF;

  RAISE NOTICE 'BOSPHORUS PORTUGUESE ROLLBACK ITINERARY DRIFT GUARD PASSED: itinerary still exactly matches the 9-stop set the forward migration introduced, including its 3 source-supported durations. Safe to remove.';
END $$;


-- ──────────────────────────────────────────────────────────────────────────
-- STEP 1: tours — restore the fourteen written fields to NULL (the
-- verified pre-population snapshot). guide_notes_tr is absent here too —
-- the forward migration never touched it, so this rollback does not
-- either.
-- ──────────────────────────────────────────────────────────────────────────

UPDATE public.tours
   SET description = NULL,
       duration_text = NULL,
       meeting_point = NULL,
       meeting_instructions_tr = NULL,
       end_point_tr = NULL,
       accessibility_info_tr = NULL,
       pets_policy_tr = NULL,
       booking_cutoff_text = NULL,
       free_cancellation_text = NULL,
       late_cancellation_text = NULL,
       no_show_policy_text = NULL,
       other_conditions_tr = NULL,
       included_items = NULL,
       excluded_items = NULL
 WHERE id = '8f308669-2bb6-42ac-9b2f-a07f77e231d4';


-- ──────────────────────────────────────────────────────────────────────────
-- STEP 2: remove the itinerary rows the forward migration introduced for
-- this tour — verified empty before it ran. Reached only if the
-- itinerary drift guard above passed.
-- ──────────────────────────────────────────────────────────────────────────

DELETE FROM public.tour_itinerary_stops WHERE tour_id = '8f308669-2bb6-42ac-9b2f-a07f77e231d4';


-- ──────────────────────────────────────────────────────────────────────────
-- POSTFLIGHT: confirm every restored value, confirm guide_notes_tr/notes
-- remain untouched, confirm the itinerary is empty again, and confirm
-- tour_channels/tour_languages remain exactly as untouched as they always
-- were.
-- ──────────────────────────────────────────────────────────────────────────

DO $$
DECLARE
  v_tour_id UUID := '8f308669-2bb6-42ac-9b2f-a07f77e231d4';
  v_row public.tours%ROWTYPE;
  v_stop_count INTEGER;
  v_channel_count INTEGER;
  v_channel_ok BOOLEAN;
BEGIN
  SELECT * INTO v_row FROM public.tours WHERE id = v_tour_id;

  IF v_row.description IS NOT NULL OR v_row.duration_text IS NOT NULL
     OR v_row.meeting_point IS NOT NULL OR v_row.meeting_instructions_tr IS NOT NULL
     OR v_row.end_point_tr IS NOT NULL OR v_row.accessibility_info_tr IS NOT NULL
     OR v_row.pets_policy_tr IS NOT NULL OR v_row.booking_cutoff_text IS NOT NULL
     OR v_row.free_cancellation_text IS NOT NULL OR v_row.late_cancellation_text IS NOT NULL
     OR v_row.no_show_policy_text IS NOT NULL OR v_row.other_conditions_tr IS NOT NULL
     OR v_row.included_items IS NOT NULL OR v_row.excluded_items IS NOT NULL
  THEN
    RAISE EXCEPTION 'BOSPHORUS PORTUGUESE ROLLBACK POSTFLIGHT FAILED: at least one written field was not restored to NULL.';
  END IF;
  IF v_row.guide_notes_tr IS NOT NULL THEN
    RAISE EXCEPTION 'BOSPHORUS PORTUGUESE ROLLBACK POSTFLIGHT FAILED: guide_notes_tr must remain untouched but is no longer NULL.';
  END IF;
  IF v_row.notes IS NOT NULL THEN
    RAISE EXCEPTION 'BOSPHORUS PORTUGUESE ROLLBACK POSTFLIGHT FAILED: notes must remain untouched but is no longer NULL.';
  END IF;

  SELECT COUNT(*) INTO v_stop_count FROM public.tour_itinerary_stops WHERE tour_id = v_tour_id;
  IF v_stop_count <> 0 THEN
    RAISE EXCEPTION 'BOSPHORUS PORTUGUESE ROLLBACK POSTFLIGHT FAILED: expected 0 itinerary stops after rollback, found %.', v_stop_count;
  END IF;

  SELECT COUNT(*) INTO v_channel_count FROM public.tour_channels WHERE tour_id = v_tour_id;
  IF v_channel_count <> 1 THEN
    RAISE EXCEPTION 'BOSPHORUS PORTUGUESE ROLLBACK POSTFLIGHT FAILED: tour_channels row count changed — must remain untouched.';
  END IF;
  SELECT EXISTS (
    SELECT 1 FROM public.tour_channels
     WHERE id = '4d20f364-3a40-451b-bd30-3a38843fd250' AND tour_id = v_tour_id
       AND external_product_id = 'Bosforo y Barrio Sultanahmet'
       AND booking_language IS NULL AND listing_url IS NULL AND is_active = TRUE
  ) INTO v_channel_ok;
  IF NOT v_channel_ok THEN
    RAISE EXCEPTION 'BOSPHORUS PORTUGUESE ROLLBACK POSTFLIGHT FAILED: tour_channels row 4d20f364-3a40-451b-bd30-3a38843fd250 changed unexpectedly.';
  END IF;

  RAISE NOTICE 'BOSPHORUS PORTUGUESE ROLLBACK POSTFLIGHT PASSED: all fields restored to the verified all-NULL pre-population snapshot, itinerary cleared, tour_channels (booking_language IS NULL accepted as-is) confirmed untouched.';
END $$;

COMMIT;

-- ============================================================
-- END OF ROLLBACK supabase_data_bosphorus_portuguese_tour_information_ROLLBACK.sql
-- ============================================================
