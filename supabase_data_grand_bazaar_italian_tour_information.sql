-- ============================================================
-- DESE TOUR OPERATIONS CENTER
-- One-time data population: Grand Bazaar Experience · İtalyanca
-- ============================================================
-- File:    supabase_data_grand_bazaar_italian_tour_information.sql
-- Depends: supabase_migration_tour_information_center.sql (already applied
--          and production-verified) — this file writes ONLY into columns/
--          tables that migration already created.
-- Type:    DATA population (DML), not schema (DDL). No CREATE/ALTER/DROP
--          anywhere in this file.
--
-- WHAT THIS IS
-- ─────────────────────────────────────────────────────────────
-- A ONE-TIME population of the Tour Information Center dossier for
-- exactly one existing tour:
--
--   id:               bed4fba3-e6ad-435a-b971-64606d8a46f4
--   name:             Grand Bazaar Experience
--   tour language:    İtalyanca
--
-- Content is an editorial Turkish translation/normalization of the
-- Civitatis Italian listing (https://www.civitatis.com/it/istanbul/
-- tour-grande-bazar) — never a literal copy of Italian marketing prose,
-- never information the source does not support. This is the SAME
-- physical route as the already-populated Spanish Grand Bazaar variant
-- (c5e42d88-0a6c-4703-9c22-90eec5a278bd) — the Italian source lists the
-- identical 10 stops — so the itinerary stop descriptions reuse the same
-- already-vetted factual Turkish text. Itinerary stops deliberately carry
-- NO approx_duration_text: Civitatis does not provide per-stop durations
-- for this product, and inventing one would violate the Tour Information
-- Center's own "never fabricate missing values" rule. guide_notes_tr
-- reuses the SAME approved Dese Tour internal operational standard
-- already used for the Spanish variant — explicitly NOT derived from
-- Civitatis.
--
-- LEFT UNCHANGED — NOT PART OF THIS POPULATION
-- ─────────────────────────────────────────────────────────────
-- Per the production snapshot and task instructions, three fields are
-- deliberately ABSENT from the UPDATE's SET clause below (never touched,
-- not even set to NULL):
--   • meeting_instructions_tr — instructed to leave unchanged.
--   • excluded_items          — Civitatis source lists no explicit
--     exclusions for this variant; never invented. Left unchanged.
--   • other_conditions_tr     — no source-supported minimum-participant
--     (or other) condition was established for this specific variant.
--     Left unchanged.
--
-- TARGETING — FAILS CLOSED, NEVER TOUCHES ANY OTHER TOUR
-- ─────────────────────────────────────────────────────────────
-- Every write below is scoped to the single UUID above by literal, exact
-- match (WHERE id = '...' / WHERE tour_id = '...') — no name-based match,
-- no LIKE, no join that could widen scope. The preflight (before any
-- write) additionally verifies:
--   1. That exact tour id exists, with name exactly "Grand Bazaar
--      Experience".
--   2. That tour_languages has a row for this tour with language_name
--      exactly "İtalyanca".
--   3. The tour's CURRENT Tour Information Center snapshot matches
--      EXACTLY the verified production read (every field below) — so a
--      write can never silently land on top of state that has drifted
--      since that snapshot was taken.
--   4. That the itinerary is currently EMPTY (0 rows) — this migration
--      inserts a brand-new itinerary; it never overwrites one that
--      already exists.
--   5. The KNOWN TWO-CHANNEL production state for this tour — see below.
-- Any mismatch RAISEs EXCEPTION and aborts the WHOLE transaction before a
-- single UPDATE/DELETE/INSERT runs.
--
-- THE TWO-CHANNEL ANOMALY — VERIFIED, NOT REPAIRED
-- ─────────────────────────────────────────────────────────────
-- Production has TWO Civitatis tour_channels rows for this one tour_id
-- (normally tour_channels has UNIQUE(tour_id, source_id), so this is an
-- unusual state — explicitly OUT OF SCOPE for this migration, which is
-- Tour Information Center dossier population only):
--   Row 1  id=d3170525-e047-4775-bf0f-a01e721f5487
--          external_product_id='Grand Bazaar Experience'
--          booking_language='İtalyanca', listing_url=NULL
--   Row 2  id=de0e4a70-5844-4d9b-a7aa-92111111c5a7
--          external_product_id=NULL, booking_language=NULL
--          listing_url='https://www.civitatis.com/it/istanbul/tour-grande-bazar'
-- The preflight verifies BOTH rows exist with EXACTLY these values, and
-- the postflight re-verifies both are still exactly as they were. Neither
-- row is ever written to, merged, deleted, or otherwise touched by this
-- file. Any channel normalization is a separate future cleanup task.
--
-- WHAT THIS NEVER TOUCHES
-- ─────────────────────────────────────────────────────────────
--   • public.tour_channels — READ-ONLY (verified in preflight/postflight
--     only). Neither of the two rows above is ever written to.
--   • public.tour_languages — READ-ONLY (verified in preflight/postflight
--     only); never written.
--   • tours.notes — never referenced at all (kept 100% intact).
--   • tours.name, category, status, base_price, currency, pricing_type,
--     tour_type, maximum_guest_capacity, is_active — none of these are in
--     the UPDATE's column list.
--   • meeting_instructions_tr, excluded_items, other_conditions_tr — see
--     "LEFT UNCHANGED" above.
--   • Every other tour in the catalog — the preflight's exact-UUID checks
--     and every subsequent statement's WHERE clause make writing to any
--     other row structurally impossible.
--   • reservations, customers, reservation_guests, payments,
--     reservation_reviews, guides, guide_payments, activity_logs — never
--     referenced.
--
-- WHAT THIS WRITES
-- ─────────────────────────────────────────────────────────────
--   public.tours (WHERE id = the one UUID above):
--     description, duration_text, meeting_point, end_point_tr,
--     accessibility_info_tr, pets_policy_tr, booking_cutoff_text,
--     free_cancellation_text, late_cancellation_text, no_show_policy_text,
--     included_items, guide_notes_tr
--
--   public.tour_itinerary_stops (WHERE tour_id = the one UUID above):
--     insert-only (preflight already confirms 0 pre-existing rows) — 10
--     ordered stops, stop_order 1..10, no approx_duration_text on any.
--
-- meeting_point CORRECTION
-- ─────────────────────────────────────────────────────────────
-- Verified production value is "Çemberlitaş Tramvay Durağı" — corrected
-- here to "Çemberlitaş Tramvay İstasyonu" (the same corrected wording
-- used for the Spanish variant) because the Civitatis source names the
-- tram station by its full name. The preflight hard-gates on the exact
-- verified prior string before applying this correction.
--
-- SAFETY
-- ─────────────────────────────────────────────────────────────
--   • Wrapped in BEGIN/COMMIT — preflight and postflight both RAISE
--     EXCEPTION on any unexpected state, aborting the WHOLE transaction.
--   • NOT idempotent by design — a second run's preflight will fail
--     closed (the itinerary is no longer empty and the snapshot no longer
--     matches the original NULL/duration_text='4' state), which is the
--     correct, safe behavior for a one-time population.
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
-- PREFLIGHT STEP 1: identity, tour_languages, and the known two-channel
-- state — verified READ-ONLY, before writing anything.
-- ──────────────────────────────────────────────────────────────────────────

