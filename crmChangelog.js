'use strict';
/**
 * crmChangelog.js
 * ─────────────────────────────────────────────────────────────────────────
 * The ONE centralized, user-facing product changelog for Dese Tour CRM
 * ("CRM Güncellemeleri"). This is NOT a technical Git history — it is a
 * permanent, editorial record of how the CRM has evolved for the people
 * who use it every day: what Berk added, and what operational benefit it
 * brought. No commit hashes, no migration/RPC names, no bug internals —
 * see the per-field contract below.
 *
 * LOADING MODEL: this file follows the exact same plain-script convention
 * as build-meta.js (see build.js) — DeseTourDashboard.jsx is a single,
 * module-less browser script (Babel, sourceType:'script', no
 * import/export), so this file is loaded via its own <script> tag in
 * index.html, BEFORE app.js. Both files are classic (non-module) scripts,
 * which in a browser share ONE global lexical scope across separate
 * <script> tags — a top-level `const`/`let` in this file and a top-level
 * `const`/`let` of the SAME NAME in app.js would collide with a
 * SyntaxError the instant the second script loads (this actually happened
 * in production: this file and DeseTourDashboard.jsx each independently
 * declared their own top-level `const CRM_CHANGELOG`/`CRM_CHANGELOG_
 * CATEGORIES`). To make that class of bug structurally impossible, EVERY
 * top-level declaration below lives inside an IIFE — nothing but the
 * single `window.DESETOUR_CHANGELOG = {...}` property assignment (never a
 * lexical declaration, so it can never collide with anything) crosses
 * into the shared global scope. It ALSO exports via module.exports when
 * require()'d (guarded — never runs in a browser), so tests load the
 * exact same data Node-side with no duplication and no eval/extraction
 * tricks.
 *
 * VERSION INVARIANT: CRM_CHANGELOG[0].version (the newest entry) MUST
 * always equal the CRM's current product version, i.e. formatCrmVersion()
 * of crm-version.json (see build-version.js — the pre-existing, sole
 * authoritative version source; this file introduces no competing one).
 * This is enforced by tests/dashboard/crmChangelog.test.js, not by a
 * runtime import (this file has no Node-only dependency on
 * build-version.js so it stays a trivial, dependency-free browser script).
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THE RELEASE CONVENTION — read this before adding a new entry
 * ─────────────────────────────────────────────────────────────────────────
 * From now on, every meaningful CRM release follows this process:
 *   1. Run `node bump-crm-version.js` (or `npm run release`) to advance
 *      the CRM's product version — see build-version.js.
 *   2. Add exactly ONE new entry to the TOP of CRM_CHANGELOG below (newest
 *      first). Its `version` MUST equal the version bump-crm-version.js
 *      just produced, and its `date` MUST be the actual release date
 *      (never a placeholder, never backdated, never postdated).
 *   3. Write `summary`/`highlights` in plain operational language — what
 *      changed for the person using the CRM, and why it helps them.
 *      NEVER raw implementation details: no file names, function/RPC
 *      names, migration names, table names, commit hashes, or internal
 *      bug/incident descriptions. `technicalNote` (optional) may carry a
 *      LITTLE more operational nuance for the curious, but the same rule
 *      applies — it is still user-facing copy, hidden by default, not an
 *      engineering log.
 *   4. NEVER document a feature as released before it actually ships.
 *      A planned/future capability (e.g. Civitatis cancellation handling)
 *      does not get an entry — not even a stub — until it is real.
 *   5. Small, purely technical fixes are not their own entries — fold
 *      them into the next meaningful release's highlights, or skip them
 *      entirely if they carry no visible operational benefit.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * ENTRY SHAPE
 * ─────────────────────────────────────────────────────────────────────────
 *   version      string   "{major}.{minor}" — must match crm-version.json
 *                          exactly for the newest entry (see invariant
 *                          above); every earlier entry's version must be
 *                          strictly lower, in the same ascending order as
 *                          `date`.
 *   date         string   "YYYY-MM-DD", the real release date.
 *   title        string   Short, human release name (Turkish).
 *   summary      string   1-2 sentence plain-language description.
 *   categories   string[] Subset of CRM_CHANGELOG_CATEGORIES only.
 *   highlights   string[] 3-5 short, concrete operational bullets.
 *   author       string   Who shipped it (e.g. "Berk").
 *   technicalNote?  string  OPTIONAL. Hidden by default in the UI. A
 *                          LITTLE more operational nuance, still never
 *                          raw engineering detail.
 * ─────────────────────────────────────────────────────────────────────────
 */

