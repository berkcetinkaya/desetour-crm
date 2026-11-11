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
  {
    version: '13.02',
    date: '2026-11-05',
    title: 'CRM Arayüz ve Kullanıcı Deneyimi Yenilendi',
    summary: 'DeseTour CRM\'in masaüstü, tablet ve mobil arayüzleri kapsamlı olarak yenilendi. Operasyonel bilgi hiyerarşisi, rezervasyon ekranları, mobil kullanım, navigasyon, erişilebilirlik ve karanlık mod deneyimi daha hızlı ve daha tutarlı bir kullanım için yeniden düzenlendi.',
    categories: ['Arayüz', 'İyileştirme'],
    highlights: [
      'Ana Sayfa operasyon önceliklerine göre yeniden düzenlendi; bugünkü turlar, yaklaşan operasyonlar ve dikkat gerektiren işler daha görünür hale getirildi.',
      'Rezervasyon listesi ve rezervasyon detay ekranları sadeleştirildi; operasyon durumu, rehber, pickup, ödeme, hazırlıklar ve Civitatis mesajları daha hızlı taranabilir hale getirildi.',
      'Sol navigasyon ve uygulama genelindeki görsel sistem yenilendi; açık tema daha hafif bir sidebar yapısına geçirildi ve aktif/hover durumları DeseTour marka renkleriyle standartlaştırıldı.',
      'Mobil CRM deneyimi kapsamlı şekilde iyileştirildi; dokunma alanları, kartlar, navigasyon, raporlar, ayarlar ve operasyon ekranları küçük ekranlar için optimize edildi.',
      'Dashboard ve uygulama genelindeki responsive yapı desktop, tablet ve mobil ekranlarda yeniden test edildi ve yatay taşma problemleri giderildi.',
    ],
    author: 'Berk',
    technicalNote: 'Light ve Dark Mode genelinde renk, yüzey, kontrast, shadow, radius ve motion sistemi standartlaştırıldı. Klavye erişimi, focus durumları, aria etiketleri, switch ve accordion davranışları dahil olmak üzere erişilebilirlik iyileştirmeleri yapıldı. Tours, Guides, Payments, Agencies, Messages, Reminders, Reports ve Settings ekranları ortak UI sistemiyle uyumlu hale getirildi. CRM artık QITEOS platform imzasını uygulama footer\'ında gösteriyor.',
  },
  {
    version: '13.01',
    date: '2026-10-30',
    title: 'Civitatis Mesajları Rezervasyonlarda',
    summary: 'Civitatis üzerinden gelen misafir mesajları artık ilgili rezervasyonla otomatik eşleştiriliyor, rezervasyon detayından takip edilebiliyor ve operasyon ekibine bildirim olarak yansıyor.',
    categories: ['Yeni Özellik', 'Otomasyon'],
    highlights: [
      'Civitatis misafir mesajları artık rezervasyon numarası üzerinden ilgili rezervasyonla otomatik eşleştiriliyor',
      'Rezervasyon detayına yeni "Civitatis Mesajları" bölümü eklendi; mesaj içerikleri daha temiz ve okunabilir şekilde gösteriliyor',
      'Yeni mesajlar operasyon bildirimlerine ve rezervasyon aktivite geçmişine yansıyor',
      'Rezervasyon listesinde yeni mesaj bulunan kayıtlar daha kolay fark edilebiliyor',
      'Aynı Civitatis mesajının tekrar işlenmesi duplicate kayıt oluşturmuyor',
    ],
    author: 'Berk',
  },
  {
    version: '12.50',
    date: '2026-10-28',
    title: 'Acente Araştırması ve Veri Kalitesi',
    summary: 'Acente araştırma sistemi daha temiz, daha güvenilir ve doğrudan iletişime uygun adaylar üretecek şekilde geliştirildi.',
    categories: ['Otomasyon', 'İyileştirme'],
    highlights: [
      'CRM\'de daha önce kayıtlı olan acenteler yeni araştırmalardan otomatik olarak dışlanıyor; aynı acentenin farklı website formatlarıyla (www, http/https, path, query, port) tekrar bulunması engelleniyor',
      'Araştırmada kullanılabilir iletişim maili bulunamayan yeni acenteler artık CRM\'e eklenmiyor; sonuçlar doğrudan outreach yapılabilecek gerçek adaylardan oluşuyor',
      'Website adresleri normalize edilerek aynı acentenin farklı yazımlarla tekrar kaydedilmesi engelleniyor; bu koruma artık ek bir güvenlik katmanıyla destekleniyor',
      'Acente detay sayfasından mail adresi, iletişim kişisi, telefon ve website bilgileri manuel olarak güncellenebiliyor; daha önce maili bulunamayan acentelere sonradan iletişim bilgisi eklenebiliyor',
      'Araştırma sonuçlarında mevcut CRM kayıtları, tekrar eden adaylar ve iletişim maili olmayan sonuçlar filtreleniyor; yalnızca yeni ve kullanılabilir adaylar sonuç listesinde gösteriliyor',
    ],
    author: 'Berk',
  },
  {
    version: '12.49',
    date: '2026-10-23',
    title: 'CRM+ ve Yeni Arayüz',
    summary: 'CRM operasyonlarını daha görünür ve daha hızlı hale getiren Agency CRM+, Son Hareketler ve yeni premium arayüz kullanıma alındı.',
    categories: ['Yeni Özellik', 'Arayüz'],
    highlights: [
      'Agency CRM+: acentelerden gelen e-posta yanıtları artık otomatik takip ediliyor, konuşma geçmişi üzerinden doğrudan yanıt verilebiliyor ve yeni acente/mail/yanıt/takip durumları tek panelden izlenebiliyor',
      'Bildirimler: yeni acente yanıtları ve önemli operasyonel gelişmeler artık Son Bildirimler alanı ve bildirim ziliyle anında görülüp ilgili kayda doğrudan gidilebiliyor',
      'Son Hareketler: rezervasyon, rehber atama, acente iletişimi ve notlar gibi önemli işlemlerin kim tarafından yapıldığı takip edilebiliyor; yöneticiler için ayrı bir ekip aktivite görünümü eklendi',
      'Acenteler: liste ve detay ekranları daha modern ve kompakt bir çalışma alanına dönüştü; yeni yanıtlar, takip bekleyenler, partner durumları, konuşmalar ve notlar daha kolay ayırt edilebiliyor',
      'Yeni tasarım sistemi: Geist ve Instrument Serif tipografisiyle daha aydınlık ve sade bir arayüz, cihazda hatırlanan açık/koyu tema desteği ve kartlar/tablolar/modallar/mobil genelinde görsel iyileştirmeler',
    ],
    author: 'Berk',
  },
  {
    version: '12.48',
    date: '2026-10-22',
    title: 'Civitatis Rezervasyon Alım Sürecinde Sessiz Kayıp Önleme',
    summary: 'Civitatis üzerinden gelen rezervasyonlardan müşteri eşleşmesi belirsiz olanlar veya başka bir güvenlik kontrolüne takılanlar artık hiçbir koşulda sistemden sessizce kaybolmuyor; bu rezervasyonlar "incelemeye alındı" durumunda kayıt altına alınıyor ve operasyon ekibi tarafından görülebiliyor.',
    categories: ['Operasyon', 'Altyapı'],
    highlights: [
      'Müşteri eşleşmesi belirsiz olan veya diğer güvenlik kontrollerine takılan Civitatis rezervasyonları artık sessizce kaybolmuyor, "incelemeye alındı" olarak kayıt altına alınıyor',
      'Otomatik kontrol (cron) süreci artık başarısız olan veya incelemeye alınan rezervasyonları daha güvenilir şekilde raporluyor',
      'Aynı belirsiz rezervasyon için tekrarlanan otomatik kontrollerde gereksiz tekrar kayıt oluşturulmuyor',
      'Operasyon ekibi, şüpheli bir müşteri eşleşmesini inceleyip mevcut müşteriyle mi yoksa yeni bir müşteriyle mi ilişkilendirileceğine açıkça karar verebiliyor',
      'Hiçbir müşteri kaydı otomatik olarak birleştirilmiyor veya varsayılan olarak eşleştirilmiyor',
    ],
    author: 'Berk',
  },
  {
    version: '12.47',
    date: '2026-10-21',
    title: 'Acente E-posta Taslak Akışı İyileştirildi',
    summary: 'Acenteler için oluşturulan ilk temas e-posta taslakları artık oluşturuldukları anda CRM\'e kaydediliyor. Taslaklar gönderim öncesinde düzenlenebiliyor, kaydedilebiliyor ve geçmiş e-postalar korunuyor.',
    categories: ['İyileştirme'],
    highlights: [
      'Oluşturulan e-posta taslakları artık otomatik olarak CRM\'e kaydediliyor',
      'Konu ve mesaj içeriği gönderim öncesinde düzenlenip kaydedilebiliyor',
      'En son oluşturulan taslak otomatik olarak açılıyor',
      'Gönderilmiş e-postalar değiştirilemiyor ve geçmiş kayıtlar korunuyor',
      'Taslak oluşturma ve güncelleme işlemlerinin kayıt sistemi iyileştirildi',
    ],
    author: 'Berk',
  },
  {
    version: '12.46',
    date: '2026-10-21',
    title: 'Acentelere CRM Üzerinden E-posta Gönderimi Eklendi',
    summary: 'Acenteler modülünde hazırlanan ilk temas e-postaları artık CRM içinden insan onayıyla hello@desetour.com adresinden gönderilebiliyor. Gönderim sonrası iletişim durumu ve ilgili acente bilgileri otomatik olarak güncelleniyor.',
    categories: ['Yeni Özellik', 'İyileştirme'],
    highlights: [
      'Hazırlanan acente e-posta taslakları gönderim öncesinde son kez incelenebiliyor',
      'Onaylanan e-postalar hello@desetour.com üzerinden gönderiliyor',
      'Aynı e-postanın yanlışlıkla birden fazla kez gönderilmesine karşı koruma eklendi',
      'Başarılı gönderim sonrası son iletişim zamanı ve acente durumu otomatik güncelleniyor',
      'Acentelerle ilgili işlem kayıtları daha güvenilir hale getirildi',
    ],
    author: 'Berk',
  },
  {
    version: '12.45',
    date: '2026-10-21',
    title: 'CRM Güvenliği İki Aşamalı Doğrulama ile Güçlendirildi',
    summary: 'DeseTour CRM giriş güvenliği güçlendirildi. Kullanıcılar artık e-posta ve şifre ile giriş yaptıktan sonra kimlik doğrulama uygulamasındaki tek kullanımlık kodla oturumlarını doğruluyor. Yetkili CRM işlemleri ve operasyon verileri ek güvenlik katmanlarıyla korunuyor.',
    categories: ['Altyapı', 'İyileştirme'],
    highlights: [
      'CRM girişlerine iki aşamalı doğrulama eklendi',
      'Google Authenticator ve standart TOTP uygulamaları destekleniyor',
      'Operasyonel CRM erişimi doğrulanmış güvenli oturum gerektiriyor',
      'Yetkisiz veya devre dışı bırakılmış kullanıcıların doğrudan veri erişimi ek olarak sınırlandırıldı',
      'Kullanıcıların kendi yetki veya aktiflik durumlarını değiştirebilmesine karşı veritabanı koruması eklendi',
    ],
    author: 'Berk',
  },
  {
    version: '12.44',
    date: '2026-10-20',
    title: 'Acente Araştırma Sonuçları Daha Güvenilir Hale Getirildi',
    summary: 'Acenteler modülündeki pazar araştırması sonuçlarının işlenmesi güçlendirildi. Uzun ve kapsamlı aramalarda oluşabilen sonuç işleme hataları giderildi; araştırma başarısız olduğunda kullanıcıya anlaşılır bir Türkçe uyarı gösteriliyor.',
    categories: ['Altyapı', 'İyileştirme'],
    highlights: [
      'Uzun ve kapsamlı pazar araştırmalarında oluşabilen sonuç işleme hataları giderildi',
      'Araştırma sonuçlarının farklı yanıt biçimlerinde güvenilir şekilde okunabilmesi sağlandı',
      'Çok sayıda aday içeren araştırmalar için çıktı kapasitesi artırıldı',
      'Araştırma başarısız olduğunda kullanıcıya teknik detaylar yerine anlaşılır bir Türkçe uyarı gösteriliyor',
      'Uygunluk, kanıt ve kaynak kuralları değiştirilmedi',
    ],
    author: 'Berk',
  },
  {
    version: '12.43',
    date: '2026-10-20',
    title: 'Pazar Araştırmasında Zaman Aşımı Sorunu Giderildi',
    summary: 'Acenteler modülündeki pazar araştırması, çok adaylı veya kapsamlı aramalarda bazen zaman aşımına uğrayıp hata veriyordu. Bu sorun giderildi; araştırma artık daha uzun süren aramalarda da güvenilir şekilde tamamlanıyor.',
    categories: ['Altyapı', 'İyileştirme'],
    highlights: [
      'Pazar araştırması artık daha uzun süren veya çok adaylı aramalarda zaman aşımına uğramıyor',
      'Zaman aşımı durumunda kullanıcıya anlaşılır bir Türkçe bilgi mesajı gösteriliyor',
      'Araştırma kalitesi, kanıt zorunluluğu ve uygunluk değerlendirmesi hiçbir şekilde değişmedi',
    ],
    author: 'Berk',
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