DO $$
DECLARE
  v_tour_id   UUID := 'bed4fba3-e6ad-435a-b971-64606d8a46f4';
  v_tour_name TEXT;
  v_channel_count INTEGER;
  v_ch1_ok BOOLEAN;
  v_ch2_ok BOOLEAN;
  v_language_ok BOOLEAN;
BEGIN
  SELECT name INTO v_tour_name FROM public.tours WHERE id = v_tour_id;
  IF v_tour_name IS NULL THEN
    RAISE EXCEPTION 'ITALIAN GRAND BAZAAR PREFLIGHT FAILED: tour % does not exist. Aborting before touching anything.', v_tour_id;
  END IF;
  IF v_tour_name IS DISTINCT FROM 'Grand Bazaar Experience' THEN
    RAISE EXCEPTION 'ITALIAN GRAND BAZAAR PREFLIGHT FAILED: tour % has name "%", expected "Grand Bazaar Experience". Aborting — this looks like the wrong tour.', v_tour_id, v_tour_name;
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM public.tour_languages WHERE tour_id = v_tour_id AND language_name = 'İtalyanca'
  ) INTO v_language_ok;
  IF NOT v_language_ok THEN
    RAISE EXCEPTION 'ITALIAN GRAND BAZAAR PREFLIGHT FAILED: tour_languages has no İtalyanca row for this tour. tour_languages is never written by this migration — only verified. Aborting.';
  END IF;

  SELECT COUNT(*) INTO v_channel_count FROM public.tour_channels WHERE tour_id = v_tour_id;
  IF v_channel_count <> 2 THEN
    RAISE EXCEPTION 'ITALIAN GRAND BAZAAR PREFLIGHT FAILED: expected exactly 2 tour_channels rows (the known verified anomaly) for this tour, found %. Aborting rather than assume.', v_channel_count;
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM public.tour_channels tc JOIN public.sources s ON s.id = tc.source_id
     WHERE tc.id = 'd3170525-e047-4775-bf0f-a01e721f5487' AND tc.tour_id = v_tour_id
       AND s.name = 'Civitatis' AND tc.external_product_id = 'Grand Bazaar Experience'
       AND tc.booking_language = 'İtalyanca' AND tc.listing_url IS NULL
  ) INTO v_ch1_ok;
  IF NOT v_ch1_ok THEN
    RAISE EXCEPTION 'ITALIAN GRAND BAZAAR PREFLIGHT FAILED: tour_channels row d3170525-e047-4775-bf0f-a01e721f5487 no longer matches the verified production state. tour_channels is never written by this migration — only verified. Aborting.';
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM public.tour_channels tc JOIN public.sources s ON s.id = tc.source_id
     WHERE tc.id = 'de0e4a70-5844-4d9b-a7aa-92111111c5a7' AND tc.tour_id = v_tour_id
       AND s.name = 'Civitatis' AND tc.external_product_id IS NULL
       AND tc.booking_language IS NULL
       AND tc.listing_url = 'https://www.civitatis.com/it/istanbul/tour-grande-bazar'
  ) INTO v_ch2_ok;
  IF NOT v_ch2_ok THEN
    RAISE EXCEPTION 'ITALIAN GRAND BAZAAR PREFLIGHT FAILED: tour_channels row de0e4a70-5844-4d9b-a7aa-92111111c5a7 no longer matches the verified production state. tour_channels is never written by this migration — only verified. Aborting.';
  END IF;

  RAISE NOTICE 'ITALIAN GRAND BAZAAR PREFLIGHT STEP 1 PASSED: tour % ("Grand Bazaar Experience"), İtalyanca tour_languages row confirmed, both known Civitatis channel rows confirmed unchanged. Proceeding.', v_tour_id;
