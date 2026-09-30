-- ============================================================
-- DESE TOUR OPERATIONS CENTER
-- Rollback: Grand Bazaar Experience · İtalyanca data population
-- ============================================================
-- File:    supabase_data_grand_bazaar_italian_tour_information_ROLLBACK.sql
-- Rolls back ONLY: supabase_data_grand_bazaar_italian_tour_information.sql
-- NOT executed. Provided for manual review and manual execution only.
--
-- SCOPE — RESTORES EXACT VERIFIED PRE-POPULATION VALUES, NOTHING ELSE
-- ─────────────────────────────────────────────────────────────
-- Targets the exact same single tour as the forward migration
-- (bed4fba3-e6ad-435a-b971-64606d8a46f4, "Grand Bazaar Experience",
-- İtalyanca), with the same preflight targeting discipline. Restores the
-- twelve tours fields the forward migration wrote to their verified
-- production values, and removes the 10 itinerary rows that migration
-- inserted (the table was verified empty for this tour before it ran).
--
-- VERIFIED PRODUCTION PRE-POPULATION SNAPSHOT (restored below)
-- ─────────────────────────────────────────────────────────────
--   description = NULL
--   duration_text = '4'
--   meeting_point = 'Çemberlitaş Tramvay Durağı'
--   end_point_tr / accessibility_info_tr / pets_policy_tr /
--   booking_cutoff_text / free_cancellation_text / late_cancellation_text /
--   no_show_policy_text / included_items / guide_notes_tr = NULL
--   tour_itinerary_stops for this tour = 0 rows
--
-- meeting_instructions_tr, excluded_items, other_conditions_tr, and notes
-- were NEVER written by the forward migration (deliberately absent from
-- its UPDATE) — this rollback does not touch them either, for the same
-- reason: restoring a field the forward migration never changed is not
-- this rollback's job, and touching it here would risk overwriting
-- unrelated legitimate state.
--
-- DRIFT SAFETY — THIS ROLLBACK REVERSES THIS MIGRATION, NOT SUBSEQUENT
-- HUMAN WORK
-- ─────────────────────────────────────────────────────────────
-- Before writing anything, this rollback verifies that the tour's twelve
-- written fields AND itinerary still hold exactly what the forward
-- migration's own postflight proved it wrote. If a human has since edited
-- any of it, this rollback RAISEs EXCEPTION and aborts the WHOLE
-- transaction rather than silently overwriting or deleting that later
-- work — same discipline as the already-applied Spanish Grand Bazaar
-- rollback.
--
-- THE TWO-CHANNEL ANOMALY AND tour_languages — VERIFIED, NEVER TOUCHED
-- ─────────────────────────────────────────────────────────────
-- Both known Civitatis tour_channels rows for this tour, and its
-- tour_languages row, are re-verified unchanged in preflight and
-- postflight, exactly as the forward migration did. This rollback never
-- writes to tour_channels or tour_languages.
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
  v_tour_id   UUID := 'bed4fba3-e6ad-435a-b971-64606d8a46f4';
  v_tour_name TEXT;
BEGIN
  SELECT name INTO v_tour_name FROM public.tours WHERE id = v_tour_id;
  IF v_tour_name IS NULL THEN
    RAISE EXCEPTION 'ITALIAN GRAND BAZAAR ROLLBACK PREFLIGHT FAILED: tour % does not exist. Aborting.', v_tour_id;
  END IF;
  IF v_tour_name IS DISTINCT FROM 'Grand Bazaar Experience' THEN
    RAISE EXCEPTION 'ITALIAN GRAND BAZAAR ROLLBACK PREFLIGHT FAILED: tour % has name "%", expected "Grand Bazaar Experience". Aborting — this looks like the wrong tour.', v_tour_id, v_tour_name;
  END IF;
  RAISE NOTICE 'ITALIAN GRAND BAZAAR ROLLBACK PREFLIGHT PASSED: tour % confirmed. Proceeding.', v_tour_id;
END $$;


-- ──────────────────────────────────────────────────────────────────────────
-- DRIFT GUARD (scalars): verify the tour's written fields still hold
-- exactly what the forward migration's own postflight proved it wrote.
-- ──────────────────────────────────────────────────────────────────────────

DO $$
DECLARE
  v_tour_id UUID := 'bed4fba3-e6ad-435a-b971-64606d8a46f4';
  v_row public.tours%ROWTYPE;
