-- ═══════════════════════════════════════════════════════════════════════
-- DeseTour CRM — güvenilir zamanlayıcı (Supabase pg_cron + pg_net)
--
-- NEDEN: GitHub Actions zamanlayıcısı bu depoda görevleri 15 dakikada bir
-- değil, birkaç saatte bir çalıştırıyor (Civitatis e-postaları CRM'e geç
-- giriyor, Telegram bildirimleri gecikiyor). Bu SQL aynı uç noktaları
-- Supabase'in kendi zamanlayıcısıyla çağırır. GitHub görevleri yedek
-- olarak kalabilir; her bildirim zaten yalnızca bir kez gönderilir.
--
-- ÇALIŞTIRMADAN ÖNCE: aşağıdaki iki <...> yerine Vercel'deki değerleri
-- yazın (Vercel → Settings → Environment Variables):
--   <CIVITATIS_SCHEDULER_SECRET>   ve   <WHATSAPP_SCHEDULER_SECRET>
-- Değerler Supabase Vault'ta şifreli saklanır. Bu dosyayı değerlerle
-- birlikte KAYDETMEYİN / paylaşmayın.
-- Saatler UTC'dir (İstanbul = UTC+3). Güvenle tekrar çalıştırılabilir.
-- ═══════════════════════════════════════════════════════════════════════
CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;

-- 1) Anahtarlar (Vault). Varsa günceller, yoksa oluşturur.
DO $$
DECLARE v_id uuid;
BEGIN
  SELECT id INTO v_id FROM vault.secrets WHERE name = 'desetour_civitatis_scheduler_secret';
  IF v_id IS NULL THEN PERFORM vault.create_secret('<CIVITATIS_SCHEDULER_SECRET>', 'desetour_civitatis_scheduler_secret');
  ELSE PERFORM vault.update_secret(v_id, '<CIVITATIS_SCHEDULER_SECRET>'); END IF;
  SELECT id INTO v_id FROM vault.secrets WHERE name = 'desetour_whatsapp_scheduler_secret';
  IF v_id IS NULL THEN PERFORM vault.create_secret('<WHATSAPP_SCHEDULER_SECRET>', 'desetour_whatsapp_scheduler_secret');
  ELSE PERFORM vault.update_secret(v_id, '<WHATSAPP_SCHEDULER_SECRET>'); END IF;
END $$;

-- 2) Çağrı fonksiyonları (yalnızca zamanlayıcı kullanır).
CREATE OR REPLACE FUNCTION public.desetour_cron_civitatis() RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  PERFORM net.http_get(
    url := 'https://desetour-crm-v15.vercel.app/api/cron-ingest-civitatis-write',
    headers := jsonb_build_object('Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'desetour_civitatis_scheduler_secret')),
    timeout_milliseconds := 55000);
END $$;

CREATE OR REPLACE FUNCTION public.desetour_cron_whatsapp(p_action text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  PERFORM net.http_post(
    url := 'https://desetour-crm-v15.vercel.app/api/whatsapp?action=' || p_action,
    body := '{}'::jsonb,
    headers := jsonb_build_object('Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'desetour_whatsapp_scheduler_secret')),
    timeout_milliseconds := 55000);
END $$;

REVOKE ALL ON FUNCTION public.desetour_cron_civitatis() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.desetour_cron_whatsapp(text) FROM PUBLIC, anon, authenticated;

-- 3) Zamanlamalar (aynı adla tekrar çalıştırılırsa güncellenir).
SELECT cron.schedule('desetour-civitatis-ingest',  '*/10 * * * *',    $$SELECT public.desetour_cron_civitatis()$$);          -- 10 dakikada bir: e-postalar + ekip bildirimleri
SELECT cron.schedule('desetour-whatsapp-worker',   '5-59/15 * * * *', $$SELECT public.desetour_cron_whatsapp('worker')$$);   -- 15 dakikada bir: rehber atamaları, yeniden denemeler
SELECT cron.schedule('desetour-daily-summary',     '0 9 * * *',       $$SELECT public.desetour_cron_whatsapp('daily-summary')$$);     -- her gün 12:00 İstanbul
SELECT cron.schedule('desetour-weekly-report',     '2 9 * * 0',       $$SELECT public.desetour_cron_whatsapp('weekly-report')$$);     -- pazar 12:02 İstanbul
SELECT cron.schedule('desetour-evening-reminders', '0 15 * * *',      $$SELECT public.desetour_cron_whatsapp('evening-reminders')$$); -- her gün 18:00 İstanbul

-- 4) Kontrol: beş satır görmelisiniz.
SELECT jobname, schedule, active FROM cron.job WHERE jobname LIKE 'desetour-%' ORDER BY jobname;

-- Sonradan çalışıp çalışmadığına bakmak için:
--   SELECT j.jobname, d.status, d.start_time FROM cron.job_run_details d JOIN cron.job j USING (jobid)
--    WHERE j.jobname LIKE 'desetour-%' ORDER BY d.start_time DESC LIMIT 20;
--   SELECT id, status_code, created FROM net._http_response ORDER BY created DESC LIMIT 20;
-- Kapatmak için:
--   SELECT cron.unschedule(jobname) FROM cron.job WHERE jobname LIKE 'desetour-%';
