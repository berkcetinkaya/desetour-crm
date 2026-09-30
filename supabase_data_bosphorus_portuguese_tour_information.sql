-- ============================================================
-- DESE TOUR OPERATIONS CENTER
-- One-time data population: Bosforo y Barrio Sultanahmet · Portekizce
-- ============================================================
-- File:    supabase_data_bosphorus_portuguese_tour_information.sql
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
--   id:               8f308669-2bb6-42ac-9b2f-a07f77e231d4
--   name (production): Bosforo y Barrio Sultanahmet
--   tour language:      Portekizce
--
-- Content is an editorial Turkish translation/normalization of the
-- Civitatis Portuguese listing (https://www.civitatis.com/pt/istambul/
-- cruzeiro-bosforo-sultanahmet) — never a literal copy of Portuguese
-- marketing prose, never information the source does not support. Lunch
-- is kept in included_items because the CURRENT published Civitatis
-- product still explicitly lists it — this migration reflects the
-- currently published marketplace product, not a future product change.
-- Three itinerary stops (Boğaz Tekne Turu, Sultanahmet Camii, Ayasofya)
-- legitimately receive approx_duration_text because the source explicitly
-- provides those durations — every other stop stays NULL, same
-- "never fabricate missing values" discipline as every other Tour
-- Information Center population in this repository.
--
-- LEFT UNCHANGED — NOT PART OF THIS POPULATION
-- ─────────────────────────────────────────────────────────────
-- guide_notes_tr is deliberately ABSENT from the UPDATE's SET clause
-- below (never touched, not even set to NULL). No approved Dese Tour
-- internal content exists for this product; marketplace content must
-- never be placed into this field, and the verified production value
-- (NULL) must not be silently overwritten with anything, including NULL
-- itself (which would still count as this migration having "written" it).
--
-- TARGETING — FAILS CLOSED, NEVER TOUCHES ANY OTHER TOUR
-- ─────────────────────────────────────────────────────────────
-- Every write below is scoped to the single UUID above by literal, exact
-- match (WHERE id = '...' / WHERE tour_id = '...') — no name-based match,
-- no LIKE, no join that could widen scope. The preflight (before any
-- write) additionally verifies:
--   1. That exact tour id exists, with name exactly "Bosforo y Barrio
--      Sultanahmet" (the verified PRODUCTION name — not translated).
--   2. That tour_languages has a row for this tour with language_name
--      exactly "Portekizce".
--   3. The known Civitatis tour_channels row for this tour — including
--      its VERIFIED booking_language IS NULL state (see below).
--   4. The tour's CURRENT Tour Information Center snapshot matches
--      EXACTLY the verified production read (every field is NULL) — so a
--      write can never silently land on top of state that has drifted.
--   5. That the itinerary is currently EMPTY (0 rows).
-- Any mismatch RAISEs EXCEPTION and aborts the WHOLE transaction before a
-- single UPDATE/INSERT runs.
--
-- booking_language IS NULL — VERIFIED, NOT REPAIRED
-- ─────────────────────────────────────────────────────────────
-- The verified production state of this tour's ONE Civitatis
-- tour_channels row (id=4d20f364-3a40-451b-bd30-3a38843fd250) is
-- booking_language IS NULL and listing_url IS NULL. This migration
-- explicitly ACCEPTS that NULL state as correct for identity-matching
-- purposes (matching on external_product_id='Bosforo y Barrio
-- Sultanahmet' instead) and does not attempt to repair or set
-- booking_language or listing_url — tour_channels is read-only here, full
-- stop. Any channel-data repair is a separate future task, out of scope.
--
-- WHAT THIS NEVER TOUCHES
-- ─────────────────────────────────────────────────────────────
--   • public.tour_channels — READ-ONLY (verified in preflight/postflight
--     only); never written, including booking_language/listing_url.
--   • public.tour_languages — READ-ONLY (verified in preflight/postflight
--     only); never written.
--   • tours.notes — never referenced at all (kept 100% intact).
--   • tours.guide_notes_tr — see "LEFT UNCHANGED" above.
--   • tours.name, category, status, base_price, currency, pricing_type,
--     tour_type, maximum_guest_capacity, is_active — none of these are in
--     the UPDATE's column list.
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
--     description, duration_text, meeting_point, meeting_instructions_tr,
--     end_point_tr, accessibility_info_tr, pets_policy_tr,
--     booking_cutoff_text, free_cancellation_text, late_cancellation_text,
--     no_show_policy_text, other_conditions_tr, included_items,
--     excluded_items
--
--   public.tour_itinerary_stops (WHERE tour_id = the one UUID above):
--     insert-only (preflight already confirms 0 pre-existing rows) — 9
--     ordered stops, stop_order 1..9. approx_duration_text is set on
--     exactly 3 of them (Boğaz Tekne Turu, Sultanahmet Camii, Ayasofya) —
--     the only ones the source explicitly supports a duration for.
--
-- SAFETY
-- ─────────────────────────────────────────────────────────────
--   • Wrapped in BEGIN/COMMIT — preflight and postflight both RAISE
--     EXCEPTION on any unexpected state, aborting the WHOLE transaction.
--   • NOT idempotent by design — a second run's preflight will fail
--     closed (the itinerary is no longer empty and the snapshot no longer
--     matches the original all-NULL state), which is the correct, safe
--     behavior for a one-time population.
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
-- PREFLIGHT STEP 1: identity, tour_languages, and the known Civitatis
-- channel state (including its verified booking_language IS NULL) —
-- verified READ-ONLY, before writing anything.
-- ──────────────────────────────────────────────────────────────────────────

DO $$
DECLARE
  v_tour_id   UUID := '8f308669-2bb6-42ac-9b2f-a07f77e231d4';
  v_tour_name TEXT;
  v_channel_count INTEGER;
  v_channel_ok BOOLEAN;
  v_language_ok BOOLEAN;
BEGIN
  SELECT name INTO v_tour_name FROM public.tours WHERE id = v_tour_id;
  IF v_tour_name IS NULL THEN
    RAISE EXCEPTION 'BOSPHORUS PORTUGUESE PREFLIGHT FAILED: tour % does not exist. Aborting before touching anything.', v_tour_id;
  END IF;
  IF v_tour_name IS DISTINCT FROM 'Bosforo y Barrio Sultanahmet' THEN
    RAISE EXCEPTION 'BOSPHORUS PORTUGUESE PREFLIGHT FAILED: tour % has name "%", expected "Bosforo y Barrio Sultanahmet". Aborting — this looks like the wrong tour.', v_tour_id, v_tour_name;
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM public.tour_languages WHERE tour_id = v_tour_id AND language_name = 'Portekizce'
  ) INTO v_language_ok;
  IF NOT v_language_ok THEN
    RAISE EXCEPTION 'BOSPHORUS PORTUGUESE PREFLIGHT FAILED: tour_languages has no Portekizce row for this tour. tour_languages is never written by this migration — only verified. Aborting.';
  END IF;

  SELECT COUNT(*) INTO v_channel_count FROM public.tour_channels WHERE tour_id = v_tour_id;
  IF v_channel_count <> 1 THEN
    RAISE EXCEPTION 'BOSPHORUS PORTUGUESE PREFLIGHT FAILED: expected exactly 1 tour_channels row for this tour, found %. Aborting.', v_channel_count;
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM public.tour_channels tc JOIN public.sources s ON s.id = tc.source_id
     WHERE tc.id = '4d20f364-3a40-451b-bd30-3a38843fd250' AND tc.tour_id = v_tour_id
       AND s.name = 'Civitatis' AND tc.external_product_id = 'Bosforo y Barrio Sultanahmet'
       AND tc.booking_language IS NULL AND tc.listing_url IS NULL AND tc.is_active = TRUE
  ) INTO v_channel_ok;
  IF NOT v_channel_ok THEN
    RAISE EXCEPTION 'BOSPHORUS PORTUGUESE PREFLIGHT FAILED: tour_channels row 4d20f364-3a40-451b-bd30-3a38843fd250 no longer matches the verified production state (including its verified booking_language IS NULL). tour_channels is never written by this migration — only verified. Aborting.';
  END IF;

  RAISE NOTICE 'BOSPHORUS PORTUGUESE PREFLIGHT STEP 1 PASSED: tour % ("Bosforo y Barrio Sultanahmet"), Portekizce tour_languages row confirmed, known Civitatis channel row (booking_language IS NULL, accepted as-is) confirmed unchanged. Proceeding.', v_tour_id;
