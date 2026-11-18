# WhatsApp kurulumu

# Seçilen yol: Dualhook ile "coexistence" (aynı numara telefonda + CRM'de)

+90 544 459 35 85 telefondaki WhatsApp Business uygulamasında kalır; CRM aynı numaradan mesaj gönderir. Meta bu bağlantıyı yalnızca yetkili aracılar üzerinden açtığı için Dualhook kullanılıyor (aylık ücretli, 14 gün deneme). Aşağıdaki "doğrudan Meta" adımları yalnızca ayrı bir numara kullanılırsa geçerlidir.

## A. Vercel'e üç değer ekleyin (bağlantıdan ÖNCE)
Vercel → desetour-crm → Settings → Environment Variables (Production):

| Değişken | Değer |
|---|---|
| `WHATSAPP_VERIFY_TOKEN` | kendiniz uydurun (ör. 30 karakter, harf-rakam) |
| `WHATSAPP_WEBHOOK_KEY` | kendiniz uydurun (ör. 30 karakter, harf-rakam) |
| `WHATSAPP_SCHEDULER_SECRET` | kendiniz uydurun |

Kaydedip **Redeploy** yapın. İlk iki değeri not edin; B adımında lazım.

## B. Dualhook'ta bağlayın
1. dualhook.com → hesap açın (Developer planı, 1 bağlantı).
2. **Connect WhatsApp** → bağlantı adı: DeseTour.
   - Webhook URL: `https://desetour-crm-v15.vercel.app/api/whatsapp?key=<WHATSAPP_WEBHOOK_KEY değeri>`
   - Verify token: `<WHATSAPP_VERIFY_TOKEN değeri>`
3. **Connect with Meta** → açılan pencerede:
   - Numara listesinde 544'lü numara "Registered" etiketiyle çıkarsa onu seçin; çıkmazsa "Enter a new phone number" ile yazın.
   - WhatsApp Business profil kartınız (logo, ad, numara) görünmeli — doğru yoldasınız demektir.
   - İşletme portföyü: **DeseTour**.
   - QR kodu telefondaki WhatsApp Business uygulamasıyla okutun; sohbet geçmişini paylaşıp paylaşmamayı seçin.
4. **DURUN ve ekran görüntüsü atın, devam etmeyin** eğer: SMS/sesli arama kodu istenirse, QR çıkmadan "bağlandı" derse, ya da "numara zaten kayıtlı, bağlantıyı kesin / taşıyın" derse. Bunlar numaranın telefondan düşebileceği yoldur.
5. Bitince Dualhook'ta bağlantının **Overview** sayfasından bir **API key** (`dh_live_…`) oluşturun. Bir kez gösterilir.

## C. Vercel'e gönderim değerlerini ekleyin
| Değişken | Değer |
|---|---|
| `WHATSAPP_ACCESS_TOKEN` | Dualhook API key (`dh_live_…`) |
| `WHATSAPP_PHONE_NUMBER_ID` | `1163770170156531` (Dualhook'ta farklı görünüyorsa oradaki) |
| `WHATSAPP_API_BASE_URL` | `https://api.dualhook.com/v25.0` |

Redeploy. CRM → Ayarlar → WhatsApp'ta "Meta bağlantısı: Hazır ✓" görünmeli.

## D. Kalanlar
- **Şablonlar** (aşağıdaki 2. bölüm): aynı metinlerle onaya gönderilir.
- **Ödeme yöntemi:** Meta → WhatsApp Yöneticisi → "Ödeme yöntemi ekleyin" (kart). Yoksa işletmenin başlattığı mesajlar gitmez.
- **GitHub** (aşağıdaki 6. bölüm): akşam özeti ve anket görevleri.
- **Telefonu açık tutun:** WhatsApp Business uygulaması yaklaşık 14 gün hiç açılmazsa Meta bağlantıyı koparır.

---

# Doğrudan Meta ile kurulum (ayrı numara kullanılırsa)

CRM tarafı hazır. Mesajlar Meta bağlantısı kurulana kadar **sırada bekler**, kaybolmaz. Aşağıdaki adımlar bir kez yapılır.

## 1. Numarayı Meta'ya bağla
WhatsApp Manager → **Phone numbers → Add phone number**.

- Numara telefondaki WhatsApp / WhatsApp Business uygulamasında kayıtlıysa doğrulama kodu gelmez. İki seçenek var:
  - **"WhatsApp Business uygulamasındaki numarayı bağla"** (coexistence): uygulamadan QR ile bağlanırsınız, uygulamayı kullanmaya devam edersiniz.
  - Numarayı uygulamadan silip yeniden denemek.
- SMS gelmiyorsa **"Sesli arama" (Voice call)** seçeneğini seçin. Türk operatörleri yurtdışı kısa SMS'leri bazen engelliyor.
- Çok deneme yapıldıysa Meta birkaç saat (bazen 24 saat) bekletir.

## 2. Mesaj şablonlarını oluştur
WhatsApp Manager → **Message templates → Create template**. Her iki şablon için:

- Kategori: **Utility**
- Dil: **Turkish**
- Adı ve metni aşağıdakiyle **birebir aynı** olmalı.

**`desetour_rehber_tur_bilgisi`**
```
Merhaba {{1}}, {{2}} tarihindeki {{3}} turunuzun bilgileri:
🕘 Başlangıç: {{4}}
🗣 Dil: {{5}}
👥 Misafir: {{6}}
📍 Buluşma: {{7}}
📝 Not: {{8}}
İyi turlar! — DeseTour Operasyon
```
Örnek değerler (Meta ister): Ayşe · 20 Kasım 2026 Cuma · Topkapı Sarayı · 10:00 · İspanyolca · 4 kişi (2 rezervasyon) · Sultanahmet Meydanı · —

**`desetour_operasyon_bildirimi`**
```
📣 DeseTour Operasyon — {{1}}
{{2}}
DeseTour CRM otomatik bildirimi.
```
Örnek: Yarın (21 Kasım 2026 Cumartesi): 2 operasyon, 7 misafir · 1) 10:00 Topkapı (İspanyolca) 5 kişi · Rehber: Ayşe