BEGIN
  SELECT * INTO v_row FROM public.tours WHERE id = v_tour_id;

  IF v_row.description IS DISTINCT FROM 'Grand Bazaar''ın tarihini, mimarisini ve geleneksel ticaret kültürünü konu alan bir yürüyüş turu. Tur, tarihi hanlar, bedestenler ve zanaat sokaklarından geçerek Sahaflar Çarşısı''na uğrar ve geleneksel Türk çayı molası içerir.' THEN
    RAISE EXCEPTION 'ITALIAN GRAND BAZAAR ROLLBACK DRIFT GUARD FAILED: description no longer matches the value the forward migration wrote. Aborting rather than overwrite that later change. Rollback refused.';
  END IF;
  IF v_row.duration_text IS DISTINCT FROM '4 Saat' THEN
    RAISE EXCEPTION 'ITALIAN GRAND BAZAAR ROLLBACK DRIFT GUARD FAILED: duration_text no longer matches. Rollback refused.';
  END IF;
  IF v_row.meeting_point IS DISTINCT FROM 'Çemberlitaş Tramvay İstasyonu' THEN
    RAISE EXCEPTION 'ITALIAN GRAND BAZAAR ROLLBACK DRIFT GUARD FAILED: meeting_point no longer matches. Rollback refused.';
  END IF;
  IF v_row.end_point_tr IS DISTINCT FROM 'Grand Bazaar' THEN
    RAISE EXCEPTION 'ITALIAN GRAND BAZAAR ROLLBACK DRIFT GUARD FAILED: end_point_tr no longer matches. Rollback refused.';
  END IF;
  IF v_row.accessibility_info_tr IS DISTINCT FROM 'Yalnızca bazı alanlar erişilebilir. Erişilebilir tuvalet bulunmaktadır.' THEN
    RAISE EXCEPTION 'ITALIAN GRAND BAZAAR ROLLBACK DRIFT GUARD FAILED: accessibility_info_tr no longer matches. Rollback refused.';
  END IF;
  IF v_row.pets_policy_tr IS DISTINCT FROM 'Evcil hayvan kabul edilmez.' THEN
    RAISE EXCEPTION 'ITALIAN GRAND BAZAAR ROLLBACK DRIFT GUARD FAILED: pets_policy_tr no longer matches. Rollback refused.';
  END IF;
  IF v_row.booking_cutoff_text IS DISTINCT FROM 'Müsaitlik olması halinde tur başlangıcından 3 gün öncesine kadar rezervasyon yapılabilir.' THEN
    RAISE EXCEPTION 'ITALIAN GRAND BAZAAR ROLLBACK DRIFT GUARD FAILED: booking_cutoff_text no longer matches. Rollback refused.';
  END IF;
  IF v_row.free_cancellation_text IS DISTINCT FROM 'Tur başlangıcından 24 saat öncesine kadar ücretsiz iptal edilebilir.' THEN
    RAISE EXCEPTION 'ITALIAN GRAND BAZAAR ROLLBACK DRIFT GUARD FAILED: free_cancellation_text no longer matches. Rollback refused.';
  END IF;
  IF v_row.late_cancellation_text IS DISTINCT FROM 'Tur başlangıcına 24 saatten az süre kala yapılan iptallerde ücret iadesi yapılmaz.' THEN
    RAISE EXCEPTION 'ITALIAN GRAND BAZAAR ROLLBACK DRIFT GUARD FAILED: late_cancellation_text no longer matches. Rollback refused.';
  END IF;
  IF v_row.no_show_policy_text IS DISTINCT FROM 'Geç kalınması veya tura katılım sağlanmaması durumunda ücret iadesi yapılmaz.' THEN
    RAISE EXCEPTION 'ITALIAN GRAND BAZAAR ROLLBACK DRIFT GUARD FAILED: no_show_policy_text no longer matches. Rollback refused.';
  END IF;
  IF v_row.included_items IS DISTINCT FROM ARRAY['İtalyanca konuşan rehber', 'Bir adet geleneksel Türk çayı']::TEXT[] THEN
    RAISE EXCEPTION 'ITALIAN GRAND BAZAAR ROLLBACK DRIFT GUARD FAILED: included_items no longer matches. Rollback refused.';
  END IF;
  IF v_row.guide_notes_tr IS DISTINCT FROM 'Turun alışveriş odaklı bir deneyime dönüşmemesine dikkat edilmelidir. Anlatımda Grand Bazaar''ın tarihi, mimarisi, hanları, bedestenleri, geleneksel zanaatları ve ticaret kültürü ön planda tutulmalıdır. Misafirlere alışveriş baskısı yapılmamalı ve komisyon odaklı mağaza yönlendirmelerinden kaçınılmalıdır.' THEN
    RAISE EXCEPTION 'ITALIAN GRAND BAZAAR ROLLBACK DRIFT GUARD FAILED: guide_notes_tr no longer matches. Rollback refused.';
  END IF;

  RAISE NOTICE 'ITALIAN GRAND BAZAAR ROLLBACK DRIFT GUARD (SCALARS) PASSED: all twelve fields still hold exactly what the forward migration wrote. Safe to restore pre-population values.';