END $$;


-- ──────────────────────────────────────────────────────────────────────────
-- PREFLIGHT STEP 2: the tour's CURRENT Tour Information Center snapshot
-- must be entirely NULL, matching the verified production read exactly.
-- Also fails closed if an itinerary already exists.
-- ──────────────────────────────────────────────────────────────────────────

DO $$
DECLARE
  v_tour_id UUID := '8f308669-2bb6-42ac-9b2f-a07f77e231d4';
  v_row public.tours%ROWTYPE;
  v_stop_count INTEGER;
BEGIN
  SELECT * INTO v_row FROM public.tours WHERE id = v_tour_id;

  IF v_row.description IS NOT NULL OR v_row.duration_text IS NOT NULL
     OR v_row.meeting_point IS NOT NULL OR v_row.meeting_instructions_tr IS NOT NULL
     OR v_row.end_point_tr IS NOT NULL OR v_row.accessibility_info_tr IS NOT NULL
     OR v_row.pets_policy_tr IS NOT NULL OR v_row.booking_cutoff_text IS NOT NULL
     OR v_row.free_cancellation_text IS NOT NULL OR v_row.late_cancellation_text IS NOT NULL
     OR v_row.no_show_policy_text IS NOT NULL OR v_row.other_conditions_tr IS NOT NULL
     OR v_row.included_items IS NOT NULL OR v_row.excluded_items IS NOT NULL
     OR v_row.guide_notes_tr IS NOT NULL OR v_row.notes IS NOT NULL
  THEN
    RAISE EXCEPTION 'BOSPHORUS PORTUGUESE PREFLIGHT FAILED: at least one field expected NULL in the verified production snapshot is no longer NULL. Aborting rather than overwrite drifted state.';
  END IF;

  SELECT COUNT(*) INTO v_stop_count FROM public.tour_itinerary_stops WHERE tour_id = v_tour_id;
  IF v_stop_count <> 0 THEN
    RAISE EXCEPTION 'BOSPHORUS PORTUGUESE PREFLIGHT FAILED: expected 0 pre-existing itinerary stops (verified production state), found %. This migration only inserts into an empty itinerary — aborting rather than overwrite existing rows.', v_stop_count;
  END IF;

  RAISE NOTICE 'BOSPHORUS PORTUGUESE PREFLIGHT STEP 2 PASSED: current state matches the verified all-NULL production snapshot exactly, itinerary confirmed empty. Proceeding to write.';