END $$;


-- ──────────────────────────────────────────────────────────────────────────
-- PREFLIGHT STEP 2: the tour's CURRENT Tour Information Center snapshot
-- must match EXACTLY the verified production read below — never write on
-- top of state that has drifted since that snapshot was taken. Also fails
-- closed if an itinerary already exists.
-- ──────────────────────────────────────────────────────────────────────────

DO $$
DECLARE
  v_tour_id UUID := 'bed4fba3-e6ad-435a-b971-64606d8a46f4';
  v_row public.tours%ROWTYPE;
  v_stop_count INTEGER;
BEGIN
  SELECT * INTO v_row FROM public.tours WHERE id = v_tour_id;

  IF v_row.description IS NOT NULL THEN
    RAISE EXCEPTION 'ITALIAN GRAND BAZAAR PREFLIGHT FAILED: description is no longer NULL — production state has drifted since the verified snapshot. Aborting.';
  END IF;
  IF v_row.duration_text IS DISTINCT FROM '4' THEN
    RAISE EXCEPTION 'ITALIAN GRAND BAZAAR PREFLIGHT FAILED: duration_text is no longer the verified "4" — production state has drifted. Aborting.';
  END IF;
  IF v_row.meeting_point IS DISTINCT FROM 'Çemberlitaş Tramvay Durağı' THEN
    RAISE EXCEPTION 'ITALIAN GRAND BAZAAR PREFLIGHT FAILED: meeting_point is no longer the verified "Çemberlitaş Tramvay Durağı" — production state has drifted. Aborting.';
  END IF;
  IF v_row.meeting_instructions_tr IS NOT NULL OR v_row.end_point_tr IS NOT NULL
     OR v_row.accessibility_info_tr IS NOT NULL OR v_row.pets_policy_tr IS NOT NULL
     OR v_row.booking_cutoff_text IS NOT NULL OR v_row.free_cancellation_text IS NOT NULL
     OR v_row.late_cancellation_text IS NOT NULL OR v_row.no_show_policy_text IS NOT NULL
     OR v_row.other_conditions_tr IS NOT NULL OR v_row.included_items IS NOT NULL
     OR v_row.excluded_items IS NOT NULL OR v_row.guide_notes_tr IS NOT NULL
     OR v_row.notes IS NOT NULL
  THEN
    RAISE EXCEPTION 'ITALIAN GRAND BAZAAR PREFLIGHT FAILED: at least one field expected NULL in the verified production snapshot is no longer NULL. Aborting rather than overwrite drifted state.';
  END IF;

  SELECT COUNT(*) INTO v_stop_count FROM public.tour_itinerary_stops WHERE tour_id = v_tour_id;
  IF v_stop_count <> 0 THEN
    RAISE EXCEPTION 'ITALIAN GRAND BAZAAR PREFLIGHT FAILED: expected 0 pre-existing itinerary stops (verified production state), found %. This migration only inserts into an empty itinerary — aborting rather than overwrite existing rows.', v_stop_count;
  END IF;

  RAISE NOTICE 'ITALIAN GRAND BAZAAR PREFLIGHT STEP 2 PASSED: current state matches the verified production snapshot exactly, itinerary confirmed empty. Proceeding to write.';
