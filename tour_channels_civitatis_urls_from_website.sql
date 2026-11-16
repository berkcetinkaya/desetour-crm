-- ============================================================
-- DESE TOUR OPERATIONS CENTER
-- DATA — Civitatis tour page URL per tour + language (from desetour.com)
-- ============================================================
-- Owner request (2026-11-16): every reservation shows the Civitatis page
-- of its tour, so the post-tour survey can send it back to the customer.
-- Source: the "Book on Civitatis" links of the desetour.com group tour
-- pages (read 2026-11-16):
--   group-tour-grand-bazaar           es → tour-gran-bazar (already set)
--                                     it → tour-grande-bazar
--   group-tour-bosphorus-old-city     it → crociera-bosforo-sultanahmet
--                                     pt → cruzeiro-bosforo-sultanahmet
--   group-tour-essential-istanbul     pt → visita-guiada-istambul
--   group-tour-topkapi-harem-hagia-irene es → visita-palacio-topkapi-haren-santa-irene-231294
-- Only EMPTY listing_url values are filled, each guarded by its own tour
-- and booking language — an existing URL is never overwritten.
-- ============================================================

BEGIN;

UPDATE public.tour_channels c
   SET listing_url = v.url
  FROM (VALUES
    ('d3170525-e047-4775-bf0f-a01e721f5487'::uuid, 'bed4fba3-e6ad-435a-b971-64606d8a46f4'::uuid, 'İtalyanca',  'https://www.civitatis.com/it/istanbul/tour-grande-bazar'),
    ('879251b0-a0be-453d-a242-008eb08b8697'::uuid, '2ea5551f-f59f-4ba4-976c-0b5c916094a8'::uuid, 'İtalyanca',  'https://www.civitatis.com/it/istanbul/crociera-bosforo-sultanahmet'),
    ('73dfaffa-f22d-4e3f-88fa-491a7f3ab992'::uuid, '8f308669-2bb6-42ac-9b2f-a07f77e231d4'::uuid, 'Portekizce', 'https://www.civitatis.com/pt/istambul/cruzeiro-bosforo-sultanahmet'),
    ('f0e859ba-09eb-4b4a-9047-797a7c865573'::uuid, 'a4e4bf16-a108-4a45-9418-d849f5bb7917'::uuid, 'Portekizce', 'https://www.civitatis.com/pt/istambul/visita-guiada-istambul'),
    ('5f06ed28-ad2f-452d-a9c0-28ef17c84e43'::uuid, '3d3a335a-1320-4277-977d-62a19fa7090a'::uuid, 'İspanyolca', 'https://www.civitatis.com/es/estambul/visita-palacio-topkapi-haren-santa-irene-231294')
  ) AS v(id, tour_id, lang, url)
 WHERE c.id = v.id AND c.tour_id = v.tour_id AND c.booking_language = v.lang
   AND (c.listing_url IS NULL OR btrim(c.listing_url) = '');

SELECT t.name, c.booking_language, c.listing_url
  FROM public.tour_channels c JOIN public.tours t ON t.id = c.tour_id
 ORDER BY t.name, c.booking_language NULLS FIRST;

COMMIT;