END $$;


-- ──────────────────────────────────────────────────────────────────────────
-- STEP 1: tours — the fourteen approved Tour Information Center fields
-- for this variant. guide_notes_tr is deliberately absent from this SET
-- clause (left unchanged — see header). notes is never referenced.
-- ──────────────────────────────────────────────────────────────────────────

UPDATE public.tours
   SET description = 'Mısır Çarşısı, Eminönü ve Boğaz''da tekne turu ile başlayan; öğle yemeğinin ardından Hipodrom Meydanı, Sultanahmet Camii ve Ayasofya ziyaretleriyle devam eden bir şehir turu.',
       duration_text = '7 Saat',
       meeting_point = 'Tamara Restaurant Sultanahmet (08:45) veya The Marmara Hotel Taksim (08:10)',
       meeting_instructions_tr = 'Misafirler rezervasyon sırasında seçtikleri buluşma noktasından belirtilen saatte alınır.',
       end_point_tr = 'Sultanahmet merkezi veya Taksim bölgesi',
       accessibility_info_tr = 'Tekerlekli sandalye kullanımına uygun değildir.',
       pets_policy_tr = 'Evcil hayvan kabul edilmez.',
       booking_cutoff_text = 'Müsaitlik olması halinde tur başlangıcından 1 gün öncesine kadar rezervasyon yapılabilir.',
       free_cancellation_text = 'Tur başlangıcından 48 saat öncesine kadar ücretsiz iptal edilebilir.',
       late_cancellation_text = 'Tur başlangıcına 48 saatten az süre kala yapılan iptallerde ücret iadesi yapılmaz.',
       no_show_policy_text = 'Geç kalınması veya tura katılım sağlanmaması durumunda ücret iadesi yapılmaz.',
       other_conditions_tr = 'Minimum 2 katılımcı gereklidir. Ayasofya ziyareti ikinci kattaki galeri bölümünü kapsar. Ayasofya biletindeki QR kod üzerinden sesli rehbere erişilebilir ve bunu dinlemek için misafirlerin kendi kulaklıklarını getirmeleri gerekir. Cuma sabahları camiler kapalıdır ve cuma günleri güzergah sırası değiştirilebilir.',
       included_items = ARRAY['Klimalı araçla ulaşım', 'Portekizce konuşan rehber', 'Boğaz tekne turu', 'Ziyaret edilen yerler için öncelikli giriş biletleri', 'Öğle yemeği']::TEXT[],
       excluded_items = ARRAY['İçecekler']::TEXT[]
 WHERE id = '8f308669-2bb6-42ac-9b2f-a07f77e231d4';