**`desetour_tur_sonrasi_anket`** (tur sonrası anket)

Tek şablon adıyla **5 dilde** oluşturun: Spanish, Portuguese (BR), Italian, English, Turkish. Kategori: Utility. Her dilde **3 "Quick reply" butonu** ekleyin; buton sırası aşağıdaki gibi olmalı. Meta buton yazısında emoji kabul etmiyor.

| Dil | Metin | Butonlar (sırayla) |
|---|---|---|
| Spanish (es) | ¡Hola {{1}}! Gracias por hacer el tour {{2}} con DeseTour. ¿Qué te ha parecido? | Excelente · Bien · Mejorable |
| Portuguese BR (pt_BR) | Olá {{1}}! Obrigado por fazer o passeio {{2}} com a DeseTour. O que você achou? | Excelente · Bom · Pode melhorar |
| Italian (it) | Ciao {{1}}! Grazie per aver fatto il tour {{2}} con DeseTour. Com'è andata? | Ottimo · Bene · Migliorabile |
| English (en) | Hi {{1}}! Thank you for joining the {{2}} tour with DeseTour. How was your experience? | Excellent · Good · Could be better |
| Turkish (tr) | Merhaba {{1}}! {{2}} turunu DeseTour ile yaptığınız için teşekkürler. Nasıldı? | Harika · İyi · Geliştirilebilir |

Örnek değerler: Maria · Bosforo y Barrio Sultanahmet

## 3. Erişim anahtarı
Meta Business Settings → **System users** → bir sistem kullanıcısı oluşturun → WhatsApp hesabına erişim verin → **kalıcı token** üretin. İzinler:

- `whatsapp_business_messaging`
- `whatsapp_business_management`

## 4. Vercel ortam değişkenleri
Vercel → Project → Settings → Environment Variables (Production):

| Değişken | Değer |
|---|---|
| `WHATSAPP_ACCESS_TOKEN` | 3. adımdaki kalıcı token |
| `WHATSAPP_PHONE_NUMBER_ID` | WhatsApp Manager → API Setup → *Phone number ID* |
| `WHATSAPP_APP_SECRET` | Meta App → Settings → Basic → *App secret* |
| `WHATSAPP_VERIFY_TOKEN` | kendiniz belirleyin (rastgele uzun bir metin) |
| `WHATSAPP_SCHEDULER_SECRET` | kendiniz belirleyin (rastgele uzun bir metin) |

Değişkenleri ekledikten sonra yeniden deploy edin (Redeploy).

## 5. Webhook (iletildi / okundu bilgisi ve gelen mesajlar)
Meta App → WhatsApp → **Configuration → Webhook**:

- Callback URL: `https://<CRM alan adı>/api/whatsapp`
- Verify token: `WHATSAPP_VERIFY_TOKEN` ile aynı değer
- Subscribe: **messages**

## 6. Zamanlanmış görevler (GitHub)
Repository → Settings → Secrets and variables → Actions:

- Variable `WHATSAPP_ENDPOINT_URL` = `https://<CRM alan adı>/api/whatsapp`
- Secret `WHATSAPP_SCHEDULER_SECRET` = Vercel'deki ile aynı değer

Bunlar eklenince iki görev çalışır:
- Her gün **18:00**'te yarının operasyon özeti operasyon listesine gider.
- **15 dakikada bir** gönderilemeyen mesajlar yeniden denenir.

## 7. Anket için CRM'de
- **Puanlama linki:** "Harika" ya da "İyi" diyen müşteriye turun Civitatis sayfası gider. Bu, turun kanal ayarlarındaki **Listing URL**'dir; rezervasyon sayfasında "Tur Sayfası" olarak da görünür. Farklı bir link gönderilecekse Turlar → tur → kanal ayarları → "Puanlama linki (WhatsApp anketi)" alanına yazın. İkisi de boşsa müşteriye sadece teşekkür mesajı gider.
- **Müşteri telefonu:** Rezervasyon sayfası → WhatsApp kartı → "Telefon ekle". Numarayı Civitatis panelinden ülke koduyla girin (ör. +34 612 345 678).
- **Zamanlama:** Anket tur günü **19:05**'te otomatik gider. GitHub görevi: `post-tour-surveys`.

## 8. CRM'de
**Ayarlar → WhatsApp**:

- "Meta bağlantısı: Hazır ✓" yazısını görün.
- Operasyon ekibi numaralarını ekleyin.
- Bir rezervasyonda **Hızlı İşlemler → Rehbere WhatsApp Gönder** ile deneyin.

## 9. Telegram grubu (ekip bildirimleri)
WhatsApp'ın resmi API'si mevcut bir WhatsApp grubuna yazamaz. Bu yüzden ekip bildirimleri (yeni rezervasyon, iptal, değişiklik, Civitatis mesajı, akşam özeti, elle yazılan ekip mesajı) bir Telegram grubuna gönderilir. Rehber ve müşteri mesajları WhatsApp'ta kalır.

1. Telegram'da **@BotFather** → `/newbot` → bota ad verin (ör. "DeseTour CRM"). BotFather bir **bot anahtarı** verir.
2. Vercel → Settings → Environment Variables → `TELEGRAM_BOT_TOKEN` = bot anahtarı → **Redeploy**. (Anahtarı sohbete ya da repoya yazmayın.)
3. Botu ekip Telegram grubuna **üye olarak ekleyin** ve grupta bir mesaj yazın (ör. `/start`).
4. CRM → **Ayarlar → WhatsApp → Telegram grubu** → **Grupları bul** → **Bu gruba bağla**. Gruba deneme mesajı düşer.

Olay bildirimleri 15 dakikada bir çalışan görevle gider; bunun için 6. adımdaki GitHub değişkeni ve secret'ı gereklidir. Grup bağlı değilken bildirimler WhatsApp operasyon listesine gider.

## 10. Çalışma kuralları (13.25)
- **Mesajlar (CRM WhatsApp penceresi):** tüm yazışmalar görünür; yanında Türkçe çevirisi çıkar. Cevabı Türkçe yazın → **Çevir** → müşterinin dilindeki metni kontrol edin → **Gönder**. Çeviri, sunucudaki `ANTHROPIC_API_KEY` ile yapılır (acente özellikleriyle aynı anahtar).
- **Rehber:** rehber atanınca atama bilgisi + tur detayları otomatik gider (15 dakikalık görev); turdan bir gün önce 18:00'te hatırlatma gider. Şablonlar: `desetour_rehber_tur_bilgisi`, `desetour_rehber_hatirlatma`.
- **Geri bildirim:** tur bittikten sonra rezervasyon sayfası → WhatsApp kartı → **Geri bildirim iste** (müşteri telefonu kayıtlıysa). Müşteri turu 1–5, rehberi 1–5 puanlar ve isterse yorum yazar. Şablon: `desetour_tur_geri_bildirim`. Otomatik gönderilmez.
- **Yorum / puan:** yanıtlar olumluysa (tur ve rehber 4–5) ertesi gün aynı karttan **Yorum ve puan iste** ile Civitatis sayfası gönderilir. Şablon: `desetour_yorum_istegi`.
- **Hatırlatmalar:** her akşam 18:00'te ekip grubuna "geri bildirim istenebilecekler" ve "yorum istenebilecekler" listesi düşer.
- **Ekip bildirimleri:** yeni rezervasyon, iptal, değişiklik ve Civitatis mesajları Telegram grubuna gider (9. adım).
- Gerekli SQL: `supabase_migration_whatsapp_phase4_feedback_scores.sql`.