END $$;


-- ──────────────────────────────────────────────────────────────────────────
-- STEP 1: tours — the twelve approved Tour Information Center fields for
-- this variant. meeting_instructions_tr, excluded_items, and
-- other_conditions_tr are deliberately absent from this SET clause (left
-- unchanged — see header). notes is never referenced.
-- ──────────────────────────────────────────────────────────────────────────

UPDATE public.tours
   SET description = 'Grand Bazaar''ın tarihini, mimarisini ve geleneksel ticaret kültürünü konu alan bir yürüyüş turu. Tur, tarihi hanlar, bedestenler ve zanaat sokaklarından geçerek Sahaflar Çarşısı''na uğrar ve geleneksel Türk çayı molası içerir.',
       duration_text = '4 Saat',
       meeting_point = 'Çemberlitaş Tramvay İstasyonu',
       end_point_tr = 'Grand Bazaar',
       accessibility_info_tr = 'Yalnızca bazı alanlar erişilebilir. Erişilebilir tuvalet bulunmaktadır.',
       pets_policy_tr = 'Evcil hayvan kabul edilmez.',
       booking_cutoff_text = 'Müsaitlik olması halinde tur başlangıcından 3 gün öncesine kadar rezervasyon yapılabilir.',
       free_cancellation_text = 'Tur başlangıcından 24 saat öncesine kadar ücretsiz iptal edilebilir.',
       late_cancellation_text = 'Tur başlangıcına 24 saatten az süre kala yapılan iptallerde ücret iadesi yapılmaz.',
       no_show_policy_text = 'Geç kalınması veya tura katılım sağlanmaması durumunda ücret iadesi yapılmaz.',
       included_items = ARRAY['İtalyanca konuşan rehber', 'Bir adet geleneksel Türk çayı']::TEXT[],
       guide_notes_tr = 'Turun alışveriş odaklı bir deneyime dönüşmemesine dikkat edilmelidir. Anlatımda Grand Bazaar''ın tarihi, mimarisi, hanları, bedestenleri, geleneksel zanaatları ve ticaret kültürü ön planda tutulmalıdır. Misafirlere alışveriş baskısı yapılmamalı ve komisyon odaklı mağaza yönlendirmelerinden kaçınılmalıdır.'
 WHERE id = 'bed4fba3-e6ad-435a-b971-64606d8a46f4';


-- ──────────────────────────────────────────────────────────────────────────
-- STEP 2: tour_itinerary_stops — INSERT ONLY (preflight already confirmed
-- 0 pre-existing rows). 10 ordered stops, no approx_duration_text — the
-- same route the already-populated Spanish variant uses.
-- ──────────────────────────────────────────────────────────────────────────