-- ──────────────────────────────────────────────────────────────────────────
-- STEP 2: tour_itinerary_stops — INSERT ONLY (preflight already confirmed
-- 0 pre-existing rows). 9 ordered stops. approx_duration_text is set on
-- exactly 3 stops the source explicitly supports a duration for; every
-- other stop's approx_duration_text is NULL.
-- ──────────────────────────────────────────────────────────────────────────

INSERT INTO public.tour_itinerary_stops (tour_id, stop_order, place_name, description_tr, operational_note, approx_duration_text) VALUES
('8f308669-2bb6-42ac-9b2f-a07f77e231d4', 1, 'Buluşma / Pickup',                'Misafirler seçtikleri buluşma noktasından alınarak tura başlanır.', NULL, NULL),
('8f308669-2bb6-42ac-9b2f-a07f77e231d4', 2, 'Mısır Çarşısı',                   'Baharat ve geleneksel ürünleriyle bilinen tarihi çarşı ziyaret edilir.', NULL, NULL),
('8f308669-2bb6-42ac-9b2f-a07f77e231d4', 3, 'Eminönü ve Tekne İskelesi',       'Boğaz tekne turunun başlayacağı iskeleye geçilir.', NULL, NULL),
('8f308669-2bb6-42ac-9b2f-a07f77e231d4', 4, 'Boğaz Tekne Turu',                'İstanbul Boğazı''nın iki yakası tekneyle gezilir.', NULL, 'Yaklaşık 1,5 saat'),
('8f308669-2bb6-42ac-9b2f-a07f77e231d4', 5, 'Geleneksel Restoran / Öğle Yemeği','Tur kapsamında geleneksel bir restoranda öğle yemeği verilir.', NULL, NULL),
('8f308669-2bb6-42ac-9b2f-a07f77e231d4', 6, 'Hipodrom Meydanı',                'Bizans dönemine ait tarihi hipodrom alanı gezilir.', NULL, NULL),
('8f308669-2bb6-42ac-9b2f-a07f77e231d4', 7, 'Sultanahmet Camii',               'Mimarisiyle bilinen tarihi cami ziyaret edilir.', NULL, 'Yaklaşık 1 saat'),
('8f308669-2bb6-42ac-9b2f-a07f77e231d4', 8, 'Ayasofya',                        'Tarihi ve mimari önemiyle bilinen Ayasofya ziyaret edilir.', NULL, 'Yaklaşık 1 saat'),
('8f308669-2bb6-42ac-9b2f-a07f77e231d4', 9, 'Sultanahmet veya Taksim',         'Tur, misafirlerin alındığı bölgeye bağlı olarak Sultanahmet veya Taksim''de sona erer.', NULL, NULL);