// Everything below is IIFE-scoped — see the LOADING MODEL note above for
// why nothing here may be a bare top-level `const`/`let`/`class`.
(function () {
'use strict';

// Controlled category vocabulary — deliberately small. Do not add a new
// category casually; reuse the closest existing one.
const CRM_CHANGELOG_CATEGORIES = [
  'Yeni Özellik',
  'Otomasyon',
  'Operasyon',
  'İyileştirme',
  'Arayüz',
  'Altyapı',
];

// Newest first. See the release convention above before editing.
const CRM_CHANGELOG = [
  {
    version: '13.26',
    date: '2026-11-17',
    title: 'Müşteri Puanları Rehber Profilinde, Ayrıntılı Telegram Bildirimleri',
    summary: 'Müşterilerin WhatsApp geri bildiriminde rehbere verdiği 1–5 puanlar rehberin CRM profiline işleniyor; Telegram grubuna düşen rezervasyon bildirimleri artık tur, tarih, kişi, tutar ve o günkü diğer katılımı gösteriyor.',
    categories: ['Yeni Özellik', 'Otomasyon'],
    highlights: [
      'Telegram bildirimi: yeni rezervasyonda tur ve dil, tarih ve saat, kişi sayısı, tutar, rehber durumu, aynı gün o turdaki diğer rezervasyonlar ve toplam kişi ile rezervasyonun CRM bağlantısı satır satır geliyor. İptal ve değişiklik bildirimleri de aynı düzende.',
      'Rehber ataması yapıldığında Telegram grubuna "Rehber atandı" bildirimi düşüyor: rehber, tur, tarih, misafir sayısı ve rehbere WhatsApp bilgisinin gidip gitmediği.',
      'Rehber profilinde "WhatsApp Geri Bildirim Puanları": rehber puanı ortalaması, yanıt sayısı ve 3 ve altı puan sayısı.',
      'Her yanıt tur, tarih, rehber ve tur puanı, müşteri yorumu ve rezervasyon bağlantısıyla listeleniyor.',
      'Bu puanlar platform değerlendirmelerinden (Civitatis vb.) ayrı tutuluyor; mevcut ortalama puan değişmiyor.',
    ],
    author: 'Berk',
  },
  {
    version: '13.25',
    date: '2026-11-17',
    title: 'WhatsApp: Türkçe Çeviri, Rehber Otomasyonu ve Puanlı Geri Bildirim',
    summary: 'Mesajlar sayfasında yazışmaların Türkçe çevirisi yan panelde görünüyor ve Türkçe yazılan cevap müşterinin diline çevrilip gönderiliyor; rehbere atama bilgisi ve tur öncesi hatırlatma otomatik gidiyor; tur sonrası geri bildirim 1–5 puanlı hale geldi.',
    categories: ['Yeni Özellik', 'Otomasyon'],
    highlights: [
      'Mesajlar: her yazışmanın yanında Türkçe çevirisi görünüyor. Cevabı Türkçe yazıp "Çevir"e basınca müşterinin dilindeki metin hazırlanıyor; kontrol edip gönderiyorsunuz.',
      'Rehber ataması yapıldığında rehbere atama bilgisi ve tur detayları WhatsApp ile otomatik gidiyor; turdan bir gün önce akşam hatırlatma mesajı gönderiliyor.',
      'Rezervasyon sayfasından "Geri bildirim iste": müşteriye teşekkür edilip tur 1–5, rehber 1–5 puanlatılıyor ve serbest yorum isteniyor. Yanıtlar rezervasyonda görünüyor; olumluysa ertesi gün "Yorum ve puan iste" ile Civitatis sayfası gönderiliyor.',
      'Ekip grubuna akşam hatırlatması: bugün turu biten ve geri bildirim istenebilecek rezervasyonlar ile olumlu yanıt verip yorum istenebilecek müşteriler listeleniyor; gelen geri bildirimler de gruba düşüyor.',
    ],
    author: 'Berk',
  },
  {
    version: '13.24',
    date: '2026-11-17',
    title: 'Ekip Bildirimleri Telegram Grubuna',
    summary: 'WhatsApp mevcut bir gruba yazamadığı için ekip bildirimleri artık bir Telegram grubuna düşebiliyor: yeni rezervasyon, iptal, değişiklik, mesaj ve akşam özeti tek grupta.',
    categories: ['Yeni Özellik', 'Otomasyon'],
    highlights: [
      'Ayarlar → WhatsApp → "Telegram grubu": bot gruba eklendikten sonra grup tek tıkla bağlanıyor ve gruba deneme mesajı düşüyor.',
      'Yeni rezervasyon, iptal, Civitatis değişikliği, Civitatis mesajı, her akşam yarının tur özeti ve elle yazılan ekip mesajları bağlı Telegram grubuna gidiyor; her olay yalnızca bir kez bildiriliyor.',
      'Rehber ve müşteri mesajları WhatsApp\'tan gitmeye devam ediyor; Telegram bağlı değilse ekip bildirimleri eskisi gibi WhatsApp operasyon listesine gidiyor.',
    ],
    author: 'Berk',
  },
  {
    version: '13.23',
    date: '2026-11-17',
    title: 'WhatsApp Penceresi, Yorum İsteği ve Ekip Bildirimleri',
    summary: 'Mesajlar sayfası gerçek WhatsApp penceresi oldu; rezervasyondan müşteriye turun sayfasıyla yorum ve puan isteği gönderiliyor; yeni rezervasyon, iptal, değişiklik ve mesajlar operasyon ekibine WhatsApp ile bildiriliyor.',
    categories: ['Yeni Özellik', 'Otomasyon'],
    highlights: [
      'Mesajlar: DeseTour numarasındaki yazışmalar (gelenler, CRM\'den gidenler, telefondan yazılanlar) tek pencerede; son 24 saatte yazan kişiye buradan cevap verilebiliyor.',
      'Rezervasyonda "Yorum ve puan iste": müşteriye kendi dilinde turun Civitatis sayfası gidiyor ve yorumunun bizim için çok önemli olduğu belirtiliyor.',
      'Yeni rezervasyon, iptal, Civitatis değişikliği ve müşteri mesajı gelince operasyon ekibindeki numaralara otomatik WhatsApp bildirimi gidiyor.',
    ],
    author: 'Berk',
  },
  {
    version: '13.22',
    date: '2026-11-17',
    title: 'Telefonda CRM: İşlem Yapılabilir Rezervasyonlar',
    summary: 'Telefondaki CRM artık yalnızca okumak için değil: rehber atama, rehbere WhatsApp, pickup, durum değiştirme ve arama telefondan yapılabiliyor; ana sayfada okunmamış uyarılar ve ayın gelir–kâr özeti var.',
    categories: ['İyileştirme', 'Arayüz'],
    highlights: [
      'Telefonda rezervasyon sayfası: Rehber Ata / Değiştir (ücretiyle), Rehbere Tur Bilgisi, Rehberi Ara, pickup, durum ve "Tamamlandı" — altta sabit işlem çubuğuyla.',
      'Rezervasyonda yolcular, Civitatis değişiklikleri, tur sayfası linki ve WhatsApp kartı telefonda da görünüyor.',
      'Rezervasyon listesinde arama (misafir, R-no, Civitatis kodu, tur, rehber) ve gün başlıkları: Bugün, Yarın, tarih.',
      'Telefon ana sayfasında okunmamış uyarılar ve "Bu Ay" net gelir / tahmini kâr; Finans Genel Bakış telefonda kart görünümünde.',
    ],
    author: 'Berk',
  },
  {
    version: '13.21',
    date: '2026-11-16',
    title: 'WhatsApp: Rehber, Ekip ve Müşteri Anketi',
    summary: 'CRM artık DeseTour WhatsApp numarasından rehberlere tur bilgisi, operasyon ekibine günlük özet ve müşterilere tur sonrası anket gönderebiliyor; rezervasyonlarda turun Civitatis sayfası görünüyor.',
    categories: ['Yeni Özellik', 'Otomasyon'],
    highlights: [
      'Rezervasyonda "Rehbere WhatsApp Gönder": tarih, saat, dil, misafir sayısı ve buluşma noktası tek mesajda rehbere gidiyor.',
      'Ayarlar → WhatsApp: operasyon ekibi numaraları, ekibe mesaj ve her akşam yarının turlarının özeti (rehbersiz turlar uyarıyla).',
      'Tur günü akşamı müşteriye kendi dilinde anket; memnun olana turun Civitatis sayfası, olmayana "ne geliştirebiliriz?" sorusu gidiyor, cevaplar rezervasyonda.',
      'Rezervasyon sayfasında "Tur Sayfası" linki ve müşteri telefonu girişi.',
    ],
    author: 'Berk',
  },
  {
    version: '13.20',
    date: '2026-11-16',
    title: 'Civitatis Değişiklikleri Görünür',
    summary: 'Civitatis\'ten gelen rezervasyon değişikliği mailleri (tarih, saat, kişi sayısı, dil, tutar) artık neyin neye değiştiğiyle rezervasyon sayfasında, bildirimlerde ve ana sayfada gösteriliyor.',
    categories: ['Otomasyon', 'Operasyon'],
    highlights: [
      'Rezervasyon sayfasında "Civitatis Değişiklikleri" bölümü: ör. Tarih 19.11.2026 → 20.11.2026, ne zaman uygulandığıyla.',
      'Ana sayfada yeni "Değişiklik" kutusu ve bildirim zilinde uyarı; rehber atanmış turlarda "değişikliği rehbere iletin" hatırlatması.',
      'Değişiklik mailleri eskiden olduğu gibi otomatik uygulanıyor; içeriği aynı olan bir mail yeni uyarı oluşturmuyor.',
    ],
    author: 'Berk',
  },
  {
    version: '13.19',
    date: '2026-11-15',
    title: 'Aylık Harcamalar ve PDF Aylık Rapor',
    summary: 'Finans\'a ay seçilerek elle girilen aylık harcamalar (Meta reklam, Higgsfield gibi) eklendi; Raporlar sayfasından seçilen ayın detaylı raporu tek tıkla PDF olarak indiriliyor.',
    categories: ['Yeni Özellik', 'Operasyon'],
    highlights: [
      'Finans → Aylık Harcamalar: ay seçip harcama adı ve tutar yazarak (ör. Ekim · Meta Reklam · ₺10.000) istediğiniz aya gider ekleyebiliyorsunuz; harcamalar o ayın kârından düşülüyor.',
      'Raporlar → Aylık Detaylı Rapor: tur ve rezervasyon sayıları, en çok satan tur, tur ve dil bazında katılım, rehberler ve hakedişleri, gelir–gider–kâr ve aylık harcamalar grafiklerle PDF\'te.',
      'Raporun son bölümü CRM\'de unutulan kayıtları (rehber atanmamış tur, girilmemiş ücret, belirsiz yemek durumu…) raporu nasıl etkilediği ve ne yapılması gerektiğiyle listeliyor.',
    ],
    author: 'Berk',
  },
  {
    version: '13.18',
    date: '2026-11-14',
    title: 'Rehber Ücreti Atamada Giriliyor',
    summary: 'Rehber maliyeti artık otomatik hesaplanmıyor: rehber atanırken rehbere ödenecek ücret giriliyor ve aynı gün, aynı tur ve aynı rehber için tek ücret sayılıyor.',
    categories: ['Operasyon', 'İyileştirme'],
    highlights: [
      'Rehber atama ekranında rehbere ödenecek ücret giriliyor; tüm finans hesapları bu tutarı kullanıyor.',
      'Aynı rehber aynı gün aynı tura başka bir rezervasyon için atanınca ilk girilen ücret silik ve değiştirilemez görünüyor; ikinci ücret oluşmuyor.',
      'Rehber atanmamış ya da ücreti girilmemiş operasyonlar maliyete sayılmıyor ve uyarıyla gösteriliyor.',
      'Eksik ücret rezervasyonun Finans kartından girilebiliyor; Yönetici ve Operasyon yanlış girilen ücreti onayla düzeltebiliyor.',
    ],
    author: 'Berk',
  },
  {
    version: '13.17',
    date: '2026-11-12',
    title: 'Ana Sayfada Sonraki Aylar',
    summary: 'Ana sayfadaki Beklenen Net Gelir kartında ay değiştirilerek sonraki ve önceki ayların net geliri, tahmini kârı ve ek satışları görülebiliyor.',
    categories: ['İyileştirme', 'Arayüz'],
    highlights: [
      'Beklenen Net Gelir kartında ay okları ve "Bu ay" düğmesi; Aralık, Ocak ve sonraki aylar görülebiliyor.',
      'Tahmini net kâr ve ek satış seçilen aya göre hesaplanıyor; dövizli rezervasyonlar güncel ECB kuruyla çevriliyor.',
      'Acente yanıtlarının e-postadan otomatik alınması, Gmail\'de silinmiş bir mesaj yüzünden durmayacak şekilde düzeltildi.',
    ],
    author: 'Berk',
  },
  {
    version: '13.16',
    date: '2026-11-11',
    title: 'Finans Merkezi, Kârlılık ve Ek Satışlar',
    summary: 'Bugünkü güncellemelerle CRM\'e tur bazında bütçe, kârlılık ve nakit planlamayı tek yerde toplayan Finans bölümü geldi. Ana sayfa artık Civitatis komisyonu düşülmüş net geliri, tahmini net kârı ve ek satışları gösteriyor; rehber, bilet ve ek satış tutarları ekrandan yönetilebiliyor.',
    categories: ['Yeni Özellik', 'Operasyon', 'Arayüz'],
    highlights: [
      'Ana sayfa: Civitatis komisyonu düşülmüş beklenen net gelir, tahmini net kâr ve ek satış yan yana; dövizli rezervasyonlar güncel ECB kuruyla TL\'ye çevriliyor.',
      'Finans Genel Bakış: önümüzdeki 7 gün, 15 gün ve 1 ay için rehber ve giriş biletleri için hazırlanacak para, bu haftanın operasyonlarıyla birlikte.',
      'Rehber maliyeti her tarih, tur ve dil için tek operasyon (standart €150); rezervasyondan operasyon bazında değiştirilebiliyor, ödemeler bu tutarla eşleştiriliyor.',
      'Tur Karlılığı: her tur tek satır, altında diller ve operasyonlar; maliyetin TL karşılığı ve kâra geçmek için gereken kişi sayısı.',
      'Ek Satışlar: turdaki müşterilere yapılan satışlar Civitatis kodu, rezervasyon numarası veya müşteri adıyla aranan rezervasyona kaydediliyor ve gelire ekleniyor.',
    ],
    author: 'Berk',
    technicalNote: 'Bütçe & Tahmin turlara göre rehber maliyetini ve dil bazında maaşlı rehber karşılaştırmasını gösteriyor. Maliyet kataloğundaki tutarlar ekrandan bugünden itibaren ya da tüm tarihler için güncellenebiliyor. Topkapı biletleri kişi başı €40, Ayasofya €25 ve Boğaz turu ₺340 olarak planlanıyor. Takvimde rezervasyona tıklayınca hızlı görünüm açılıyor; mobil rezervasyon detayında da Finans kartı var. İptal edilen operasyonlar maliyet taşımıyor; farklı para birimindeki veya iptal edilmiş operasyona ait ödemeler inceleme için ayrıca gösteriliyor.',
  },
];

// The ONE thing that crosses into the shared global scope — a property
// assignment on an existing object, never a lexical declaration, so this
// can never collide with anything app.js (or any other script) declares.
if (typeof window !== 'undefined') {
  window.DESETOUR_CHANGELOG = {
    entries: CRM_CHANGELOG,
    categories: CRM_CHANGELOG_CATEGORIES,
  };
}
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { CRM_CHANGELOG, CRM_CHANGELOG_CATEGORIES };
}

})();