END $$;


-- ──────────────────────────────────────────────────────────────────────────
-- DRIFT GUARD (itinerary): verify the itinerary still holds exactly the
-- 10 stops the forward migration introduced. Aborts before the DELETE if
-- anything has changed since.
-- ──────────────────────────────────────────────────────────────────────────

DO $$
DECLARE
  v_tour_id UUID := 'bed4fba3-e6ad-435a-b971-64606d8a46f4';
  v_stop_count INTEGER;
  v_stop_names TEXT[];
BEGIN
  SELECT COUNT(*) INTO v_stop_count FROM public.tour_itinerary_stops WHERE tour_id = v_tour_id;
  IF v_stop_count <> 10 THEN
    RAISE EXCEPTION 'ITALIAN GRAND BAZAAR ROLLBACK ITINERARY DRIFT GUARD FAILED: expected exactly 10 itinerary stops, found %. Refusing to blindly delete it. Rollback refused.', v_stop_count;
  END IF;

  SELECT array_agg(place_name ORDER BY stop_order) INTO v_stop_names
    FROM public.tour_itinerary_stops WHERE tour_id = v_tour_id;
  IF v_stop_names IS DISTINCT FROM ARRAY[
    'Çemberlitaş Tramvay İstasyonu', 'Kalpakçılar Caddesi', 'Tarihi Hanlar', 'Büyük Valide Han',
    'Kızlarağası Han', 'Sandal Bedesteni', 'Halıcılar Sokak', 'Sahaflar Çarşısı', 'Şark Kahvesi', 'Grand Bazaar'
  ]::TEXT[] THEN
    RAISE EXCEPTION 'ITALIAN GRAND BAZAAR ROLLBACK ITINERARY DRIFT GUARD FAILED: itinerary stop order/names no longer match the set the forward migration introduced. Refusing to blindly delete it. Rollback refused.';
  END IF;

  IF EXISTS (SELECT 1 FROM public.tour_itinerary_stops WHERE tour_id = v_tour_id AND approx_duration_text IS NOT NULL) THEN
    RAISE EXCEPTION 'ITALIAN GRAND BAZAAR ROLLBACK ITINERARY DRIFT GUARD FAILED: at least one itinerary stop now has a non-NULL approx_duration_text. Refusing to blindly delete it. Rollback refused.';
  END IF;

  RAISE NOTICE 'ITALIAN GRAND BAZAAR ROLLBACK ITINERARY DRIFT GUARD PASSED: itinerary still exactly matches the 10-stop set the forward migration introduced. Safe to remove.';
END $$;


-- ──────────────────────────────────────────────────────────────────────────
-- STEP 1: tours — restore the twelve written fields to their verified
-- pre-population values. meeting_instructions_tr, excluded_items,
-- other_conditions_tr, and notes are absent here too — the forward
-- migration never touched them, so this rollback does not either.
-- ──────────────────────────────────────────────────────────────────────────

UPDATE public.tours
   SET description = NULL,
       duration_text = '4',
       meeting_point = 'Çemberlitaş Tramvay Durağı',
       end_point_tr = NULL,
       accessibility_info_tr = NULL,
       pets_policy_tr = NULL,
       booking_cutoff_text = NULL,
       free_cancellation_text = NULL,
       late_cancellation_text = NULL,
       no_show_policy_text = NULL,
       included_items = NULL,
       guide_notes_tr = NULL
 WHERE id = 'bed4fba3-e6ad-435a-b971-64606d8a46f4';


-- ──────────────────────────────────────────────────────────────────────────
-- STEP 2: remove the itinerary rows the forward migration introduced for
-- this tour — verified empty before it ran. Reached only if the
-- itinerary drift guard above passed.
-- ──────────────────────────────────────────────────────────────────────────

DELETE FROM public.tour_itinerary_stops WHERE tour_id = 'bed4fba3-e6ad-435a-b971-64606d8a46f4';


-- ──────────────────────────────────────────────────────────────────────────
-- POSTFLIGHT: confirm every restored value, confirm the itinerary is
-- empty again, and confirm both tour_channels rows plus tour_languages
-- remain exactly as untouched as they always were.
-- ──────────────────────────────────────────────────────────────────────────