INSERT INTO public.tour_itinerary_stops (tour_id, stop_order, place_name, description_tr, operational_note, approx_duration_text) VALUES
('bed4fba3-e6ad-435a-b971-64606d8a46f4', 1,  'Çemberlitaş Tramvay İstasyonu', 'Turun başlangıç ve buluşma noktası. Rehberle buluşmanın ardından Grand Bazaar yönünde yürüyüş başlar.', NULL, NULL),
('bed4fba3-e6ad-435a-b971-64606d8a46f4', 2,  'Kalpakçılar Caddesi',           'Grand Bazaar''ın hareketli ana akslarından biri. Buradan tarihi hanlara doğru ilerlenir.', NULL, NULL),
('bed4fba3-e6ad-435a-b971-64606d8a46f4', 3,  'Tarihi Hanlar',                 'Osmanlı döneminde kervanlar ve tüccarlar için konaklama, depolama ve ticaret merkezi olarak kullanılan hanların tarihsel işlevi anlatılır.', NULL, NULL),
('bed4fba3-e6ad-435a-b971-64606d8a46f4', 4,  'Büyük Valide Han',              'Tüccarların ve kervanların geçmişte kullandığı önemli tarihi hanlardan biri ziyaret edilir.', NULL, NULL),
('bed4fba3-e6ad-435a-b971-64606d8a46f4', 5,  'Kızlarağası Han',               'Grand Bazaar çevresindeki tarihi ticaret ve konaklama kültürünün izlerinin görülebileceği hanlardan biri.', NULL, NULL),
('bed4fba3-e6ad-435a-b971-64606d8a46f4', 6,  'Sandal Bedesteni',              'Bölgedeki imparatorluk dönemi ticaretinin kökenleri ve bedesten kültürü hakkında bilgi verilir.', NULL, NULL),
('bed4fba3-e6ad-435a-b971-64606d8a46f4', 7,  'Halıcılar Sokak',               'Grand Bazaar''ın geleneksel zanaat mirasının ve yüzyıllardır devam eden dokuma kültürünün izleri incelenir.', NULL, NULL),
('bed4fba3-e6ad-435a-b971-64606d8a46f4', 8,  'Sahaflar Çarşısı',              'Grand Bazaar''ın dışındaki tarihi ikinci el kitapçılar çarşısı ziyaret edilir.', NULL, NULL),
('bed4fba3-e6ad-435a-b971-64606d8a46f4', 9,  'Şark Kahvesi',                  'Tur kapsamında geleneksel Türk çayı molası verilir.', NULL, NULL),
('bed4fba3-e6ad-435a-b971-64606d8a46f4', 10, 'Grand Bazaar',                  'Yaklaşık dört saatlik yürüyüşün ardından tur Grand Bazaar''da sona erer.', NULL, NULL);


-- ──────────────────────────────────────────────────────────────────────────
-- POSTFLIGHT: verify every written value landed exactly as intended, the
-- three "left unchanged" fields are STILL NULL (never touched), the
-- itinerary is exactly the 10 expected stops in order, and both
-- tour_channels rows plus tour_languages are provably unchanged.
-- ──────────────────────────────────────────────────────────────────────────

DO $$
DECLARE
  v_tour_id UUID := 'bed4fba3-e6ad-435a-b971-64606d8a46f4';
  v_row public.tours%ROWTYPE;
  v_stop_count INTEGER;
  v_stop_names TEXT[];
  v_channel_count INTEGER;
  v_ch1_ok BOOLEAN;
  v_ch2_ok BOOLEAN;
  v_language_ok BOOLEAN;
