# WhatsApp kurulumu (Meta WhatsApp Business Cloud API)

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
```
Örnek: Yarın (21 Kasım 2026 Cumartesi): 2 operasyon, 7 misafir · 1) 10:00 Topkapı (İspanyolca) 5 kişi · Rehber: Ayşe

**`desetour_tur_sonrasi_anket`** (tur sonrası anket)

Tek şablon adıyla **5 dilde** oluşturun: Spanish, Portuguese (BR), Italian, English, Turkish. Kategori: Utility. Her dilde **3 "Quick reply" butonu** ekleyin; buton sırası aşağıdaki gibi olmalı.

| Dil | Metin | Butonlar (sırayla) |
|---|---|---|
| Spanish (es) | ¡Hola {{1}}! Gracias por hacer el tour {{2}} con DeseTour. ¿Qué te ha parecido? | 😍 Excelente · 🙂 Bien · 😕 Mejorable |
| Portuguese BR (pt_BR) | Olá {{1}}! Obrigado por fazer o passeio {{2}} com a DeseTour. O que você achou? | 😍 Excelente · 🙂 Bom · 😕 Pode melhorar |
| Italian (it) | Ciao {{1}}! Grazie per aver fatto il tour {{2}} con DeseTour. Com'è andata? | 😍 Ottimo · 🙂 Bene · 😕 Migliorabile |
| English (en) | Hi {{1}}! Thank you for joining the {{2}} tour with DeseTour. How was your experience? | 😍 Excellent · 🙂 Good · 😕 Could be better |
| Turkish (tr) | Merhaba {{1}}! {{2}} turunu DeseTour ile yaptığınız için teşekkürler. Nasıldı? | 😍 Harika · 🙂 İyi · 😕 Geliştirilebilir |

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
- Her gün **18:05**'te yarının operasyon özeti operasyon listesine gider.
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