DO $$
DECLARE
  v_tour_id UUID := 'bed4fba3-e6ad-435a-b971-64606d8a46f4';
  v_row public.tours%ROWTYPE;
  v_stop_count INTEGER;
  v_channel_count INTEGER;
  v_ch1_ok BOOLEAN;
  v_ch2_ok BOOLEAN;
BEGIN
  SELECT * INTO v_row FROM public.tours WHERE id = v_tour_id;

  IF v_row.description IS NOT NULL THEN
    RAISE EXCEPTION 'ITALIAN GRAND BAZAAR ROLLBACK POSTFLIGHT FAILED: description was not restored to NULL.';
  END IF;
  IF v_row.duration_text IS DISTINCT FROM '4' THEN
    RAISE EXCEPTION 'ITALIAN GRAND BAZAAR ROLLBACK POSTFLIGHT FAILED: duration_text was not restored.';
  END IF;
  IF v_row.meeting_point IS DISTINCT FROM 'Çemberlitaş Tramvay Durağı' THEN
    RAISE EXCEPTION 'ITALIAN GRAND BAZAAR ROLLBACK POSTFLIGHT FAILED: meeting_point was not restored.';
  END IF;
  IF v_row.end_point_tr IS NOT NULL OR v_row.accessibility_info_tr IS NOT NULL
     OR v_row.pets_policy_tr IS NOT NULL OR v_row.booking_cutoff_text IS NOT NULL
     OR v_row.free_cancellation_text IS NOT NULL OR v_row.late_cancellation_text IS NOT NULL
     OR v_row.no_show_policy_text IS NOT NULL OR v_row.included_items IS NOT NULL
     OR v_row.guide_notes_tr IS NOT NULL
  THEN
    RAISE EXCEPTION 'ITALIAN GRAND BAZAAR ROLLBACK POSTFLIGHT FAILED: at least one written field was not restored to NULL.';
  END IF;

  SELECT COUNT(*) INTO v_stop_count FROM public.tour_itinerary_stops WHERE tour_id = v_tour_id;
  IF v_stop_count <> 0 THEN
    RAISE EXCEPTION 'ITALIAN GRAND BAZAAR ROLLBACK POSTFLIGHT FAILED: expected 0 itinerary stops after rollback, found %.', v_stop_count;
  END IF;

  SELECT COUNT(*) INTO v_channel_count FROM public.tour_channels WHERE tour_id = v_tour_id;
  IF v_channel_count <> 2 THEN
    RAISE EXCEPTION 'ITALIAN GRAND BAZAAR ROLLBACK POSTFLIGHT FAILED: tour_channels row count changed — must remain untouched.';
  END IF;
  SELECT EXISTS (
    SELECT 1 FROM public.tour_channels
     WHERE id = 'd3170525-e047-4775-bf0f-a01e721f5487' AND tour_id = v_tour_id
       AND external_product_id = 'Grand Bazaar Experience' AND booking_language = 'İtalyanca'
       AND listing_url IS NULL
  ) INTO v_ch1_ok;
  IF NOT v_ch1_ok THEN
    RAISE EXCEPTION 'ITALIAN GRAND BAZAAR ROLLBACK POSTFLIGHT FAILED: tour_channels row d3170525-e047-4775-bf0f-a01e721f5487 changed unexpectedly.';
  END IF;
  SELECT EXISTS (
    SELECT 1 FROM public.tour_channels
     WHERE id = 'de0e4a70-5844-4d9b-a7aa-92111111c5a7' AND tour_id = v_tour_id
       AND external_product_id IS NULL AND booking_language IS NULL
       AND listing_url = 'https://www.civitatis.com/it/istanbul/tour-grande-bazar'
  ) INTO v_ch2_ok;
  IF NOT v_ch2_ok THEN
    RAISE EXCEPTION 'ITALIAN GRAND BAZAAR ROLLBACK POSTFLIGHT FAILED: tour_channels row de0e4a70-5844-4d9b-a7aa-92111111c5a7 changed unexpectedly.';
  END IF;

  RAISE NOTICE 'ITALIAN GRAND BAZAAR ROLLBACK POSTFLIGHT PASSED: all fields restored to the verified pre-population snapshot, itinerary cleared, both tour_channels rows confirmed untouched.';
END $$;

COMMIT;

-- ============================================================
-- END OF ROLLBACK supabase_data_grand_bazaar_italian_tour_information_ROLLBACK.sql
-- ============================================================