-- ──────────────────────────────────────────────────────────────────────────
-- POSTFLIGHT: verify every written value landed exactly as intended,
-- guide_notes_tr and notes are STILL NULL (never touched), the itinerary
-- is exactly the 9 expected stops in order with durations on only the
-- 3 supported stops, and tour_channels/tour_languages are provably
-- unchanged (including the accepted booking_language IS NULL state).
-- ──────────────────────────────────────────────────────────────────────────

DO $$
DECLARE
  v_tour_id UUID := '8f308669-2bb6-42ac-9b2f-a07f77e231d4';
  v_row public.tours%ROWTYPE;
  v_stop_count INTEGER;
  v_stop_names TEXT[];
  v_channel_count INTEGER;
  v_channel_ok BOOLEAN;
  v_language_ok BOOLEAN;
  v_duration_stops INTEGER;
BEGIN
  SELECT * INTO v_row FROM public.tours WHERE id = v_tour_id;

  IF v_row.description IS DISTINCT FROM 'Mısır Çarşısı, Eminönü ve Boğaz''da tekne turu ile başlayan; öğle yemeğinin ardından Hipodrom Meydanı, Sultanahmet Camii ve Ayasofya ziyaretleriyle devam eden bir şehir turu.' THEN
    RAISE EXCEPTION 'BOSPHORUS PORTUGUESE POSTFLIGHT FAILED: description does not match the expected written value.';
  END IF;
  IF v_row.duration_text IS DISTINCT FROM '7 Saat' THEN
    RAISE EXCEPTION 'BOSPHORUS PORTUGUESE POSTFLIGHT FAILED: duration_text does not match.';
  END IF;
  IF v_row.meeting_point IS DISTINCT FROM 'Tamara Restaurant Sultanahmet (08:45) veya The Marmara Hotel Taksim (08:10)' THEN
    RAISE EXCEPTION 'BOSPHORUS PORTUGUESE POSTFLIGHT FAILED: meeting_point does not match.';
  END IF;
  IF v_row.meeting_instructions_tr IS DISTINCT FROM 'Misafirler rezervasyon sırasında seçtikleri buluşma noktasından belirtilen saatte alınır.' THEN
    RAISE EXCEPTION 'BOSPHORUS PORTUGUESE POSTFLIGHT FAILED: meeting_instructions_tr does not match.';
  END IF;
  IF v_row.end_point_tr IS DISTINCT FROM 'Sultanahmet merkezi veya Taksim bölgesi' THEN
    RAISE EXCEPTION 'BOSPHORUS PORTUGUESE POSTFLIGHT FAILED: end_point_tr does not match.';
  END IF;
  IF v_row.accessibility_info_tr IS DISTINCT FROM 'Tekerlekli sandalye kullanımına uygun değildir.' THEN
    RAISE EXCEPTION 'BOSPHORUS PORTUGUESE POSTFLIGHT FAILED: accessibility_info_tr does not match.';
  END IF;
  IF v_row.pets_policy_tr IS DISTINCT FROM 'Evcil hayvan kabul edilmez.' THEN
    RAISE EXCEPTION 'BOSPHORUS PORTUGUESE POSTFLIGHT FAILED: pets_policy_tr does not match.';
  END IF;
  IF v_row.booking_cutoff_text IS DISTINCT FROM 'Müsaitlik olması halinde tur başlangıcından 1 gün öncesine kadar rezervasyon yapılabilir.' THEN
    RAISE EXCEPTION 'BOSPHORUS PORTUGUESE POSTFLIGHT FAILED: booking_cutoff_text does not match.';
  END IF;
  IF v_row.free_cancellation_text IS DISTINCT FROM 'Tur başlangıcından 48 saat öncesine kadar ücretsiz iptal edilebilir.' THEN
    RAISE EXCEPTION 'BOSPHORUS PORTUGUESE POSTFLIGHT FAILED: free_cancellation_text does not match.';
  END IF;
  IF v_row.late_cancellation_text IS DISTINCT FROM 'Tur başlangıcına 48 saatten az süre kala yapılan iptallerde ücret iadesi yapılmaz.' THEN
    RAISE EXCEPTION 'BOSPHORUS PORTUGUESE POSTFLIGHT FAILED: late_cancellation_text does not match.';
  END IF;
  IF v_row.no_show_policy_text IS DISTINCT FROM 'Geç kalınması veya tura katılım sağlanmaması durumunda ücret iadesi yapılmaz.' THEN
    RAISE EXCEPTION 'BOSPHORUS PORTUGUESE POSTFLIGHT FAILED: no_show_policy_text does not match.';
  END IF;
  IF v_row.other_conditions_tr IS DISTINCT FROM 'Minimum 2 katılımcı gereklidir. Ayasofya ziyareti ikinci kattaki galeri bölümünü kapsar. Ayasofya biletindeki QR kod üzerinden sesli rehbere erişilebilir ve bunu dinlemek için misafirlerin kendi kulaklıklarını getirmeleri gerekir. Cuma sabahları camiler kapalıdır ve cuma günleri güzergah sırası değiştirilebilir.' THEN
    RAISE EXCEPTION 'BOSPHORUS PORTUGUESE POSTFLIGHT FAILED: other_conditions_tr does not match.';
  END IF;
  IF v_row.included_items IS DISTINCT FROM ARRAY['Klimalı araçla ulaşım', 'Portekizce konuşan rehber', 'Boğaz tekne turu', 'Ziyaret edilen yerler için öncelikli giriş biletleri', 'Öğle yemeği']::TEXT[] THEN
    RAISE EXCEPTION 'BOSPHORUS PORTUGUESE POSTFLIGHT FAILED: included_items does not match.';
  END IF;
  IF v_row.excluded_items IS DISTINCT FROM ARRAY['İçecekler']::TEXT[] THEN
    RAISE EXCEPTION 'BOSPHORUS PORTUGUESE POSTFLIGHT FAILED: excluded_items does not match.';
  END IF;

  IF v_row.guide_notes_tr IS NOT NULL THEN
    RAISE EXCEPTION 'BOSPHORUS PORTUGUESE POSTFLIGHT FAILED: guide_notes_tr was supposed to be left unchanged (NULL) — no approved internal content exists for this product — but is not.';
  END IF;
  IF v_row.notes IS NOT NULL THEN
    RAISE EXCEPTION 'BOSPHORUS PORTUGUESE POSTFLIGHT FAILED: notes must never be touched by this migration but is no longer NULL.';
  END IF;

  SELECT COUNT(*) INTO v_stop_count FROM public.tour_itinerary_stops WHERE tour_id = v_tour_id;
  IF v_stop_count <> 9 THEN
    RAISE EXCEPTION 'BOSPHORUS PORTUGUESE POSTFLIGHT FAILED: expected exactly 9 itinerary stops, found %.', v_stop_count;
  END IF;

  SELECT array_agg(place_name ORDER BY stop_order) INTO v_stop_names
    FROM public.tour_itinerary_stops WHERE tour_id = v_tour_id;
  IF v_stop_names IS DISTINCT FROM ARRAY[
    'Buluşma / Pickup', 'Mısır Çarşısı', 'Eminönü ve Tekne İskelesi', 'Boğaz Tekne Turu',
    'Geleneksel Restoran / Öğle Yemeği', 'Hipodrom Meydanı', 'Sultanahmet Camii', 'Ayasofya',
    'Sultanahmet veya Taksim'
  ]::TEXT[] THEN
    RAISE EXCEPTION 'BOSPHORUS PORTUGUESE POSTFLIGHT FAILED: itinerary stop order/names do not match the expected sequence.';
  END IF;

  SELECT COUNT(*) INTO v_duration_stops FROM public.tour_itinerary_stops
   WHERE tour_id = v_tour_id AND approx_duration_text IS NOT NULL;
  IF v_duration_stops <> 3 THEN
    RAISE EXCEPTION 'BOSPHORUS PORTUGUESE POSTFLIGHT FAILED: expected exactly 3 stops with a non-NULL approx_duration_text (Boğaz Tekne Turu, Sultanahmet Camii, Ayasofya — the only source-supported durations), found %.', v_duration_stops;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.tour_itinerary_stops WHERE tour_id = v_tour_id AND place_name = 'Boğaz Tekne Turu' AND approx_duration_text = 'Yaklaşık 1,5 saat') THEN
    RAISE EXCEPTION 'BOSPHORUS PORTUGUESE POSTFLIGHT FAILED: Boğaz Tekne Turu approx_duration_text does not match.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.tour_itinerary_stops WHERE tour_id = v_tour_id AND place_name = 'Sultanahmet Camii' AND approx_duration_text = 'Yaklaşık 1 saat') THEN
    RAISE EXCEPTION 'BOSPHORUS PORTUGUESE POSTFLIGHT FAILED: Sultanahmet Camii approx_duration_text does not match.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.tour_itinerary_stops WHERE tour_id = v_tour_id AND place_name = 'Ayasofya' AND approx_duration_text = 'Yaklaşık 1 saat') THEN
    RAISE EXCEPTION 'BOSPHORUS PORTUGUESE POSTFLIGHT FAILED: Ayasofya approx_duration_text does not match.';
  END IF;

  -- tour_channels / tour_languages must be provably untouched.
  SELECT COUNT(*) INTO v_channel_count FROM public.tour_channels WHERE tour_id = v_tour_id;
  IF v_channel_count <> 1 THEN
    RAISE EXCEPTION 'BOSPHORUS PORTUGUESE POSTFLIGHT FAILED: tour_channels row count for this tour changed (now %) — this migration must never touch tour_channels.', v_channel_count;
  END IF;
  SELECT EXISTS (
    SELECT 1 FROM public.tour_channels
     WHERE id = '4d20f364-3a40-451b-bd30-3a38843fd250' AND tour_id = v_tour_id
       AND external_product_id = 'Bosforo y Barrio Sultanahmet'
       AND booking_language IS NULL AND listing_url IS NULL AND is_active = TRUE
  ) INTO v_channel_ok;
  IF NOT v_channel_ok THEN
    RAISE EXCEPTION 'BOSPHORUS PORTUGUESE POSTFLIGHT FAILED: tour_channels row 4d20f364-3a40-451b-bd30-3a38843fd250 changed unexpectedly — this migration must never write to tour_channels.';
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM public.tour_languages WHERE tour_id = v_tour_id AND language_name = 'Portekizce'
  ) INTO v_language_ok;
  IF NOT v_language_ok THEN
    RAISE EXCEPTION 'BOSPHORUS PORTUGUESE POSTFLIGHT FAILED: tour_languages no longer has the Portekizce row for this tour — this migration must never touch tour_languages, and it should not have changed.';
  END IF;

  RAISE NOTICE 'BOSPHORUS PORTUGUESE POSTFLIGHT PASSED: all fourteen written tours fields verified, guide_notes_tr/notes confirmed still NULL, 9 itinerary stops confirmed in exact order with durations only on the 3 source-supported stops, and tour_channels (including its accepted booking_language IS NULL state) plus tour_languages confirmed untouched.';
END $$;

COMMIT;

-- ============================================================
-- END OF DATA MIGRATION supabase_data_bosphorus_portuguese_tour_information.sql
-- ============================================================
