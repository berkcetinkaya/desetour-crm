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
    version: '12.39',
    date: '2026-10-04',
    title: 'Civitatis Hakediş Yönetimi',
    summary: 'Ödemeler ekranına eklenen Civitatis Hakedişleri ile Civitatis rezervasyonlarının hakedişleri artık Doğrudan Ödemelerden ayrı, dönem bazında takip edilip talep ve ödeme adımlarıyla yönetilebiliyor.',
    categories: ['Yeni Özellik', 'Operasyon'],
    highlights: [
      'Ödemeler ekranına "Civitatis Hakedişleri" sekmesinin eklenmesi; Civitatis hakedişlerinin Doğrudan Ödemelerden tamamen ayrı takip edilmesi (Doğrudan Ödemeler mevcut haliyle kullanılmaya devam ediyor)',
      'Hakediş ekranında Talep Edilebilir, Bu Ay Biriken, Talep Edildi ve Ödenen özetlerinin tek bakışta görülebilmesi',
      'Hakedişlerin aylara göre gruplanması; her dönemde toplam hakediş tutarı, rezervasyon sayısı, misafir sayısı ve hakediş durumunun görülebilmesi, dönem açılarak rezervasyon bazındaki detayların incelenebilmesi',
      'Bir dönem talep edilebilir hale geldiğinde "Talep Edildi Olarak İşaretle" ile Civitatis\'e CRM dışında yapılan talebin kayda geçirilmesi, ödeme geldikten sonra "Ödendi Olarak İşaretle" ile dönemin kapatılması; henüz talep edilebilir olmayan dönemlerde bu işlemlerin yapılamaması',
      'Tutarsız bir finansal durum tespit edildiğinde yanlış işlem yapılmasını önlemek için ilgili dönemin "Kontrol Gerekli" olarak işaretlenmesi',
    ],
    author: 'Berk',
    technicalNote: 'EUR cinsinden hakedişler, CRM\'in operasyonel görünümünde sabit bir kur (1 EUR = 55 TL) ile TL karşılığıyla gösteriliyor; bu yalnızca ekrandaki bilgilendirme amaçlıdır, gerçek tahsilat tutarını yansıtmaz.',
  },
  {
    version: '12.38',
    date: '2026-10-02',
    title: 'Tur Hazırlıkları Takibi',
    summary: 'Civitatis rezervasyonları için gerekli bilet hazırlıkları artık otomatik olarak belirleniyor; Ana Sayfa ve Rezervasyon Detayı\'ndan takip edilip tamamlanabiliyor, yanlışlıkla tamamlanan bir hazırlık da güvenle geri alınabiliyor.',
    categories: ['Yeni Özellik', 'Operasyon', 'Otomasyon'],
    highlights: [
      'Yeni veya değişen Civitatis rezervasyonları için gerekli giriş bileti hazırlıklarının (örn. Ayasofya, Topkapı Sarayı + Harem) misafir sayısına göre otomatik belirlenmesi',
      'Ana Sayfa\'da Bilet Hazırlıkları panelinde Bekleyenler ve Tamamlananlar olarak ayrı takip, "Hazırlandı" ile tek tıkla tamamlama',
      'Rezervasyon Detayı\'nda o rezervasyona ait tüm bilet hazırlıklarının görüntülenebilmesi',
      'Yemek dahil/dahil değil bilgisinin Rezervasyon Detayı\'nda ve Ana Sayfa\'da ayrıca görülebilmesi',
      'Yanlışlıkla tamamlanan bir bilet hazırlığının Rezervasyon Detayı\'ndan onay adımıyla güvenle yeniden bekleyen durumuna alınabilmesi',
    ],
    author: 'Berk',
    technicalNote: 'Bilet hazırlığı tamamlama ve geri alma işlemleri yalnızca yönetici ve operasyon rolleri tarafından yapılabiliyor; geri alma özelliği bilinçli bir düzeltme adımı olması için sadece Rezervasyon Detayı\'nda sunuluyor, Ana Sayfa\'ya eklenmedi.',
  },
  {
    version: '12.37',
    date: '2026-09-30',
    title: 'Tur Bilgi Merkezi',
    summary: 'Tur detayları artık operasyon ekibinin ihtiyaç duyduğu her bilgiyi Türkçe olarak bir arada sunan kapsamlı bir Tur Bilgi Merkezi\'ne dönüştü; Ana Sayfa da okunmamış önemli operasyon uyarılarını artık öne çıkarıyor.',
    categories: ['Yeni Özellik', 'Operasyon'],
    highlights: [
      'Tur detaylarının kapsamlı bir Tur Bilgi Merkezi olarak görüntülenmesi',
      'Yabancı dilde satılan turların operasyon bilgilerinin CRM içinde Türkçe tutulabilmesi',
      'Durak bazlı tur rotası, dahil/hariç hizmetler, buluşma-bitiş bilgileri ve rezervasyon/iptal kurallarının tur bazında görüntülenmesi',
      'Dese Tour\'a özel rehber operasyon notlarının marketplace içeriğinden ayrı tutulması ve rehberlerin kendilerine atanmış turları salt okunur görebilmesi',
      'Ana Sayfa\'da Civitatis rezervasyon iptalleri gibi okunmamış önemli operasyon uyarılarının öne çıkarılması',
    ],
    author: 'Berk',
    technicalNote: 'Rehberler yalnızca kendilerine atanmış rezervasyonların tur bilgilerini görebiliyor; ticari satış kanalı ve fiyat bilgileri bu görünümde yer almıyor, düzenleme yapamıyorlar.',
  },
  {
    version: '12.36',
    date: '2026-09-28',
    title: 'Portekizce Civitatis Desteği',
    summary: 'Civitatis üzerinden gelen Portekizce rezervasyonlar ve yeni rezervasyon formatları artık CRM tarafından güvenli şekilde işlenebiliyor.',
    categories: ['Otomasyon', 'İyileştirme'],
    highlights: [
      'Portekizce rezervasyon desteği',
      'Yeni yolcu adı formatları desteği',
      'EUR fiyat formatı desteği',
      'Saati belirtilmeyen rezervasyonlarda doğru gösterim',
    ],
    author: 'Berk',
    technicalNote: 'Rezervasyon e-postasında tur saati belirtilmediğinde CRM artık uydurma bir saat göstermek yerine bunu net şekilde belirtiyor.',
  },
  {
    version: '12.35',
    date: '2026-09-28',
    title: 'Otomatik Civitatis Tur Oluşturma',
    summary: 'CRM\'de henüz karşılığı olmayan yeni bir Civitatis ürün + dil kombinasyonu için rezervasyon geldiğinde, CRM ilgili tur kaydını artık otomatik olarak hazırlayabiliyor.',
    categories: ['Otomasyon', 'Yeni Özellik'],
    highlights: [
      'Yeni bir Civitatis ürün + dil kombinasyonu için otomatik tur kaydı oluşturulması',
      'Aynı Civitatis ürününün, diller bazında ayrı CRM tur kayıtlarına sahip olabilmesi',
      'Tur adının her zaman gerçek ürün/iç kod bilgisini yansıtması',
      'Rezervasyon fiyatının, oluşturulan turun taban fiyatı olarak kullanılmaması',
      'Otomatik oluşturulan turların taslak (draft) durumunda başlayıp ekibin gözden geçirmesini beklemesi',
    ],
    author: 'Berk',
  },
  {
    version: '12.30',
    date: '2026-09-22',
    title: 'Güvenli Rezervasyon İşleme',
    summary: 'Civitatis\'ten gelen rezervasyonların CRM\'e güvenli, tekrarsız ve tutarlı şekilde aktarılmasını sağlayan altyapı tamamlandı.',
    categories: ['Altyapı', 'Otomasyon'],
    highlights: [
      'Aynı rezervasyonun yanlışlıkla birden fazla kez oluşturulmasının engellenmesi',
      'Rezervasyon kimliğinin güvenli ve tutarlı biçimde eşleştirilmesi',
      'Rezervasyon numaralarının otomatik ve çakışmasız üretilmesi',
      'Mevcut misafir kayıtlarıyla kontrollü, temkinli eşleştirme',
      'Bir aktarım sırasında sorun yaşanırsa yapılan değişikliklerin bütünüyle geri alınması',
    ],
    author: 'Berk',
  },
  {
    version: '12.24',
    date: '2026-09-21',
    title: 'Civitatis Rezervasyon Altyapısı',
    summary: 'Civitatis\'ten e-posta yoluyla gelen rezervasyon bildirimleri artık CRM tarafından otomatik olarak yorumlanabiliyor.',
    categories: ['Otomasyon', 'Altyapı'],
    highlights: [
      'Civitatis rezervasyon bildirimlerinin CRM tarafından otomatik yorumlanması',
      'Rezervasyon sahibi (iletişim kişisi) ile yolcuların birbirinden ayrıştırılması',
      'Yorumlanan rezervasyon bilgisinin CRM\'e aktarılabilmesi',
      'Aktarılan rezervasyonların takvim ve operasyon ekranlarında diğer rezervasyonlarla birlikte görünmesi',
    ],
    author: 'Berk',
  },
  {
    version: '12.18',
    date: '2026-09-18',
    title: 'Tur ve Satış Kanalı Mimarisi',
    summary: 'Turlar, dış satış ve değerlendirme kanallarından ayrı bir kimliğe kavuştu. Bir tur artık farklı dillere ve kanallara göre ayrı ayrı eşleştirilebiliyor.',
    categories: ['Altyapı', 'Operasyon'],
    highlights: [
      'CRM turlarının dış satış/değerlendirme kanallarından ayrı bir kimlik kazanması',
      'Bir turun birden fazla dile ve kanala göre ayrı ayrı eşleştirilebilmesi',
      'Civitatis, Tripadvisor, Google, Viator, Musement, Airbnb Experiences gibi farklı kanal ve kaynakların sistemde tanımlanabilmesi',
      'Tur listesinde dil ve platform bazlı görünüm',
    ],
    author: 'Berk',
  },
  {
    version: '12.13',
    date: '2026-09-17',
    title: 'Değerlendirme ve Rehber Performansı',
    summary: 'Rezervasyonlara değerlendirme eklenebiliyor; bu değerlendirmeler rehber performansına otomatik olarak yansıyor.',
    categories: ['Yeni Özellik', 'Operasyon'],
    highlights: [
      'Bir rezervasyona birden fazla değerlendirme eklenebilmesi',
      'Değerlendirmelerde dil/kaynak bilgisinin kaydedilmesi',
      'Rehber profilinde gerçek değerlendirmelere dayanan performans özeti',
      'Rehber detay sayfasında tur ve değerlendirme geçmişinin bir arada görünmesi',
    ],
    author: 'Berk',
  },
  {
    version: '12.08',
    date: '2026-09-15',
    title: 'Rehber Yönetimi',
    summary: 'Rehberlerimiz modülü ile rehber profilleri, konuştukları diller ve rezervasyon atamaları tek bir yerden yönetilebiliyor.',
    categories: ['Yeni Özellik', 'Operasyon'],
    highlights: [
      'Rehber profilleri ve konuştukları diller',
      'Rezervasyona rehber ataması',
      'Rehber hakediş/ödeme kayıtlarının takip edilebilmesi',
      'Rehber bilgilerinin rezervasyon ve takvim ekranlarında görünmesi',
    ],
    author: 'Berk',
  },
  {
    version: '12.05',
    date: '2026-09-14',
    title: 'Yeni Operasyon Arayüzü',
    summary: 'Dese Tour\'un premium marka diliyle uyumlu, sade ve masaüstü öncelikli yeni bir operasyon arayüzü hayata geçti; mobil kullanım deneyimi de baştan tasarlandı.',
    categories: ['Arayüz', 'İyileştirme'],
    highlights: [
      'Lacivert, fildişi ve altın tonlarında sade, premium bir tasarım dili',
      'Sadeleştirilmiş yan menü ve yeniden tasarlanan Ana Sayfa',
      'Masaüstü öncelikli, yoğun operasyon ekranları',
      'Mobil cihazlarda kullanılabilirliği artıran ayrı bir mobil deneyim',
    ],
    author: 'Berk',
  },
  {
    version: '12.01',
    date: '2026-09-13',
    title: 'Dese Tour Operasyon Merkezi',
    summary: 'Dese Tour CRM\'in temel operasyon akışı kuruldu: Misafirler, Rezervasyonlar, Turlar, Rehberler ve Ödemeler tek bir sistemde birleşti.',
    categories: ['Altyapı', 'Operasyon'],
    highlights: [
      'Misafir, rezervasyon, tur, rehber ve ödeme kayıtlarının tek bir operasyon merkezinde birleşmesi',
      'Genel bir satış hunisi mantığından turizm operasyonuna özel bir yapıya geçilmesi',
      'Gerçek verilerle çalışan, gösterim amaçlı sahte verilerden arındırılmış bir temel kurulması',
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