BEGIN
  SELECT * INTO v_row FROM public.tours WHERE id = v_tour_id;

  IF v_row.description IS DISTINCT FROM 'Grand Bazaar''ın tarihini, mimarisini ve geleneksel ticaret kültürünü konu alan bir yürüyüş turu. Tur, tarihi hanlar, bedestenler ve zanaat sokaklarından geçerek Sahaflar Çarşısı''na uğrar ve geleneksel Türk çayı molası içerir.' THEN
    RAISE EXCEPTION 'ITALIAN GRAND BAZAAR POSTFLIGHT FAILED: description does not match the expected written value.';
  END IF;
  IF v_row.duration_text IS DISTINCT FROM '4 Saat' THEN
    RAISE EXCEPTION 'ITALIAN GRAND BAZAAR POSTFLIGHT FAILED: duration_text does not match.';
  END IF;
  IF v_row.meeting_point IS DISTINCT FROM 'Çemberlitaş Tramvay İstasyonu' THEN
    RAISE EXCEPTION 'ITALIAN GRAND BAZAAR POSTFLIGHT FAILED: meeting_point does not match.';
  END IF;
  IF v_row.end_point_tr IS DISTINCT FROM 'Grand Bazaar' THEN
    RAISE EXCEPTION 'ITALIAN GRAND BAZAAR POSTFLIGHT FAILED: end_point_tr does not match.';
  END IF;
  IF v_row.accessibility_info_tr IS DISTINCT FROM 'Yalnızca bazı alanlar erişilebilir. Erişilebilir tuvalet bulunmaktadır.' THEN
    RAISE EXCEPTION 'ITALIAN GRAND BAZAAR POSTFLIGHT FAILED: accessibility_info_tr does not match.';
  END IF;
  IF v_row.pets_policy_tr IS DISTINCT FROM 'Evcil hayvan kabul edilmez.' THEN
    RAISE EXCEPTION 'ITALIAN GRAND BAZAAR POSTFLIGHT FAILED: pets_policy_tr does not match.';
  END IF;
  IF v_row.booking_cutoff_text IS DISTINCT FROM 'Müsaitlik olması halinde tur başlangıcından 3 gün öncesine kadar rezervasyon yapılabilir.' THEN
    RAISE EXCEPTION 'ITALIAN GRAND BAZAAR POSTFLIGHT FAILED: booking_cutoff_text does not match.';
  END IF;
  IF v_row.free_cancellation_text IS DISTINCT FROM 'Tur başlangıcından 24 saat öncesine kadar ücretsiz iptal edilebilir.' THEN
    RAISE EXCEPTION 'ITALIAN GRAND BAZAAR POSTFLIGHT FAILED: free_cancellation_text does not match.';
  END IF;
  IF v_row.late_cancellation_text IS DISTINCT FROM 'Tur başlangıcına 24 saatten az süre kala yapılan iptallerde ücret iadesi yapılmaz.' THEN
    RAISE EXCEPTION 'ITALIAN GRAND BAZAAR POSTFLIGHT FAILED: late_cancellation_text does not match.';
  END IF;
  IF v_row.no_show_policy_text IS DISTINCT FROM 'Geç kalınması veya tura katılım sağlanmaması durumunda ücret iadesi yapılmaz.' THEN
    RAISE EXCEPTION 'ITALIAN GRAND BAZAAR POSTFLIGHT FAILED: no_show_policy_text does not match.';
  END IF;
  IF v_row.included_items IS DISTINCT FROM ARRAY['İtalyanca konuşan rehber', 'Bir adet geleneksel Türk çayı']::TEXT[] THEN
    RAISE EXCEPTION 'ITALIAN GRAND BAZAAR POSTFLIGHT FAILED: included_items does not match.';
  END IF;
  IF v_row.guide_notes_tr IS DISTINCT FROM 'Turun alışveriş odaklı bir deneyime dönüşmemesine dikkat edilmelidir. Anlatımda Grand Bazaar''ın tarihi, mimarisi, hanları, bedestenleri, geleneksel zanaatları ve ticaret kültürü ön planda tutulmalıdır. Misafirlere alışveriş baskısı yapılmamalı ve komisyon odaklı mağaza yönlendirmelerinden kaçınılmalıdır.' THEN
    RAISE EXCEPTION 'ITALIAN GRAND BAZAAR POSTFLIGHT FAILED: guide_notes_tr does not match.';
  END IF;

  -- The three deliberately-untouched fields must still be exactly NULL.
  IF v_row.meeting_instructions_tr IS NOT NULL THEN
    RAISE EXCEPTION 'ITALIAN GRAND BAZAAR POSTFLIGHT FAILED: meeting_instructions_tr was supposed to be left unchanged (NULL) but is not.';
  END IF;
  IF v_row.excluded_items IS NOT NULL THEN
    RAISE EXCEPTION 'ITALIAN GRAND BAZAAR POSTFLIGHT FAILED: excluded_items was supposed to be left unchanged (NULL) but is not.';
  END IF;
  IF v_row.other_conditions_tr IS NOT NULL THEN
    RAISE EXCEPTION 'ITALIAN GRAND BAZAAR POSTFLIGHT FAILED: other_conditions_tr was supposed to be left unchanged (NULL) but is not.';
  END IF;
  IF v_row.notes IS NOT NULL THEN
    RAISE EXCEPTION 'ITALIAN GRAND BAZAAR POSTFLIGHT FAILED: notes must never be touched by this migration but is no longer NULL.';
  END IF;

  SELECT COUNT(*) INTO v_stop_count FROM public.tour_itinerary_stops WHERE tour_id = v_tour_id;
  IF v_stop_count <> 10 THEN
    RAISE EXCEPTION 'ITALIAN GRAND BAZAAR POSTFLIGHT FAILED: expected exactly 10 itinerary stops, found %.', v_stop_count;
  END IF;

  SELECT array_agg(place_name ORDER BY stop_order) INTO v_stop_names
    FROM public.tour_itinerary_stops WHERE tour_id = v_tour_id;
  IF v_stop_names IS DISTINCT FROM ARRAY[
    'Çemberlitaş Tramvay İstasyonu', 'Kalpakçılar Caddesi', 'Tarihi Hanlar', 'Büyük Valide Han',
    'Kızlarağası Han', 'Sandal Bedesteni', 'Halıcılar Sokak', 'Sahaflar Çarşısı', 'Şark Kahvesi', 'Grand Bazaar'
  ]::TEXT[] THEN
    RAISE EXCEPTION 'ITALIAN GRAND BAZAAR POSTFLIGHT FAILED: itinerary stop order/names do not match the expected sequence.';
  END IF;

  IF EXISTS (SELECT 1 FROM public.tour_itinerary_stops WHERE tour_id = v_tour_id AND approx_duration_text IS NOT NULL) THEN
    RAISE EXCEPTION 'ITALIAN GRAND BAZAAR POSTFLIGHT FAILED: at least one itinerary stop has a non-NULL approx_duration_text — none must ever be set for this variant.';
  END IF;

  -- Both known tour_channels rows must be provably unchanged.
  SELECT COUNT(*) INTO v_channel_count FROM public.tour_channels WHERE tour_id = v_tour_id;
  IF v_channel_count <> 2 THEN
    RAISE EXCEPTION 'ITALIAN GRAND BAZAAR POSTFLIGHT FAILED: tour_channels row count for this tour changed (now %) — this migration must never touch tour_channels.', v_channel_count;
  END IF;
  SELECT EXISTS (
    SELECT 1 FROM public.tour_channels
     WHERE id = 'd3170525-e047-4775-bf0f-a01e721f5487' AND tour_id = v_tour_id
       AND external_product_id = 'Grand Bazaar Experience' AND booking_language = 'İtalyanca'
       AND listing_url IS NULL
  ) INTO v_ch1_ok;
  IF NOT v_ch1_ok THEN
    RAISE EXCEPTION 'ITALIAN GRAND BAZAAR POSTFLIGHT FAILED: tour_channels row d3170525-e047-4775-bf0f-a01e721f5487 changed unexpectedly.';
  END IF;
  SELECT EXISTS (
    SELECT 1 FROM public.tour_channels
     WHERE id = 'de0e4a70-5844-4d9b-a7aa-92111111c5a7' AND tour_id = v_tour_id
       AND external_product_id IS NULL AND booking_language IS NULL
       AND listing_url = 'https://www.civitatis.com/it/istanbul/tour-grande-bazar'
  ) INTO v_ch2_ok;
  IF NOT v_ch2_ok THEN
    RAISE EXCEPTION 'ITALIAN GRAND BAZAAR POSTFLIGHT FAILED: tour_channels row de0e4a70-5844-4d9b-a7aa-92111111c5a7 changed unexpectedly.';
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM public.tour_languages WHERE tour_id = v_tour_id AND language_name = 'İtalyanca'
  ) INTO v_language_ok;
  IF NOT v_language_ok THEN
    RAISE EXCEPTION 'ITALIAN GRAND BAZAAR POSTFLIGHT FAILED: tour_languages no longer has the İtalyanca row for this tour — this migration must never touch tour_languages, and it should not have changed.';
  END IF;

  RAISE NOTICE 'ITALIAN GRAND BAZAAR POSTFLIGHT PASSED: all twelve written tours fields verified, three left-unchanged fields confirmed still NULL, 10 itinerary stops confirmed in exact order with no fabricated durations, both tour_channels rows and tour_languages confirmed untouched.';
END $$;

COMMIT;

-- ============================================================
-- END OF DATA MIGRATION supabase_data_grand_bazaar_italian_tour_information.sql
-- ============================================================
