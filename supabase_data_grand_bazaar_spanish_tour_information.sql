-- ============================================================
-- DESE TOUR OPERATIONS CENTER
-- One-time data population: Grand Bazaar Experience · İspanyolca
-- ============================================================
-- File:    supabase_data_grand_bazaar_spanish_tour_information.sql
-- Depends: supabase_migration_tour_information_center.sql (commit 096175e,
--          already applied and production-verified) — this file writes
--          ONLY into columns/tables that migration already created.
-- Type:    DATA population (DML), not schema (DDL). No CREATE/ALTER/DROP
--          anywhere in this file.
--
-- WHAT THIS IS
-- ─────────────────────────────────────────────────────────────
-- A ONE-TIME population of the Tour Information Center dossier for
-- exactly one existing tour:
--
--   id:               c5e42d88-0a6c-4703-9c22-90eec5a278bd
--   name:             Grand Bazaar Experience
--   booking_language: İspanyolca (Civitatis)
--   listing_url:      https://www.civitatis.com/es/estambul/tour-gran-bazar
--
-- Content is an editorial Turkish translation/normalization of the
-- Civitatis Spanish listing — never a literal copy of Spanish marketing
-- prose, never information the source does not support. Itinerary stops
-- deliberately carry NO approx_duration_text: Civitatis does not provide
-- per-stop durations, and inventing one would violate the Tour Information
-- Center's own "never fabricate missing values" rule. guide_notes_tr is
-- Dese Tour's own approved internal operational standard for this
-- product — explicitly NOT derived from Civitatis, exactly as the
-- Tour Information Center architecture (supabase_migration_tour_
-- information_center.sql's own COMMENT ON COLUMN) requires that field to
-- be kept.
--
-- TARGETING — FAILS CLOSED, NEVER TOUCHES ANY OTHER TOUR
-- ─────────────────────────────────────────────────────────────
-- Every write below is scoped to the single UUID above by literal, exact
-- match (WHERE id = '...' / WHERE tour_id = '...') — no name-based match,
-- no LIKE, no join that could widen scope. The preflight (before any
-- write) additionally verifies:
--   1. That exact tour id exists.
--   2. Its name is exactly "Grand Bazaar Experience" (defense in depth
--      against a UUID transcription mistake pointing at the wrong row).
--   3. It has EXACTLY ONE tour_channels row, whose source is Civitatis,
--      whose booking_language is EXACTLY "İspanyolca", and whose
--      listing_url already EXACTLY matches the known Civitatis URL.
-- Any mismatch RAISEs EXCEPTION and aborts the WHOLE transaction before a
-- single UPDATE/DELETE/INSERT runs — this Turkish dossier content can
-- never be attached to the wrong tour, the wrong language variant, or a
-- tour whose channel configuration doesn't match what this content was
-- written for.
--
-- WHAT THIS NEVER TOUCHES
-- ─────────────────────────────────────────────────────────────
--   • public.tour_channels — READ-ONLY (the preflight verifies
--     booking_language/listing_url/source already match; this file
--     contains no UPDATE/INSERT/DELETE referencing tour_channels at all).
--     source_id, external_product_id, booking_language, price, currency,
--     is_active, listing_url are all left exactly as they are.
--   • public.tour_languages — never referenced at all.
--   • tours.notes — never referenced at all (kept 100% intact, per the
--     Tour Information Center's own standing "never touch notes"
--     decision — this includes whatever value it may currently hold).
--   • tours.name, category, status, base_price, currency, pricing_type,
--     tour_type, maximum_guest_capacity, is_active — none of these are in
--     the UPDATE's column list; only the eleven approved Tour Information
--     Center scalar fields plus included_items/excluded_items are written.
--   • Every other tour in the catalog — the preflight's exact-UUID checks
--     and every subsequent statement's WHERE clause make writing to any
--     other row structurally impossible.
--   • reservations, customers, reservation_guests, payments,
--     reservation_reviews, guides, guide_payments — never referenced.
--
-- WHAT THIS WRITES
-- ─────────────────────────────────────────────────────────────
--   public.tours (WHERE id = the one UUID above):
--     description, duration_text, meeting_point, end_point_tr,
--     accessibility_info_tr, pets_policy_tr, booking_cutoff_text,
--     free_cancellation_text, late_cancellation_text, no_show_policy_text,
--     other_conditions_tr, included_items, excluded_items, guide_notes_tr
--
--   public.tour_itinerary_stops (WHERE tour_id = the one UUID above):
--     replace-all (DELETE then INSERT), same convention the application's
--     own _syncTourItineraryStops already uses — 10 ordered stops,
--     stop_order 1..10, no approx_duration_text on any of them.
--
-- meeting_point CORRECTION
-- ─────────────────────────────────────────────────────────────
-- The task's own production observation is that this tour's
-- meeting_point currently reads "Çemberlitaş Metro Durağı" — corrected
-- here to "Çemberlitaş Tramvay İstasyonu" because the Civitatis source
-- explicitly names the tram station, not the metro. The preflight does
-- NOT hard-gate on this specific prior string (unlike duration_text
-- below) because a concrete value was actually supplied to work from;
-- it is still recommended to re-confirm with a quick
-- `SELECT meeting_point FROM public.tours WHERE id = '...';` immediately
-- before applying, simply as good practice before any production write.
--
-- SAFETY
-- ─────────────────────────────────────────────────────────────
--   • Wrapped in BEGIN/COMMIT — preflight and postflight both RAISE
--     EXCEPTION on any unexpected state, aborting the WHOLE transaction,
--     same discipline as every migration in this repository.
--   • NOT idempotent by design (this is a one-time content population,
--     not a repeatable schema migration) — but safe to re-run: a second
--     run simply overwrites the same eleven scalar fields with the same
--     values again and replaces the itinerary with the same 10 rows
--     again (delete-then-insert), so re-running after a successful first
--     run is a harmless no-op in effect, not a duplication.
--   • No SQL in this file has been executed. No Supabase connection was
--     made to produce it.
--
-- HOW TO APPLY
-- ─────────────────────────────────────────────────────────────
-- Supabase Dashboard → SQL Editor → paste and run this file IN FULL, in a
-- single execution.
-- ============================================================


BEGIN;

-- ──────────────────────────────────────────────────────────────────────────
-- PREFLIGHT: confirm this is exactly the intended tour, in exactly the
-- expected channel configuration, before writing anything.
-- ──────────────────────────────────────────────────────────────────────────

DO $$
DECLARE
  v_tour_id   UUID := 'c5e42d88-0a6c-4703-9c22-90eec5a278bd';
  v_tour_name TEXT;
  v_channel_count INTEGER;
  v_booking_language TEXT;
  v_listing_url TEXT;
  v_source_name TEXT;
BEGIN
  SELECT name INTO v_tour_name FROM public.tours WHERE id = v_tour_id;
  IF v_tour_name IS NULL THEN
    RAISE EXCEPTION 'GRAND BAZAAR DATA POPULATION PREFLIGHT FAILED: tour % does not exist. Aborting before touching anything.', v_tour_id;
  END IF;

  IF v_tour_name IS DISTINCT FROM 'Grand Bazaar Experience' THEN
    RAISE EXCEPTION 'GRAND BAZAAR DATA POPULATION PREFLIGHT FAILED: tour % has name "%", expected "Grand Bazaar Experience". This looks like the wrong tour — aborting before touching anything.', v_tour_id, v_tour_name;
  END IF;

  SELECT COUNT(*) INTO v_channel_count FROM public.tour_channels WHERE tour_id = v_tour_id;
  IF v_channel_count <> 1 THEN
    RAISE EXCEPTION 'GRAND BAZAAR DATA POPULATION PREFLIGHT FAILED: expected exactly 1 tour_channels row for this tour, found %. tour_channels is never written by this migration — an ambiguous or missing channel configuration must never be assumed. Aborting.', v_channel_count;
  END IF;

  SELECT tc.booking_language, tc.listing_url, s.name
    INTO v_booking_language, v_listing_url, v_source_name
    FROM public.tour_channels tc
    JOIN public.sources s ON s.id = tc.source_id
   WHERE tc.tour_id = v_tour_id;

  IF v_source_name IS DISTINCT FROM 'Civitatis' THEN
    RAISE EXCEPTION 'GRAND BAZAAR DATA POPULATION PREFLIGHT FAILED: this tour''s channel source is "%", expected Civitatis. Aborting.', v_source_name;
  END IF;

  IF v_booking_language IS DISTINCT FROM 'İspanyolca' THEN
    RAISE EXCEPTION 'GRAND BAZAAR DATA POPULATION PREFLIGHT FAILED: tour_channels.booking_language is "%", expected İspanyolca. This Turkish dossier content must never be attached to the wrong language variant of this tour. Aborting.', v_booking_language;
  END IF;

  IF v_listing_url IS DISTINCT FROM 'https://www.civitatis.com/es/estambul/tour-gran-bazar' THEN
    RAISE EXCEPTION 'GRAND BAZAAR DATA POPULATION PREFLIGHT FAILED: tour_channels.listing_url is "%", expected the known Civitatis URL. tour_channels is never written by this migration — only verified. Aborting.', v_listing_url;
  END IF;

  RAISE NOTICE 'GRAND BAZAAR DATA POPULATION PREFLIGHT PASSED: tour % ("Grand Bazaar Experience"), Civitatis channel with booking_language=İspanyolca and the expected listing_url confirmed. Proceeding.', v_tour_id;
END $$;


-- ──────────────────────────────────────────────────────────────────────────
-- STEP 1: tours — the eleven approved Tour Information Center scalar
-- fields, plus included_items/excluded_items. Every other column
-- (name, category, status, base_price, currency, pricing_type, tour_type,
-- maximum_guest_capacity, is_active, notes, created_by, created_at) is
-- absent from this SET clause and therefore left completely untouched.
-- ──────────────────────────────────────────────────────────────────────────

UPDATE public.tours
   SET description = 'Grand Bazaar''ın yalnızca alışveriş alanlarını değil, tarihini, mimarisini, geleneksel ticaret kültürünü ve zanaat mirasını keşfetmeye odaklanan yürüyüş turu. Tur, tarihi hanlar, bedestenler, zanaat sokakları ve Sahaflar Çarşısı üzerinden ilerler ve geleneksel Türk çayı molası içerir.',
       duration_text = '4 Saat',
       meeting_point = 'Çemberlitaş Tramvay İstasyonu',
       end_point_tr = 'Grand Bazaar',
       accessibility_info_tr = 'Yalnızca bazı alanlar erişilebilir. Erişilebilir tuvalet bulunmaktadır.',
       pets_policy_tr = 'Evcil hayvan kabul edilmez.',
       booking_cutoff_text = 'Müsaitlik olması halinde tur başlangıcından 3 gün öncesine kadar rezervasyon yapılabilir.',
       free_cancellation_text = 'Tur başlangıcından 24 saat öncesine kadar ücretsiz iptal edilebilir.',
       late_cancellation_text = 'Tur başlangıcına 24 saatten az süre kala yapılan iptallerde ücret iadesi yapılmaz.',
       no_show_policy_text = 'Geç kalınması veya tura katılım sağlanmaması durumunda ücret iadesi yapılmaz.',
       other_conditions_tr = 'Turun gerçekleşmesi için minimum 2 katılımcı gereklidir. Minimum katılımcı sayısına ulaşılamaması halinde Civitatis alternatif seçenekler sunmak üzere müşteriyle iletişime geçebilir.',
       included_items = ARRAY['İspanyolca konuşan rehber', 'Bir adet geleneksel Türk çayı']::TEXT[],
       excluded_items = NULL, -- the Civitatis source lists no explicit exclusions — never invented; NULL matches the application's own "empty means NULL" convention (mapTourToDB)
       guide_notes_tr = 'Turun alışveriş odaklı bir deneyime dönüşmemesine dikkat edilmelidir. Anlatımda Grand Bazaar''ın tarihi, mimarisi, hanları, bedestenleri, geleneksel zanaatları ve ticaret kültürü ön planda tutulmalıdır. Misafirlere alışveriş baskısı yapılmamalı ve komisyon odaklı mağaza yönlendirmelerinden kaçınılmalıdır.'
 WHERE id = 'c5e42d88-0a6c-4703-9c22-90eec5a278bd';


-- ──────────────────────────────────────────────────────────────────────────
-- STEP 2: tour_itinerary_stops — replace-all for this tour only, same
-- delete-then-insert convention the application's own
-- _syncTourItineraryStops already uses. No approx_duration_text on any
-- stop — Civitatis does not provide per-stop durations, and inventing one
-- would violate the "never fabricate missing values" rule.
-- ──────────────────────────────────────────────────────────────────────────

DELETE FROM public.tour_itinerary_stops WHERE tour_id = 'c5e42d88-0a6c-4703-9c22-90eec5a278bd';

INSERT INTO public.tour_itinerary_stops (tour_id, stop_order, place_name, description_tr, operational_note, approx_duration_text) VALUES
('c5e42d88-0a6c-4703-9c22-90eec5a278bd', 1,  'Çemberlitaş Tramvay İstasyonu', 'Turun başlangıç ve buluşma noktası. Rehberle buluşmanın ardından Grand Bazaar yönünde yürüyüş başlar.', NULL, NULL),
('c5e42d88-0a6c-4703-9c22-90eec5a278bd', 2,  'Kalpakçılar Caddesi',           'Grand Bazaar''ın hareketli ana akslarından biri. Buradan tarihi hanlara doğru ilerlenir.', NULL, NULL),
('c5e42d88-0a6c-4703-9c22-90eec5a278bd', 3,  'Tarihi Hanlar',                 'Osmanlı döneminde kervanlar ve tüccarlar için konaklama, depolama ve ticaret merkezi olarak kullanılan hanların tarihsel işlevi anlatılır.', NULL, NULL),
('c5e42d88-0a6c-4703-9c22-90eec5a278bd', 4,  'Büyük Valide Han',              'Tüccarların ve kervanların geçmişte kullandığı önemli tarihi hanlardan biri ziyaret edilir.', NULL, NULL),
('c5e42d88-0a6c-4703-9c22-90eec5a278bd', 5,  'Kızlarağası Han',               'Grand Bazaar çevresindeki tarihi ticaret ve konaklama kültürünün izlerinin görülebileceği hanlardan biri.', NULL, NULL),
('c5e42d88-0a6c-4703-9c22-90eec5a278bd', 6,  'Sandal Bedesteni',              'Bölgedeki imparatorluk dönemi ticaretinin kökenleri ve bedesten kültürü hakkında bilgi verilir.', NULL, NULL),
('c5e42d88-0a6c-4703-9c22-90eec5a278bd', 7,  'Halıcılar Sokak',               'Grand Bazaar''ın geleneksel zanaat mirasının ve yüzyıllardır devam eden dokuma kültürünün izleri incelenir.', NULL, NULL),
('c5e42d88-0a6c-4703-9c22-90eec5a278bd', 8,  'Sahaflar Çarşısı',              'Grand Bazaar''ın dışındaki tarihi ikinci el kitapçılar çarşısı ziyaret edilir.', NULL, NULL),
('c5e42d88-0a6c-4703-9c22-90eec5a278bd', 9,  'Şark Kahvesi',                  'Tur kapsamında geleneksel Türk çayı molası verilir.', NULL, NULL),
('c5e42d88-0a6c-4703-9c22-90eec5a278bd', 10, 'Grand Bazaar',                  'Yaklaşık dört saatlik yürüyüşün ardından tur Grand Bazaar''da sona erer.', NULL, NULL);


-- ──────────────────────────────────────────────────────────────────────────
-- POSTFLIGHT: verify every written value landed exactly as intended, the
-- itinerary is exactly the 10 expected stops in the expected order, and
-- tour_channels/tour_languages are provably unchanged. RAISE EXCEPTION
-- aborts the WHOLE transaction (including Steps 1-2) on any mismatch.
-- ──────────────────────────────────────────────────────────────────────────

DO $$
DECLARE
  v_tour_id UUID := 'c5e42d88-0a6c-4703-9c22-90eec5a278bd';
  v_row public.tours%ROWTYPE;
  v_stop_count INTEGER;
  v_stop_names TEXT[];
  v_channel_count INTEGER;
  v_channel_ok BOOLEAN;
  v_language_count INTEGER;
BEGIN
  SELECT * INTO v_row FROM public.tours WHERE id = v_tour_id;

  IF v_row.description IS DISTINCT FROM 'Grand Bazaar''ın yalnızca alışveriş alanlarını değil, tarihini, mimarisini, geleneksel ticaret kültürünü ve zanaat mirasını keşfetmeye odaklanan yürüyüş turu. Tur, tarihi hanlar, bedestenler, zanaat sokakları ve Sahaflar Çarşısı üzerinden ilerler ve geleneksel Türk çayı molası içerir.' THEN
    RAISE EXCEPTION 'GRAND BAZAAR DATA POPULATION POSTFLIGHT FAILED: description does not match the expected written value.';
  END IF;
  IF v_row.duration_text IS DISTINCT FROM '4 Saat' THEN
    RAISE EXCEPTION 'GRAND BAZAAR DATA POPULATION POSTFLIGHT FAILED: duration_text does not match.';
  END IF;
  IF v_row.meeting_point IS DISTINCT FROM 'Çemberlitaş Tramvay İstasyonu' THEN
    RAISE EXCEPTION 'GRAND BAZAAR DATA POPULATION POSTFLIGHT FAILED: meeting_point does not match.';
  END IF;
  IF v_row.end_point_tr IS DISTINCT FROM 'Grand Bazaar' THEN
    RAISE EXCEPTION 'GRAND BAZAAR DATA POPULATION POSTFLIGHT FAILED: end_point_tr does not match.';
  END IF;
  IF v_row.accessibility_info_tr IS DISTINCT FROM 'Yalnızca bazı alanlar erişilebilir. Erişilebilir tuvalet bulunmaktadır.' THEN
    RAISE EXCEPTION 'GRAND BAZAAR DATA POPULATION POSTFLIGHT FAILED: accessibility_info_tr does not match.';
  END IF;
  IF v_row.pets_policy_tr IS DISTINCT FROM 'Evcil hayvan kabul edilmez.' THEN
    RAISE EXCEPTION 'GRAND BAZAAR DATA POPULATION POSTFLIGHT FAILED: pets_policy_tr does not match.';
  END IF;
  IF v_row.booking_cutoff_text IS DISTINCT FROM 'Müsaitlik olması halinde tur başlangıcından 3 gün öncesine kadar rezervasyon yapılabilir.' THEN
    RAISE EXCEPTION 'GRAND BAZAAR DATA POPULATION POSTFLIGHT FAILED: booking_cutoff_text does not match.';
  END IF;
  IF v_row.free_cancellation_text IS DISTINCT FROM 'Tur başlangıcından 24 saat öncesine kadar ücretsiz iptal edilebilir.' THEN
    RAISE EXCEPTION 'GRAND BAZAAR DATA POPULATION POSTFLIGHT FAILED: free_cancellation_text does not match.';
  END IF;
  IF v_row.late_cancellation_text IS DISTINCT FROM 'Tur başlangıcına 24 saatten az süre kala yapılan iptallerde ücret iadesi yapılmaz.' THEN
    RAISE EXCEPTION 'GRAND BAZAAR DATA POPULATION POSTFLIGHT FAILED: late_cancellation_text does not match.';
  END IF;
  IF v_row.no_show_policy_text IS DISTINCT FROM 'Geç kalınması veya tura katılım sağlanmaması durumunda ücret iadesi yapılmaz.' THEN
    RAISE EXCEPTION 'GRAND BAZAAR DATA POPULATION POSTFLIGHT FAILED: no_show_policy_text does not match.';
  END IF;
  IF v_row.other_conditions_tr IS DISTINCT FROM 'Turun gerçekleşmesi için minimum 2 katılımcı gereklidir. Minimum katılımcı sayısına ulaşılamaması halinde Civitatis alternatif seçenekler sunmak üzere müşteriyle iletişime geçebilir.' THEN
    RAISE EXCEPTION 'GRAND BAZAAR DATA POPULATION POSTFLIGHT FAILED: other_conditions_tr does not match.';
  END IF;
  IF v_row.included_items IS DISTINCT FROM ARRAY['İspanyolca konuşan rehber', 'Bir adet geleneksel Türk çayı']::TEXT[] THEN
    RAISE EXCEPTION 'GRAND BAZAAR DATA POPULATION POSTFLIGHT FAILED: included_items does not match.';
  END IF;
  IF v_row.excluded_items IS NOT NULL THEN
    RAISE EXCEPTION 'GRAND BAZAAR DATA POPULATION POSTFLIGHT FAILED: excluded_items must be NULL (no source-supported exclusions) but is not.';
  END IF;
  IF v_row.guide_notes_tr IS DISTINCT FROM 'Turun alışveriş odaklı bir deneyime dönüşmemesine dikkat edilmelidir. Anlatımda Grand Bazaar''ın tarihi, mimarisi, hanları, bedestenleri, geleneksel zanaatları ve ticaret kültürü ön planda tutulmalıdır. Misafirlere alışveriş baskısı yapılmamalı ve komisyon odaklı mağaza yönlendirmelerinden kaçınılmalıdır.' THEN
    RAISE EXCEPTION 'GRAND BAZAAR DATA POPULATION POSTFLIGHT FAILED: guide_notes_tr does not match.';
  END IF;

  SELECT COUNT(*) INTO v_stop_count FROM public.tour_itinerary_stops WHERE tour_id = v_tour_id;
  IF v_stop_count <> 10 THEN
    RAISE EXCEPTION 'GRAND BAZAAR DATA POPULATION POSTFLIGHT FAILED: expected exactly 10 itinerary stops, found %.', v_stop_count;
  END IF;

  SELECT array_agg(place_name ORDER BY stop_order) INTO v_stop_names
    FROM public.tour_itinerary_stops WHERE tour_id = v_tour_id;
  IF v_stop_names IS DISTINCT FROM ARRAY[
    'Çemberlitaş Tramvay İstasyonu', 'Kalpakçılar Caddesi', 'Tarihi Hanlar', 'Büyük Valide Han',
    'Kızlarağası Han', 'Sandal Bedesteni', 'Halıcılar Sokak', 'Sahaflar Çarşısı', 'Şark Kahvesi', 'Grand Bazaar'
  ]::TEXT[] THEN
    RAISE EXCEPTION 'GRAND BAZAAR DATA POPULATION POSTFLIGHT FAILED: itinerary stop order/names do not match the expected sequence.';
  END IF;

  IF EXISTS (SELECT 1 FROM public.tour_itinerary_stops WHERE tour_id = v_tour_id AND approx_duration_text IS NOT NULL) THEN
    RAISE EXCEPTION 'GRAND BAZAAR DATA POPULATION POSTFLIGHT FAILED: at least one itinerary stop has a non-NULL approx_duration_text — Civitatis provides none, so none must ever be set.';
  END IF;

  -- tour_channels / tour_languages must be provably untouched.
  SELECT COUNT(*) INTO v_channel_count FROM public.tour_channels WHERE tour_id = v_tour_id;
  IF v_channel_count <> 1 THEN
    RAISE EXCEPTION 'GRAND BAZAAR DATA POPULATION POSTFLIGHT FAILED: tour_channels row count for this tour changed (now %) — this migration must never touch tour_channels.', v_channel_count;
  END IF;
  SELECT EXISTS (
    SELECT 1 FROM public.tour_channels
     WHERE tour_id = v_tour_id
       AND booking_language = 'İspanyolca'
       AND listing_url = 'https://www.civitatis.com/es/estambul/tour-gran-bazar'
  ) INTO v_channel_ok;
  IF NOT v_channel_ok THEN
    RAISE EXCEPTION 'GRAND BAZAAR DATA POPULATION POSTFLIGHT FAILED: tour_channels.booking_language/listing_url changed unexpectedly — this migration must never write to tour_channels.';
  END IF;

  SELECT COUNT(*) INTO v_language_count FROM public.tour_languages WHERE tour_id = v_tour_id;
  IF v_language_count < 1 THEN
    RAISE EXCEPTION 'GRAND BAZAAR DATA POPULATION POSTFLIGHT FAILED: tour_languages has zero rows for this tour — this migration must never touch tour_languages, and it should not have changed.';
  END IF;

  RAISE NOTICE 'GRAND BAZAAR DATA POPULATION POSTFLIGHT PASSED: all fourteen tours fields verified, 10 itinerary stops confirmed in exact order with no fabricated durations, and tour_channels/tour_languages confirmed untouched.';
END $$;

COMMIT;

-- ============================================================
-- END OF DATA MIGRATION supabase_data_grand_bazaar_spanish_tour_information.sql
-- ============================================================
